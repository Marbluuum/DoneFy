import {
  and,
  asc,
  count,
  eq,
  gte,
  inArray,
  isNotNull,
  lte,
  max,
  notInArray,
  sql,
} from 'drizzle-orm'
import type { PgDatabase } from 'drizzle-orm/pg-core'

import {
  automations,
  contacts,
  enrollments,
  events,
  jobs,
  linkedinAccounts,
  messages,
  posts,
  quotaUsage,
} from '@linkfy/db'
import {
  TERMINAL_STATES,
  type ConversationStage,
  type ConversationTurn,
  type EnrollmentState,
  type HealthWindow,
  type JobType,
  type QuickReply,
  type UsageSnapshot,
} from '@linkfy/core'

import type {
  ActiveAutomation,
  ContactSnapshot,
  PendingEnrollment,
  QueuedJob,
  Repository,
} from './ports.js'

/**
 * The Repository backed by Postgres.
 *
 * Everything the tick treats as a single step is a single statement here.
 * Claiming a job, counting a quota and enrolling a contact are all points where
 * two agents — or one agent and a retry of itself — can collide, and doing them
 * as read-then-write would produce exactly the failure this product cannot
 * afford: the same person messaged twice.
 */

/** Any drizzle Postgres handle, so tests can run this against an in-process database. */
type AnyPgDatabase = PgDatabase<any, any, any>

const TERMINAL = [...TERMINAL_STATES]

/**
 * States only reachable by an invitation having been accepted. Used for the
 * acceptance rate, so it must not include anything reachable another way.
 */
const POST_ACCEPTANCE_STATES: EnrollmentState[] = [
  'connected',
  'dm_sent',
  'followup_1_sent',
  'followup_2_sent',
  'replied',
  'booked',
  'disqualified',
  'handed_off',
  'closed',
]

/** How long a claimed job stays claimed before another agent may take it. */
const LEASE_MINUTES = 5

/** Failures worth another attempt, before the job is given up on. */
const MAX_JOB_ATTEMPTS = 3

/** How far back the health breaker looks. */
const HEALTH_WINDOW_DAYS = 30

const DAY_MS = 86_400_000

export type RepositoryOptions = {
  /**
   * Quotas are per local day, so the boundary has to be the account owner's
   * midnight. Counting in UTC would roll the day over mid-evening in Buenos
   * Aires and hand back a fresh invite allowance at the worst possible moment.
   */
  timezone: string
  /**
   * The clock, shared with the tick.
   *
   * Reading `new Date()` here instead would let the repository disagree with
   * the caller about what time it is — which sounds harmless until a row
   * written as "due now" lands in the future relative to the scheduler that
   * has to pick it up, and the flow never starts.
   */
  now?: () => Date
}

export function dayKey(date: Date, timeZone: string): string {
  // en-CA formats as YYYY-MM-DD, which sorts correctly as text.
  return new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(date)
}

function firstNameOf(fullName: string | null): string {
  return (fullName ?? '').trim().split(/\s+/)[0] ?? ''
}

/** postgres-js returns rows directly; pglite wraps them. Both are in use here. */
function rowsOf<T>(result: unknown): T[] {
  if (Array.isArray(result)) return result as T[]
  return ((result as { rows?: T[] }).rows ?? []) as T[]
}

export class DrizzleRepository implements Repository {
  private readonly now: () => Date

  constructor(
    private readonly db: AnyPgDatabase,
    private readonly options: RepositoryOptions,
  ) {
    this.now = options.now ?? (() => new Date())
  }

  async activeAutomations(accountId: string): Promise<ActiveAutomation[]> {
    const rows = await this.db
      .select({
        id: automations.id,
        keywords: automations.keywords,
        postIds: automations.postIds,
        flow: automations.flow,
      })
      .from(automations)
      .where(and(eq(automations.accountId, accountId), eq(automations.status, 'active')))

    const result: ActiveAutomation[] = []
    for (const row of rows) {
      const postIds = row.postIds ?? []
      // An empty postIds means every post on the account — the common case, so
      // that a new post is picked up without editing the automation.
      const watched = await this.db
        .select({ url: posts.url })
        .from(posts)
        .where(
          postIds.length > 0
            ? and(eq(posts.accountId, accountId), inArray(posts.id, postIds))
            : eq(posts.accountId, accountId),
        )

      result.push({
        id: row.id,
        accountId,
        keywords: row.keywords ?? [],
        postUrls: watched.map((p) => p.url),
        calendarUrl: calendarUrlFromFlow(row.flow),
      })
    }
    return result
  }

  async contactByIdentifier(
    accountId: string,
    publicIdentifier: string,
  ): Promise<ContactSnapshot | null> {
    const [contact] = await this.db
      .select({
        id: contacts.id,
        publicIdentifier: contacts.publicIdentifier,
        optedOutAt: contacts.optedOutAt,
      })
      .from(contacts)
      .where(
        and(eq(contacts.accountId, accountId), eq(contacts.publicIdentifier, publicIdentifier)),
      )
      .limit(1)

    if (!contact) return null

    const enrolled = await this.db
      .select({ state: enrollments.state, invitedAt: enrollments.invitedAt })
      .from(enrollments)
      .where(eq(enrollments.contactId, contact.id))

    const [contacted] = await this.db
      .select({ last: max(messages.sentAt), channels: sql<string>`string_agg(distinct ${messages.channel}, ',')` })
      .from(messages)
      .where(and(eq(messages.contactId, contact.id), eq(messages.direction, 'outbound')))

    const channels = (contacted?.channels ?? '').split(',')

    return {
      id: contact.id,
      publicIdentifier: contact.publicIdentifier,
      hasActiveEnrollment: enrolled.some((e) => !TERMINAL.includes(e.state as EnrollmentState)),
      // An invite counts as sent even when it carried no note, so this reads the
      // enrollment rather than looking for an invite_note message.
      everInvited: enrolled.some((e) => e.invitedAt !== null),
      everMessaged: channels.includes('dm'),
      lastOutcome: lastOutcomeOf(enrolled.map((e) => e.state as EnrollmentState)),
      lastContactedAt: contacted?.last ?? null,
      optedOut: contact.optedOutAt !== null,
    }
  }

  async ownIdentifier(accountId: string): Promise<string> {
    const [account] = await this.db
      .select({ publicIdentifier: linkedinAccounts.publicIdentifier })
      .from(linkedinAccounts)
      .where(eq(linkedinAccounts.id, accountId))
      .limit(1)
    return account?.publicIdentifier ?? ''
  }

  async isCommentEnrolled(automationId: string, commentUrn: string): Promise<boolean> {
    const [row] = await this.db
      .select({ id: enrollments.id })
      .from(enrollments)
      .where(
        and(eq(enrollments.automationId, automationId), eq(enrollments.commentUrn, commentUrn)),
      )
      .limit(1)
    return row !== undefined
  }

  async createEnrollment(input: {
    accountId: string
    automationId: string
    publicIdentifier: string
    fullName: string
    headline?: string
    commentUrn: string
    commentText: string
    matchedKeyword: string
    postUrl: string
  }): Promise<string> {
    const [contact] = await this.db
      .insert(contacts)
      .values({
        accountId: input.accountId,
        publicIdentifier: input.publicIdentifier,
        fullName: input.fullName,
        headline: input.headline ?? null,
      })
      .onConflictDoUpdate({
        target: [contacts.accountId, contacts.publicIdentifier],
        set: { fullName: input.fullName, headline: input.headline ?? null, updatedAt: this.now() },
      })
      .returning({ id: contacts.id })

    const postId = await this.upsertPost(input.accountId, input.postUrl)

    const [created] = await this.db
      .insert(enrollments)
      .values({
        automationId: input.automationId,
        contactId: contact!.id,
        postId,
        state: 'detected',
        commentUrn: input.commentUrn,
        commentText: input.commentText,
        matchedKeyword: input.matchedKeyword,
        // Due immediately: the scheduler only looks at rows with a time on them,
        // and a fresh enrollment with nothing set would sit forever.
        nextActionAt: this.now(),
      })
      // One enrollment per contact per automation. Losing the race is the
      // correct outcome, not an error — the person is already in the flow.
      .onConflictDoNothing({ target: [enrollments.automationId, enrollments.contactId] })
      .returning({ id: enrollments.id })

    if (created) return created.id

    const [existing] = await this.db
      .select({ id: enrollments.id })
      .from(enrollments)
      .where(
        and(
          eq(enrollments.automationId, input.automationId),
          eq(enrollments.contactId, contact!.id),
        ),
      )
      .limit(1)
    return existing!.id
  }

  private async upsertPost(accountId: string, url: string): Promise<string | null> {
    if (!url) return null
    // The URL doubles as the URN when the activity URN was not captured: it is
    // stable per post and unique per account, which is all the index needs.
    await this.db
      .insert(posts)
      .values({ accountId, urn: url, url })
      .onConflictDoNothing({ target: [posts.accountId, posts.urn] })

    const [row] = await this.db
      .select({ id: posts.id })
      .from(posts)
      .where(and(eq(posts.accountId, accountId), eq(posts.urn, url)))
      .limit(1)
    return row?.id ?? null
  }

  async dueEnrollments(accountId: string, now: Date, limit: number): Promise<PendingEnrollment[]> {
    const rows = await this.selectEnrollments(
      and(
        eq(automations.accountId, accountId),
        notInArray(enrollments.state, TERMINAL),
        isNotNull(enrollments.nextActionAt),
        lte(enrollments.nextActionAt, now),
      ),
      limit,
    )
    return rows
  }

  async enrollmentById(id: string): Promise<PendingEnrollment | null> {
    const [row] = await this.selectEnrollments(eq(enrollments.id, id), 1)
    return row ?? null
  }

  async conversingEnrollments(accountId: string, limit: number): Promise<PendingEnrollment[]> {
    return this.selectEnrollments(
      and(eq(automations.accountId, accountId), eq(enrollments.state, 'replied')),
      limit,
    )
  }

  private async selectEnrollments(where: any, limit: number): Promise<PendingEnrollment[]> {
    const rows = await this.db
      .select({
        id: enrollments.id,
        accountId: automations.accountId,
        automationId: enrollments.automationId,
        contactId: enrollments.contactId,
        publicIdentifier: contacts.publicIdentifier,
        fullName: contacts.fullName,
        headline: contacts.headline,
        state: enrollments.state,
        enteredStateAt: enrollments.enteredStateAt,
        commentUrn: enrollments.commentUrn,
        commentText: enrollments.commentText,
        matchedKeyword: enrollments.matchedKeyword,
        postUrl: posts.url,
        degree: contacts.degree,
        optedOutAt: contacts.optedOutAt,
        attempts: enrollments.attempts,
        stage: enrollments.stage,
        threadId: enrollments.threadId,
        autoReply: enrollments.autoReply,
        conversationReadAt: enrollments.conversationReadAt,
      })
      .from(enrollments)
      .innerJoin(contacts, eq(enrollments.contactId, contacts.id))
      .innerJoin(automations, eq(enrollments.automationId, automations.id))
      .leftJoin(posts, eq(enrollments.postId, posts.id))
      .where(where)
      .orderBy(asc(enrollments.nextActionAt))
      .limit(limit)

    return rows.map((row) => ({
      id: row.id,
      accountId: row.accountId,
      automationId: row.automationId,
      contactId: row.contactId,
      publicIdentifier: row.publicIdentifier,
      firstName: firstNameOf(row.fullName),
      headline: row.headline,
      state: row.state as EnrollmentState,
      enteredStateAt: row.enteredStateAt,
      commentUrn: row.commentUrn,
      commentText: row.commentText,
      matchedKeyword: row.matchedKeyword,
      postUrl: row.postUrl,
      degree: row.degree,
      optedOut: row.optedOutAt !== null,
      attempts: row.attempts,
      stage: (row.stage as ConversationStage | null) ?? null,
      threadId: row.threadId,
      autoReply: row.autoReply === 1,
      conversationReadAt: row.conversationReadAt,
    }))
  }

  async enqueueJob(input: {
    accountId: string
    enrollmentId: string
    type: JobType
    payload: Record<string, unknown>
    runAfter: Date
  }): Promise<void> {
    await this.db.insert(jobs).values({
      accountId: input.accountId,
      enrollmentId: input.enrollmentId,
      type: input.type,
      payload: input.payload,
      status: 'pending',
      runAfter: input.runAfter,
    })
  }

  async claimJobs(
    accountId: string,
    now: Date,
    limit: number,
    leaseHolder: string,
  ): Promise<QueuedJob[]> {
    const leasedUntil = new Date(now.getTime() + LEASE_MINUTES * 60_000)

    // One statement, so two agents polling the same account cannot both come
    // away holding the same job. SKIP LOCKED lets the loser take other work
    // instead of blocking on rows it is never going to get.
    const result = await this.db.execute(sql`
      UPDATE ${jobs} SET
        status = 'leased',
        leased_until = ${leasedUntil},
        leased_by = ${leaseHolder},
        attempts = ${jobs.attempts} + 1
      WHERE ${jobs.id} IN (
        SELECT ${jobs.id} FROM ${jobs}
        WHERE ${jobs.accountId} = ${accountId}
          AND ${jobs.runAfter} <= ${now}
          AND (
            ${jobs.status} = 'pending'
            OR (${jobs.status} = 'leased' AND ${jobs.leasedUntil} < ${now})
          )
        ORDER BY ${jobs.runAfter} ASC
        LIMIT ${limit}
        FOR UPDATE SKIP LOCKED
      )
      RETURNING id, account_id, enrollment_id, type, payload, attempts
    `)

    return rowsOf<{
      id: string
      account_id: string
      enrollment_id: string | null
      type: string
      payload: Record<string, unknown>
      attempts: number
    }>(result).map((row) => ({
      id: row.id,
      accountId: row.account_id,
      enrollmentId: row.enrollment_id,
      type: row.type as JobType,
      payload: row.payload ?? {},
      attempts: row.attempts,
    }))
  }

  async completeJob(jobId: string): Promise<void> {
    await this.db
      .update(jobs)
      .set({ status: 'done', completedAt: this.now(), lastError: null })
      .where(eq(jobs.id, jobId))
  }

  async failJob(jobId: string, error: string, retryable: boolean): Promise<void> {
    const [job] = await this.db
      .select({ attempts: jobs.attempts, enrollmentId: jobs.enrollmentId })
      .from(jobs)
      .where(eq(jobs.id, jobId))
      .limit(1)
    if (!job) return

    const willRetry = retryable && job.attempts < MAX_JOB_ATTEMPTS
    if (willRetry) {
      // Backoff on the attempt count: a transient failure usually clears, and
      // retrying immediately mostly reproduces it.
      const delayMs = Math.min(30, 2 ** job.attempts) * 60_000
      await this.db
        .update(jobs)
        .set({
          status: 'pending',
          lastError: error,
          leasedBy: null,
          leasedUntil: null,
          runAfter: new Date(this.now().getTime() + delayMs),
        })
        .where(eq(jobs.id, jobId))
      return
    }

    await this.db
      .update(jobs)
      .set({ status: 'failed', lastError: error, leasedBy: null, leasedUntil: null })
      .where(eq(jobs.id, jobId))

    // The enrollment was parked when the job was queued. Left alone it would
    // sit there forever — invisible, and never retried or given up on. Handing
    // it back to the scheduler lets the engine retry it or, once attempts run
    // out, move it to `failed` where the panel shows it.
    if (job.enrollmentId) {
      await this.db
        .update(enrollments)
        .set({
          attempts: sql`${enrollments.attempts} + 1`,
          lastError: error,
          nextActionAt: this.now(),
        })
        .where(eq(enrollments.id, job.enrollmentId))
    }
  }

  async setEnrollmentState(
    enrollmentId: string,
    state: EnrollmentState,
    nextActionAt: Date | null,
  ): Promise<void> {
    await this.db
      .update(enrollments)
      .set({
        state,
        nextActionAt,
        // Only bumped on a real change. The engine measures "how long in this
        // state" to decide when to follow up or withdraw, so refreshing it on
        // every no-op write would silently postpone all of that forever.
        enteredStateAt: sql`CASE WHEN ${enrollments.state} = ${state}
                                 THEN ${enrollments.enteredStateAt} ELSE now() END`,
      })
      .where(eq(enrollments.id, enrollmentId))
  }

  async markInvited(enrollmentId: string, at: Date): Promise<void> {
    await this.db.update(enrollments).set({ invitedAt: at }).where(eq(enrollments.id, enrollmentId))
  }

  async setContactDegree(contactId: string, degree: number): Promise<void> {
    await this.db
      .update(contacts)
      .set({ degree, updatedAt: this.now() })
      .where(eq(contacts.id, contactId))
  }

  async recordMessage(input: {
    contactId: string
    enrollmentId: string
    channel: 'comment_reply' | 'invite_note' | 'dm'
    direction: 'outbound' | 'inbound'
    body: string
    generated: boolean
  }): Promise<void> {
    await this.db.insert(messages).values({
      contactId: input.contactId,
      enrollmentId: input.enrollmentId,
      channel: input.channel,
      direction: input.direction,
      body: input.body,
      generated: input.generated ? 1 : 0,
      // Stamped from the shared clock rather than the database's, so "has this
      // been read since it arrived" compares two times that mean the same thing.
      sentAt: this.now(),
    })
  }

  async usage(accountId: string, now: Date): Promise<UsageSnapshot> {
    const today = dayKey(now, this.options.timezone)
    const week = Array.from({ length: 7 }, (_, i) =>
      dayKey(new Date(now.getTime() - i * DAY_MS), this.options.timezone),
    )

    const rows = await this.db
      .select({ day: quotaUsage.day, action: quotaUsage.action, count: quotaUsage.count })
      .from(quotaUsage)
      .where(and(eq(quotaUsage.accountId, accountId), inArray(quotaUsage.day, week)))

    const snapshot: UsageSnapshot = {
      today: { invite: 0, dm: 0, comment_reply: 0 },
      invitesTrailingWeek: 0,
    }

    for (const row of rows) {
      if (row.action === 'invite') snapshot.invitesTrailingWeek += row.count
      if (row.day === today && row.action in snapshot.today) {
        snapshot.today[row.action as keyof UsageSnapshot['today']] = row.count
      }
    }
    return snapshot
  }

  async countAction(
    accountId: string,
    action: 'invite' | 'dm' | 'comment_reply',
    now: Date,
  ): Promise<void> {
    // Incremented in the database rather than read-modify-written here: two
    // concurrent sends would otherwise both read N and both write N+1, and the
    // quota that exists to protect the account would drift upward silently.
    await this.db
      .insert(quotaUsage)
      .values({ accountId, day: dayKey(now, this.options.timezone), action, count: 1 })
      .onConflictDoUpdate({
        target: [quotaUsage.accountId, quotaUsage.day, quotaUsage.action],
        set: { count: sql`${quotaUsage.count} + 1` },
      })
  }

  async healthWindow(accountId: string): Promise<HealthWindow> {
    const since = new Date(this.now().getTime() - HEALTH_WINDOW_DAYS * DAY_MS)

    const invited = and(
      eq(automations.accountId, accountId),
      isNotNull(enrollments.invitedAt),
      gte(enrollments.invitedAt, since),
    )

    const countInvites = async (extra: any) => {
      const [row] = await this.db
        .select({ n: count() })
        .from(enrollments)
        .innerJoin(automations, eq(enrollments.automationId, automations.id))
        .where(and(invited, extra))
      return row?.n ?? 0
    }

    const pending = await countInvites(eq(enrollments.state, 'invite_sent'))
    const accepted = await countInvites(inArray(enrollments.state, POST_ACCEPTANCE_STATES))
    const resolved = await countInvites(notInArray(enrollments.state, ['invite_sent']))

    // Failures come from the job log rather than a counter: a send that threw
    // is exactly a job that ended in `failed`, and keeping a separate tally
    // would be a second source of truth to keep in sync.
    const [attemptRow] = await this.db
      .select({
        attempted: count(),
        failed: sql<number>`count(*) filter (where ${jobs.status} = 'failed')`,
      })
      .from(jobs)
      .where(
        and(
          eq(jobs.accountId, accountId),
          gte(jobs.createdAt, since),
          inArray(jobs.status, ['done', 'failed']),
          inArray(jobs.type, ['send_invite', 'send_dm', 'reply_comment', 'send_reply']),
        ),
      )

    return {
      invitesResolved: resolved,
      invitesAccepted: accepted,
      invitesPending: pending,
      actionFailures: Number(attemptRow?.failed ?? 0),
      actionsAttempted: Number(attemptRow?.attempted ?? 0),
    }
  }

  async recordEvent(
    accountId: string,
    type: string,
    data: Record<string, unknown>,
  ): Promise<void> {
    await this.db.insert(events).values({ accountId, type, data })
  }

  async history(enrollmentId: string): Promise<ConversationTurn[]> {
    const rows = await this.db
      .select({ direction: messages.direction, body: messages.body, at: messages.sentAt })
      .from(messages)
      .where(eq(messages.enrollmentId, enrollmentId))
      .orderBy(asc(messages.sentAt))

    return rows.map((row) => ({
      from: row.direction === 'outbound' ? 'owner' : 'lead',
      body: row.body,
      at: row.at,
    }))
  }

  async openEnrollmentFor(
    accountId: string,
    publicIdentifier: string,
  ): Promise<PendingEnrollment | null> {
    const [row] = await this.selectEnrollments(
      and(
        eq(automations.accountId, accountId),
        eq(contacts.publicIdentifier, publicIdentifier),
        notInArray(enrollments.state, TERMINAL),
      ),
      1,
    )
    return row ?? null
  }

  async setStage(enrollmentId: string, stage: ConversationStage): Promise<void> {
    // The suggestions belonged to the stage just left, so they are cleared
    // rather than left on screen offering a question that was already asked.
    await this.db
      .update(enrollments)
      .set({ stage, suggestions: [] })
      .where(eq(enrollments.id, enrollmentId))
  }

  async saveConversationRead(input: {
    enrollmentId: string
    stage: ConversationStage
    intent: string
    confidence: number
    suggestions: QuickReply[]
    nextStage: ConversationStage
    notes: string[]
    threadId?: string | null
  }): Promise<void> {
    await this.db
      .update(enrollments)
      .set({
        stage: input.stage,
        lastIntent: input.intent,
        // Stored 0-100 so the column stays an integer; the panel divides again.
        lastConfidence: Math.round(input.confidence * 100),
        suggestions: input.suggestions.map((option) => ({
          ...option,
          // Only the option that advances moves the stage; the rest stay put.
          nextStage: option.advances ? input.nextStage : input.stage,
        })),
        agentNotes: input.notes,
        conversationReadAt: this.now(),
        ...(input.threadId ? { threadId: input.threadId } : {}),
      })
      .where(eq(enrollments.id, input.enrollmentId))
  }

  async touchAccount(accountId: string, at: Date): Promise<void> {
    await this.db
      .update(linkedinAccounts)
      .set({ agentLastSeenAt: at })
      .where(eq(linkedinAccounts.id, accountId))
  }
}

/** The most advanced outcome this contact has reached, for the dedup rules. */
function lastOutcomeOf(
  states: EnrollmentState[],
): 'booked' | 'disqualified' | 'handed_off' | 'closed' | 'opted_out' | null {
  const ranked = ['booked', 'handed_off', 'disqualified', 'opted_out', 'closed'] as const
  for (const outcome of ranked) {
    if (states.includes(outcome)) return outcome
  }
  return null
}

function calendarUrlFromFlow(flow: unknown): string {
  const nodes = (flow as { nodes?: Array<{ config?: Record<string, unknown> }> } | null)?.nodes ?? []
  for (const node of nodes) {
    const url = node.config?.calendarUrl
    if (typeof url === 'string' && url) return url
  }
  return ''
}
