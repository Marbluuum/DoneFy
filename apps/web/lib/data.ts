import { and, desc, eq, gte, inArray, sql } from 'drizzle-orm'

import {
  assessHealth,
  DEFAULT_QUOTA,
  TERMINAL_STATES,
  type ConversationStage,
  type EnrollmentState,
  type HealthState,
  type LeadIntent,
} from '@linkfy/core'
import {
  automations,
  contacts,
  createDb,
  enrollments,
  linkedinAccounts,
  messages,
  posts,
  quotaUsage,
} from '@linkfy/db'

import {
  FUNNEL as FIXTURE_FUNNEL,
  HEALTH as FIXTURE_HEALTH,
  LEADS as FIXTURE_LEADS,
  POSTS as FIXTURE_POSTS,
  type FixtureLead,
  type FixtureMessage,
  type FixturePost,
} from './fixtures'

/**
 * What the panel shows.
 *
 * Falls back to the fixtures when there is no database configured, on purpose:
 * the panel is also the design surface, and a layout that can only be looked at
 * with a live account and real leads in it is a layout nobody iterates on. The
 * `live` flag says which one you are looking at, so demo data is never mistaken
 * for the real funnel.
 */

export type PanelHealth = Omit<typeof FIXTURE_HEALTH, 'state'> & { state: HealthState }

export type PanelAutomation = {
  id: string
  name: string
  status: string
  keywords: string[]
  postUrls: string[]
  calendarUrl: string
  /** People this automation has pulled in, and how many booked. */
  enrolled: number
  booked: number
}

export type PanelData = {
  live: boolean
  automations: PanelAutomation[]
  leads: FixtureLead[]
  posts: FixturePost[]
  funnel: typeof FIXTURE_FUNNEL
  health: PanelHealth
}

const DAY_MS = 86_400_000

export async function getPanelData(): Promise<PanelData> {
  const url = process.env.DATABASE_URL
  const accountId = process.env.LINKFY_ACCOUNT_ID ?? process.env.DONEFY_ACCOUNT_ID

  if (!url || !accountId) {
    return {
      live: false,
      automations: [],
      leads: FIXTURE_LEADS,
      posts: FIXTURE_POSTS,
      funnel: FIXTURE_FUNNEL,
      health: FIXTURE_HEALTH,
    }
  }

  const db = createDb(url)

  const [account] = await db
    .select({ id: linkedinAccounts.id })
    .from(linkedinAccounts)
    .where(eq(linkedinAccounts.id, accountId))
    .limit(1)

  if (!account) {
    return {
      live: false,
      automations: [],
      leads: FIXTURE_LEADS,
      posts: FIXTURE_POSTS,
      funnel: FIXTURE_FUNNEL,
      health: FIXTURE_HEALTH,
    }
  }

  const rows = await db
    .select({
      id: enrollments.id,
      contactId: contacts.id,
      name: contacts.fullName,
      headline: contacts.headline,
      company: contacts.company,
      degree: contacts.degree,
      publicIdentifier: contacts.publicIdentifier,
      state: enrollments.state,
      stage: enrollments.stage,
      lastIntent: enrollments.lastIntent,
      lastConfidence: enrollments.lastConfidence,
      suggestions: enrollments.suggestions,
      agentNotes: enrollments.agentNotes,
      autoReply: enrollments.autoReply,
      automationId: enrollments.automationId,
      keyword: enrollments.matchedKeyword,
      comment: enrollments.commentText,
      postUrl: posts.url,
      postExcerpt: posts.excerpt,
      enteredStateAt: enrollments.enteredStateAt,
    })
    .from(enrollments)
    .innerJoin(contacts, eq(enrollments.contactId, contacts.id))
    .innerJoin(automations, eq(enrollments.automationId, automations.id))
    .leftJoin(posts, eq(enrollments.postId, posts.id))
    .where(eq(automations.accountId, account.id))
    .orderBy(desc(enrollments.enteredStateAt))
    .limit(200)

  const threads =
    rows.length > 0
      ? await db
          .select({
            enrollmentId: messages.enrollmentId,
            channel: messages.channel,
            direction: messages.direction,
            body: messages.body,
            generated: messages.generated,
            sentAt: messages.sentAt,
          })
          .from(messages)
          .where(inArray(messages.enrollmentId, rows.map((r) => r.id)))
          .orderBy(messages.sentAt)
      : []

  const byEnrollment = new Map<string, FixtureMessage[]>()
  for (const message of threads) {
    if (!message.enrollmentId) continue
    const list = byEnrollment.get(message.enrollmentId) ?? []
    list.push({
      from: message.direction === 'outbound' ? 'owner' : 'lead',
      body: message.body,
      at: relativeTime(message.sentAt),
      channel: message.channel as FixtureMessage['channel'],
      generated: message.generated === 1,
    })
    byEnrollment.set(message.enrollmentId, list)
  }

  const leads: FixtureLead[] = rows.map((row) => ({
    id: row.id,
    name: row.name ?? row.publicIdentifier,
    headline: row.headline ?? '',
    company: row.company ?? undefined,
    degree: (row.degree ?? 3) as 1 | 2 | 3,
    avatarInitials: initialsOf(row.name ?? row.publicIdentifier),
    state: row.state as EnrollmentState,
    stage: (row.stage as ConversationStage | null) ?? null,
    keyword: row.keyword ?? '',
    postExcerpt: row.postExcerpt ?? row.postUrl ?? '',
    comment: row.comment ?? '',
    messages: byEnrollment.get(row.id) ?? [],
    // Unread means the lead spoke last and nobody has answered — the only
    // definition that matches what the badge is used for.
    unread: (byEnrollment.get(row.id) ?? []).at(-1)?.from === 'lead',
    lastActivity: relativeTime(row.enteredStateAt),
    // Only present once the agent has actually read a reply. Absent is what
    // the panel renders as "todavía no respondió", which is the truth before
    // there is anything to read.
    analysis: row.lastIntent
      ? {
          intent: row.lastIntent as LeadIntent,
          confidence: (row.lastConfidence ?? 0) / 100,
          rationale: (row.agentNotes ?? [])[0] ?? '',
          autonomy: (row.suggestions ?? []).length > 0 ? ('suggest' as const) : ('handoff' as const),
          notes: row.agentNotes ?? [],
          signals: {},
        }
      : undefined,
    autoReply: row.autoReply === 1,
    quickReplies: (row.suggestions ?? []).map((s) => ({
      label: s.label,
      body: s.body,
      advances: s.advances,
    })),
  }))

  const watched = await db
    .select({
      id: posts.id,
      url: posts.url,
      excerpt: posts.excerpt,
      createdAt: posts.createdAt,
    })
    .from(posts)
    .where(eq(posts.accountId, account.id))
    .orderBy(desc(posts.createdAt))
    .limit(20)

  const matchedByPost = new Map<string, number>()
  for (const lead of rows) {
    if (!lead.postUrl) continue
    matchedByPost.set(lead.postUrl, (matchedByPost.get(lead.postUrl) ?? 0) + 1)
  }

  const panelPosts: FixturePost[] = watched.map((post) => ({
    id: post.id,
    excerpt: post.excerpt ?? post.url,
    postedAt: relativeTime(post.createdAt),
    reactions: 0,
    comments: 0,
    matched: matchedByPost.get(post.url) ?? 0,
  }))

  const states = rows.map((r) => r.state as EnrollmentState)
  const reached = (...of: EnrollmentState[]) => states.filter((s) => of.includes(s)).length

  const health = assessHealth({
    invitesResolved: 0,
    invitesAccepted: 0,
    invitesPending: reached('invite_sent'),
    actionFailures: reached('failed'),
    actionsAttempted: states.length,
  })

  const week = Array.from({ length: 7 }, (_, i) =>
    new Date(Date.now() - i * DAY_MS).toISOString().slice(0, 10),
  )
  const [invitesThisWeek] = await db
    .select({ total: sql<number>`coalesce(sum(${quotaUsage.count}), 0)` })
    .from(quotaUsage)
    .where(
      and(
        eq(quotaUsage.accountId, account.id),
        eq(quotaUsage.action, 'invite'),
        inArray(quotaUsage.day, week),
      ),
    )

  const accepted = reached(
    'connected',
    'dm_sent',
    'followup_1_sent',
    'followup_2_sent',
    'replied',
    'booked',
  )

  const automationRows = await db
    .select({
      id: automations.id,
      name: automations.name,
      status: automations.status,
      keywords: automations.keywords,
      postIds: automations.postIds,
      flow: automations.flow,
    })
    .from(automations)
    .where(eq(automations.accountId, account.id))
    .orderBy(desc(automations.createdAt))

  const postUrlById = new Map(watched.map((p) => [p.id, p.url]))

  const panelAutomations: PanelAutomation[] = automationRows.map((row) => {
    const mine = rows.filter((r) => r.automationId === row.id)
    return {
      id: row.id,
      name: row.name,
      status: row.status,
      keywords: row.keywords ?? [],
      // An empty list means every post on the account, which the page says in
      // words rather than showing as zero — zero reads as broken.
      postUrls: (row.postIds ?? []).map((id) => postUrlById.get(id) ?? '').filter(Boolean),
      calendarUrl: calendarUrlOf(row.flow),
      enrolled: mine.length,
      booked: mine.filter((r) => r.state === 'booked').length,
    }
  })

  return {
    live: true,
    automations: panelAutomations,
    leads,
    posts: panelPosts,
    funnel: {
      comments: states.length,
      replied: states.filter((s) => s !== 'detected').length,
      invitesSent: reached('invite_sent') + accepted,
      invitesAccepted: accepted,
      dmsSent: reached('dm_sent', 'followup_1_sent', 'followup_2_sent', 'replied', 'booked'),
      conversations: reached('replied'),
      booked: reached('booked'),
    },
    health: {
      state: health.state,
      acceptanceRate: health.acceptanceRate ?? 0,
      invitesThisWeek: Number(invitesThisWeek?.total ?? 0),
      invitesCap: DEFAULT_QUOTA.invitesPerRollingWeek,
      pending: reached('invite_sent'),
      failureRate: health.failureRate,
    },
  }
}

/** Counts what still needs the owner, which is the number the header shows. */
export function needsYou(leads: FixtureLead[]): number {
  return leads.filter((lead) => lead.state === 'handed_off' || lead.state === 'replied').length
}

export function isTerminalState(state: string): boolean {
  return TERMINAL_STATES.has(state as EnrollmentState)
}

function calendarUrlOf(flow: unknown): string {
  const nodes = (flow as { nodes?: Array<{ config?: Record<string, unknown> }> } | null)?.nodes ?? []
  for (const node of nodes) {
    const url = node.config?.calendarUrl
    if (typeof url === 'string' && url) return url
  }
  return ''
}

function initialsOf(name: string): string {
  return name
    .split(/\s+/)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase() ?? '')
    .join('')
}

/** Dates read better as "hace 2 días" here than as a timestamp nobody parses. */
function relativeTime(date: Date | null): string {
  if (!date) return ''
  const minutes = Math.round((Date.now() - date.getTime()) / 60_000)
  if (minutes < 1) return 'recién'
  if (minutes < 60) return `hace ${minutes} min`
  const hours = Math.round(minutes / 60)
  if (hours < 24) return `hace ${hours} h`
  const days = Math.round(hours / 24)
  if (days < 7) return `hace ${days} ${days === 1 ? 'día' : 'días'}`
  const weeks = Math.round(days / 7)
  return `hace ${weeks} ${weeks === 1 ? 'semana' : 'semanas'}`
}
