/**
 * Quota rules.
 *
 * The invite cap is the real constraint on this product. LinkedIn allows ~100
 * invitations per rolling 7-day window (higher for accounts in good standing),
 * and a big post can produce more keyword comments than that in a day. So
 * invites are rationed and prioritized, while comment replies and DMs to
 * existing 1st-degree connections — which cost nothing against that cap — flow
 * freely.
 */

export type QuotaConfig = {
  /** Trailing-7-day invite ceiling. Kept under the platform limit on purpose. */
  invitesPerRollingWeek: number
  invitesPerDay: number
  dmsPerDay: number
  commentRepliesPerDay: number
}

/**
 * Deliberately below LinkedIn's stated caps.
 *
 * The published limit is where restrictions begin, not a safe operating point,
 * and there is no upside to running at the edge: the cap is spent either way,
 * only faster.
 */
export const DEFAULT_QUOTA: QuotaConfig = {
  invitesPerRollingWeek: 80,
  invitesPerDay: 15,
  dmsPerDay: 40,
  commentRepliesPerDay: 80,
}

export type QuotaAction = 'invite' | 'dm' | 'comment_reply'

export type UsageSnapshot = {
  /** Count for the current local day, per action. */
  today: Record<QuotaAction, number>
  /** Invites sent across the trailing 7 local days, inclusive of today. */
  invitesTrailingWeek: number
}

export type QuotaVerdict =
  | { allowed: true }
  | { allowed: false; reason: 'daily_cap' | 'weekly_cap'; retryAfterDays: number }

export function checkQuota(
  action: QuotaAction,
  usage: UsageSnapshot,
  config: QuotaConfig = DEFAULT_QUOTA,
): QuotaVerdict {
  if (action === 'invite') {
    if (usage.invitesTrailingWeek >= config.invitesPerRollingWeek) {
      return { allowed: false, reason: 'weekly_cap', retryAfterDays: 1 }
    }
    if (usage.today.invite >= config.invitesPerDay) {
      return { allowed: false, reason: 'daily_cap', retryAfterDays: 1 }
    }
    return { allowed: true }
  }

  const dailyCap = action === 'dm' ? config.dmsPerDay : config.commentRepliesPerDay
  if (usage.today[action] >= dailyCap) {
    return { allowed: false, reason: 'daily_cap', retryAfterDays: 1 }
  }
  return { allowed: true }
}

/**
 * Priority score for an enrollment competing for a scarce invite slot.
 *
 * Higher wins. When a post lands 200 keyword comments in a week and only 80
 * invites are available, this decides who gets one first. Everyone still gets
 * the public comment reply, so nobody is left without what they asked for.
 */
export type PriorityInput = {
  /** Their headline/title, matched against `idealTitles`. */
  headline?: string | null
  company?: string | null
  /** 2 is one hop away and likelier to accept than 3. */
  degree?: number | null
  /** Length of what they wrote — a sentence signals more intent than one word. */
  commentLength: number
  /** Lowercased title fragments worth prioritizing, e.g. ["ceo", "founder"]. */
  idealTitles: string[]
}

export function priorityScore(input: PriorityInput): number {
  let score = 0

  const headline = (input.headline ?? '').toLowerCase()
  if (headline && input.idealTitles.some((t) => headline.includes(t.toLowerCase()))) {
    score += 50
  }
  if (input.company) score += 10
  if (input.degree === 2) score += 20

  // A written sentence beats a bare keyword, with a ceiling so an essay does
  // not outrank an actual title match.
  score += Math.min(20, Math.floor(input.commentLength / 10))

  return score
}
