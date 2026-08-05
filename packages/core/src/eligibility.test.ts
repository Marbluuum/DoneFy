import assert from 'node:assert/strict'
import { test } from 'node:test'

import { checkEligibility, matchesKeyword, type ContactHistory } from './eligibility.js'
import { DEFAULT_THRESHOLDS, assessHealth, type HealthWindow } from './health.js'

const NOW = new Date('2026-08-05T14:00:00Z')
const HEALTHY = assessHealth({
  invitesResolved: 100,
  invitesAccepted: 80,
  invitesPending: 10,
  actionFailures: 0,
  actionsAttempted: 200,
})

function history(overrides: Partial<ContactHistory> = {}): ContactHistory {
  return {
    hasActiveEnrollment: false,
    everInvited: false,
    everMessaged: false,
    lastOutcome: null,
    lastContactedAt: null,
    optedOut: false,
    isSelf: false,
    ...overrides,
  }
}

function window(overrides: Partial<HealthWindow> = {}): HealthWindow {
  return {
    invitesResolved: 100,
    invitesAccepted: 80,
    invitesPending: 10,
    actionFailures: 0,
    actionsAttempted: 200,
    ...overrides,
  }
}

// --- eligibility -----------------------------------------------------------

test('a new commenter is enrolled and needs an invite', () => {
  const v = checkEligibility({ history: history(), health: HEALTHY, now: NOW })
  assert.equal(v.eligible, true)
  assert.equal(v.eligible === true && v.needsInvite, true)
})

test('someone mid-sequence commenting on another post is not enrolled twice', () => {
  // The case that will actually happen on an account that posts often.
  const v = checkEligibility({
    history: history({ hasActiveEnrollment: true }),
    health: HEALTHY,
    now: NOW,
  })
  assert.equal(v.eligible, false)
  assert.equal(v.eligible === false && v.code, 'already_enrolled')
})

test('a previously invited contact is never invited a second time', () => {
  const v = checkEligibility({
    history: history({ everInvited: true, lastContactedAt: null }),
    health: HEALTHY,
    now: NOW,
  })
  assert.equal(v.eligible === true && v.needsInvite, false)
})

test('booked, disqualified and opted-out contacts stay out', () => {
  const cases = [
    ['booked', 'already_booked'],
    ['disqualified', 'disqualified'],
    ['opted_out', 'opted_out'],
  ] as const
  for (const [outcome, code] of cases) {
    const v = checkEligibility({
      history: history({ lastOutcome: outcome }),
      health: HEALTHY,
      now: NOW,
    })
    assert.equal(v.eligible === false && v.code, code, outcome)
  }
})

test('automation does not take back a conversation a human owns', () => {
  const v = checkEligibility({
    history: history({ lastOutcome: 'handed_off' }),
    health: HEALTHY,
    now: NOW,
  })
  assert.equal(v.eligible === false && v.code, 'human_owned')
})

test('a recently contacted person waits out the cooldown, then re-enters', () => {
  const recent = new Date(NOW.getTime() - 10 * 24 * 60 * 60 * 1000)
  const blocked = checkEligibility({ history: history({ lastContactedAt: recent }), health: HEALTHY, now: NOW })
  assert.equal(blocked.eligible === false && blocked.code, 'too_soon')

  const old = new Date(NOW.getTime() - 200 * 24 * 60 * 60 * 1000)
  const allowed = checkEligibility({ history: history({ lastContactedAt: old }), health: HEALTHY, now: NOW })
  assert.equal(allowed.eligible, true)
})

test('the account owner is never enrolled by their own comment', () => {
  const v = checkEligibility({ history: history({ isSelf: true }), health: HEALTHY, now: NOW })
  assert.equal(v.eligible === false && v.code, 'self')
})

test('a stopped account blocks enrollment entirely', () => {
  const sick = assessHealth(window({ actionFailures: 50, actionsAttempted: 100 }))
  const v = checkEligibility({ history: history(), health: sick, now: NOW })
  assert.equal(v.eligible === false && v.code, 'health_stopped')
})

test('a throttled account still enrolls, it just stops inviting', () => {
  const throttled = assessHealth(window({ invitesResolved: 100, invitesAccepted: 20 }))
  assert.equal(throttled.state, 'throttled')

  const v = checkEligibility({ history: history(), health: throttled, now: NOW })
  assert.equal(v.eligible, true)
  assert.equal(v.eligible === true && v.needsInvite, false)
})

// --- keyword matching ------------------------------------------------------

test('keywords match on word boundaries, not substrings', () => {
  assert.equal(matchesKeyword('GUIA', ['guia']), 'guia')
  assert.equal(matchesKeyword('me mandas la guia?', ['guia']), 'guia')
  // "seguian" contains "guia" — matching it would enroll the wrong people.
  assert.equal(matchesKeyword('todos seguian el hilo', ['guia']), null)
})

test('accents and case are ignored, since people type it however they like', () => {
  assert.equal(matchesKeyword('GUÍA por favor', ['guia']), 'guia')
  assert.equal(matchesKeyword('guia', ['GUÍA']), 'GUÍA')
})

test('punctuation around the keyword does not break the match', () => {
  for (const text of ['guia!', '"guia"', 'guia.', '(guia)', 'guia,']) {
    assert.equal(matchesKeyword(text, ['guia']), 'guia', text)
  }
})

test('the first matching keyword wins, and non-matches return null', () => {
  assert.equal(matchesKeyword('quiero la demo', ['guia', 'demo']), 'demo')
  assert.equal(matchesKeyword('felicitaciones!', ['guia', 'demo']), null)
})

test('an automation with no keywords fires on any non-empty comment', () => {
  assert.equal(matchesKeyword('lo que sea', []), '*')
  assert.equal(matchesKeyword('   ', []), null)
})

// --- health ----------------------------------------------------------------

test('a healthy inbound account is left alone', () => {
  const r = assessHealth(window())
  assert.equal(r.state, 'healthy')
  assert.equal(r.allowInvites, true)
})

test('acceptance below the floor stops invites but not conversations', () => {
  const r = assessHealth(window({ invitesResolved: 100, invitesAccepted: 30 }))
  assert.equal(r.state, 'throttled')
  assert.equal(r.allowInvites, false)
  // Leads mid-conversation are not punished for the account's invite numbers.
  assert.equal(r.allowSends, true)
})

test('mediocre acceptance warns without stopping', () => {
  const r = assessHealth(window({ invitesResolved: 100, invitesAccepted: 50 }))
  assert.equal(r.state, 'warning')
  assert.equal(r.allowInvites, true)
})

test('a small sample does not trip the breaker', () => {
  // 2 of 5 is 40%, but five invitations prove nothing.
  const r = assessHealth(window({ invitesResolved: 5, invitesAccepted: 2 }))
  assert.equal(r.state, 'healthy')
  assert.match(r.reasons[0] ?? '', /muestra insuficiente/)
})

test('failing actions stop everything, since a restriction is likely already live', () => {
  const r = assessHealth(window({ actionFailures: 30, actionsAttempted: 100 }))
  assert.equal(r.state, 'stopped')
  assert.equal(r.allowSends, false)
  assert.equal(r.allowInvites, false)
})

test('a couple of failures out of a handful is not a restriction', () => {
  const r = assessHealth(window({ actionFailures: 2, actionsAttempted: 5 }))
  assert.notEqual(r.state, 'stopped')
})

test('a pile of pending invitations pauses new ones', () => {
  const r = assessHealth(window({ invitesPending: DEFAULT_THRESHOLDS.maxPendingInvites + 1 }))
  assert.equal(r.state, 'throttled')
  assert.equal(r.allowInvites, false)
})

test('every non-healthy verdict explains itself', () => {
  for (const w of [
    window({ invitesResolved: 100, invitesAccepted: 10 }),
    window({ actionFailures: 30, actionsAttempted: 100 }),
    window({ invitesPending: 500 }),
  ]) {
    assert.ok(assessHealth(w).reasons.length > 0)
  }
})
