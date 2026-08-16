#!/usr/bin/env node
/**
 * One command.
 *
 *   npm start
 *
 * Works out what is missing, does it, and then runs the agent and the panel
 * together. Six commands in the right order, each of which fails differently
 * when skipped, is a setup people abandon halfway — and a half-configured
 * install looks identical to a working one right up until nothing happens.
 *
 * Ctrl-C stops both processes.
 */

import { spawn } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'

import { parseEnv } from './setup-validate.mjs'
import { plan } from './start-plan.mjs'

const ENV_PATH = '.env'

function env() {
  return existsSync(ENV_PATH) ? parseEnv(readFileSync(ENV_PATH, 'utf8')) : {}
}

/** Runs a command to completion, with its output going straight to the terminal. */
function run(command, args, { quiet = false } = {}) {
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      stdio: quiet ? ['ignore', 'pipe', 'pipe'] : 'inherit',
      shell: process.platform === 'win32',
    })
    let output = ''
    child.stdout?.on('data', (d) => (output += d))
    child.stderr?.on('data', (d) => (output += d))
    child.on('close', (code) => resolve({ code: code ?? 1, output }))
  })
}

/** Runs a long-lived process, tagging every line so two streams stay readable. */
function tail(name, command, args, colour) {
  const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'], shell: process.platform === 'win32' })
  const prefix = `${colour}${name}[0m`

  for (const stream of [child.stdout, child.stderr]) {
    let buffer = ''
    stream.on('data', (chunk) => {
      buffer += chunk
      const lines = buffer.split('\n')
      buffer = lines.pop() ?? ''
      for (const line of lines) if (line.trim()) console.log(`${prefix} ${line}`)
    })
  }
  return child
}

// Run from the wrong directory this fails as an npm ENOENT about a missing
// package.json, which reads like a broken install rather than a wrong `cd`.
// It is the single easiest mistake to make and the least obvious to diagnose.
if (!existsSync('package.json') || !readFileSync('package.json', 'utf8').includes('"linkfy"')) {
  console.error('❌ Este comando se corre desde la carpeta del proyecto.')
  console.error(`   Estás en: ${process.cwd()}`)
  console.error('\n   Probá:')
  console.error('   cd ~/Documents/Linkfy   (o donde lo hayas clonado)')
  console.error('   npm start\n')
  process.exit(1)
}

console.log('\nLinkfy')
console.log('══════\n')

// Built first: every step below runs compiled code, and a stale build fails in
// ways that look like configuration problems.
console.log('Compilando…')
const build = await run('npm', ['run', 'build'], { quiet: true })
if (build.code !== 0) {
  console.error('❌ No compiló.\n')
  console.error(build.output.split('\n').slice(-25).join('\n'))
  process.exit(1)
}

for (const step of plan(env(), { hasEnvFile: existsSync(ENV_PATH) })) {
  console.log(`\n▸ ${step.label}`)

  const command =
    step.id === 'setup'
      ? ['run', 'setup']
      : step.id === 'migrate'
        ? ['run', 'db:push']
        : ['run', 'init']

  const result = await run('npm', command)
  if (result.code !== 0) {
    console.error(`\n❌ Falló: ${step.label}`)
    console.error('   Arreglá eso y volvé a correr `npm start`.\n')
    process.exit(1)
  }
}

// Re-read: setup and init both write to it, and the values they wrote are what
// the next check depends on.
const configured = env()
if (!configured.LINKFY_ACCOUNT_ID && !configured.DONEFY_ACCOUNT_ID) {
  console.error('\n❌ La cuenta no quedó conectada. Corré `npm run init` y fijate qué dice.\n')
  process.exit(1)
}

const automations = await run('npm', ['run', 'automation'], { quiet: true })
if (automations.output.includes('No hay automatizaciones')) {
  console.log('\n⚠️  No tenés ninguna automatización todavía, así que el agente no va a mirar ningún post.')
  console.log('   Creá una en otra terminal:')
  console.log('   npm run automation -- --nueva "Guía" --palabra guia --post <url> --agenda <tu link>\n')
}

console.log('\n✅ Todo listo. Arrancando.\n')
console.log('   Panel:  http://localhost:3000')
console.log('   Ctrl-C para parar los dos.\n')

const agent = tail('agente', 'npm', ['run', 'agent'], '[35m')
const panel = tail('panel ', 'npm', ['run', 'dev', '-w', '@linkfy/web'], '[36m')

let stopping = false
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    if (stopping) return
    stopping = true
    console.log('\nParando…')
    agent.kill('SIGINT')
    panel.kill('SIGINT')
  })
}

// If either half dies on its own, the other is not much use — and two windows
// where one is silently dead is worse than a clean stop.
for (const [name, child] of [['El agente', agent], ['El panel', panel]]) {
  child.on('close', (code) => {
    if (stopping) return
    stopping = true
    if (code !== 0) console.error(`\n❌ ${name} se cerró con error.`)
    agent.kill('SIGINT')
    panel.kill('SIGINT')
    process.exit(code ?? 0)
  })
}
