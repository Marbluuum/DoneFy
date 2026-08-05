import type { HealthReport } from './health.js'

/**
 * Who actually gets enrolled when a keyword comment shows up.
 *
 * The guard that matters most here is cross-post deduplication. On an account
 * that posts often, the same people comment again and again — that is what an
 * engaged audience looks like. Treating each comment as a fresh lead would send
 * the same person a second invitation, then a third opening DM, and nothing
 * makes an account look automated faster than that.
 *
 * The enrollment table's unique index covers one automation. This covers the
 * account: across every post and every automation.
 */

export type ContactHistory = {
  /** Any prior enrollment for this contact on this account. */
  hasActiveEnrollment: boolean
  /** They already got an invite from us at some point. */
  everInvited: boolean
  /** We already sent them a DM at some point. */
  everMessaged: boolean
  /** Terminal outcome of their last run, if any. */
  lastOutcome?: 'booked' | 'disqualified' | 'handed_off' | 'closed' | 'opted_out' | null
  /** When we last sent them anything. */
  lastContactedAt?: Date | null
  optedOut: boolean
  /** Their own profile, so we never enroll the account owner. */
  isSelf: boolean
}

export type EligibilityInput = {
  history: ContactHistory
  health: HealthReport
  now: Date
  /** Do not re-enrol someone we already ran a sequence on inside this window. */
  reEnrollAfterDays?: number
}

export type EligibilityVerdict =
  | { eligible: true; needsInvite: boolean }
  | { eligible: false; reason: string; code: EligibilityCode }

export type EligibilityCode =
  | 'self'
  | 'opted_out'
  | 'already_enrolled'
  | 'already_booked'
  | 'disqualified'
  | 'human_owned'
  | 'too_soon'
  | 'health_stopped'

const DEFAULT_RE_ENROLL_DAYS = 90

export function checkEligibility(input: EligibilityInput): EligibilityVerdict {
  const { history, health, now } = input
  const reEnrollDays = input.reEnrollAfterDays ?? DEFAULT_RE_ENROLL_DAYS

  if (history.isSelf) {
    return { eligible: false, reason: 'es la propia cuenta', code: 'self' }
  }
  if (history.optedOut || history.lastOutcome === 'opted_out') {
    return { eligible: false, reason: 'el contacto pidió no recibir mensajes', code: 'opted_out' }
  }

  // Someone mid-sequence commenting on another post is engagement, not a new
  // lead. Enrolling them again would run two sequences at the same person.
  if (history.hasActiveEnrollment) {
    return { eligible: false, reason: 'ya está en una secuencia activa', code: 'already_enrolled' }
  }

  if (history.lastOutcome === 'booked') {
    return { eligible: false, reason: 'ya agendó una reunión', code: 'already_booked' }
  }
  if (history.lastOutcome === 'disqualified') {
    return { eligible: false, reason: 'ya fue descartado', code: 'disqualified' }
  }
  // A human took this conversation over. Automation does not take it back.
  if (history.lastOutcome === 'handed_off') {
    return { eligible: false, reason: 'la conversación la lleva un humano', code: 'human_owned' }
  }

  if (history.lastContactedAt) {
    const daysSince = (now.getTime() - history.lastContactedAt.getTime()) / (24 * 60 * 60 * 1000)
    if (daysSince < reEnrollDays) {
      return {
        eligible: false,
        reason: `contactado hace ${Math.floor(daysSince)} días, se re-habilita a los ${reEnrollDays}`,
        code: 'too_soon',
      }
    }
  }

  if (!health.allowSends) {
    return { eligible: false, reason: health.reasons[0] ?? 'cuenta en pausa', code: 'health_stopped' }
  }

  // Eligible. Whether they need an invite is a separate question from whether
  // they qualify — someone already connected skips straight to the DM, and
  // someone we invited before does not get invited twice.
  return { eligible: true, needsInvite: !history.everInvited && health.allowInvites }
}

/**
 * Does this comment fire this automation?
 *
 * Matches on word boundaries so "GUIA" does not fire on "seguían", and
 * normalizes accents because people type the keyword however they please.
 */
export function matchesKeyword(commentText: string, keywords: string[]): string | null {
  if (keywords.length === 0) return commentText.trim() ? '*' : null

  const normalized = normalize(commentText)
  for (const keyword of keywords) {
    const needle = normalize(keyword)
    if (!needle) continue
    const pattern = new RegExp(`(^|[^\\p{L}\\p{N}])${escapeRegex(needle)}([^\\p{L}\\p{N}]|$)`, 'u')
    if (pattern.test(normalized)) return keyword
  }
  return null
}

function normalize(text: string): string {
  return text
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .trim()
}

function escapeRegex(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}
