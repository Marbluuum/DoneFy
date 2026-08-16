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
 *
 * The flow itself lives in setup-flow.mjs; this file is only the readline
 * wiring around it.
 */

import { createInterface } from 'node:readline/promises'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { stdin, stdout } from 'node:process'

import { runSetup } from './setup-flow.mjs'
import { parseEnv } from './setup-validate.mjs'

const ENV_PATH = '.env'

if (!stdin.isTTY) {
  console.error('Este comando es interactivo. Corrélo directamente en la terminal:')
  console.error('   npm run setup')
  process.exit(1)
}

const rl = createInterface({ input: stdin, output: stdout })

// Ctrl-D closes the stream while a question is pending, and that question's
// promise then never resolves — the script would hang with no explanation. So
// the pending question races against the close instead.
//
// It has to be a race rather than a `close` handler that exits: `close` also
// fires on the deliberate rl.close() below, and an exit there ran *before* the
// file was written. The setup looked like it worked and silently produced
// nothing.
const CANCELLED = Symbol('cancelled')
const cancelled = new Promise((resolve) => rl.once('close', () => resolve(CANCELLED)))

async function prompt(question) {
  const answer = await Promise.race([rl.question(question), cancelled])
  if (answer === CANCELLED) {
    console.log('\nCancelado. No se guardó nada.')
    process.exit(0)
  }
  return answer
}

console.log('\nConfiguración de Linkfy')
console.log('═══════════════════════')

await runSetup({
  prompt,
  log: (line) => console.log(line),
  existing: existsSync(ENV_PATH) ? parseEnv(readFileSync(ENV_PATH, 'utf8')) : {},
  write: (contents) => writeFileSync(ENV_PATH, contents, 'utf8'),
})

rl.close()

console.log('\n✅ .env guardado.')
console.log('\nAhora creá las tablas:')
console.log('   npm run db:push\n')
