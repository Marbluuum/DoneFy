import assert from 'node:assert/strict'
import { test } from 'node:test'

import { runLoop } from './loop.js'
import type { TickResult } from './tick.js'

const OK: TickResult = {
  health: 'healthy',
  enrolled: 0,
  scheduled: 0,
  executed: 0,
  failed: 0,
  inbound: 0,
  proposed: 0,
  accepted: 0,
  skipped: [],
}

/** Records what was waited for instead of waiting, so the suite stays instant. */
function fakeClock() {
  const waits: number[] = []
  return { waits, sleep: async (ms: number) => void waits.push(ms) }
}

test('a failing tick does not end the run', async () => {
  // The whole point of the loop. A transient database blip or a slow page
  // should cost one cycle, not the agent — a dead agent leaves leads sitting
  // in states nobody advances, and nothing says so until someone looks.
  const clock = fakeClock()
  let calls = 0

  const summary = await runLoop({
    tick: async () => {
      calls++
      if (calls === 2) throw new Error('conexión caída')
      return OK
    },
    intervalMs: 1000,
    sleep: clock.sleep,
    shouldContinue: () => calls < 4,
  })

  assert.equal(summary.failures, 1)
  assert.ok(summary.ticks >= 2, 'siguió después del error')
  assert.equal(summary.stoppedBecause, 'asked')
})

test('consecutive failures back off instead of hammering', async () => {
  const clock = fakeClock()
  let calls = 0

  await runLoop({
    tick: async () => {
      calls++
      throw new Error('sigue rota')
    },
    intervalMs: 1000,
    sleep: clock.sleep,
    shouldContinue: () => calls < 3,
    maxConsecutiveFailures: 99,
  })

  assert.deepEqual(clock.waits, [2000, 4000, 8000])
})

test('it gives up rather than failing forever in silence', async () => {
  const clock = fakeClock()

  const summary = await runLoop({
    tick: async () => {
      throw new Error('rota de verdad')
    },
    intervalMs: 1000,
    sleep: clock.sleep,
    shouldContinue: () => true,
    maxConsecutiveFailures: 3,
  })

  assert.equal(summary.stoppedBecause, 'too_many_failures')
  assert.equal(summary.failures, 3)
})

test('a recovered tick resets the backoff', async () => {
  const clock = fakeClock()
  let calls = 0

  await runLoop({
    tick: async () => {
      calls++
      if (calls <= 2) throw new Error('blip')
      return OK
    },
    intervalMs: 1000,
    sleep: clock.sleep,
    shouldContinue: () => calls < 3,
  })

  // 2s, 4s while failing; back to the plain interval once it recovers.
  assert.deepEqual(clock.waits, [2000, 4000, 1000])
})

test('a stopped account is polled slowly, not at the normal rate', async () => {
  // Health 'stopped' means LinkedIn is already refusing us. Polling every 90
  // seconds adds requests to an account that is in trouble and fixes nothing.
  const clock = fakeClock()
  let calls = 0

  await runLoop({
    tick: async () => {
      calls++
      return { ...OK, health: 'stopped' }
    },
    intervalMs: 1000,
    sleep: clock.sleep,
    shouldContinue: () => calls < 1,
    maxBackoffMs: 600_000,
  })

  assert.deepEqual(clock.waits, [600_000])
})

test('stopping is honoured before a tick, not after', async () => {
  const clock = fakeClock()
  let calls = 0

  const summary = await runLoop({
    tick: async () => {
      calls++
      return OK
    },
    intervalMs: 1000,
    sleep: clock.sleep,
    shouldContinue: () => false,
  })

  assert.equal(calls, 0)
  assert.equal(summary.ticks, 0)
})
