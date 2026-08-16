import type { TickResult } from './tick.js'

/**
 * The loop around the tick.
 *
 * Everything that decides anything lives in the tick, which is bounded and
 * returns. This only decides *when* to run it and what to do when it throws —
 * and the answer to the second is almost always "keep going". A crashed agent
 * is worse than a slow one: leads sit in states nobody is advancing, and the
 * failure is invisible until someone opens the panel.
 */

export type LoopOptions = {
  tick: () => Promise<TickResult>
  intervalMs: number
  sleep: (ms: number) => Promise<void>
  /** Checked before every tick, so a stop is honoured within one cycle. */
  shouldContinue: () => boolean
  log?: (message: string, data?: Record<string, unknown>) => void
  /** Give up after this many consecutive failures. */
  maxConsecutiveFailures?: number
  /** Longest wait a backoff may reach. */
  maxBackoffMs?: number
}

export type LoopSummary = {
  ticks: number
  failures: number
  stoppedBecause: 'asked' | 'too_many_failures'
}

export async function runLoop(options: LoopOptions): Promise<LoopSummary> {
  const log = options.log ?? (() => {})
  const maxFailures = options.maxConsecutiveFailures ?? 10
  const maxBackoff = options.maxBackoffMs ?? 15 * 60_000

  let ticks = 0
  let failures = 0
  let consecutive = 0

  while (options.shouldContinue()) {
    try {
      const result = await options.tick()
      ticks++
      consecutive = 0

      if (result.enrolled || result.scheduled || result.executed || result.failed) {
        log('ciclo', {
          nuevos: result.enrolled,
          agendados: result.scheduled,
          ejecutados: result.executed,
          fallidos: result.failed,
        })
      }

      // A stopped account is not an error, so the loop keeps running — but
      // polling at the normal rate achieves nothing except more requests
      // against an account that is already in trouble.
      const wait = result.health === 'stopped' ? Math.max(options.intervalMs, maxBackoff) : options.intervalMs
      await options.sleep(wait)
    } catch (error) {
      failures++
      consecutive++
      log('ciclo falló', { intento: consecutive, error: error instanceof Error ? error.message : String(error) })

      if (consecutive >= maxFailures) {
        return { ticks, failures, stoppedBecause: 'too_many_failures' }
      }

      // Backoff on consecutive failures only. Whatever is broken — the network,
      // the database, the session — retrying it every 90 seconds neither fixes
      // it nor makes it visible any sooner.
      await options.sleep(Math.min(maxBackoff, options.intervalMs * 2 ** consecutive))
    }
  }

  return { ticks, failures, stoppedBecause: 'asked' }
}
