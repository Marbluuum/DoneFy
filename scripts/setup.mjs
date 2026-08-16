#!/usr/bin/env node
/**
 * Interactive setup: asks for the two secrets and writes .env.
 *
 * Editing a dotfile by hand is a real barrier — invisible in Finder, easy to
 * get the quoting wrong, and the failure mode is a value pasted inside another
 * value's quotes with nothing to say so. This asks two questions instead,
 * validates the answers, and writes the file.
 *
 *   npm run setup
 *
 * Existing values are kept unless a new one is entered, so re-running it to
 * change one setting does not wipe the others.
 */

import { createInterface } from 'node:readline/promises'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { stdin, stdout } from 'node:process'

import {
  parseEnv,
  renderEnv,
  validateAnthropicKey,
  validateDatabaseUrl,
} from './setup-validate.mjs'

const ENV_PATH = '.env'

if (!stdin.isTTY) {
  console.error('Este comando es interactivo. Corrélo directamente en la terminal:')
  console.error('   npm run setup')
  process.exit(1)
}

const rl = createInterface({ input: stdin, output: stdout })
// Ctrl-D or a closed pipe should exit cleanly rather than hang on an await
// that will never resolve.
rl.on('close', () => process.exit(0))

const existing = existsSync(ENV_PATH) ? parseEnv(readFileSync(ENV_PATH, 'utf8')) : {}

function mask(value) {
  if (!value) return '(vacío)'
  return value.length <= 12 ? '••••' : `${value.slice(0, 8)}…${value.slice(-4)}`
}

async function ask(label, current, validate) {
  console.log(`\n${label}`)
  if (current) console.log(`   actual: ${mask(current)}  — enter para dejarlo así`)

  for (;;) {
    const answer = (await rl.question('   > ')).trim()
    if (!answer && current) return current

    const error = validate(answer)
    if (error) {
      console.log(`   ⚠️  ${error}`)
      continue
    }
    return answer
  }
}

console.log('\nConfiguración de DoneFy')
console.log('═══════════════════════')

const databaseUrl = await ask(
  '1. URL de Supabase\n   Panel de Supabase → botón "Connect" → Session pooler → copiá la URI\n   Acordate de reemplazar [YOUR-PASSWORD] por tu contraseña.',
  existing.DATABASE_URL,
  validateDatabaseUrl,
)

const anthropicKey = await ask(
  '2. API key de Anthropic\n   console.anthropic.com → API Keys → Create Key',
  existing.ANTHROPIC_API_KEY,
  validateAnthropicKey,
)

rl.close()

writeFileSync(ENV_PATH, renderEnv({ databaseUrl, anthropicKey, existing }), 'utf8')

console.log('\n✅ .env guardado.')
console.log('\nAhora creá las tablas:')
console.log('   npm run db:push\n')
