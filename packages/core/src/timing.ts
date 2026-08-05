/**
 * Timing rules.
 *
 * Two things drive everything here: LinkedIn reads bursts and instant
 * reactions as non-human, and a message that lands during working hours simply
 * performs better. Both point the same way, so the delays below are not a tax
 * on the product — they are part of it.
 */

export type TimingConfig = {
  /** Wait between them accepting the invite and the opening DM. */
  dmAfterConnectMinMinutes: number
  dmAfterConnectMaxMinutes: number
  /** Silence before each follow-up. */
  followup1AfterDays: number
  followup2AfterDays: number
  /** Withdraw unanswered invites after this, to free room under the cap. */
  withdrawInviteAfterDays: number
  /** Gap between any two consecutive agent actions. */
  minGapSeconds: number
  maxGapSeconds: number
}

export const DEFAULT_TIMING: TimingConfig = {
  dmAfterConnectMinMinutes: 120,
  dmAfterConnectMaxMinutes: 360,
  followup1AfterDays: 3,
  followup2AfterDays: 5,
  withdrawInviteAfterDays: 21,
  minGapSeconds: 60,
  maxGapSeconds: 210,
}

export type WorkingHours = {
  /** IANA timezone, e.g. "America/Argentina/Buenos_Aires". */
  timezone: string
  /** Local hour the agent may start acting, 0-23. */
  startHour: number
  /** Local hour after which it stops, 0-23. */
  endHour: number
  /** ISO weekdays it may act on: 1 = Monday .. 7 = Sunday. */
  activeDays: number[]
}

export const DEFAULT_WORKING_HOURS: WorkingHours = {
  timezone: 'America/Argentina/Buenos_Aires',
  startHour: 9,
  endHour: 19,
  activeDays: [1, 2, 3, 4, 5],
}

/** Local wall-clock parts of `instant` in `timezone`. */
function localParts(instant: Date, timezone: string): { hour: number; weekday: number } {
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    hour: 'numeric',
    hour12: false,
    weekday: 'short',
  })
  const parts = fmt.formatToParts(instant)
  const hour = Number(parts.find((p) => p.type === 'hour')?.value ?? '0')
  const weekdayName = parts.find((p) => p.type === 'weekday')?.value ?? 'Mon'
  const names = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']
  return { hour: hour % 24, weekday: names.indexOf(weekdayName) + 1 }
}

export function isWithinWorkingHours(instant: Date, hours: WorkingHours): boolean {
  const { hour, weekday } = localParts(instant, hours.timezone)
  if (!hours.activeDays.includes(weekday)) return false
  return hour >= hours.startHour && hour < hours.endHour
}

/**
 * Push `instant` forward to the next moment inside working hours.
 *
 * Steps hour by hour rather than doing timezone arithmetic, which keeps DST
 * transitions correct for free. Bounded at two weeks so a misconfigured window
 * (say, zero active days) fails loudly instead of spinning.
 */
export function nextWorkingMoment(instant: Date, hours: WorkingHours): Date {
  if (isWithinWorkingHours(instant, hours)) return instant

  const cursor = new Date(instant)
  for (let i = 0; i < 24 * 15; i++) {
    cursor.setUTCMinutes(0, 0, 0)
    cursor.setUTCHours(cursor.getUTCHours() + 1)
    if (isWithinWorkingHours(cursor, hours)) return cursor
  }
  throw new Error(
    `No working moment found within 15 days — check WorkingHours (activeDays=${hours.activeDays.join(',')}, ${hours.startHour}-${hours.endHour})`,
  )
}

/**
 * A delay in `[minSeconds, maxSeconds]`.
 *
 * `random` is injected so the scheduler stays deterministic under test.
 */
export function jitteredDelayMs(
  minSeconds: number,
  maxSeconds: number,
  random: () => number = Math.random,
): number {
  const span = Math.max(0, maxSeconds - minSeconds)
  return Math.round((minSeconds + random() * span) * 1000)
}

export const MINUTE_MS = 60_000
export const HOUR_MS = 60 * MINUTE_MS
export const DAY_MS = 24 * HOUR_MS
