/**
 * Reports which selectors actually match on the live site.
 *
 * Selectors are the one part of this codebase that cannot be verified without
 * a signed-in browser on a real machine, so this exists to close that loop: it
 * visits each page, tries every candidate in SELECTORS, and prints what hit and
 * what missed. Paste the output back and the misses become a one-file fix.
 *
 *   npm run inspect-dom -w @donefy/agent
 *   npm run inspect-dom -w @donefy/agent -- https://www.linkedin.com/posts/xxx
 *
 * Reports counts and element tag names only — never anyone's content.
 */

import type { BrowserContext, Page } from 'playwright'

import { agentConfig, loadEnv, resolveBrowser } from '../config.js'
import { launchBrowser } from '../linkedin/browser.js'
import { SELECTORS, URLS } from '../linkedin/selectors.js'

loadEnv()

const { profilePath, screenshotDir, headless } = agentConfig()
const postUrl = process.argv[2]

const browser = resolveBrowser()
let context: BrowserContext
try {
  context = await launchBrowser({
    profilePath,
    executablePath: browser.executablePath,
    headless,
    screenshotDir,
  })
} catch (error) {
  console.error('❌ No se pudo abrir el navegador:', error instanceof Error ? error.message : error)
  process.exit(1)
}

const page = context.pages()[0] ?? (await context.newPage())

/** Prints hit/miss for one selector group. */
async function probe(label: string, groups: Record<string, readonly string[]>) {
  console.log(`\n── ${label} ──`)
  for (const [name, selectors] of Object.entries(groups)) {
    const results: string[] = []
    for (const selector of selectors) {
      const count = await page.locator(selector).count().catch(() => 0)
      results.push(`${count > 0 ? '✅' : '  '} ${String(count).padStart(3)}  ${selector}`)
    }
    const anyHit = results.some((r) => r.startsWith('✅'))
    console.log(`\n  ${anyHit ? '✅' : '❌'} ${name}`)
    for (const line of results) console.log(`     ${line}`)
  }
}

try {
  console.log(`Navegando al feed…`)
  await page.goto(URLS.feed, { waitUntil: 'domcontentloaded' })
  await page.waitForTimeout(3000)
  console.log(`URL final: ${page.url()}`)

  await probe('Sesión', { loggedIn: SELECTORS.loggedIn, authWall: SELECTORS.authWall })

  console.log('\nNavegando a invitaciones enviadas…')
  await page.goto(URLS.sentInvitations, { waitUntil: 'domcontentloaded' })
  await page.waitForTimeout(3000)
  await probe('Invitaciones enviadas', SELECTORS.invitationsSent)

  console.log('\nNavegando a mensajes…')
  await page.goto(URLS.messaging, { waitUntil: 'domcontentloaded' })
  await page.waitForTimeout(3000)
  await probe('Mensajería', SELECTORS.messaging)

  if (postUrl) {
    console.log(`\nNavegando a la publicación…`)
    await page.goto(postUrl, { waitUntil: 'domcontentloaded' })
    await page.waitForTimeout(3000)
    await probe('Publicación', SELECTORS.post)
  } else {
    console.log('\n⚠️  Sin URL de publicación: los selectores de comentarios no se probaron.')
    console.log('   Volvé a correr con la URL de un post tuyo que tenga comentarios:')
    console.log('   npm run inspect-dom -w @donefy/agent -- https://www.linkedin.com/posts/...')
  }

  console.log('\n─────────────────────────────────────')
  console.log('Copiá todo esto y pegámelo. Con los ❌ ajusto los selectores.')
} catch (error) {
  console.error('\n❌ Error:', error instanceof Error ? error.message : error)
  process.exitCode = 1
} finally {
  await page.waitForTimeout(1000)
  await context.close()
}
