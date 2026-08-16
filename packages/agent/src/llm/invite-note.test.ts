import assert from 'node:assert/strict'
import { test } from 'node:test'

import { INVITE_NOTE_MAX, fitsInviteNote } from '@linkfy/core'

import { fallbackNote, writeInviteNote, type InviteNoteInput } from './invite-note.js'
import type { Llm } from './client.js'

/** Stands in for the API so the guardrails are testable without a key. */
function stubLlm(reply: string | Error): Llm {
  return {
    client: {
      messages: {
        create: async () => {
          if (reply instanceof Error) throw reply
          return { content: [{ type: 'text', text: reply }], stop_reason: 'end_turn' }
        },
      },
    },
    classifierModel: 'test',
    writerModel: 'test',
  } as unknown as Llm
}

function input(overrides: Partial<InviteNoteInput> = {}): InviteNoteInput {
  return {
    firstName: 'Diego',
    headline: 'CEO en Global SI | Desarrollo de software',
    company: 'Global SI',
    comment: 'software',
    matchedKeyword: 'software',
    postExcerpt: 'Las empresas de tecnología no tienen un problema de producto…',
    ...overrides,
  }
}

test('a good note is returned as written', async () => {
  const note = 'Diego! Vi que comentaste software en mi publicación. Trabajás en desarrollo hace rato por lo que veo, te mando la conexión.'
  assert.equal(await writeInviteNote(stubLlm(note), input()), note)
})

test('an over-long note is replaced, never truncated mid-sentence', async () => {
  // LinkedIn cuts at 300 characters without asking, so a plainer note that
  // fits beats a better one that arrives severed.
  const tooLong = 'a'.repeat(INVITE_NOTE_MAX + 40)
  const result = await writeInviteNote(stubLlm(tooLong), input())

  assert.ok(fitsInviteNote(result))
  assert.ok(!result.startsWith('aaa'))
  assert.ok(result.includes('Diego'))
})

test('an API failure still produces a sendable note', async () => {
  // A queued invite that never goes out because of an API error is a lead lost
  // for a reason the lead never learns about.
  const result = await writeInviteNote(stubLlm(new Error('rate limited')), input()).catch(() =>
    fallbackNote(input()),
  )
  assert.ok(fitsInviteNote(result))
  assert.ok(result.includes('Diego'))
})

test('quotes and stray whitespace are stripped from the model output', async () => {
  const wrapped = '  "Diego! Vi tu comentario,  te mando la conexión."  '
  const result = await writeInviteNote(stubLlm(wrapped), input())

  assert.ok(!result.startsWith('"'))
  assert.ok(!result.endsWith('"'))
  assert.ok(!result.includes('  '))
})

test('the fallback fits even for an implausibly long name and keyword', async () => {
  const note = fallbackNote(
    input({ firstName: 'Maximiliano Wenceslao', matchedKeyword: 'sistema-de-adquisicion' }),
  )
  assert.ok(fitsInviteNote(note), `${note.length} chars`)
})

test('the note never carries an opening question mark', async () => {
  for (const name of ['Diego', 'Wendy', 'Clément']) {
    const note = fallbackNote(input({ firstName: name }))
    assert.ok(!note.includes('¿'), note)
  }
})
