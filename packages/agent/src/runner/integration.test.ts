import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { after, before, test } from 'node:test'

import { PGlite } from '@electric-sql/pglite'
import { drizzle } from 'drizzle-orm/pglite'
import { eq } from 'drizzle-orm'

import { DEFAULT_WORKING_HOURS } from '@linkfy/core'
import { automations, enrollments, jobs, linkedinAccounts, messages, posts, users } from '@linkfy/db'

import type { LinkedInAdapter, PostComment } from '../linkedin/adapter.js'
import { DrizzleRepository } from './repository.js'
import { runTick } from './tick.js'

/**
 * The whole agent against a real database: real repository, real engine, real
 * tick. Only LinkedIn and the LLM are stand-ins.
 *
 * Every unit here is already tested. What is not tested anywhere else is
 * whether they are wired to each other correctly — and a mis-wiring does not
 * throw, it just produces an agent that runs, logs nothing wrong, and never
 * contacts anybody.
 */

let pg: PGlite
let db: ReturnType<typeof drizzle>
let repo: DrizzleRepository
let accountId: string

/** Everything the fake LinkedIn was asked to do, in order. */
const performed: string[] = []

const COMMENT: PostComment = {
  urn: 'urn:li:comment:1',
  authorPublicIdentifier: 'wendy-torres',
  authorName: 'Wendy Torres',
  authorHeadline: 'CTO en Nubity',
  body: 'guia',
}

const POST_URL = 'https://www.linkedin.com/feed/update/urn:li:activity:7000'

function fakeLinkedIn(): LinkedInAdapter {
  return {
    assertSignedIn: async () => {},
    readComments: async () => [COMMENT],
    replyToComment: async (_url, _urn, body) => {
      performed.push(`reply:${body}`)
    },
    readProfile: async (publicIdentifier) => {
      performed.push('profile')
      return { publicIdentifier, fullName: 'Wendy Torres', degree: 2 }
    },
    sendInvite: async (_id, note) => {
      performed.push(`invite:${note ?? ''}`)
      return { sent: true, withNote: Boolean(note) }
    },
    withdrawInvite: async () => true,
    sendMessage: async (_id, body) => {
      performed.push(`dm:${body}`)
    },
    listConversations: async () => [],
    readThread: async () => [],
    close: async () => {},
  }
}

/** Wednesday 14:00 UTC — 11:00 in Buenos Aires, inside working hours. */
let clock = new Date('2026-08-05T14:00:00Z')

function tick() {
  return runTick({
    accountId,
    repo,
    linkedin: fakeLinkedIn(),
    classifier: { classify: async () => ({ intent: 'unclear', confidence: 0, signals: {} }) as never },
    writer: {
      inviteNote: async (input) => `Buenas ${input.firstName}! Vi que comentaste "${input.matchedKeyword}".`,
    },
    workingHours: DEFAULT_WORKING_HOURS,
    now: () => clock,
    leaseHolder: 'test',
  })
}

/** Moves the clock forward so scheduled work becomes due. */
function advance(minutes: number) {
  clock = new Date(clock.getTime() + minutes * 60_000)
}

before(async () => {
  pg = new PGlite()
  const dir = join(import.meta.dirname, '..', '..', '..', 'db', 'migrations')
  await pg.exec(
    readdirSync(dir)
      .filter((f) => f.endsWith('.sql'))
      .sort()
      .map((f) => readFileSync(join(dir, f), 'utf8'))
      .join('\n'),
  )
  db = drizzle({ client: pg } as never)
  repo = new DrizzleRepository(db, { timezone: DEFAULT_WORKING_HOURS.timezone, now: () => clock })

  const [user] = await db.insert(users).values({ email: 'martin@example.com' }).returning({ id: users.id })
  const [account] = await db
    .insert(linkedinAccounts)
    .values({ userId: user!.id, publicIdentifier: 'martinbufczyk' })
    .returning({ id: linkedinAccounts.id })
  accountId = account!.id

  await db.insert(posts).values({ accountId, urn: POST_URL, url: POST_URL })
  await db.insert(automations).values({
    accountId,
    name: 'Guía',
    status: 'active',
    keywords: ['guia'],
    postIds: [],
    flow: { nodes: [], edges: [] },
  })
})

after(async () => {
  await pg?.close()
})

test('a keyword comment becomes a public reply, then a personalized invite', async () => {
  // The product in one test. Someone comments the keyword; they get answered
  // in public and invited with a note that references what they wrote — the
  // sequence every competing tool sends blank or templated.

  // 1. Detection. The comment enrolls them and the reply is scheduled, not
  //    fired: replying within a second of a comment reads as a bot.
  let result = await tick()
  assert.equal(result.enrolled, 1)
  assert.equal(result.scheduled, 1)
  assert.equal(performed.length, 0, 'todavía no mandó nada')

  // 2. Same comment, same tick a minute later. Nothing new: neither a second
  //    enrollment nor a second job.
  result = await tick()
  assert.equal(result.enrolled, 0)
  assert.equal(result.scheduled, 0, 'no re-encola el mismo trabajo')

  const queued = await db.select().from(jobs)
  assert.equal(queued.length, 1, 'un solo job en la cola')

  // 3. The reply comes due.
  advance(10)
  result = await tick()
  assert.equal(result.executed, 1)
  assert.ok(performed.some((p) => p.startsWith('reply:Wendy')), `respondió: ${performed.join(' | ')}`)

  // 4. Degree unknown, so it looks before deciding invite-versus-DM.
  advance(10)
  await tick()
  advance(10)
  await tick()
  assert.ok(performed.includes('profile'), 'miró el perfil antes de decidir')

  // 5. 2nd degree, so an invite with a note that quotes the keyword.
  advance(10)
  await tick()
  advance(10)
  await tick()

  const invite = performed.find((p) => p.startsWith('invite:'))
  assert.ok(invite, `esperaba una invitación: ${performed.join(' | ')}`)
  assert.match(invite!, /Wendy/, 'la nota lo llama por su nombre')
  assert.match(invite!, /guia/, 'la nota menciona lo que comentó')

  // 6. And it is all recorded: state, the invite stamp the health breaker
  //    reads, and the messages the panel shows.
  const [enrollment] = await db.select().from(enrollments)
  assert.equal(enrollment!.state, 'invite_sent')
  assert.ok(enrollment!.invitedAt, 'quedó marcado el momento de la invitación')

  const sent = await db.select().from(messages)
  assert.deepEqual(
    sent.map((m) => m.channel).sort(),
    ['comment_reply', 'invite_note'],
    'quedó registrado lo que salió',
  )

  const usage = await repo.usage(accountId, clock)
  assert.equal(usage.today.invite, 1)
  assert.equal(usage.today.comment_reply, 1)
})

test('a second person on the same post is handled independently', async () => {
  // Two leads share a post and an automation but not a state. Getting this
  // wrong is how one person's reply advances someone else's enrollment.
  const other = { ...COMMENT, urn: 'urn:li:comment:2', authorPublicIdentifier: 'piero-storace', authorName: 'Piero Storace' }

  const result = await runTick({
    accountId,
    repo,
    linkedin: { ...fakeLinkedIn(), readComments: async () => [COMMENT, other] },
    classifier: { classify: async () => ({ intent: 'unclear', confidence: 0, signals: {} }) as never },
    writer: { inviteNote: async () => 'nota' },
    workingHours: DEFAULT_WORKING_HOURS,
    now: () => clock,
    leaseHolder: 'test',
  })

  assert.equal(result.enrolled, 1, 'solo el nuevo')

  const rows = await db.select({ state: enrollments.state }).from(enrollments)
  assert.equal(rows.length, 2)
  assert.equal(rows.filter((r) => r.state === 'detected').length, 1)
  assert.equal(rows.filter((r) => r.state === 'invite_sent').length, 1)
})

test('the account is marked alive on every cycle', async () => {
  // The panel cannot otherwise tell a quiet agent from a dead one, and quiet
  // is the normal state most of the day.
  const [before] = await db
    .select({ seen: linkedinAccounts.agentLastSeenAt })
    .from(linkedinAccounts)
    .where(eq(linkedinAccounts.id, accountId))

  assert.ok(before!.seen, 'ya quedó registrado en los ciclos anteriores')
})
