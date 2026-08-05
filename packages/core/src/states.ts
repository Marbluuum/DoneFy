/**
 * The enrollment state machine.
 *
 * Every person who comments a keyword walks this graph exactly once. Terminal
 * states are the only places a person can come to rest.
 */
export const ENROLLMENT_STATES = [
  /** Comment matched a keyword. Nothing sent yet. */
  'detected',
  /** Public reply posted under their comment. */
  'comment_replied',
  /** Needs an invite but the weekly cap is spent — parked in the priority queue. */
  'invite_queued',
  /** Invite sent with a personalized note. Waiting on them to accept. */
  'invite_sent',
  /** 1st-degree, either because they accepted or because they already were. */
  'connected',
  /** Opening DM delivered. */
  'dm_sent',
  'followup_1_sent',
  'followup_2_sent',

  // --- terminal ---
  /** They wrote back. The automation stops and a human takes over. */
  'replied',
  /** Ran the full sequence without a reply. */
  'closed',
  /** Invite went unanswered long enough that we withdrew it to free the cap. */
  'invite_expired',
  /** Contact opted out, or was excluded from the panel. */
  'opted_out',
  /** Repeated failures. Surfaced in the panel for manual review. */
  'failed',
] as const

export type EnrollmentState = (typeof ENROLLMENT_STATES)[number]

export const TERMINAL_STATES: ReadonlySet<EnrollmentState> = new Set([
  'replied',
  'closed',
  'invite_expired',
  'opted_out',
  'failed',
])

export function isTerminal(state: EnrollmentState): boolean {
  return TERMINAL_STATES.has(state)
}

/** Actions the agent knows how to perform against LinkedIn. */
export const JOB_TYPES = [
  'scan_comments',
  'reply_comment',
  'send_invite',
  'check_connection',
  'withdraw_invite',
  'send_dm',
] as const

export type JobType = (typeof JOB_TYPES)[number]
