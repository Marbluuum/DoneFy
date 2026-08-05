import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  DEFAULT_IMPORT,
  applyImportedBatch,
  historyFromConversation,
  initialImportState,
  planImportStep,
  shouldStoreContent,
  type ImportState,
} from './history-import.js'
import type { ConversationSummary } from './linkedin/adapter.js'

const NOW = new Date('2026-08-05T14:00:00Z')
const TODAY = '2026-08-05'
const DAY = 24 * 60 * 60 * 1000

function conversation(overrides: Partial<ConversationSummary> = {}): ConversationSummary {
  return {
    threadId: 't1',
    participantPublicIdentifier: 'diego-perez',
    participantName: 'Diego Perez',
    lastMessageAt: new Date(NOW.getTime() - DAY),
    lastMessageFromOwner: false,
    snippet: '...',
    ...overrides,
  }
}

function state(overrides: Partial<ImportState> = {}): ImportState {
  return { ...initialImportState(TODAY), ...overrides }
}

test('the first step fetches a batch from the top of the list', () => {
  const step = planImportStep(state(), DEFAULT_IMPORT, NOW, TODAY)
  assert.equal(step.action, 'fetch')
  assert.equal(step.action === 'fetch' && step.limit, DEFAULT_IMPORT.perBatch)
  assert.equal(step.action === 'fetch' && step.before, undefined)
})

test('later steps page backwards from the oldest conversation seen', () => {
  const cursor = new Date(NOW.getTime() - 30 * DAY)
  const step = planImportStep(state({ oldestSeen: cursor }), DEFAULT_IMPORT, NOW, TODAY)
  assert.equal(step.action === 'fetch' && step.before, cursor)
})

test('the daily allowance stops the import until tomorrow', () => {
  // Reading a whole inbox in one sitting is the mass-retrieval pattern that
  // gets accounts flagged. This is the pacing that avoids it.
  const step = planImportStep(
    state({ importedToday: DEFAULT_IMPORT.perDay }),
    DEFAULT_IMPORT,
    NOW,
    TODAY,
  )
  assert.equal(step.action, 'wait')
})

test('a new day resets the allowance without touching the running total', () => {
  const yesterday = state({ imported: 200, importedToday: 200, today: '2026-08-04' })
  const step = planImportStep(yesterday, DEFAULT_IMPORT, NOW, TODAY)
  assert.equal(step.action, 'fetch')
})

test('the batch never exceeds what is left in the day or in total', () => {
  const nearlyDone = state({
    imported: DEFAULT_IMPORT.maxTotal - 3,
    importedToday: DEFAULT_IMPORT.perDay - 10,
  })
  const step = planImportStep(nearlyDone, DEFAULT_IMPORT, NOW, TODAY)
  assert.equal(step.action === 'fetch' && step.limit, 3)
})

test('the import ends at the total cap and at the age cutoff', () => {
  const capped = planImportStep(
    state({ imported: DEFAULT_IMPORT.maxTotal }),
    DEFAULT_IMPORT,
    NOW,
    TODAY,
  )
  assert.equal(capped.action, 'done')

  const ancient = planImportStep(
    state({ oldestSeen: new Date(NOW.getTime() - 900 * DAY) }),
    DEFAULT_IMPORT,
    NOW,
    TODAY,
  )
  assert.equal(ancient.action, 'done')
})

test('an empty batch means the inbox is exhausted, not that the cap was hit', () => {
  const after = applyImportedBatch(state({ imported: 40 }), [], TODAY)
  assert.equal(after.completed, true)
  assert.equal(planImportStep(after, DEFAULT_IMPORT, NOW, TODAY).action, 'done')
})

test('a batch advances the cursor to its oldest conversation', () => {
  const older = new Date(NOW.getTime() - 60 * DAY)
  const batch = [
    conversation({ threadId: 'a', lastMessageAt: new Date(NOW.getTime() - 2 * DAY) }),
    conversation({ threadId: 'b', lastMessageAt: older }),
  ]

  const after = applyImportedBatch(state(), batch, TODAY)
  assert.equal(after.imported, 2)
  assert.equal(after.importedToday, 2)
  assert.deepEqual(after.oldestSeen, older)
})

test('crossing midnight resets the daily counter as batches land', () => {
  const yesterday = state({ imported: 100, importedToday: 100, today: '2026-08-04' })
  const after = applyImportedBatch(yesterday, [conversation()], TODAY)
  assert.equal(after.imported, 101)
  assert.equal(after.importedToday, 1)
})

test('message bodies are kept only where the playbook could pick the thread up', () => {
  // Metadata is what dedup needs; content is third-party data, so it is kept
  // only for threads that could still become live conversations.
  assert.equal(shouldStoreContent(conversation(), NOW), true)

  // We spoke last — nothing for the playbook to respond to.
  assert.equal(shouldStoreContent(conversation({ lastMessageFromOwner: true }), NOW), false)

  // Long dead.
  assert.equal(
    shouldStoreContent(conversation({ lastMessageAt: new Date(NOW.getTime() - 200 * DAY) }), NOW),
    false,
  )
})

test('imported metadata is enough to block a cold opener to a warm contact', () => {
  // The whole reason the import exists.
  const history = historyFromConversation(conversation())
  assert.equal(history.everMessaged, true)
  assert.equal(history.publicIdentifier, 'diego-perez')
  assert.ok(history.lastContactedAt instanceof Date)
})
