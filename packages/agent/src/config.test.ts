import assert from 'node:assert/strict'
import { test } from 'node:test'

import { DEFAULT_WORKING_HOURS } from '@donefy/core'

import { parseWorkingHours, resolveBrowser } from './config.js'

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
