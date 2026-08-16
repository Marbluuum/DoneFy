/**
 * Checks every link in the chain and says which one is broken.
 *
 *   npm run doctor
 *
 * "Nothing happens" is the hardest report to act on, because a dozen different
 * states produce it: no .env, no tables, no account, no automation, an
 * automation with a keyword nobody commented, an agent that is not running, a
 * dead LinkedIn session. Each one is silent on its own, and asking one
 * question at a time to find out which costs a round trip each.
 *
 * So this checks all of them, in the order they depend on each other, and
 * stops at the first that fails — because everything after it would fail too
 * and reporting six problems when there is one is its own kind of noise.
 */

import { count, desc, eq, sql } from 'drizzle-orm'

import {
  automations,
  contacts,
  createDb,
  enrollments,
  jobs,
  linkedinAccounts,
  posts,
} from '@linkfy/db'

import { agentConfig, findEnvFile, isSchemaError, loadEnv, resolveBrowser } from '../config.js'

loadEnv()

const config = agentConfig()
let failed = false

function ok(label: string, detail = '') {
  console.log(`  ✅ ${label}${detail ? `  ${detail}` : ''}`)
}

function bad(label: string, fix: string) {
  console.log(`  ❌ ${label}`)
  console.log(`     → ${fix}`)
  failed = true
}

function warn(label: string, detail: string) {
  console.log(`  ⚠️  ${label}`)
  console.log(`     ${detail}`)
}

console.log('\nLinkfy — diagnóstico')
console.log('════════════════════\n')

// --- 1. configuration ------------------------------------------------------
console.log('Configuración')

const envPath = findEnvFile()
if (!envPath) {
  bad('No encontré ningún .env', 'Corré `npm start` — te lo crea preguntándote los datos.')
} else {
  ok('.env', envPath)
}

if (!failed) {
  if (!config.databaseUrl) bad('Falta DATABASE_URL', 'Corré `npm run setup`.')
  else ok('DATABASE_URL', config.databaseUrl.replace(/:[^:@]+@/, ':••••@'))

  if (!config.anthropicKey) bad('Falta ANTHROPIC_API_KEY', 'Corré `npm run setup`.')
  else ok('ANTHROPIC_API_KEY', `${config.anthropicKey.slice(0, 12)}…`)

  if (!config.accountId) bad('La cuenta no está conectada', 'Corré `npm run init`.')
  else ok('Cuenta configurada', config.accountId)
}

try {
  const browser = resolveBrowser()
  ok('Navegador', browser.label)
} catch (error) {
  bad('Navegador', error instanceof Error ? error.message : String(error))
}

if (failed) finish()

// --- 2. database -----------------------------------------------------------
console.log('\nBase de datos')

const db = createDb(config.databaseUrl)

try {
  await db.execute(sql`select 1`)
  ok('Conexión')
} catch (error) {
  bad(
    'No me pude conectar',
    `${error instanceof Error ? error.message : String(error)}\n     → Revisá DATABASE_URL. Tiene que ser la del "Session pooler", no la "Direct connection".`,
  )
  finish()
}

try {
  // Selecting a recent column rather than counting rows: a table that exists
  // but is missing the columns this version writes fails later, mid-run, as a
  // Postgres error naming something internal.
  await db
    .select({ id: linkedinAccounts.id, synced: linkedinAccounts.postsSyncedAt })
    .from(linkedinAccounts)
    .limit(1)
  ok('Tablas al día')
} catch (error) {
  bad(
    isSchemaError(error) ? 'La base está desactualizada' : 'No pude leer las tablas',
    'Corré `npm run db:push`.',
  )
  finish()
}

// --- 3. account ------------------------------------------------------------
console.log('\nCuenta')

const [account] = await db
  .select({
    id: linkedinAccounts.id,
    identifier: linkedinAccounts.publicIdentifier,
    seen: linkedinAccounts.agentLastSeenAt,
  })
  .from(linkedinAccounts)
  .where(eq(linkedinAccounts.id, config.accountId))
  .limit(1)

if (!account) {
  bad(
    `No existe la cuenta ${config.accountId}`,
    'El LINKFY_ACCOUNT_ID del .env no está en la base. Corré `npm run init` de nuevo.',
  )
  finish()
}

ok('Conectada como', account.identifier)

if (!account.seen) {
  warn('El agente nunca corrió', 'Arrancalo con `npm start` y dejalo abierto.')
} else {
  const minutes = Math.round((Date.now() - account.seen.getTime()) / 60_000)
  if (minutes <= 5) ok('Agente activo', `hace ${minutes} min`)
  else
    warn(
      `El agente no da señales hace ${minutes} min`,
      'Si lo tenés abierto, mirá qué dice esa terminal. Si no, corré `npm start`.',
    )
}

// --- 4. automations --------------------------------------------------------
console.log('\nAutomatizaciones')

const rules = await db
  .select({
    id: automations.id,
    name: automations.name,
    status: automations.status,
    keywords: automations.keywords,
    postIds: automations.postIds,
  })
  .from(automations)
  .where(eq(automations.accountId, account.id))

const active = rules.filter((r) => r.status === 'active')

if (rules.length === 0) {
  bad(
    'No hay ninguna automatización',
    'El agente no tiene qué mirar. Creá una en el panel, en Automatizaciones.',
  )
} else if (active.length === 0) {
  bad(`${rules.length} automatización(es), todas pausadas`, 'Activá una desde el panel.')
} else {
  for (const rule of active) {
    const watched = rule.postIds?.length ?? 0
    ok(rule.name, `palabras: ${(rule.keywords ?? []).join(', ') || '—'} · ${watched || 'todos los'} post(s)`)
    if ((rule.keywords ?? []).length === 0) {
      warn(`"${rule.name}" no tiene palabras clave`, 'Se dispararía con cualquier comentario.')
    }
  }
}

const watchedPosts = await db
  .select({ n: count() })
  .from(posts)
  .where(eq(posts.accountId, account.id))

if ((watchedPosts[0]?.n ?? 0) === 0) {
  warn('No hay ninguna publicación cargada', 'Agregá la URL de un post a una automatización.')
}

// --- 5. what has happened --------------------------------------------------
console.log('\nActividad')

const [people] = await db.select({ n: count() }).from(contacts).where(eq(contacts.accountId, account.id))
console.log(`  ${people?.n ?? 0} persona(s) detectada(s)`)

const byState = await db
  .select({ state: enrollments.state, n: count() })
  .from(enrollments)
  .innerJoin(automations, eq(enrollments.automationId, automations.id))
  .where(eq(automations.accountId, account.id))
  .groupBy(enrollments.state)

if (byState.length === 0) {
  console.log('  Todavía nadie entró al flujo.')
  console.log('  Si ya hay comentarios con tu palabra clave, el agente los toma en el próximo ciclo.')
} else {
  for (const row of byState) console.log(`  ${row.n}  ${row.state}`)
}

const failedJobs = await db
  .select({ type: jobs.type, error: jobs.lastError, at: jobs.createdAt })
  .from(jobs)
  .where(eq(jobs.accountId, account.id))
  .orderBy(desc(jobs.createdAt))
  .limit(50)

const broken = failedJobs.filter((j) => j.error)
if (broken.length > 0) {
  console.log('\n  Últimos errores:')
  for (const job of broken.slice(0, 5)) {
    console.log(`  ⚠️  ${job.type}: ${job.error?.split('\n')[0]}`)
  }
}

finish()

function finish(): never {
  if (failed) {
    console.log('\nArreglá lo marcado con ❌ y volvé a correr `linkfy doctor`.\n')
  } else {
    console.log('\nTodo en orden.\n')
  }

  // Always zero. Finding a problem is this command succeeding — exiting
  // non-zero makes npm print a "Lifecycle script failed" dump underneath the
  // report, which reads as the diagnosis itself having crashed and buries the
  // one line that says what to do.
  process.exit(0)
}
