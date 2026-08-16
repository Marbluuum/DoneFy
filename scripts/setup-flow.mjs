/**
 * The setup flow — asking, re-asking on a bad answer, and writing the file —
 * kept apart from readline so it can be driven by a scripted `prompt` in a test.
 *
 * The separation exists because of a real bug: the script printed
 * "✅ .env guardado" while writing nothing, and the only way to catch that is a
 * test that asserts the write happened with the values that were typed.
 */

import { renderEnv, validateAnthropicKey, validateDatabaseUrl } from './setup-validate.mjs'

export function mask(value) {
  if (!value) return '(vacío)'
  return value.length <= 12 ? '••••' : `${value.slice(0, 8)}…${value.slice(-4)}`
}

const QUESTIONS = [
  {
    key: 'DATABASE_URL',
    label:
      '1. URL de Supabase\n' +
      '   Panel de Supabase → botón "Connect" → Session pooler → copiá la URI\n' +
      '   Acordate de reemplazar [YOUR-PASSWORD] por tu contraseña.',
    validate: validateDatabaseUrl,
  },
  {
    key: 'ANTHROPIC_API_KEY',
    label: '2. API key de Anthropic\n   console.anthropic.com → API Keys → Create Key',
    validate: validateAnthropicKey,
  },
]

async function askUntilValid({ prompt, log, question, current }) {
  log(`\n${question.label}`)
  if (current) log(`   actual: ${mask(current)}  — enter para dejarlo así`)

  for (;;) {
    const answer = (await prompt('   > ')).trim()
    if (!answer && current) return current

    const error = question.validate(answer)
    if (error) {
      log(`   ⚠️  ${error}`)
      continue
    }
    return answer
  }
}

/**
 * Asks for every setting and writes the file. Returns what was written so the
 * caller does not have to re-read it.
 *
 * @param prompt  asks one line and resolves with the answer
 * @param log     prints a line to the user
 * @param existing values already in .env; a blank answer keeps them
 * @param write   receives the rendered file contents
 */
export async function runSetup({ prompt, log, existing = {}, write }) {
  const answers = {}
  for (const question of QUESTIONS) {
    answers[question.key] = await askUntilValid({
      prompt,
      log,
      question,
      current: existing[question.key],
    })
  }

  const contents = renderEnv({
    databaseUrl: answers.DATABASE_URL,
    anthropicKey: answers.ANTHROPIC_API_KEY,
    existing,
  })

  // Written before the caller tears down its input, so no shutdown path can
  // land between the last answer and the file existing on disk.
  write(contents)
  return contents
}
