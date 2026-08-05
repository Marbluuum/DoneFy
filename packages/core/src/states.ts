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
  /**
   * They wrote back. The outbound sequence stops here and the conversation
   * playbook takes over — see `playbook.ts`. Not terminal: this is where the
   * qualifying actually happens.
   */
  'replied',

  // --- terminal ---
  /** Ran the full sequence without a reply. */
  'closed',
  /** Playbook finished: meeting booked. */
  'booked',
  /** Playbook finished: not the target profile, or no pain to solve. */
  'disqualified',
  /** Went off-script. A human owns the conversation now. */
  'handed_off',
  /** Invite went unanswered long enough that we withdrew it to free the cap. */
  'invite_expired',
  /** Contact opted out, or was excluded from the panel. */
  'opted_out',
  /** Repeated failures. Surfaced in the panel for manual review. */
  'failed',
] as const

export type EnrollmentState = (typeof ENROLLMENT_STATES)[number]

export const TERMINAL_STATES: ReadonlySet<EnrollmentState> = new Set([
  'closed',
  'booked',
  'disqualified',
  'handed_off',
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
  /** Read new inbound messages on a live conversation. */
  'poll_conversation',
  /** Send a playbook reply the agent chose, or the owner picked from the panel. */
  'send_reply',
] as const

export type JobType = (typeof JOB_TYPES)[number]
