import assert from 'node:assert/strict'
import { test } from 'node:test'

import { advance, openingDm, quickReplies, type ConversationStage } from './playbook.js'
import { ENBI_VOICE, commentReply, fitsInviteNote } from './voice.js'

const CTX = { firstName: 'Diego', calendarUrl: 'https://enbiconsulting.com/agenda-software' }

test('the happy path walks the real sales sequence', () => {
  // Mirrors the actual Diego Perez thread: profile -> pain -> pitch -> link.
  const s1 = advance('qualifying_company', 'confirms')
  assert.equal(s1.nextStage, 'qualifying_pain')

  const s2 = advance('qualifying_pain', 'shares_pain')
  assert.equal(s2.nextStage, 'pitching')

  const s3 = advance('pitching', 'requests_link')
  assert.equal(s3.nextStage, 'awaiting_booking')

  const s4 = advance('awaiting_booking', 'books')
  assert.equal(s4.nextStage, 'booked')
})

test('the pitch is never reached before the lead names a problem', () => {
  // The one ordering rule that matters. Confirming you are a tech company is
  // not permission to pitch.
  assert.notEqual(advance('qualifying_company', 'confirms').nextStage, 'pitching')
})

test('volunteering the pain early skips the redundant question', () => {
  const step = advance('qualifying_company', 'shares_pain')
  assert.equal(step.nextStage, 'pitching')
})

test('objections and questions go to a human, never to the model', () => {
  for (const stage of ['qualifying_company', 'qualifying_pain', 'pitching'] as const) {
    for (const intent of ['objects', 'asks_question', 'unclear'] as const) {
      const step = advance(stage, intent)
      assert.equal(step.nextStage, 'handed_off', `${stage} + ${intent}`)
      assert.equal(step.autonomy, 'handoff')
    }
  }
})

test('the pitch itself is only ever suggested, never sent unattended', () => {
  assert.equal(advance('qualifying_pain', 'shares_pain').autonomy, 'suggest')
  assert.equal(advance('qualifying_company', 'shares_pain').autonomy, 'suggest')
})

test('qualifying questions and requested links may go out on their own', () => {
  assert.equal(advance('qualifying_company', 'confirms').autonomy, 'auto')
  assert.equal(advance('pitching', 'requests_link').autonomy, 'auto')
})

test('a disinterested lead is dropped from any stage', () => {
  for (const stage of ['qualifying_company', 'qualifying_pain', 'pitching', 'awaiting_booking'] as const) {
    assert.equal(advance(stage, 'not_interested').nextStage, 'disqualified')
  }
})

test('closed conversations are not reopened by late messages', () => {
  for (const stage of ['booked', 'disqualified', 'handed_off', 'abandoned'] as const) {
    assert.equal(advance(stage, 'confirms').nextStage, stage)
  }
})

test('every live stage offers quick replies, and terminal ones offer none', () => {
  const live: ConversationStage[] = ['qualifying_company', 'qualifying_pain', 'pitching', 'awaiting_booking']
  for (const stage of live) {
    assert.ok(quickReplies(stage, CTX).length > 0, stage)
  }
  assert.equal(quickReplies('booked', CTX).length, 0)
})

test('quick replies carry the calendar link once it is time to send it', () => {
  const bodies = quickReplies('pitching', CTX).map((r) => r.body)
  assert.ok(bodies.some((b) => b.includes(CTX.calendarUrl)))
})

test('a slow reply acknowledges the delay instead of ignoring it', () => {
  const [first] = quickReplies('qualifying_company', { ...CTX, wasSlow: true })
  assert.ok(first && first.body.includes('Estuve de viaje'))
})

test('generated copy keeps the voice: no opening punctuation, short, asks something', () => {
  const messages = [
    openingDm('Diego'),
    ...quickReplies('qualifying_company', CTX).map((r) => r.body),
    ...quickReplies('qualifying_pain', CTX).map((r) => r.body),
  ]
  for (const m of messages) {
    assert.ok(!m.includes('¿'), `opening question mark in: ${m}`)
    assert.ok(!m.includes('¡'), `opening exclamation mark in: ${m}`)
    assert.ok(m.length < 250, `too long: ${m}`)
  }
  assert.ok(openingDm('Diego').startsWith('Buenas Diego!'))
  assert.ok(openingDm('Diego').endsWith('?'))
})

test('the public comment reply stays as short as the real one', () => {
  const reply = commentReply('Wendy')
  assert.equal(reply, 'Wendy enviado')
  assert.ok(reply.length < 30)
})

test('the invite note limit is enforced, not merely documented', () => {
  assert.ok(fitsInviteNote('a'.repeat(300)))
  assert.ok(!fitsInviteNote('a'.repeat(301)))
})

test('the voice profile bans the phrasings that give automation away', () => {
  assert.ok(ENBI_VOICE.avoid.includes('Espero que estés muy bien'))
  assert.ok(ENBI_VOICE.examples.length >= 3)
})
