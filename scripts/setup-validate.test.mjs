import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  parseEnv,
  renderEnv,
  validateAnthropicKey,
  validateDatabaseUrl,
} from './setup-validate.mjs'

test('the unsubstituted password placeholder is caught at entry', () => {
  // Supabase hands you the URI with [YOUR-PASSWORD] in it. Pasted as-is, it
  // fails much later as an authentication error that says nothing about the
  // real cause, so it is worth catching at the moment it is typed.
  const raw = 'postgresql://postgres:[YOUR-PASSWORD]@db.abc.supabase.co:5432/postgres'
  assert.match(validateDatabaseUrl(raw) ?? '', /YOUR-PASSWORD/)
  assert.match(validateDatabaseUrl(raw.replace('YOUR-PASSWORD', 'PASSWORD')) ?? '', /YOUR-PASSWORD/)
})

test('a complete connection string is accepted', () => {
  assert.equal(
    validateDatabaseUrl(
      'postgresql://postgres.rzqym:sup3rs3cret@aws-0-us-east-1.pooler.supabase.com:5432/postgres',
    ),
    null,
  )
})

test('the direct-connection host is caught before it fails as a DNS error', () => {
  // It resolves over IPv6 only, so from a home connection it dies as
  // ENOTFOUND — which reads like the project does not exist. The pooler host
  // is the one that works, and Supabase offers both on the same screen.
  const direct = 'postgresql://postgres:clave@db.rzqymqbzegnasyeaaxtc.supabase.co:5432/postgres'
  assert.match(validateDatabaseUrl(direct) ?? '', /Session pooler/)

  assert.equal(
    validateDatabaseUrl(
      'postgresql://postgres.rzqymqbzegnasyeaaxtc:clave@aws-0-us-east-1.pooler.supabase.com:5432/postgres',
    ),
    null,
  )
})

test('something that is not a connection string is rejected with a reason', () => {
  assert.match(validateDatabaseUrl('') ?? '', /valor/)
  assert.match(validateDatabaseUrl('rzqymqbzegnasyeaaxtc') ?? '', /postgresql/)
  assert.match(validateDatabaseUrl('postgresql://sin-arroba') ?? '', /completa/)
})

test('the Anthropic key is checked for shape', () => {
  assert.equal(validateAnthropicKey('sk-ant-api03-abcdefghijklmnop'), null)
  assert.match(validateAnthropicKey('abc123') ?? '', /sk-ant-/)
  assert.match(validateAnthropicKey('sk-ant-') ?? '', /incompleta/)
})

test('re-running preserves settings it does not ask about', () => {
  // Someone who set a custom Chrome path or working hours should not lose them
  // by re-running setup to change a key.
  const existing = parseEnv(`
DATABASE_URL="postgresql://old"
CHROME_EXECUTABLE_PATH="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
AGENT_ACTIVE_HOURS="08:00-20:00"
`)

  const rendered = renderEnv({
    databaseUrl: 'postgresql://new:pass@host:5432/db',
    anthropicKey: 'sk-ant-new',
    existing,
  })

  assert.match(rendered, /CHROME_EXECUTABLE_PATH="\/Applications\/Google Chrome/)
  assert.match(rendered, /AGENT_ACTIVE_HOURS="08:00-20:00"/)
  assert.match(rendered, /DATABASE_URL="postgresql:\/\/new:pass@host:5432\/db"/)
})

test('parsing tolerates the shapes a hand-edited file takes', () => {
  const values = parseEnv(`
# un comentario
DATABASE_URL="postgresql://a"
ANTHROPIC_API_KEY=sk-ant-sin-comillas
AGENT_TICK_SECONDS = 120
`)

  assert.equal(values.DATABASE_URL, 'postgresql://a')
  assert.equal(values.ANTHROPIC_API_KEY, 'sk-ant-sin-comillas')
  assert.equal(values.AGENT_TICK_SECONDS, '120')
})
