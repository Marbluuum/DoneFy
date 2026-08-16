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

import { agentConfig, loadEnv } from '../config.js'
import { clearDemo, runDemo, seedDemo } from '../demo/simulation.js'

loadEnv()

const config = agentConfig()

if (!config.databaseUrl || !config.accountId) {
  console.error('❌ Falta configuración. Corré `linkfy doctor` para ver qué.')
  process.exit(1)
}

const db = createDb(config.databaseUrl)

const [account] = await db
  .select({ id: linkedinAccounts.id, identifier: linkedinAccounts.publicIdentifier })
  .from(linkedinAccounts)
  .where(eq(linkedinAccounts.id, config.accountId))
  .limit(1)

if (!account) {
  console.error('❌ No encontré tu cuenta. Corré `linkfy init`.')
  process.exit(1)
}

if (process.argv.includes('--limpiar')) {
  const removed = await clearDemo(db, account.id)
  console.log(removed > 0 ? '\n✅ Demo borrada.\n' : '\nNo había ninguna demo.\n')
  process.exit(0)
}

console.log('\nLinkfy — demo')
console.log('═════════════\n')
console.log('Corriendo el motor real contra un LinkedIn simulado.')
console.log('No se toca tu cuenta: no se abre ningún navegador.\n')

await seedDemo(db, account.id)

const { actions } = await runDemo({
  db,
  accountId: account.id,
  timezone: config.timezone,
  log: (message) => console.log(message),
})

console.log('\nLo que hizo:\n')
for (const action of actions) console.log(`  ${action}`)

console.log(`\n✅ Listo. Abrí el panel: http://localhost:${process.env.PANEL_PORT ?? 2500}`)
console.log('   Pipeline, Inbox y Leads ahora tienen esto adentro.')
console.log('\n   Para borrarlo: linkfy demo -- --limpiar\n')

process.exit(0)
