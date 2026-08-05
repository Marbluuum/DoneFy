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

import type { BrowserContext } from 'playwright-core'

import { assertSignedIn, launchBrowser } from '../linkedin/browser.js'
import { AdapterError } from '../linkedin/adapter.js'
import { SELECTORS, URLS, anyOf } from '../linkedin/selectors.js'

const profilePath = process.env.CHROME_PROFILE_PATH ?? './.chrome-profile'
const executablePath = process.env.CHROME_EXECUTABLE_PATH ?? ''
const screenshotDir = process.env.SCREENSHOT_DIR ?? './screenshots'
// Headed by default: the first run needs a human to log in, and a visible
// window is what a real session looks like. HEADLESS=1 is for servers and CI.
const headless = process.env.HEADLESS === '1'

console.log(`Perfil: ${profilePath}`)
console.log(`Chrome: ${executablePath || '(Chromium incluido — apuntá CHROME_EXECUTABLE_PATH a tu Chrome real)'}`)
console.log(`Modo:   ${headless ? 'headless' : 'con ventana'}`)
console.log('Abriendo LinkedIn…\n')

let context: BrowserContext
try {
  context = await launchBrowser({ profilePath, executablePath, headless, screenshotDir })
} catch (error) {
  // Launch failures surface as raw Playwright stack traces, which say nothing
  // useful to whoever is running setup. The display case is the common one.
  const message = error instanceof Error ? error.message : String(error)
  if (/DISPLAY|X server/i.test(message)) {
    console.error('❌ No hay entorno gráfico disponible para abrir el navegador.')
    console.error('   Si estás en un servidor o contenedor, corré: HEADLESS=1 npm run check-session -w @donefy/agent')
    console.error('   (en headless no vas a poder loguearte a mano la primera vez)')
  } else if (/Executable doesn't exist|ENOENT/i.test(message)) {
    console.error('❌ No se encontró el navegador.')
    console.error(`   CHROME_EXECUTABLE_PATH apunta a: ${executablePath || '(vacío)'}`)
    console.error('   Dejalo vacío para usar el Chromium incluido, o corregí la ruta.')
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

  console.log('\nTodo listo. El perfil queda logueado para las próximas corridas.')
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
