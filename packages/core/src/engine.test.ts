import assert from 'node:assert/strict'
import { test } from 'node:test'

import { applyExternalEvent, decide, type DecisionContext, type EnrollmentView } from './engine.js'
import { DEFAULT_QUOTA, checkQuota, priorityScore, type UsageSnapshot } from './quota.js'
import { DAY_MS, isWithinWorkingHours, nextWorkingMoment } from './timing.js'

/** A Wednesday at 14:00 UTC — inside the default working window. */
const NOW = new Date('2026-08-05T14:00:00Z')

function usage(overrides: Partial<UsageSnapshot['today']> = {}, trailingWeek = 0): UsageSnapshot {
  return {
    today: { invite: 0, dm: 0, comment_reply: 0, ...overrides },
    invitesTrailingWeek: trailingWeek,
  }
}

function ctx(overrides: Partial<DecisionContext> = {}): DecisionContext {
  return {
    now: NOW,
    usage: usage(),
    // Fixed midpoint so jittered delays are deterministic under test.
    random: () => 0.5,
    workingHours: { timezone: 'UTC', startHour: 9, endHour: 19, activeDays: [1, 2, 3, 4, 5] },
    ...overrides,
  }
}

function enrollment(overrides: Partial<EnrollmentView> = {}): EnrollmentView {
  return {
    id: 'e1',
    state: 'detected',
    enteredStateAt: NOW,
    commentText: 'GUIA',
    degree: null,
    optedOut: false,
    attempts: 0,
    ...overrides,
  }
}

test('a fresh detection replies to the comment first', () => {
  const d = decide(enrollment(), ctx())
  assert.equal(d.kind, 'enqueue')
  assert.equal(d.kind === 'enqueue' && d.job, 'reply_comment')
  assert.equal(d.kind === 'enqueue' && d.nextState, 'comment_replied')
})

test('1st-degree contacts get a DM and never consume an invite', () => {
  const d = decide(enrollment({ state: 'comment_replied', degree: 1 }), ctx())
  assert.equal(d.kind === 'enqueue' && d.job, 'send_dm')
  assert.equal(d.kind === 'enqueue' && d.nextState, 'dm_sent')
})

test('2nd-degree contacts get an invite', () => {
  const d = decide(enrollment({ state: 'comment_replied', degree: 2 }), ctx())
  assert.equal(d.kind === 'enqueue' && d.job, 'send_invite')
  assert.equal(d.kind === 'enqueue' && d.nextState, 'invite_sent')
})

test('degree is looked up before the invite-vs-DM branch is taken', () => {
  const d = decide(enrollment({ state: 'comment_replied', degree: null }), ctx())
  assert.equal(d.kind === 'enqueue' && d.job, 'check_connection')
})

test('a spent weekly invite cap parks the contact instead of dropping them', () => {
  const d = decide(
    enrollment({ state: 'comment_replied', degree: 2 }),
    ctx({ usage: usage({}, DEFAULT_QUOTA.invitesPerRollingWeek) }),
  )
  assert.equal(d.kind, 'transition')
  assert.equal(d.kind === 'transition' && d.nextState, 'invite_queued')
})

test('a parked contact leaves the queue once the cap frees up', () => {
  const queued = enrollment({ state: 'invite_queued' })
  const blocked = decide(queued, ctx({ usage: usage({}, DEFAULT_QUOTA.invitesPerRollingWeek) }))
  assert.equal(blocked.kind, 'wait')

  const freed = decide(queued, ctx({ usage: usage({}, 10) }))
  assert.equal(freed.kind === 'enqueue' && freed.job, 'send_invite')
})

test('the opening DM waits out the cool-off after a connection is accepted', () => {
  const justConnected = enrollment({ state: 'connected', enteredStateAt: NOW })
  assert.equal(decide(justConnected, ctx()).kind, 'wait')

  const connectedYesterday = enrollment({
    state: 'connected',
    enteredStateAt: new Date(NOW.getTime() - DAY_MS),
  })
  const d = decide(connectedYesterday, ctx())
  assert.equal(d.kind === 'enqueue' && d.job, 'send_dm')
})

test('follow-ups fire on silence and stop after the second one', () => {
  const silent = (state: EnrollmentView['state'], days: number) =>
    decide(enrollment({ state, enteredStateAt: new Date(NOW.getTime() - days * DAY_MS) }), ctx())

  assert.equal(silent('dm_sent', 1).kind, 'wait')
  assert.equal(silent('dm_sent', 4).kind, 'enqueue')

  const second = silent('followup_1_sent', 6)
  assert.equal(second.kind === 'enqueue' && second.nextState, 'followup_2_sent')

  const done = silent('followup_2_sent', 10)
  assert.equal(done.kind === 'transition' && done.nextState, 'closed')
})

test('unanswered invites are withdrawn to reclaim the slot', () => {
  const stale = enrollment({ state: 'invite_sent', enteredStateAt: new Date(NOW.getTime() - 22 * DAY_MS) })
  const d = decide(stale, ctx())
  assert.equal(d.kind === 'enqueue' && d.job, 'withdraw_invite')
  assert.equal(d.kind === 'enqueue' && d.nextState, 'invite_expired')
})

test('an opt-out halts the sequence from any live state', () => {
  const d = decide(enrollment({ state: 'dm_sent', optedOut: true }), ctx())
  assert.equal(d.kind === 'transition' && d.nextState, 'opted_out')
})

test('terminal states produce no further work', () => {
  for (const state of ['closed', 'booked', 'disqualified', 'handed_off', 'opted_out', 'failed'] as const) {
    assert.equal(decide(enrollment({ state }), ctx()).kind, 'idle')
  }
})

test('a live conversation is left to the playbook, not the outbound scheduler', () => {
  const d = decide(enrollment({ state: 'replied' }), ctx())
  assert.equal(d.kind, 'idle')
  assert.match(d.kind === 'idle' ? d.reason : '', /playbook/)
})

test('repeated failures stop the sequence rather than retrying forever', () => {
  const d = decide(enrollment({ attempts: 3 }), ctx())
  assert.equal(d.kind === 'transition' && d.nextState, 'failed')
})

test('a reply always wins, and terminal states ignore late events', () => {
  assert.equal(applyExternalEvent('dm_sent', { type: 'contact_replied' }), 'replied')
  assert.equal(applyExternalEvent('invite_sent', { type: 'invite_accepted' }), 'connected')
  // An acceptance for someone already past that point is not a regression.
  assert.equal(applyExternalEvent('dm_sent', { type: 'invite_accepted' }), null)
  assert.equal(applyExternalEvent('replied', { type: 'contact_replied' }), null)
})

test('work is never scheduled outside working hours', () => {
  const fridayEvening = new Date('2026-08-07T20:00:00Z')
  const hours = { timezone: 'UTC', startHour: 9, endHour: 19, activeDays: [1, 2, 3, 4, 5] }

  assert.equal(isWithinWorkingHours(fridayEvening, hours), false)

  const next = nextWorkingMoment(fridayEvening, hours)
  assert.equal(isWithinWorkingHours(next, hours), true)
  // Friday night rolls to Monday, not Saturday.
  assert.equal(next.getUTCDay(), 1)
})

test('the daily invite cap holds even with weekly room to spare', () => {
  const verdict = checkQuota('invite', usage({ invite: DEFAULT_QUOTA.invitesPerDay }, 0))
  assert.equal(verdict.allowed, false)
  assert.equal(verdict.allowed === false && verdict.reason, 'daily_cap')
})

test('priority favours matching titles over comment length', () => {
  const ideal = ['founder', 'ceo']
  const founder = priorityScore({ headline: 'Founder at Acme', commentLength: 4, idealTitles: ideal })
  const verbose = priorityScore({ headline: 'Student', commentLength: 400, idealTitles: ideal })
  assert.ok(founder > verbose)
})
