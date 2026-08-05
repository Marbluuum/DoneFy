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

import { assertSignedIn, launchBrowser } from '../linkedin/browser.js'
import { AdapterError } from '../linkedin/adapter.js'
import { SELECTORS, URLS, anyOf } from '../linkedin/selectors.js'

const profilePath = process.env.CHROME_PROFILE_PATH ?? './.chrome-profile'
const executablePath = process.env.CHROME_EXECUTABLE_PATH ?? ''
const screenshotDir = process.env.SCREENSHOT_DIR ?? './screenshots'

const context = await launchBrowser({
  profilePath,
  executablePath,
  headless: false, // headed: you may need to log in, and it is what a person looks like
  screenshotDir,
})

const page = context.pages()[0] ?? (await context.newPage())

console.log(`Perfil: ${profilePath}`)
console.log(`Chrome: ${executablePath || '(Chromium incluido — apuntá CHROME_EXECUTABLE_PATH a tu Chrome real)'}`)
console.log('Abriendo LinkedIn…\n')

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
    if (error.kind === 'auth') {
      console.error('\n   La ventana queda abierta 2 minutos: logueate a mano y volvé a correr esto.')
      await page.waitForTimeout(120_000)
    }
  } else {
    console.error('❌ Error inesperado:', error)
  }
  process.exitCode = 1
} finally {
  await context.close()
}
