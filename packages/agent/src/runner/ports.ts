import type {
  Classification,
  ConversationStage,
  ConversationTurn,
  EnrollmentState,
  HealthWindow,
  JobType,
  QuickReply,
  UsageSnapshot,
} from '@linkfy/core'

/**
 * What one tick of the runner needs from the outside world.
 *
 * Declared as interfaces rather than reaching for Drizzle directly so the tick
 * — which is where the ordering, the guards and the failure handling live — can
 * be tested against fakes. The alternative is a loop that can only be exercised
 * with a live database and a live LinkedIn session, which is exactly the code
 * that most needs testing and least tolerates being run for real.
 */

export type ActiveAutomation = {
  id: string
  accountId: string
  keywords: string[]
  postUrls: string[]
  calendarUrl: string
}

export type PendingEnrollment = {
  id: string
  accountId: string
  automationId: string
  contactId: string
  publicIdentifier: string
  firstName: string
  headline?: string | null
  state: EnrollmentState
  enteredStateAt: Date
  commentUrn: string | null
  commentText: string | null
  matchedKeyword: string | null
  postUrl: string | null
  degree: number | null
  optedOut: boolean
  attempts: number
  /** Null until they reply — the outbound sequence has no stage. */
  stage: ConversationStage | null
  threadId: string | null
  /** When the agent last classified this conversation. */
  conversationReadAt: Date | null
}

export type QueuedJob = {
  id: string
  accountId: string
  enrollmentId: string | null
  type: JobType
  payload: Record<string, unknown>
  attempts: number
}

export type ContactSnapshot = {
  id: string
  publicIdentifier: string
  hasActiveEnrollment: boolean
  everInvited: boolean
  everMessaged: boolean
  lastOutcome?: 'booked' | 'disqualified' | 'handed_off' | 'closed' | 'opted_out' | null
  lastContactedAt?: Date | null
  optedOut: boolean
}

export interface Repository {
  activeAutomations(accountId: string): Promise<ActiveAutomation[]>

  /** Contact state for dedup. Missing means we have never seen this person. */
  contactByIdentifier(accountId: string, publicIdentifier: string): Promise<ContactSnapshot | null>

  /** The account owner, so their own comments never enroll them. */
  ownIdentifier(accountId: string): Promise<string>

  /** True when this comment already produced an enrollment. */
  isCommentEnrolled(automationId: string, commentUrn: string): Promise<boolean>

  createEnrollment(input: {
    accountId: string
    automationId: string
    publicIdentifier: string
    fullName: string
    headline?: string
    commentUrn: string
    commentText: string
    matchedKeyword: string
    postUrl: string
  }): Promise<string>

  /** Enrollments whose next action is due. */
  dueEnrollments(accountId: string, now: Date, limit: number): Promise<PendingEnrollment[]>

  /**
   * One enrollment, whatever its schedule. A job executes long after the
   * enrollment stopped being due, so looking it up among the due rows finds
   * nothing exactly when the work is about to happen.
   */
  enrollmentById(id: string): Promise<PendingEnrollment | null>

  enqueueJob(input: {
    accountId: string
    enrollmentId: string
    type: JobType
    payload: Record<string, unknown>
    runAfter: Date
  }): Promise<void>

  /** Claims jobs so two agents cannot run the same one. */
  claimJobs(accountId: string, now: Date, limit: number, leaseHolder: string): Promise<QueuedJob[]>

  completeJob(jobId: string): Promise<void>
  failJob(jobId: string, error: string, retryable: boolean): Promise<void>

  setEnrollmentState(enrollmentId: string, state: EnrollmentState, nextActionAt: Date | null): Promise<void>

  /** Stamps when an invitation actually went out, for the acceptance rate. */
  markInvited(enrollmentId: string, at: Date): Promise<void>

  setContactDegree(contactId: string, degree: number): Promise<void>
  recordMessage(input: {
    contactId: string
    enrollmentId: string
    channel: 'comment_reply' | 'invite_note' | 'dm'
    direction: 'outbound' | 'inbound'
    body: string
    generated: boolean
  }): Promise<void>

  usage(accountId: string, now: Date): Promise<UsageSnapshot>
  healthWindow(accountId: string): Promise<HealthWindow>
  countAction(accountId: string, action: 'invite' | 'dm' | 'comment_reply', now: Date): Promise<void>
  recordEvent(accountId: string, type: string, data: Record<string, unknown>): Promise<void>

  /** Live conversations, for the playbook to advance. */
  conversingEnrollments(accountId: string, limit: number): Promise<PendingEnrollment[]>

  /** Everything said in one conversation, oldest first. */
  history(enrollmentId: string): Promise<ConversationTurn[]>

  /**
   * The open enrollment for this person, whatever state it is in.
   *
   * An inbound message arrives identified by who sent it, not by which
   * enrollment it belongs to, so this is how a reply finds its conversation.
   */
  openEnrollmentFor(accountId: string, publicIdentifier: string): Promise<PendingEnrollment | null>

  /** Moves the conversation on after a reply actually went out. */
  setStage(enrollmentId: string, stage: ConversationStage): Promise<void>

  /** What the agent read and what it proposes, for the panel to show. */
  saveConversationRead(input: {
    enrollmentId: string
    stage: ConversationStage
    intent: string
    confidence: number
    suggestions: QuickReply[]
    notes: string[]
    threadId?: string | null
  }): Promise<void>

  /** Liveness, so the panel can tell a quiet agent from a dead one. */
  touchAccount(accountId: string, at: Date): Promise<void>
}

export interface Classifier {
  classify(input: {
    stage: string
    history: Array<{ from: 'owner' | 'lead'; body: string; at: Date }>
    latest: string
  }): Promise<Classification>
}

export interface NoteWriter {
  inviteNote(input: {
    firstName: string
    headline?: string | null
    comment: string
    matchedKeyword: string
    postExcerpt: string
  }): Promise<string>
}
