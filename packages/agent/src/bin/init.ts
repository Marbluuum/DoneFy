/**
 * Connects your LinkedIn account to the database.
 *
 *   npm run init -w @linkfy/agent
 *
 * Reads who you are from the live session rather than asking — the browser
 * already knows, and a hand-typed public identifier that does not match the
 * logged-in account produces an agent that appears to work while every dedup
 * and self-comment check silently compares against the wrong person.
 *
 * Writes LINKFY_ACCOUNT_ID into .env so nothing has to be copied by hand.
 */

import { appendFileSync, readFileSync, writeFileSync } from 'node:fs'

import { readSessionFromUrl } from '@linkfy/core'
import { createDb, linkedinAccounts, users } from '@linkfy/db'
import { and, eq } from 'drizzle-orm'

import { agentConfig, loadEnv, resolveBrowser } from '../config.js'
import { launchBrowser, navigate } from '../linkedin/browser.js'

loadEnv()

const config = agentConfig()

if (!config.databaseUrl) {
  console.error('❌ Falta DATABASE_URL.')
  console.error('   Corré `npm run setup` en la raíz del proyecto.')
  process.exit(1)
}

const browser = resolveBrowser()
console.log('Abriendo LinkedIn para ver con qué cuenta estás conectado…\n')

const context = await launchBrowser({
  profilePath: config.profilePath,
  executablePath: browser.executablePath,
  headless: config.headless,
})

const page = context.pages()[0] ?? (await context.newPage())

// /in/me/ redirects to your own profile, so the final URL carries the public
// identifier. No scraping and no parsing of a page that changes every deploy.
await navigate(page, 'https://www.linkedin.com/in/me/')
const finalUrl = page.url()
const verdict = readSessionFromUrl(finalUrl)

if (verdict.state !== 'signed_in') {
  console.error(`\n❌ ${verdict.reason}`)
  console.error('   Corré `npm run check-session -w @linkfy/agent` y logueate una vez.')
  await context.close()
  process.exit(1)
}

const publicIdentifier = finalUrl.match(/\/in\/([^/?#]+)/)?.[1]
if (!publicIdentifier || publicIdentifier === 'me') {
  console.error(`\n❌ No pude leer tu identificador desde ${finalUrl}`)
  await context.close()
  process.exit(1)
}

const displayName = (await page.title()).split(/[|(]/)[0]?.trim() ?? null
await context.close()

const db = createDb(config.databaseUrl)
const email = config.ownerEmail || `${publicIdentifier}@linkfy.local`

const [user] = await db
  .insert(users)
  .values({ email, name: displayName })
  .onConflictDoUpdate({ target: users.email, set: { name: displayName } })
  .returning({ id: users.id })

const [created] = await db
  .insert(linkedinAccounts)
  .values({ userId: user!.id, publicIdentifier, displayName })
  .onConflictDoNothing({ target: [linkedinAccounts.userId, linkedinAccounts.publicIdentifier] })
  .returning({ id: linkedinAccounts.id })

const accountId =
  created?.id ??
  (
    await db
      .select({ id: linkedinAccounts.id })
      .from(linkedinAccounts)
      .where(
        and(
          eq(linkedinAccounts.userId, user!.id),
          eq(linkedinAccounts.publicIdentifier, publicIdentifier),
        ),
      )
      .limit(1)
  )[0]!.id

writeAccountId(accountId)

console.log(`✅ Cuenta conectada: ${displayName ?? publicIdentifier} (${publicIdentifier})`)
console.log(`   LINKFY_ACCOUNT_ID guardado en .env`)
console.log('\nAhora creá una automatización y arrancá el agente:')
console.log('   npm run agent -w @linkfy/agent\n')

process.exit(0)

/** Replaces the line if it exists so re-running does not stack duplicates. */
function writeAccountId(id: string): void {
  const line = `LINKFY_ACCOUNT_ID="${id}"`
  let contents = ''
  try {
    contents = readFileSync('.env', 'utf8')
  } catch {
    appendFileSync('.env', `\n${line}\n`)
    return
  }

  if (/^LINKFY_ACCOUNT_ID=.*$/m.test(contents)) {
    writeFileSync('.env', contents.replace(/^LINKFY_ACCOUNT_ID=.*$/m, line), 'utf8')
  } else {
    writeFileSync('.env', `${contents.trimEnd()}\n\n# --- Cuenta ---\n${line}\n`, 'utf8')
  }
}
