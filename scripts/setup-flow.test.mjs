import assert from 'node:assert/strict'
import { test } from 'node:test'

import { runSetup } from './setup-flow.mjs'

/** Answers the questions in order, so a test reads like the session it stands in for. */
function scripted(answers) {
  const queue = [...answers]
  return () => {
    assert.ok(queue.length > 0, 'se pidió una respuesta de más')
    return Promise.resolve(queue.shift())
  }
}

const DB = 'postgresql://postgres.abc:clave@aws-0-us-east-1.pooler.supabase.com:5432/postgres'
const KEY = 'sk-ant-api03-una-key-cualquiera'

test('the answers actually reach the file', async () => {
  // The regression this guards: the script printed "✅ .env guardado" and wrote
  // nothing, because the readline shutdown exited the process first. Everything
  // downstream — db:push, the agent — then failed with "Falta DATABASE_URL",
  // pointing back at the setup that had just said it worked.
  const written = []

  await runSetup({
    prompt: scripted([DB, KEY]),
    log: () => {},
    write: (contents) => written.push(contents),
  })

  assert.equal(written.length, 1)
  assert.match(written[0], /DATABASE_URL="postgresql:\/\/postgres\.abc:clave@/)
  assert.match(written[0], /ANTHROPIC_API_KEY="sk-ant-api03-una-key-cualquiera"/)
})

test('a bad answer is asked again instead of being written', async () => {
  const logged = []
  const written = []

  await runSetup({
    prompt: scripted(['rzqymqbzegnasyeaaxtc', DB, KEY]),
    log: (line) => logged.push(line),
    write: (contents) => written.push(contents),
  })

  assert.ok(
    logged.some((line) => line.includes('postgresql://')),
    'debería explicar por qué no sirve',
  )
  assert.doesNotMatch(written[0], /rzqymqbzegnasyeaaxtc/)
})

test('enter on a question keeps the value already configured', async () => {
  const written = []

  await runSetup({
    prompt: scripted(['', '']),
    log: () => {},
    existing: {
      DATABASE_URL: DB,
      ANTHROPIC_API_KEY: KEY,
      CHROME_EXECUTABLE_PATH: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    },
    write: (contents) => written.push(contents),
  })

  assert.match(written[0], /DATABASE_URL="postgresql:\/\/postgres\.abc:clave@/)
  assert.match(written[0], /ANTHROPIC_API_KEY="sk-ant-api03-una-key-cualquiera"/)
  assert.match(written[0], /CHROME_EXECUTABLE_PATH="\/Applications\/Google Chrome/)
})

test('the current value is shown masked, never in full', async () => {
  const logged = []

  await runSetup({
    prompt: scripted(['', '']),
    log: (line) => logged.push(line),
    existing: { DATABASE_URL: DB, ANTHROPIC_API_KEY: KEY },
    write: () => {},
  })

  const shown = logged.join('\n')
  assert.doesNotMatch(shown, /clave/, 'la contraseña no se imprime en pantalla')
  assert.match(shown, /actual: postgres…/)
})
