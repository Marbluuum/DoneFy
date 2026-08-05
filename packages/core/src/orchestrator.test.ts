import assert from 'node:assert/strict'
import { test } from 'node:test'

import { parseClassification, type Classification, type ConversationTurn } from './classifier.js'
import {
  DEFAULT_POLICY,
  orchestrate,
  type ConversationView,
  type OrchestratorMode,
  type OrchestratorPolicy,
} from './orchestrator.js'
import type { LeadIntent } from './playbook.js'

const NOW = new Date('2026-08-05T14:00:00Z') // Wednesday, inside working hours
const HOURS = { timezone: 'UTC', startHour: 9, endHour: 19, activeDays: [1, 2, 3, 4, 5] }

function policy(overrides: Partial<OrchestratorPolicy> = {}): OrchestratorPolicy {
  return { ...DEFAULT_POLICY, workingHours: HOURS, ...overrides }
}

function classification(intent: LeadIntent, confidence = 0.95): Classification {
  return { intent, confidence, signals: {}, rationale: 'test' }
}

function turns(...pairs: Array<['owner' | 'lead', string]>): ConversationTurn[] {
  return pairs.map(([from, body], i) => ({
    from,
    body,
    at: new Date(NOW.getTime() - (pairs.length - i) * 60_000),
  }))
}

function conversation(overrides: Partial<ConversationView> = {}): ConversationView {
  return {
    stage: 'qualifying_company',
    history: turns(['owner', 'tenes una empresa de tecnologia?'], ['lead', 'Si tengo una empresa de desarrollo']),
    optedOut: false,
    firstName: 'Diego',
    calendarUrl: 'https://enbiconsulting.com/agenda-software',
    ...overrides,
  }
}

test('copilot mode never sends on its own, however confident the read', () => {
  const d = orchestrate(conversation(), classification('confirms', 1), policy({ mode: 'copilot' }), NOW)
  assert.equal(d.action.kind, 'suggest')
  assert.equal(d.playbookStep.autonomy, 'auto') // the playbook would have allowed it
  assert.equal(d.effectiveAutonomy, 'suggest')
})

test('autopilot sends the step that advances the stage', () => {
  const d = orchestrate(conversation(), classification('confirms'), policy({ mode: 'autopilot' }), NOW)
  assert.equal(d.action.kind, 'send')
  assert.equal(d.nextStage, 'qualifying_pain')

  const body = d.action.kind === 'send' ? d.action.body : ''
  // Must be the pain question, not the pitch. Both mention "clientes", so
  // assert on what separates them.
  assert.match(body, /busqueda de mas clientes/)
  assert.doesNotMatch(body, /sistema propio/)
})

test('confirming the profile never skips ahead to the pitch', () => {
  // Regression: quick replies were keyed by destination stage, so a lead
  // confirming they run a tech company got pitched immediately — without ever
  // being asked about the pain. The whole method is that ordering.
  for (const mode of ['assisted', 'autopilot'] as OrchestratorMode[]) {
    const d = orchestrate(conversation(), classification('confirms'), policy({ mode }), NOW)
    assert.doesNotMatch(d.action.kind === 'send' ? d.action.body : '', /sistema propio/, mode)
  }
})

test('reaching a terminal stage sends nothing, it just stops', () => {
  for (const intent of ['not_interested', 'books'] as const) {
    const d = orchestrate(conversation(), classification(intent), policy({ mode: 'autopilot' }), NOW)
    assert.equal(d.action.kind, 'none', intent)
  }
})

test('low confidence revokes autonomy even in autopilot', () => {
  const shaky = orchestrate(conversation(), classification('confirms', 0.6), policy({ mode: 'autopilot' }), NOW)
  assert.equal(shaky.action.kind, 'suggest')

  const useless = orchestrate(conversation(), classification('confirms', 0.2), policy({ mode: 'autopilot' }), NOW)
  assert.equal(useless.action.kind, 'handoff')
})

test('the pitch is never sent unattended, even at full confidence on autopilot', () => {
  const d = orchestrate(
    conversation({ stage: 'qualifying_pain' }),
    classification('shares_pain', 1),
    policy({ mode: 'autopilot' }),
    NOW,
  )
  assert.equal(d.nextStage, 'pitching')
  assert.equal(d.action.kind, 'suggest')
})

test('questions and objections reach a human regardless of mode', () => {
  for (const mode of ['copilot', 'assisted', 'autopilot'] as OrchestratorMode[]) {
    for (const intent of ['asks_question', 'objects', 'unclear'] as const) {
      const d = orchestrate(conversation(), classification(intent), policy({ mode }), NOW)
      assert.equal(d.action.kind, 'handoff', `${mode} + ${intent}`)
    }
  }
})

test('it never sends twice without hearing back', () => {
  const d = orchestrate(
    conversation({ history: turns(['lead', 'si'], ['owner', 'y estas buscando clientes?']) }),
    classification('confirms'),
    policy({ mode: 'autopilot' }),
    NOW,
  )
  assert.equal(d.action.kind, 'none')
  assert.match(d.action.kind === 'none' ? d.action.reason : '', /awaiting the lead/)
})

test('a long conversation stops automating and hands over', () => {
  const many: Array<['owner' | 'lead', string]> = []
  for (let i = 0; i < 8; i++) many.push(['owner', `m${i}`], ['lead', `r${i}`])

  const d = orchestrate(
    conversation({ history: turns(...many) }),
    classification('confirms'),
    policy({ mode: 'autopilot' }),
    NOW,
  )
  assert.equal(d.action.kind, 'handoff')
})

test('an opted-out contact produces nothing at all', () => {
  const d = orchestrate(
    conversation({ optedOut: true }),
    classification('confirms'),
    policy({ mode: 'autopilot' }),
    NOW,
  )
  assert.equal(d.action.kind, 'none')
})

test('out-of-hours sends are deferred to the next window, not dropped', () => {
  const saturday = new Date('2026-08-08T14:00:00Z')
  const history = turns(['owner', 'tenes una empresa?'], ['lead', 'si'])
  const d = orchestrate(
    conversation({ history }),
    classification('confirms'),
    policy({ mode: 'autopilot' }),
    saturday,
  )
  assert.equal(d.action.kind, 'send')
  const sendAt = d.action.kind === 'send' ? d.action.sendAt : saturday
  assert.ok(sendAt > saturday)
  assert.equal(sendAt.getUTCDay(), 1) // Monday
})

test('a lead left waiting overnight gets the delay acknowledged', () => {
  const yesterday = new Date(NOW.getTime() - 30 * 60 * 60 * 1000)
  const history: ConversationTurn[] = [
    { from: 'owner', body: 'tenes una empresa de tecnologia?', at: new Date(yesterday.getTime() - 60_000) },
    { from: 'lead', body: 'si, de desarrollo', at: yesterday },
  ]
  const d = orchestrate(conversation({ history }), classification('confirms'), policy({ mode: 'autopilot' }), NOW)
  assert.match(d.action.kind === 'send' ? d.action.body : '', /Estuve de viaje/)
})

test('a terminal stage produces nothing', () => {
  const d = orchestrate(conversation({ stage: 'booked' }), classification('confirms'), policy(), NOW)
  assert.equal(d.action.kind, 'none')
})

test('the decision trail explains every downgrade', () => {
  const d = orchestrate(conversation(), classification('confirms', 0.5), policy({ mode: 'autopilot' }), NOW)
  assert.ok(d.notes.length > 0)
  assert.ok(d.notes.some((n) => n.includes('confianza')))
})

test('an unparseable model response is treated as unclear, not guessed at', () => {
  const c = parseClassification('lo siento, no puedo')
  assert.equal(c.intent, 'unclear')
  assert.equal(c.confidence, 0)
})

test('an unknown intent label gets zero confidence rather than being trusted', () => {
  const c = parseClassification('{"intent":"maybe_interested","confidence":0.99}')
  assert.equal(c.intent, 'unclear')
  assert.equal(c.confidence, 0)
})

test('signals are extracted, and invented nulls are dropped', () => {
  const c = parseClassification(
    '{"intent":"shares_pain","confidence":0.9,"signals":{"pain":"tengo dos clientes pero no puedo crecer","company":"null","timeline":""},"rationale":"nombra el problema"}',
  )
  assert.equal(c.intent, 'shares_pain')
  assert.equal(c.signals.pain, 'tengo dos clientes pero no puedo crecer')
  assert.equal(c.signals.company, undefined)
  assert.equal(c.signals.timeline, undefined)
})

test('confidence outside 0-1 is clamped instead of trusted', () => {
  assert.equal(parseClassification('{"intent":"confirms","confidence":5}').confidence, 1)
  assert.equal(parseClassification('{"intent":"confirms","confidence":-2}').confidence, 0)
  assert.equal(parseClassification('{"intent":"confirms","confidence":"mucha"}').confidence, 0)
})
