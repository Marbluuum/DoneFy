import type { ConversationSummary } from './linkedin/adapter.js'

/**
 * Importing the account's existing conversations.
 *
 * Not optional, and not obvious why until you look at the dedup rules: they ask
 * "have we messaged this person before?", and on a fresh install the answer is
 * always no. Without an import, the first campaign opens with "Buenas! Vi que
 * me comentaste" to people the owner has been talking to for months.
 *
 * Two constraints shape it. Reading two thousand conversations in ten minutes
 * is the mass-retrieval pattern that gets accounts flagged, so it is paced over
 * days. And these are third parties' messages, so metadata is kept for everyone
 * and content only for threads the automation could actually touch.
 */

export type ImportConfig = {
  /** Conversations to read per day. Low on purpose — this runs once. */
  perDay: number
  /** Per batch within a day, so it arrives in bursts a person could produce. */
  perBatch: number
  /** Stop once conversations are older than this. */
  maxAgeDays: number
  /** Hard ceiling regardless of age. */
  maxTotal: number
}

export const DEFAULT_IMPORT: ImportConfig = {
  perDay: 200,
  perBatch: 25,
  maxAgeDays: 730,
  maxTotal: 5000,
}

export type ImportState = {
  /** Conversations imported across all days. */
  imported: number
  /** Imported during the current local day. */
  importedToday: number
  /** Local day the counter belongs to, YYYY-MM-DD. */
  today: string
  /** Oldest conversation reached so far — the pagination cursor. */
  oldestSeen: Date | null
  completed: boolean
}

export function initialImportState(today: string): ImportState {
  return { imported: 0, importedToday: 0, today, oldestSeen: null, completed: false }
}

export type ImportStep =
  | { action: 'fetch'; limit: number; before: Date | undefined }
  | { action: 'wait'; reason: string; until: 'tomorrow' }
  | { action: 'done'; reason: string }

export function planImportStep(
  state: ImportState,
  config: ImportConfig,
  now: Date,
  today: string,
): ImportStep {
  if (state.completed) {
    return { action: 'done', reason: 'importación completa' }
  }
  if (state.imported >= config.maxTotal) {
    return { action: 'done', reason: `alcanzado el tope de ${config.maxTotal} conversaciones` }
  }

  // A new local day resets the daily allowance. The caller rolls `today`.
  const importedToday = state.today === today ? state.importedToday : 0

  if (importedToday >= config.perDay) {
    return { action: 'wait', reason: `${importedToday} importadas hoy, sigue mañana`, until: 'tomorrow' }
  }

  if (state.oldestSeen) {
    const ageDays = (now.getTime() - state.oldestSeen.getTime()) / (24 * 60 * 60 * 1000)
    if (ageDays > config.maxAgeDays) {
      return { action: 'done', reason: `se alcanzaron conversaciones de hace ${Math.floor(ageDays)} días` }
    }
  }

  const remainingToday = config.perDay - importedToday
  const remainingTotal = config.maxTotal - state.imported
  const limit = Math.min(config.perBatch, remainingToday, remainingTotal)

  return { action: 'fetch', limit, before: state.oldestSeen ?? undefined }
}

export function applyImportedBatch(
  state: ImportState,
  batch: ConversationSummary[],
  today: string,
): ImportState {
  const importedToday = state.today === today ? state.importedToday : 0

  // An empty batch means the conversation list is exhausted — there is nothing
  // older to page into, so the import is finished regardless of the caps.
  if (batch.length === 0) {
    return { ...state, today, importedToday, completed: true }
  }

  const oldest = batch.reduce(
    (min, c) => (min === null || c.lastMessageAt < min ? c.lastMessageAt : min),
    null as Date | null,
  )

  return {
    imported: state.imported + batch.length,
    importedToday: importedToday + batch.length,
    today,
    oldestSeen: oldest,
    completed: false,
  }
}

/**
 * Whether to store the thread's messages, or just the fact that it exists.
 *
 * Dedup only needs to know *that* the owner has spoken to someone and when —
 * that alone prevents the cold opener to a warm contact. Message bodies are
 * only worth keeping where the playbook might pick the conversation up, which
 * means a thread the lead spoke in last and that is recent enough to still be
 * live. Everything else stays as metadata.
 */
export function shouldStoreContent(
  conversation: ConversationSummary,
  now: Date,
  recentDays = 90,
): boolean {
  if (conversation.lastMessageFromOwner) return false
  const ageDays = (now.getTime() - conversation.lastMessageAt.getTime()) / (24 * 60 * 60 * 1000)
  return ageDays <= recentDays
}

/**
 * The contact history the dedup rules read, derived from imported metadata.
 * `everInvited` is unknowable from the conversation list — a pending invite has
 * no thread — so it comes from the sent-invitations page separately.
 */
export function historyFromConversation(conversation: ConversationSummary) {
  return {
    publicIdentifier: conversation.participantPublicIdentifier,
    everMessaged: true,
    lastContactedAt: conversation.lastMessageAt,
  }
}
