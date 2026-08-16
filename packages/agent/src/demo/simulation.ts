import { and, eq } from 'drizzle-orm'
import type { PgDatabase } from 'drizzle-orm/pg-core'

import { DEFAULT_WORKING_HOURS } from '@linkfy/core'
import { automations, posts } from '@linkfy/db'

import type { LinkedInAdapter, PostComment } from '../linkedin/adapter.js'
import { DrizzleRepository } from '../runner/repository.js'
import { runTick } from '../runner/tick.js'

/**
 * The whole product against a simulated LinkedIn.
 *
 * The engine, the repository, the playbook and the orchestrator are the real
 * ones, writing to a real database. Only LinkedIn is fake, and the classifier
 * is a fixed script so it costs nothing and answers the same way twice.
 *
 * It exists because the other way to see this work is to publish a post, wait
 * for a stranger to comment, and hope — a bad first look at software someone
 * is deciding whether to trust. Here the funnel is on screen in ten seconds,
 * in states the engine actually produced rather than rows typed into a fixture.
 *
 * Kept out of the bin script so it can be run against a test database: a demo
 * that crashes on someone's first look is worse than no demo.
 */

type AnyPgDatabase = PgDatabase<any, any, any>

export const DEMO_AUTOMATION = 'Demo — así funciona'
export const DEMO_POST = 'https://www.linkedin.com/feed/update/urn:li:activity:demo'

/** Modelled on real threads: short comments, one word, one that asks for the pitch. */
export const CAST = [
  {
    identifier: 'demo-wendy-castillo',
    name: 'Wendy Castillo',
    headline: 'Account Manager en Excelia | Strategic Business Development',
    comment: 'demo',
    degree: 2,
    accepts: true,
    /** What they write back once the DM lands. */
    reply: 'Hola! Si, tenemos una empresa de desarrollo de software' as string | null,
  },
  {
    identifier: 'demo-piero-storace',
    name: 'Piero Storace',
    headline: 'CEO en Nubity | Cloud & DevOps',
    comment: 'demo, me interesa',
    degree: 2,
    accepts: true,
    reply: 'como nos podrias ayudar?' as string | null,
  },
  {
    identifier: 'demo-yeison-villamil',
    name: 'Yeison Villamil',
    headline: 'GTM Acquisition Leader',
    comment: 'demo',
    // 1st degree: skips the invitation entirely and costs nothing against the
    // weekly cap, which on a real account is most of the volume.
    degree: 1,
    accepts: true,
    reply: 'de 10, contame' as string | null,
  },
  {
    identifier: 'demo-clement-geynet',
    name: 'Clément Geynet',
    headline: 'Conferencier IA | HEC Paris',
    comment: 'demo por favor',
    degree: 3,
    // Left pending, which is where most invitations sit for a while.
    accepts: false,
    reply: null as string | null,
  },
]

export type DemoResult = {
  actions: string[]
  cycles: number
}

export async function runDemo(options: {
  db: AnyPgDatabase
  accountId: string
  timezone: string
  /** Injected so the run does not depend on today's date. */
  startAt?: Date
  cycles?: number
  stepMinutes?: number
  log?: (message: string) => void
}): Promise<DemoResult> {
  const log = options.log ?? (() => {})
  const actions: string[] = []
  const threads = new Map<string, Array<{ from: 'owner' | 'lead'; body: string }>>()

  /** Wednesday, 09:15 in Buenos Aires: a full working day ahead of the run. */
  let clock = options.startAt ?? new Date('2026-08-05T12:15:00Z')

  const comments: PostComment[] = CAST.map((one, i) => ({
    urn: `urn:li:comment:demo-${i}`,
    authorPublicIdentifier: one.identifier,
    authorName: one.name,
    authorHeadline: one.headline,
    body: one.comment,
  }))

  const person = (identifier: string) => CAST.find((p) => p.identifier === identifier)

  const linkedin: LinkedInAdapter = {
    assertSignedIn: async () => {},
    readComments: async () => comments,
    likeComment: async () => true,
    replyToComment: async (_url, urn, body) => {
      const index = Number(urn.split('-').at(-1))
      actions.push(`💬 respuesta pública a ${CAST[index]?.name ?? urn}: "${body}"`)
    },
    readProfile: async (publicIdentifier) => ({
      publicIdentifier,
      fullName: person(publicIdentifier)?.name ?? publicIdentifier,
      degree: person(publicIdentifier)?.degree ?? 2,
    }),
    sendInvite: async (publicIdentifier, note) => {
      actions.push(`🤝 invitación a ${person(publicIdentifier)?.name}: "${note ?? '(sin nota)'}"`)
      return { sent: true, withNote: Boolean(note) }
    },
    // Whoever accepts disappears from here, which is exactly how the real page
    // tells the agent an invitation was taken.
    listPendingInvites: async () => CAST.filter((p) => !p.accepts).map((p) => p.identifier),
    withdrawInvite: async () => true,
    sendMessage: async (publicIdentifier, body) => {
      actions.push(`✉️  DM a ${person(publicIdentifier)?.name}: "${body}"`)
      const thread = threads.get(publicIdentifier) ?? []
      thread.push({ from: 'owner', body })

      // They answer the first message, not every one. A lead who replies
      // instantly to everything would hide the state this product is built
      // around: waiting.
      const scripted = person(publicIdentifier)?.reply
      if (scripted && thread.length === 1) thread.push({ from: 'lead', body: scripted })

      threads.set(publicIdentifier, thread)
    },
    listOwnPosts: async () => [
      { urn: 'urn:li:activity:demo', url: DEMO_POST, excerpt: 'Publicación de demostración.' },
    ],
    listConversations: async () =>
      [...threads.entries()]
        .filter(([, messages]) => messages.at(-1)?.from === 'lead')
        .map(([identifier, messages]) => ({
          threadId: `demo-${identifier}`,
          participantPublicIdentifier: identifier,
          participantName: person(identifier)?.name ?? identifier,
          lastMessageAt: clock,
          lastMessageFromOwner: false,
          snippet: messages.at(-1)?.body ?? '',
        })),
    readThread: async (threadId) => {
      const identifier = threadId.replace('demo-', '')
      return (threads.get(identifier) ?? []).map((m) => ({ from: m.from, body: m.body, at: clock }))
    },
    close: async () => {},
  }

  const repo = new DrizzleRepository(options.db, {
    timezone: options.timezone,
    now: () => clock,
  })

  // Half an hour per cycle across a working day, because the engine holds the
  // DM for two to six hours after someone accepts — deliberately, since
  // nothing reads as automated like a message landing the second they do. A
  // shorter run ends before the conversation half of the product appears at
  // all, which is the half worth seeing.
  const stepMs = options.stepMinutes ? options.stepMinutes * 60_000 : 30 * 60_000
  const cycles = options.cycles ?? 24
  for (let cycle = 1; cycle <= cycles; cycle++) {
    const result = await runTick({
      accountId: options.accountId,
      repo,
      linkedin,
      classifier: {
        // A fixed script rather than the real classifier: costs nothing, runs
        // instantly, and answers the same way twice — which is what you want
        // from something showing how the parts fit rather than how good the
        // model is.
        classify: async (input) => {
          const text = input.latest.toLowerCase()
          if (text.includes('podrias ayudar') || text.includes('contame')) {
            return {
              intent: 'invites_pitch' as const,
              confidence: 0.9,
              signals: {},
              rationale: 'Pide que le cuentes la propuesta.',
            }
          }
          return {
            intent: 'confirms' as const,
            confidence: 0.88,
            signals: { company: 'empresa de desarrollo' },
            rationale: 'Confirma que tiene empresa de tecnología.',
          }
        },
      },
      writer: {
        inviteNote: async (input) =>
          `Buenas ${input.firstName}! Vi que comentaste "${input.matchedKeyword}" en mi publicación. Te paso lo que pediste por acá.`,
      },
      workingHours: DEFAULT_WORKING_HOURS,
      // Assisted, so some replies send themselves and some wait — which is the
      // distinction the panel exists to show.
      mode: 'assisted',
      now: () => clock,
      leaseHolder: 'demo',
    })

    if (result.enrolled || result.executed || result.accepted || result.proposed) {
      log(
        `ciclo ${cycle}: ${result.enrolled} nuevos · ${result.executed} acciones · ` +
          `${result.accepted} aceptaron · ${result.proposed} respuestas propuestas`,
      )
    }

    clock = new Date(clock.getTime() + stepMs)
  }

  return { actions, cycles }
}

/** Creates the demo automation and the post it watches. Idempotent. */
export async function seedDemo(db: AnyPgDatabase, accountId: string): Promise<void> {
  await db
    .insert(posts)
    .values({
      accountId,
      urn: DEMO_POST,
      url: DEMO_POST,
      excerpt: 'Publicación de demostración.',
    })
    .onConflictDoNothing({ target: [posts.accountId, posts.urn] })

  const [post] = await db
    .select({ id: posts.id })
    .from(posts)
    .where(and(eq(posts.accountId, accountId), eq(posts.urn, DEMO_POST)))
    .limit(1)

  const [existing] = await db
    .select({ id: automations.id })
    .from(automations)
    .where(and(eq(automations.accountId, accountId), eq(automations.name, DEMO_AUTOMATION)))
    .limit(1)

  if (existing) return

  await db.insert(automations).values({
    accountId,
    name: DEMO_AUTOMATION,
    status: 'active',
    mode: 'assisted',
    keywords: ['demo'],
    postIds: post ? [post.id] : [],
    flow: {
      nodes: [
        { id: 'book', type: 'book', config: { calendarUrl: 'https://enbiconsulting.com/agenda' } },
      ],
      edges: [],
    },
  })
}

/**
 * Removes the demo.
 *
 * Deleting the automation is enough — enrollments, jobs and messages hang off
 * it by cascading keys. Contacts are left alone: a contact is a person, and a
 * stale row there is harmless while a deleted one loses the history that keeps
 * them from being contacted twice.
 */
export async function clearDemo(db: AnyPgDatabase, accountId: string): Promise<number> {
  const removed = await db
    .delete(automations)
    .where(and(eq(automations.accountId, accountId), eq(automations.name, DEMO_AUTOMATION)))
    .returning({ id: automations.id })

  await db.delete(posts).where(and(eq(posts.accountId, accountId), eq(posts.urn, DEMO_POST)))
  return removed.length
}
