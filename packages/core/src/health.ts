/**
 * Account health, as a circuit breaker.
 *
 * Jitter and quotas limit how fast the account acts. Neither notices when the
 * account is *already* in trouble. Invitation acceptance rate is the signal
 * LinkedIn itself is known to weigh, and it is the one that degrades first: a
 * healthy inbound account sits high, because everyone was asked to comment.
 * When it drops, something is wrong upstream — wrong audience, wrong post, or a
 * keyword being gamed — and sending harder makes it worse.
 *
 * So the breaker trips on the account's own numbers, before LinkedIn has to.
 */

export type HealthWindow = {
  /** Invitations sent in the observation window that have been answered or expired. */
  invitesResolved: number
  invitesAccepted: number
  /** Invitations still pending. Not counted in the rate, but tracked. */
  invitesPending: number
  /** Sends that failed outright — a strong sign of a restriction already applied. */
  actionFailures: number
  actionsAttempted: number
}

export type HealthThresholds = {
  /** Below this acceptance rate, stop sending invitations. */
  minAcceptanceRate: number
  /** Below this, warn but keep going. */
  warnAcceptanceRate: number
  /** Sample size below which the rate is not meaningful yet. */
  minSampleSize: number
  /** Failure rate above which everything stops, not just invites. */
  maxFailureRate: number
  /** Pending invitations above which we stop adding more. */
  maxPendingInvites: number
}

/**
 * An inbound account should comfortably clear 60% — the person just asked you
 * for something. Landing near a cold-outreach rate means the assumption behind
 * this whole product does not hold for that post, and that is worth stopping
 * over.
 */
export const DEFAULT_THRESHOLDS: HealthThresholds = {
  minAcceptanceRate: 0.4,
  warnAcceptanceRate: 0.6,
  minSampleSize: 20,
  maxFailureRate: 0.15,
  maxPendingInvites: 200,
}

export type HealthState = 'healthy' | 'warning' | 'throttled' | 'stopped'

export type HealthReport = {
  state: HealthState
  acceptanceRate: number | null
  failureRate: number
  /** What the agent may still do. */
  allowInvites: boolean
  allowSends: boolean
  reasons: string[]
}

export function assessHealth(
  window: HealthWindow,
  thresholds: HealthThresholds = DEFAULT_THRESHOLDS,
): HealthReport {
  const reasons: string[] = []

  const acceptanceRate =
    window.invitesResolved > 0 ? window.invitesAccepted / window.invitesResolved : null
  const failureRate =
    window.actionsAttempted > 0 ? window.actionFailures / window.actionsAttempted : 0

  // Failures first: actions being rejected outright usually means a restriction
  // is already in place, and continuing turns a warning into a suspension.
  if (failureRate > thresholds.maxFailureRate && window.actionsAttempted >= 10) {
    reasons.push(
      `${Math.round(failureRate * 100)}% de acciones fallaron — posible restricción activa`,
    )
    return { state: 'stopped', acceptanceRate, failureRate, allowInvites: false, allowSends: false, reasons }
  }

  if (window.invitesPending > thresholds.maxPendingInvites) {
    reasons.push(`${window.invitesPending} invitaciones pendientes acumuladas`)
    return { state: 'throttled', acceptanceRate, failureRate, allowInvites: false, allowSends: true, reasons }
  }

  // Not enough data yet. Saying "healthy" here would be a guess, but blocking
  // would mean never starting, so invites continue and the state is honest.
  if (acceptanceRate === null || window.invitesResolved < thresholds.minSampleSize) {
    reasons.push(
      `muestra insuficiente (${window.invitesResolved}/${thresholds.minSampleSize} invitaciones resueltas)`,
    )
    return { state: 'healthy', acceptanceRate, failureRate, allowInvites: true, allowSends: true, reasons }
  }

  if (acceptanceRate < thresholds.minAcceptanceRate) {
    reasons.push(
      `aceptación ${Math.round(acceptanceRate * 100)}% bajo el mínimo de ${Math.round(thresholds.minAcceptanceRate * 100)}%`,
    )
    return { state: 'throttled', acceptanceRate, failureRate, allowInvites: false, allowSends: true, reasons }
  }

  if (acceptanceRate < thresholds.warnAcceptanceRate) {
    reasons.push(`aceptación ${Math.round(acceptanceRate * 100)}%, por debajo de lo esperado en inbound`)
    return { state: 'warning', acceptanceRate, failureRate, allowInvites: true, allowSends: true, reasons }
  }

  return { state: 'healthy', acceptanceRate, failureRate, allowInvites: true, allowSends: true, reasons }
}
