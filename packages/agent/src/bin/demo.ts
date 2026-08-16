/**
 * Fills the panel with a run of the real engine against a simulated LinkedIn.
 *
 *   npm run demo
 *   npm run demo -- --limpiar
 *
 * No browser is opened and the account is never touched. The logic doing the
 * work is the same code that runs for real — see demo/simulation.ts.
 */

import { eq } from 'drizzle-orm'

import { createDb, linkedinAccounts } from '@linkfy/db'

import { spawnSync } from 'node:child_process'

import { agentConfig, isSchemaError, loadEnv, writeEnvValue } from '../config.js'
import { clearDemo, ensureDemoAccount, runDemo, seedDemo } from '../demo/simulation.js'

loadEnv()

const config = agentConfig()

if (!config.databaseUrl) {
  console.error('❌ Falta DATABASE_URL. Corré `linkfy doctor` para ver qué.')
  process.exit(1)
}

const db = createDb(config.databaseUrl)

/**
 * The demo provisions its own account when none is connected.
 *
 * Requiring the LinkedIn login first would put the one step nobody can do on
 * your behalf ahead of the thing that shows why it is worth doing — which is
 * exactly where someone stops. `linkfy init` replaces this later.
 */
let accountId = config.accountId
let provisioned = false

if (accountId) {
  const [existing] = await db
    .select({ id: linkedinAccounts.id })
    .from(linkedinAccounts)
    .where(eq(linkedinAccounts.id, accountId))
    .limit(1)
  if (!existing) accountId = ''
}

if (!accountId) {
  accountId = await ensureDemoAccount(db)
  provisioned = true
}

const account = { id: accountId }

if (process.argv.includes('--limpiar')) {
  const removed = await clearDemo(db, account.id)
  console.log(removed > 0 ? '\n✅ Demo borrada.\n' : '\nNo había ninguna demo.\n')
  process.exit(0)
}

console.log('\nLinkfy — demo')
console.log('═════════════\n')
console.log('Corriendo el motor real contra un LinkedIn simulado.')
console.log('No se toca tu cuenta: no se abre ningún navegador.\n')

if (provisioned) {
  writeEnvValue('LINKFY_ACCOUNT_ID', accountId)
  console.log('Todavía no conectaste tu cuenta, así que creé una de demostración.')
  console.log('Cuando corras `linkfy init`, se reemplaza por la tuya.\n')
}

/**
 * Applies pending migrations rather than failing on them.
 *
 * The schema changes as the product does, and a database one version behind
 * fails as a Postgres error naming an internal column — which reads like a bug
 * in the software rather than a command nobody ran. `npm start` already
 * migrates unattended; there is no reason this should be stricter.
 */
async function withSchema<T>(work: () => Promise<T>): Promise<T> {
  try {
    return await work()
  } catch (error) {
    if (!isSchemaError(error)) throw error

    console.log('\nTu base estaba desactualizada. Aplicando el esquema…\n')
    const result = spawnSync('npm', ['run', 'db:push'], { stdio: 'inherit', cwd: process.cwd() })
    if (result.status !== 0) {
      console.error('\n❌ No se pudo actualizar el esquema. Corré `npm run db:push` y mirá qué dice.\n')
      process.exit(1)
    }
    return work()
  }
}

const { actions } = await withSchema(async () => {
  await seedDemo(db, account.id)
  return runDemo({
    db,
    accountId: account.id,
    timezone: config.timezone,
    log: (message) => console.log(message),
  })
})

console.log('\nLo que hizo:\n')
for (const action of actions) console.log(`  ${action}`)

console.log(`\n✅ Listo. Abrí el panel: http://localhost:${process.env.PANEL_PORT ?? 2500}`)
console.log('   Pipeline, Inbox y Leads ahora tienen esto adentro.')
console.log('\n   Para borrarlo: linkfy demo -- --limpiar\n')

process.exit(0)
