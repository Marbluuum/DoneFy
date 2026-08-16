import assert from 'node:assert/strict'
import { test } from 'node:test'

import { DEFAULT_WORKING_HOURS } from '@linkfy/core'

import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { findEnvFile, isSchemaError, parseWorkingHours, resolveBrowser } from './config.js'

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

test('las horas de trabajo toleran lo que uno escribe a mano', () => {
  // A wrong value here is silent: the agent simply never acts. Falling back to
  // the default and echoing it at startup beats refusing to boot over a typo.
  assert.deepEqual(parseWorkingHours('09:00-19:00', '1,2,3,4,5', 'America/Argentina/Buenos_Aires'), {
    timezone: 'America/Argentina/Buenos_Aires',
    startHour: 9,
    endHour: 19,
    activeDays: [1, 2, 3, 4, 5],
  })

  assert.equal(parseWorkingHours('9-19').startHour, 9, 'sin los minutos también')
  assert.equal(parseWorkingHours('cualquier cosa').startHour, DEFAULT_WORKING_HOURS.startHour)
  assert.equal(parseWorkingHours('19:00-09:00').startHour, DEFAULT_WORKING_HOURS.startHour, 'invertido = default')
  assert.deepEqual(parseWorkingHours('', 'lunes,martes').activeDays, DEFAULT_WORKING_HOURS.activeDays)
  assert.deepEqual(parseWorkingHours('', '6,7').activeDays, [6, 7], 'el fin de semana es válido')
})

test('the .env is found from inside a workspace, not just from the repo root', () => {
  // npm runs `npm run init -w @linkfy/agent` with the working directory set to
  // packages/agent, while the file lives at the root. Looking only at the
  // current directory reported "Falta DATABASE_URL" on an install that was
  // configured correctly — the person did their part and was told they had not.
  const root = mkdtempSync(join(tmpdir(), 'linkfy-'))
  const workspace = join(root, 'packages', 'agent')
  mkdirSync(workspace, { recursive: true })
  writeFileSync(join(root, '.env'), 'DATABASE_URL="postgresql://x@y/z"\n')

  assert.equal(findEnvFile(workspace), join(root, '.env'))
  assert.equal(findEnvFile(root), join(root, '.env'))
})

test('the nearest .env wins over one further up', () => {
  const root = mkdtempSync(join(tmpdir(), 'linkfy-'))
  const nested = join(root, 'packages', 'agent')
  mkdirSync(nested, { recursive: true })
  writeFileSync(join(root, '.env'), 'DATABASE_URL="raiz"\n')
  writeFileSync(join(nested, '.env'), 'DATABASE_URL="propio"\n')

  assert.equal(findEnvFile(nested), join(nested, '.env'))
})

test('no .env anywhere is not an error', () => {
  // The normal first-run state: setup has not been run yet.
  assert.equal(findEnvFile(mkdtempSync(join(tmpdir(), 'linkfy-'))), null)
})

test('a database one version behind is recognised, not reported as a crash', () => {
  // Postgres reports these as 42703 and 42P01. Raw, they surface as a stack
  // trace naming an internal column, which reads like a bug in the product
  // rather than a migration nobody ran — and that is the difference between
  // someone running one command and someone giving up.
  assert.equal(isSchemaError({ code: '42703' }), true, 'columna que falta')
  assert.equal(isSchemaError({ code: '42P01' }), true, 'tabla que falta')

  assert.equal(isSchemaError({ code: '28P01' }), false, 'contraseña mal: otra cosa')
  assert.equal(isSchemaError(new Error('ENOTFOUND')), false)
  assert.equal(isSchemaError(null), false)
})
