import { readSessionFromUrl } from '@linkfy/core'
import { chromium, type BrowserContext, type Page } from 'playwright'

import { AdapterError } from './adapter.js'
import { SELECTORS, URLS, anyOf } from './selectors.js'

/**
 * The browser the agent drives.
 *
 * Deliberately a *persistent context* rather than a fresh browser per run:
 * cookies, local storage and the profile's fingerprint survive between
 * sessions, so LinkedIn sees the same returning browser it saw yesterday
 * instead of a brand-new one every time the agent wakes up.
 *
 * Point `executablePath` at the real Chrome install and the fingerprint stops
 * being something to fake — it is genuinely that browser, with its fonts, its
 * GPU and its build string. The bundled Chromium works and is the fallback,
 * but real Chrome is the better answer where it exists.
 */

export type BrowserOptions = {
  /** Directory holding the persistent profile. Never commit this — see .gitignore. */
  profilePath: string
  /** Real Chrome if you have it; empty falls back to bundled Chromium. */
  executablePath?: string
  /** Headed is easier to debug and is what a human session looks like. */
  headless?: boolean
  /** Where failure screenshots land. */
  screenshotDir?: string
  locale?: string
  timezone?: string
}

export async function launchBrowser(options: BrowserOptions): Promise<BrowserContext> {
  return chromium.launchPersistentContext(options.profilePath, {
    executablePath: options.executablePath || undefined,
    headless: options.headless ?? false,
    locale: options.locale ?? 'es-AR',
    timezoneId: options.timezone ?? 'America/Argentina/Buenos_Aires',
    viewport: null, // inherit the real window size
    args: [
      // The one automation tell that is visible from page JS and trivial to
      // drop. Everything else about this browser is genuinely a real browser.
      '--disable-blink-features=AutomationControlled',
    ],
  })
}

/**
 * Confirms the profile is signed in.
 *
 * Runs before anything else, every time. The alternative is discovering the
 * session died halfway through a queue and having a run's worth of jobs fail
 * one by one, each one looking like a separate problem.
 */
export async function assertSignedIn(page: Page, screenshotDir?: string): Promise<void> {
  await navigate(page, URLS.feed)

  // Let a redirect settle before reading the URL — LinkedIn bounces signed-out
  // browsers after the initial document loads.
  await page.waitForLoadState('domcontentloaded').catch(() => {})
  const verdict = readSessionFromUrl(page.url())

  if (verdict.state === 'signed_in') return

  if (verdict.state === 'unknown') {
    // Landing somewhere unexpected is more often a slow redirect than a dead
    // session, so give the DOM a chance to say otherwise before failing.
    const navPresent = await page
      .locator(anyOf(SELECTORS.loggedIn))
      .first()
      .waitFor({ state: 'attached', timeout: 10_000 })
      .then(() => true)
      .catch(() => false)
    if (navPresent) return
  }

  const authWall = await page.locator(anyOf(SELECTORS.authWall)).count()
  const message =
    verdict.state === 'checkpoint'
      ? verdict.reason
      : authWall > 0
        ? 'LinkedIn está mostrando la pantalla de login. Logueate en la ventana y volvé a correr esto.'
        : `${verdict.reason}. Logueate en la ventana y volvé a correr esto.`

  throw new AdapterError('auth', message, await capture(page, screenshotDir, 'not-signed-in'))
}

/**
 * Navigates, turning network failures into a classified error.
 *
 * A dropped connection or a slow page is transient — the queue should retry it,
 * and it must not count against account health the way a refused action does.
 * Left unwrapped it surfaces as a raw Playwright stack trace, which tells
 * whoever is watching nothing about what to do.
 */
export async function navigate(page: Page, url: string, timeoutMs = 30_000): Promise<void> {
  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: timeoutMs })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    throw new AdapterError(
      'transient',
      `No se pudo abrir ${url}. ${describeNetworkFailure(message)}`,
    )
  }
}

function describeNetworkFailure(message: string): string {
  if (/ERR_CONNECTION_RESET|ERR_CONNECTION_REFUSED|ERR_NETWORK/i.test(message)) {
    return 'La conexión se cortó — puede ser la red, un proxy o un firewall bloqueando LinkedIn.'
  }
  if (/ERR_NAME_NOT_RESOLVED/i.test(message)) {
    return 'No se resolvió el dominio — revisá la conexión o el DNS.'
  }
  if (/Timeout/i.test(message)) {
    return 'LinkedIn tardó demasiado en responder. Se reintenta más tarde.'
  }
  return message
}

/**
 * First matching selector from the list, or null.
 *
 * Selectors are lists precisely so a LinkedIn redesign degrades to the next
 * fallback instead of failing outright.
 */
export async function findFirst(page: Page, selectors: readonly string[], timeoutMs = 5_000) {
  for (const selector of selectors) {
    const locator = page.locator(selector).first()
    const found = await locator
      .waitFor({ state: 'attached', timeout: timeoutMs / selectors.length })
      .then(() => true)
      .catch(() => false)
    if (found) return locator
  }
  return null
}

/** Same, but a missing element is an error naming the selectors that were tried. */
export async function requireFirst(
  page: Page,
  selectors: readonly string[],
  what: string,
  screenshotDir?: string,
) {
  const locator = await findFirst(page, selectors)
  if (!locator) {
    throw new AdapterError(
      'selector',
      `No se encontró ${what}. Probados: ${selectors.join(' | ')}`,
      await capture(page, screenshotDir, `missing-${what.replace(/\W+/g, '-')}`),
    )
  }
  return locator
}

/**
 * Types like a person: per-character, with variable delay.
 *
 * A contenteditable that receives its full text in one paste-like event does
 * not look like typing, and LinkedIn's composer sometimes fails to register
 * the input at all.
 */
export async function typeHumanly(
  page: Page,
  selector: string,
  text: string,
  random: () => number = Math.random,
): Promise<void> {
  const field = page.locator(selector).first()
  await field.click()
  for (const char of text) {
    await field.type(char, { delay: 25 + random() * 85 })
  }
  await page.waitForTimeout(300 + random() * 700)
}

async function capture(page: Page, dir: string | undefined, name: string): Promise<string | undefined> {
  if (!dir) return undefined
  // A screenshot at the moment of failure is the difference between "the
  // selector broke" and knowing which page it broke on.
  const path = `${dir}/${name}-${Number(new Date())}.png`
  return page
    .screenshot({ path, fullPage: false })
    .then(() => path)
    .catch(() => undefined)
}
