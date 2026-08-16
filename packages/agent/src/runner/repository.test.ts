import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { after, before, describe, test } from 'node:test'

import { PGlite } from '@electric-sql/pglite'
import { drizzle } from 'drizzle-orm/pglite'
import { eq } from 'drizzle-orm'

import { automations, contacts, enrollments, jobs, linkedinAccounts, users } from '@linkfy/db'

import { DrizzleRepository, dayKey } from './repository.js'

/**
 * Run against a real Postgres — PGlite is the actual engine compiled to wasm,
 * not an emulation — because every interesting thing this file does is SQL:
 * upserts, conflict targets, atomic increments, FOR UPDATE SKIP LOCKED. A mock
 * would agree with whatever the code does and prove nothing.
 */

let db: ReturnType<typeof drizzle>
let pg: PGlite
let repo: DrizzleRepository
let accountId: string
let automationId: string

const TZ = 'America/Argentina/Buenos_Aires'

/** The generated migrations are the schema; running them here also tests them. */
function migrationSql(): string {
  const dir = join(import.meta.dirname, '..', '..', '..', 'db', 'migrations')
  return readdirSync(dir)
    .filter((f) => f.endsWith('.sql'))
    .sort()
    .map((f) => readFileSync(join(dir, f), 'utf8'))
    .join('\n')
}

before(async () => {
  pg = new PGlite()
  await pg.exec(migrationSql())
  // drizzle-orm bundles its own copy of the PGlite types, so the instance is
  // structurally the same class but not nominally the same type.
  db = drizzle({ client: pg } as never)
  repo = new DrizzleRepository(db, { timezone: TZ })

  const [user] = await db
    .insert(users)
    .values({ email: 'martin@example.com' })
    .returning({ id: users.id })

  const [account] = await db
    .insert(linkedinAccounts)
    .values({ userId: user!.id, publicIdentifier: 'martin-bufczyk' })
    .returning({ id: linkedinAccounts.id })
  accountId = account!.id

  const [automation] = await db
    .insert(automations)
    .values({
      accountId,
      name: 'Guía',
      status: 'active',
      keywords: ['guia'],
      flow: { nodes: [{ id: 'book', type: 'book', config: { calendarUrl: 'https://cal.com/enbi' } }], edges: [] },
    })
    .returning({ id: automations.id })
  automationId = automation!.id
})

after(async () => {
  await pg?.close()
})

async function enroll(identifier: string, name = 'Wendy Torres') {
  return repo.createEnrollment({
    accountId,
    automationId,
    publicIdentifier: identifier,
    fullName: name,
    headline: 'CTO',
    commentUrn: `urn:comment:${identifier}`,
    commentText: 'guia',
    matchedKeyword: 'guia',
    postUrl: 'https://linkedin.com/feed/update/urn:li:activity:1',
  })
}

describe('enrolling', () => {
  test('the same person commenting twice produces one enrollment', async () => {
    // The unique index is the last line of defense against messaging someone
    // twice, so the second call has to return the first row rather than throw
    // or insert. LinkedIn shows the same comment on repeat scans routinely.
    const first = await enroll('wendy-torres')
    const second = await enroll('wendy-torres')
    assert.equal(first, second)

    const rows = await db.select().from(enrollments).where(eq(enrollments.contactId, (await db.select({ id: contacts.id }).from(contacts).where(eq(contacts.publicIdentifier, 'wendy-torres')))[0]!.id))
    assert.equal(rows.length, 1)
  })

  test('a new enrollment is due immediately', async () => {
    // A fresh row with no nextActionAt is invisible to the scheduler forever —
    // the flow would silently never start.
    await enroll('piero-storace', 'Piero Storace')
    const due = await repo.dueEnrollments(accountId, new Date(), 50)
    assert.ok(due.some((e) => e.publicIdentifier === 'piero-storace'))
  })

  test('the first name is split out for the message templates', async () => {
    await enroll('yeison-villamil', 'Yeison Villamil')
    const due = await repo.dueEnrollments(accountId, new Date(), 50)
    const yeison = due.find((e) => e.publicIdentifier === 'yeison-villamil')
    assert.equal(yeison?.firstName, 'Yeison')
  })

  test('the same comment is not enrolled twice across scans', async () => {
    await enroll('bernardo-b', 'Bernardo Bertolotto')
    assert.equal(await repo.isCommentEnrolled(automationId, 'urn:comment:bernardo-b'), true)
    assert.equal(await repo.isCommentEnrolled(automationId, 'urn:comment:nadie'), false)
  })
})

describe('state', () => {
  test('re-writing the same state does not restart the clock', async () => {
    // The engine measures time-in-state to decide when to follow up or
    // withdraw. If a no-op write bumped it, an invite would never age out and
    // a follow-up would never fire — the sequence would just stop, quietly.
    const id = await enroll('omar-droguett', 'Omar Droguett')
    await repo.setEnrollmentState(id, 'invite_sent', null)

    const [before] = await db
      .select({ at: enrollments.enteredStateAt })
      .from(enrollments)
      .where(eq(enrollments.id, id))

    await new Promise((r) => setTimeout(r, 25))
    await repo.setEnrollmentState(id, 'invite_sent', new Date())

    const [after] = await db
      .select({ at: enrollments.enteredStateAt })
      .from(enrollments)
      .where(eq(enrollments.id, id))

    assert.equal(before!.at!.getTime(), after!.at!.getTime())
  })

  test('a real state change does restart it', async () => {
    const id = await enroll('cambio-real', 'Cambio Real')
    await repo.setEnrollmentState(id, 'invite_sent', null)
    const [before] = await db
      .select({ at: enrollments.enteredStateAt })
      .from(enrollments)
      .where(eq(enrollments.id, id))

    await new Promise((r) => setTimeout(r, 25))
    await repo.setEnrollmentState(id, 'connected', null)

    const [after] = await db
      .select({ at: enrollments.enteredStateAt })
      .from(enrollments)
      .where(eq(enrollments.id, id))

    assert.ok(after!.at!.getTime() > before!.at!.getTime())
  })

  test('an enrollment is findable when it is not due', async () => {
    // This is the state a job executes in: parked, with no nextActionAt.
    const id = await enroll('parked-lead', 'Parked Lead')
    await repo.setEnrollmentState(id, 'comment_replied', null)

    assert.equal((await repo.dueEnrollments(accountId, new Date(), 50)).some((e) => e.id === id), false)
    assert.equal((await repo.enrollmentById(id))?.firstName, 'Parked')
  })
})

describe('jobs', () => {
  test('a job is claimed once, even by two agents at the same time', async () => {
    const id = await enroll('claim-test', 'Claim Test')
    await repo.enqueueJob({
      accountId,
      enrollmentId: id,
      type: 'send_dm',
      payload: { publicIdentifier: 'claim-test' },
      runAfter: new Date(Date.now() - 1000),
    })

    const [a, b] = await Promise.all([
      repo.claimJobs(accountId, new Date(), 10, 'agente-a'),
      repo.claimJobs(accountId, new Date(), 10, 'agente-b'),
    ])

    const claimed = [...a, ...b].filter((j) => j.enrollmentId === id)
    assert.equal(claimed.length, 1, 'un job, un agente')
  })

  test('a job in the future is not claimed yet', async () => {
    const id = await enroll('future-job', 'Future Job')
    await repo.enqueueJob({
      accountId,
      enrollmentId: id,
      type: 'send_dm',
      payload: {},
      runAfter: new Date(Date.now() + 60_000),
    })

    const claimed = await repo.claimJobs(accountId, new Date(), 10, 'agente')
    assert.equal(claimed.some((j) => j.enrollmentId === id), false)
  })

  test('a transient failure is retried later, not immediately', async () => {
    const id = await enroll('retry-job', 'Retry Job')
    await repo.enqueueJob({ accountId, enrollmentId: id, type: 'send_dm', payload: {}, runAfter: new Date(0) })
    const [job] = await repo.claimJobs(accountId, new Date(), 10, 'agente')

    await repo.failJob(job!.id, 'timeout', true)

    const [row] = await db.select().from(jobs).where(eq(jobs.id, job!.id))
    assert.equal(row!.status, 'pending')
    assert.ok(row!.runAfter.getTime() > Date.now(), 'con backoff, no al toque')
  })

  test('a job that is given up on hands the enrollment back to the scheduler', async () => {
    // Otherwise the enrollment stays parked with no nextActionAt: never
    // retried, never failed, never shown. A lead lost in silence.
    const id = await enroll('dead-job', 'Dead Job')
    await repo.setEnrollmentState(id, 'comment_replied', null)
    await repo.enqueueJob({ accountId, enrollmentId: id, type: 'send_invite', payload: {}, runAfter: new Date(0) })
    const [job] = await repo.claimJobs(accountId, new Date(), 10, 'agente')

    await repo.failJob(job!.id, 'botón no encontrado', false)

    const [row] = await db.select().from(enrollments).where(eq(enrollments.id, id))
    assert.equal(row!.attempts, 1)
    assert.ok(row!.nextActionAt, 'vuelve a estar visible para el scheduler')
    assert.match(row!.lastError ?? '', /botón/)
  })
})

describe('quotas', () => {
  test('counting is atomic under concurrency', async () => {
    // Read-modify-write here would lose increments, and the quota exists to
    // keep the account under LinkedIn's cap. Drifting upward is the one
    // direction that gets an account restricted.
    const now = new Date()
    await Promise.all(Array.from({ length: 12 }, () => repo.countAction(accountId, 'invite', now)))

    const usage = await repo.usage(accountId, now)
    assert.equal(usage.today.invite, 12)
    assert.equal(usage.invitesTrailingWeek, 12)
  })

  test('the day boundary is the account owner\'s midnight, not UTC', () => {
    // 02:00 UTC is still the previous evening in Buenos Aires. Counting in UTC
    // would hand back a fresh invite allowance in the middle of the workday.
    const lateNight = new Date('2026-03-10T02:00:00Z')
    assert.equal(dayKey(lateNight, TZ), '2026-03-09')
    assert.equal(dayKey(lateNight, 'UTC'), '2026-03-10')
  })
})

describe('health', () => {
  test('contacts messaged without an invite do not count as acceptances', async () => {
    // 1st-degree contacts are DMed directly and never invited. Counting them
    // would inflate the acceptance rate — the exact number the circuit breaker
    // trips on — and the breaker would never fire.
    const invited = await enroll('invitado', 'Invitado Uno')
    await repo.markInvited(invited, new Date())
    await repo.setEnrollmentState(invited, 'invite_sent', null)

    const direct = await enroll('primer-grado', 'Primer Grado')
    await repo.setEnrollmentState(direct, 'dm_sent', null)

    const window = await repo.healthWindow(accountId)
    assert.equal(window.invitesPending, 1)
    assert.equal(window.invitesAccepted, 0, 'el 1er grado no cuenta como aceptación')
    assert.equal(window.invitesResolved, 0)
  })

  test('an accepted invitation moves from pending to accepted', async () => {
    const id = await enroll('acepto', 'Aceptó Rápido')
    await repo.markInvited(id, new Date())
    await repo.setEnrollmentState(id, 'connected', null)

    const window = await repo.healthWindow(accountId)
    assert.equal(window.invitesAccepted, 1)
    assert.equal(window.invitesResolved, 1)
  })
})

describe('dedup', () => {
  test('someone already in a live flow is flagged as such', async () => {
    await enroll('activo', 'Activo Uno')
    const snapshot = await repo.contactByIdentifier(accountId, 'activo')
    assert.equal(snapshot?.hasActiveEnrollment, true)
    assert.equal(snapshot?.everInvited, false)
  })

  test('someone never seen returns nothing rather than an empty shell', async () => {
    assert.equal(await repo.contactByIdentifier(accountId, 'desconocido'), null)
  })

  test('opting out is visible to the eligibility check', async () => {
    await enroll('opt-out', 'Opt Out')
    await db
      .update(contacts)
      .set({ optedOutAt: new Date() })
      .where(eq(contacts.publicIdentifier, 'opt-out'))

    const snapshot = await repo.contactByIdentifier(accountId, 'opt-out')
    assert.equal(snapshot?.optedOut, true)
  })
})

describe('automations', () => {
  test('an automation with no posts listed watches every post on the account', async () => {
    const active = await repo.activeAutomations(accountId)
    assert.equal(active.length, 1)
    assert.ok(active[0]!.postUrls.length > 0)
    assert.equal(active[0]!.calendarUrl, 'https://cal.com/enbi')
  })

  test('a paused automation is not returned', async () => {
    await db.update(automations).set({ status: 'paused' }).where(eq(automations.id, automationId))
    assert.equal((await repo.activeAutomations(accountId)).length, 0)
    await db.update(automations).set({ status: 'active' }).where(eq(automations.id, automationId))
  })
})
