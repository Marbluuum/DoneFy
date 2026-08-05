/**
 * What the agent needs LinkedIn to do.
 *
 * An interface rather than a class so the execution layer is swappable: the
 * Playwright driver today, a hosted API (Unipile and similar) the day volume
 * justifies it, and a fake in tests. Nothing above this line — not the engine,
 * not the playbook, not the panel — knows which one is running.
 *
 * Every method can fail in a way that means "the account is in trouble", not
 * "this one action didn't work". That distinction is what `AdapterError.kind`
 * carries, and it is what the health breaker reads.
 */

export type PostComment = {
  /** Stable per comment; used to avoid replying twice. */
  urn: string
  authorPublicIdentifier: string
  authorName: string
  authorHeadline?: string
  body: string
  postedAt?: Date
}

export type ProfileSummary = {
  publicIdentifier: string
  fullName: string
  headline?: string
  company?: string
  /** 1 | 2 | 3. Null when LinkedIn does not show a badge. */
  degree: number | null
}

export type ConversationSummary = {
  /** LinkedIn's thread id. */
  threadId: string
  participantPublicIdentifier: string
  participantName: string
  lastMessageAt: Date
  /** True when the last message in the thread came from the account owner. */
  lastMessageFromOwner: boolean
  snippet: string
}

export type ThreadMessage = {
  from: 'owner' | 'lead'
  body: string
  at: Date
}

export type InviteResult =
  | { sent: true; withNote: boolean }
  | { sent: false; reason: 'already_connected' | 'already_pending' | 'no_invite_button' | 'weekly_limit' }

export interface LinkedInAdapter {
  /** Throws AdapterError('auth') if the session is dead. Call before anything else. */
  assertSignedIn(): Promise<void>

  /** Comments on a post, newest first, paginating up to `limit`. */
  readComments(postUrl: string, limit: number): Promise<PostComment[]>

  /** Public reply under a specific comment. */
  replyToComment(postUrl: string, commentUrn: string, body: string): Promise<void>

  /** Degree, headline and company. The invite-vs-DM branch depends on degree. */
  readProfile(publicIdentifier: string): Promise<ProfileSummary>

  /** Connection request. `note` is capped at 300 characters by the caller. */
  sendInvite(publicIdentifier: string, note?: string): Promise<InviteResult>

  /** Withdraws a pending invite to free room under the weekly cap. */
  withdrawInvite(publicIdentifier: string): Promise<boolean>

  sendMessage(publicIdentifier: string, body: string): Promise<void>

  /**
   * Conversation list, newest first. Used by the history import to learn who
   * the owner has already spoken to — without which the dedup rules have
   * nothing to check against on day one.
   */
  listConversations(options: { limit: number; before?: Date }): Promise<ConversationSummary[]>

  /** Full message history for one thread. */
  readThread(threadId: string): Promise<ThreadMessage[]>

  close(): Promise<void>
}

export type AdapterErrorKind =
  /** Session expired, or LinkedIn is showing a checkpoint. Stop everything. */
  | 'auth'
  /** LinkedIn refused the action — a cap, a block, a restriction. */
  | 'blocked'
  /** The DOM did not match. Almost always a selector that needs updating. */
  | 'selector'
  /** Timeout, navigation failure, transient. Safe to retry. */
  | 'transient'

export class AdapterError extends Error {
  override readonly name = 'AdapterError'

  constructor(
    readonly kind: AdapterErrorKind,
    message: string,
    /** Path to a screenshot captured at failure, when one was taken. */
    readonly screenshotPath?: string,
  ) {
    super(message)
  }

  /**
   * Whether this failure should count against account health.
   *
   * A broken selector is our bug and says nothing about the account — counting
   * it would trip the breaker on a LinkedIn redesign. A refused action is the
   * signal the breaker exists for.
   */
  get countsAsAccountFailure(): boolean {
    return this.kind === 'blocked' || this.kind === 'auth'
  }
}
