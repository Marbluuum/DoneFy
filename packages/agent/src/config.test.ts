import assert from 'node:assert/strict'
import { test } from 'node:test'

import { resolveBrowser } from './config.js'

test('a configured path that exists is used as given', () => {
  // Any executable will do — the point is that a real path is honoured.
  const choice = resolveBrowser(process.execPath)
  assert.equal(choice.executablePath, process.execPath)
  assert.equal(choice.source, 'configured')
})

test('a configured path that does not exist fails loudly, not silently', () => {
  // The original bug was the opposite: a wrong or unread value fell through to
  // "bundled", so setup failed later with a message about the wrong thing.
  assert.throws(
    () => resolveBrowser('/Applications/Not Chrome.app/Contents/MacOS/Nope'),
    /no existe/,
  )
})

test('an empty setting falls back rather than erroring', () => {
  // Not configuring anything has to work — that is the default first run.
  const choice = resolveBrowser('')
  assert.ok(['detected', 'bundled'].includes(choice.source))
})

test('whitespace counts as empty', () => {
  // "CHROME_EXECUTABLE_PATH= " in a hand-edited .env is a real thing.
  assert.deepEqual(resolveBrowser('   '), resolveBrowser(''))
})
