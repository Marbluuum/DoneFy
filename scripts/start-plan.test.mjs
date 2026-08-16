import assert from 'node:assert/strict'
import { test } from 'node:test'

import { isReady, plan } from './start-plan.mjs'

const FULL = {
  DATABASE_URL: 'postgresql://postgres.abc:clave@aws-0.pooler.supabase.com:5432/postgres',
  ANTHROPIC_API_KEY: 'sk-ant-api03-lo-que-sea',
  LINKFY_ACCOUNT_ID: '5a2f8c1e-0000-4000-8000-000000000000',
}

const ids = (steps) => steps.map((s) => s.id)

test('a first run does everything, in an order where each step can succeed', () => {
  // The order is the point: connecting the account writes to a table that the
  // migration creates, and the migration needs the connection string the setup
  // asks for. Any other order fails on a step the person did nothing wrong on.
  assert.deepEqual(ids(plan({}, { hasEnvFile: false })), ['setup', 'migrate', 'connect'])
})

test('a configured install only migrates', () => {
  // Schema changes between versions, and a missing column surfaces as a query
  // error that says nothing about a migration — so this runs every time.
  assert.deepEqual(ids(plan(FULL)), ['migrate'])
  assert.equal(isReady(FULL), true)
})

test('half a .env is treated as no .env', () => {
  // A file with a database and no API key is the state you land in by
  // cancelling setup partway. Skipping it because the file exists produces an
  // agent that starts and dies on the first message it tries to write.
  assert.deepEqual(ids(plan({ DATABASE_URL: 'postgresql://x@y/z' })), ['setup', 'migrate', 'connect'])
})

test('an account connected before the rename still counts as connected', () => {
  const old = { ...FULL, LINKFY_ACCOUNT_ID: undefined, DONEFY_ACCOUNT_ID: FULL.LINKFY_ACCOUNT_ID }
  assert.deepEqual(ids(plan(old)), ['migrate'])
})

test('the steps that need a person are marked as such', () => {
  // The runner hands interactive steps the real terminal; capturing their
  // output instead would hang on a prompt nobody can see.
  const steps = plan({}, { hasEnvFile: false })
  assert.deepEqual(
    steps.filter((s) => s.interactive).map((s) => s.id),
    ['setup', 'connect'],
  )
})
