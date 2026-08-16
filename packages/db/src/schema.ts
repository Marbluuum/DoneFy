import {
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core'

/**
 * One row per Linkfy user. Single-tenant today (just you), but every table
 * below carries `userId` so going multi-tenant is a matter of scoping queries
 * rather than reshaping the schema.
 */
export const users = pgTable('users', {
  id: uuid('id').primaryKey().defaultRandom(),
  email: text('email').notNull().unique(),
  name: text('name'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
})

/**
 * A LinkedIn identity the agent acts as.
 *
 * Deliberately stores no cookies or credentials. The session lives only in the
 * Chrome profile on the machine running the agent — that is the whole point of
 * the local-agent design, and the main thing that separates Linkfy from the
 * cookies-to-the-cloud tools.
 */
export const linkedinAccounts = pgTable('linkedin_accounts', {
  id: uuid('id').primaryKey().defaultRandom(),
  userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),

  publicIdentifier: text('public_identifier').notNull(), // e.g. "martin-bufczyk"
  displayName: text('display_name'),
  isPremium: integer('is_premium').notNull().default(0),

  /** Set by the agent on every successful tick, so the panel can show liveness. */
  agentLastSeenAt: timestamp('agent_last_seen_at', { withTimezone: true }),

  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  uniqueIndex('linkedin_accounts_user_identifier_idx').on(t.userId, t.publicIdentifier),
])

/**
 * A post being watched for keyword comments.
 */
export const posts = pgTable('posts', {
  id: uuid('id').primaryKey().defaultRandom(),
  accountId: uuid('account_id').notNull().references(() => linkedinAccounts.id, { onDelete: 'cascade' }),

  urn: text('urn').notNull(), // LinkedIn activity URN
  url: text('url').notNull(),
  excerpt: text('excerpt'),

  postedAt: timestamp('posted_at', { withTimezone: true }),
  lastScannedAt: timestamp('last_scanned_at', { withTimezone: true }),

  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  uniqueIndex('posts_account_urn_idx').on(t.accountId, t.urn),
])

/**
 * An automation: the keyword trigger plus the flow that runs when it fires.
 *
 * `flow` holds the node graph the builder edits. Keeping it as JSON means the
 * visual builder (phase 3) can ship without a schema migration.
 */
export const automations = pgTable('automations', {
  id: uuid('id').primaryKey().defaultRandom(),
  accountId: uuid('account_id').notNull().references(() => linkedinAccounts.id, { onDelete: 'cascade' }),

  name: text('name').notNull(),
  status: text('status').notNull().default('paused'), // paused | active | archived

  /** Keywords that fire this automation, lowercased. Empty = any comment. */
  keywords: jsonb('keywords').$type<string[]>().notNull().default([]),

  /** Restrict to specific posts. Empty = every post on the account. */
  postIds: jsonb('post_ids').$type<string[]>().notNull().default([]),

  flow: jsonb('flow').$type<FlowDefinition>().notNull(),

  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
})

/**
 * A person who interacted with one of your posts.
 *
 * Only people who commented ever land here — we never crawl or store profiles
 * that did not reach out first. That restraint is what keeps Linkfy clear of
 * the scraping case law, so it is a hard rule, not a default.
 */
export const contacts = pgTable('contacts', {
  id: uuid('id').primaryKey().defaultRandom(),
  accountId: uuid('account_id').notNull().references(() => linkedinAccounts.id, { onDelete: 'cascade' }),

  publicIdentifier: text('public_identifier').notNull(),
  fullName: text('full_name'),
  headline: text('headline'),
  company: text('company'),

  /** 1 | 2 | 3 — drives the invite-vs-direct-DM branch. Null until observed. */
  degree: integer('degree'),

  tags: jsonb('tags').$type<string[]>().notNull().default([]),

  /** Honoured before every send. Set from the panel or by an opt-out reply. */
  optedOutAt: timestamp('opted_out_at', { withTimezone: true }),

  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  uniqueIndex('contacts_account_identifier_idx').on(t.accountId, t.publicIdentifier),
])

/**
 * One contact moving through one automation. This row *is* the state machine —
 * `state` plus `nextActionAt` is everything the scheduler needs.
 */
export const enrollments = pgTable('enrollments', {
  id: uuid('id').primaryKey().defaultRandom(),
  automationId: uuid('automation_id').notNull().references(() => automations.id, { onDelete: 'cascade' }),
  contactId: uuid('contact_id').notNull().references(() => contacts.id, { onDelete: 'cascade' }),
  postId: uuid('post_id').references(() => posts.id, { onDelete: 'set null' }),

  state: text('state').notNull().default('detected'),

  /**
   * Where the conversation is, once there is one. Null until they reply.
   *
   * Separate from `state` on purpose: `state` tracks the outbound sequence and
   * stops at "they answered", while this tracks the qualifying that happens
   * afterwards. Collapsing them would mean a lead who replies twice looks like
   * a lead who moved backwards.
   */
  stage: text('stage'),

  /**
   * When the agent last looked at whether this invitation was accepted.
   *
   * Acceptance arrives as no event at all — LinkedIn just makes you a 1st
   * degree connection — so it has to be polled, and polling every pending
   * invite on every cycle is a page visit per lead per 90 seconds.
   */
  acceptanceCheckedAt: timestamp('acceptance_checked_at', { withTimezone: true }),

  /** LinkedIn's thread id, so replies are read from the right conversation. */
  threadId: text('thread_id'),

  /**
   * Per-conversation autopilot, set from the inbox.
   *
   * The global mode is a ceiling; this only ever loosens one thread, and only
   * where the playbook already allows unattended sending.
   */
  autoReply: integer('auto_reply').notNull().default(0),

  /** The agent's last read of the lead, for the panel's right-hand column. */
  lastIntent: text('last_intent'),
  /** 0-100. Stored as an integer to keep the column free of float surprises. */
  lastConfidence: integer('last_confidence'),

  /** What the panel offers as one-click replies. Empty when there is nothing to propose. */
  suggestions: jsonb('suggestions').$type<SuggestedReply[]>().notNull().default([]),

  /** Why the agent decided what it decided, in the owner's language. */
  agentNotes: jsonb('agent_notes').$type<string[]>().notNull().default([]),

  /**
   * When the agent last read this conversation.
   *
   * Without it every waiting conversation is re-classified on every cycle —
   * one model call per lead per 90 seconds, forever, to reach the same
   * conclusion about the same unanswered message.
   */
  conversationReadAt: timestamp('conversation_read_at', { withTimezone: true }),

  /** The comment that triggered this. Kept for personalizing the invite note. */
  commentUrn: text('comment_urn'),
  commentText: text('comment_text'),
  matchedKeyword: text('matched_keyword'),

  /** When the scheduler should next look at this row. Null = waiting on an event. */
  nextActionAt: timestamp('next_action_at', { withTimezone: true }),

  /**
   * Set when an invitation actually goes out.
   *
   * Without it the acceptance rate cannot be measured honestly: 1st-degree
   * contacts are messaged without ever being invited, and counting them as
   * accepted would inflate the very number the circuit breaker trips on.
   */
  invitedAt: timestamp('invited_at', { withTimezone: true }),

  enteredStateAt: timestamp('entered_state_at', { withTimezone: true }).notNull().defaultNow(),
  lastError: text('last_error'),
  attempts: integer('attempts').notNull().default(0),

  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  // One enrollment per contact per automation — the guard against double-sends.
  uniqueIndex('enrollments_automation_contact_idx').on(t.automationId, t.contactId),
  index('enrollments_due_idx').on(t.state, t.nextActionAt),
])

/**
 * Work queued for the agent. The agent polls this table; nothing pushes to it,
 * so the agent needs no inbound network exposure.
 */
export const jobs = pgTable('jobs', {
  id: uuid('id').primaryKey().defaultRandom(),
  accountId: uuid('account_id').notNull().references(() => linkedinAccounts.id, { onDelete: 'cascade' }),
  enrollmentId: uuid('enrollment_id').references(() => enrollments.id, { onDelete: 'cascade' }),

  type: text('type').notNull(),
  payload: jsonb('payload').$type<Record<string, unknown>>().notNull().default({}),

  status: text('status').notNull().default('pending'), // pending | leased | done | failed
  runAfter: timestamp('run_after', { withTimezone: true }).notNull().defaultNow(),

  /** Set while an agent holds the job, so two agents cannot run it at once. */
  leasedUntil: timestamp('leased_until', { withTimezone: true }),
  leasedBy: text('leased_by'),

  attempts: integer('attempts').notNull().default(0),
  lastError: text('last_error'),

  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  completedAt: timestamp('completed_at', { withTimezone: true }),
}, (t) => [
  index('jobs_claim_idx').on(t.accountId, t.status, t.runAfter),
])

/**
 * Everything sent or received, for the inbox and for proving what went out.
 */
export const messages = pgTable('messages', {
  id: uuid('id').primaryKey().defaultRandom(),
  contactId: uuid('contact_id').notNull().references(() => contacts.id, { onDelete: 'cascade' }),
  enrollmentId: uuid('enrollment_id').references(() => enrollments.id, { onDelete: 'set null' }),

  channel: text('channel').notNull(), // comment_reply | invite_note | dm
  direction: text('direction').notNull(), // outbound | inbound
  body: text('body').notNull(),

  /** True when an LLM wrote it, so the panel can flag it for review. */
  generated: integer('generated').notNull().default(0),

  sentAt: timestamp('sent_at', { withTimezone: true }).notNull().defaultNow(),
})

/**
 * Rolling counters the scheduler checks before queueing anything.
 *
 * LinkedIn's invite cap is a rolling 7-day window, not a calendar week, so we
 * count per-day and sum the trailing 7 rather than resetting on Mondays.
 */
export const quotaUsage = pgTable('quota_usage', {
  id: uuid('id').primaryKey().defaultRandom(),
  accountId: uuid('account_id').notNull().references(() => linkedinAccounts.id, { onDelete: 'cascade' }),

  day: text('day').notNull(), // YYYY-MM-DD in the account's timezone
  action: text('action').notNull(), // invite | dm | comment_reply
  count: integer('count').notNull().default(0),
}, (t) => [
  uniqueIndex('quota_usage_account_day_action_idx').on(t.accountId, t.day, t.action),
])

/** Append-only audit trail. Never updated, only inserted. */
export const events = pgTable('events', {
  id: uuid('id').primaryKey().defaultRandom(),
  accountId: uuid('account_id').notNull().references(() => linkedinAccounts.id, { onDelete: 'cascade' }),
  enrollmentId: uuid('enrollment_id').references(() => enrollments.id, { onDelete: 'set null' }),

  type: text('type').notNull(),
  data: jsonb('data').$type<Record<string, unknown>>().notNull().default({}),

  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  index('events_account_created_idx').on(t.accountId, t.createdAt),
])

/** Mirrors QuickReply in @linkfy/core; see the note below on why it is copied. */
type SuggestedReply = {
  label: string
  body: string
  advances: boolean
  /**
   * Where sending this one leaves the conversation. Stored per option so the
   * panel never has to compute it — the playbook already decided, and a second
   * implementation in the UI is a second thing to get wrong.
   */
  nextStage: string
}

// The flow graph shape lives in @linkfy/core; re-declared structurally here to
// keep @linkfy/db free of a dependency on it.
type FlowDefinition = {
  nodes: Array<{ id: string; type: string; config: Record<string, unknown> }>
  edges: Array<{ from: string; to: string; when?: string }>
}
