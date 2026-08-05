/**
 * First-run check: does the browser open, and does LinkedIn see a live session?
 *
 * Everything else in the agent assumes both. Run this once before wiring up
 * anything that sends, because a dead session fails every job in the queue one
 * at a time, and each failure looks like a separate problem.
 *
 *   npm run check-session -w @donefy/agent
 *
 * On first run the profile is empty: a browser window opens, you log into
 * LinkedIn by hand, and the session persists into the profile directory from
 * then on. That login is the only manual step in the whole setup.
 */

import type { BrowserContext } from 'playwright'

import { agentConfig, loadEnv, resolveBrowser } from '../config.js'
import { assertSignedIn, launchBrowser } from '../linkedin/browser.js'
import { AdapterError } from '../linkedin/adapter.js'
import { SELECTORS, URLS, anyOf } from '../linkedin/selectors.js'

loadEnv()

const { profilePath, screenshotDir, headless } = agentConfig()

let browser
try {
  browser = resolveBrowser()
} catch (error) {
  console.error(`❌ ${error instanceof Error ? error.message : String(error)}`)
  process.exit(1)
}

const SOURCE_LABEL = {
  configured: 'configurado en .env',
  detected: 'detectado automáticamente',
  bundled: 'incluido',
} as const

console.log(`Perfil:  ${profilePath}`)
console.log(`Chrome:  ${browser.label}  (${SOURCE_LABEL[browser.source]})`)
console.log(`Modo:    ${headless ? 'headless' : 'con ventana'}`)
console.log('\nAbriendo LinkedIn…\n')

let context: BrowserContext
try {
  context = await launchBrowser({
    profilePath,
    executablePath: browser.executablePath,
    headless,
    screenshotDir,
  })
} catch (error) {
  // Launch failures surface as raw Playwright stack traces, which say nothing
  // useful to whoever is running setup. These are the causes that actually come up.
  const message = error instanceof Error ? error.message : String(error)
  if (/DISPLAY|X server/i.test(message)) {
    console.error('❌ No hay entorno gráfico para abrir el navegador.')
    console.error('   En un servidor o contenedor: HEADLESS=1 npm run check-session -w @donefy/agent')
    console.error('   (en headless no vas a poder loguearte a mano la primera vez)')
  } else if (/Executable doesn't exist|ENOENT/i.test(message)) {
    console.error('❌ No se encontró el navegador.')
    console.error(`   Se intentó: ${browser.label}`)
    console.error('   Si no tenés Chrome instalado, bajá el Chromium de Playwright:')
    console.error('     npx playwright install chromium')
  } else {
    console.error('❌ No se pudo abrir el navegador:', message)
  }
  process.exit(1)
}

const page = context.pages()[0] ?? (await context.newPage())

try {
  await assertSignedIn(page, screenshotDir)
  console.log('✅ Sesión activa.')

  // Reads nothing but the account's own name — enough to prove the selectors
  // resolve against the live DOM without touching anyone else's data.
  const me = await page.locator(anyOf(SELECTORS.loggedIn)).first().getAttribute('alt')
  if (me) console.log(`   Conectado como: ${me}`)

  await page.goto(URLS.sentInvitations, { waitUntil: 'domcontentloaded' })
  const pending = await page.locator(anyOf(SELECTORS.invitationsSent.row)).count()
  console.log(`   Invitaciones pendientes: ${pending}`)

  console.log('\nListo. El perfil queda logueado para las próximas corridas.')
} catch (error) {
  if (error instanceof AdapterError) {
    console.error(`❌ ${error.kind}: ${error.message}`)
    if (error.screenshotPath) console.error(`   Captura: ${error.screenshotPath}`)
    if (error.kind === 'auth' && !headless) {
      console.error('\n   La ventana queda abierta 2 minutos: logueate a mano y volvé a correr esto.')
      await page.waitForTimeout(120_000)
    } else if (error.kind === 'auth') {
      // Nothing to wait for — there is no window to log in through.
      console.error('\n   Corré esto con ventana (sin HEADLESS=1) para poder loguearte.')
    }
  } else {
    console.error('❌ Error inesperado:', error)
  }
  process.exitCode = 1
} finally {
  await context.close()
}
