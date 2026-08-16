/**
 * The agent.
 *
 *   npm run agent -w @linkfy/agent
 *
 * Runs on your machine, drives your own Chrome profile, and never sends a
 * session cookie anywhere. Everything it decides is written to the database,
 * which is what the panel reads.
 *
 * Ctrl-C stops it cleanly: the current cycle finishes and the browser closes,
 * so it never dies holding a job lease.
 */

import { hostname } from 'node:os'

import { ENBI_VOICE, type ConversationStage } from '@linkfy/core'
import { createDb } from '@linkfy/db'

import { agentConfig, loadEnv, parseWorkingHours, resolveBrowser } from '../config.js'
import { launchBrowser } from '../linkedin/browser.js'
import { PlaywrightLinkedInAdapter } from '../linkedin/playwright-adapter.js'
import { classifyReply } from '../llm/classify.js'
import { createLlm } from '../llm/client.js'
import { writeInviteNote } from '../llm/invite-note.js'
import { runLoop } from '../runner/loop.js'
import { DrizzleRepository } from '../runner/repository.js'
import { runTick } from '../runner/tick.js'

loadEnv()

const config = agentConfig()
const missing = [
  !config.databaseUrl && 'DATABASE_URL',
  !config.anthropicKey && 'ANTHROPIC_API_KEY',
].filter(Boolean)

if (missing.length > 0) {
  console.error(`❌ Falta ${missing.join(' y ')} en .env`)
  console.error('   Corré `npm run setup` en la raíz del proyecto.')
  process.exit(1)
}

if (!config.accountId) {
  console.error('❌ Falta LINKFY_ACCOUNT_ID en .env')
  console.error('   Corré `npm run init -w @linkfy/agent` para conectar tu cuenta.')
  process.exit(1)
}

const hours = parseWorkingHours()
const browser = resolveBrowser()

console.log('Linkfy — agente')
console.log('═══════════════')
console.log(`Cuenta:  ${config.accountId}`)
console.log(`Chrome:  ${browser.label}`)
console.log(`Horario: ${hours.startHour}:00–${hours.endHour}:00, días ${hours.activeDays.join(',')} (${hours.timezone})`)
console.log(`Ciclo:   cada ${config.tickSeconds}s`)
console.log('\nCtrl-C para parar.\n')

const db = createDb(config.databaseUrl)
const repo = new DrizzleRepository(db, { timezone: config.timezone })
const llm = createLlm({ apiKey: config.anthropicKey })

const context = await launchBrowser({
  profilePath: config.profilePath,
  executablePath: browser.executablePath,
  headless: config.headless,
})

const linkedin = new PlaywrightLinkedInAdapter({
  context,
  screenshotDir: config.screenshotDir,
})

let running = true
// Two signals rather than one: a terminal Ctrl-C sends SIGINT, but anything
// supervising the process (launchd, a container) sends SIGTERM, and being
// killed mid-cycle leaves a job leased for five minutes for no reason.
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    if (!running) return
    running = false
    console.log('\nTerminando el ciclo actual…')
  })
}

const summary = await runLoop({
  intervalMs: config.tickSeconds * 1000,
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  shouldContinue: () => running,
  log: (message, data) => {
    const stamp = new Date().toLocaleTimeString('es-AR', { timeZone: config.timezone })
    console.log(`[${stamp}] ${message}`, data ?? '')
  },
  tick: () =>
    runTick({
      accountId: config.accountId,
      repo,
      linkedin,
      classifier: {
        // The port keeps `stage` as a string so the runner does not depend on
        // the playbook's vocabulary; this is the one place the two meet.
        classify: (input) =>
          classifyReply(llm, {
            ...input,
            stage: input.stage as ConversationStage,
            voice: ENBI_VOICE,
          }),
      },
      writer: { inviteNote: (input) => writeInviteNote(llm, input) },
      workingHours: hours,
      now: () => new Date(),
      // Identifies this machine when claiming jobs, so a second agent on
      // another machine takes different work rather than the same work.
      leaseHolder: `${hostname()}:${process.pid}`,
      log: (message, data) => console.log(`   ${message}`, data ?? ''),
    }),
})

await linkedin.close()

if (summary.stoppedBecause === 'too_many_failures') {
  console.error(`\n❌ Se cortó después de ${summary.failures} fallas seguidas.`)
  console.error('   Revisá la sesión con `npm run check-session -w @linkfy/agent`.')
  process.exit(1)
}

console.log(`\n✅ Parado. ${summary.ticks} ciclos, ${summary.failures} con error.`)
process.exit(0)
