import { chromium, type BrowserContext, type Page } from 'playwright-core'

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
  await page.goto(URLS.feed, { waitUntil: 'domcontentloaded' })

  const authWall = await page.locator(anyOf(SELECTORS.authWall)).count()
  if (authWall > 0) {
    throw new AdapterError(
      'auth',
      'LinkedIn está pidiendo login o verificación. Abrí el perfil de Chrome a mano, resolvelo, y volvé a arrancar el agente.',
      await capture(page, screenshotDir, 'auth-wall'),
    )
  }

  const signedIn = await page
    .locator(anyOf(SELECTORS.loggedIn))
    .first()
    .waitFor({ state: 'attached', timeout: 15_000 })
    .then(() => true)
    .catch(() => false)

  if (!signedIn) {
    throw new AdapterError(
      'auth',
      'No se encontró la sesión iniciada. Si LinkedIn cambió el DOM, revisá SELECTORS.loggedIn.',
      await capture(page, screenshotDir, 'not-signed-in'),
    )
  }
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
