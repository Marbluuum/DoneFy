import { accessSync, constants } from 'node:fs'

import { DEFAULT_WORKING_HOURS, type WorkingHours } from '@donefy/core'

/**
 * Loads `.env` and works out which browser to drive.
 *
 * Both halves exist because setup should not require getting configuration
 * right before anything runs. The first version read `process.env` directly and
 * nothing ever loaded the file, so a correctly filled `.env` was silently
 * ignored — the worst kind of setup failure, because the user did their part.
 */

/** Node's own .env loader — no dependency, and a missing file is fine. */
export function loadEnv(path = '.env'): void {
  try {
    process.loadEnvFile(path)
  } catch {
    // No .env is a normal state: the defaults below cover the first run.
  }
}

/** Where Chrome actually installs, per platform. */
const CHROME_PATHS: Record<string, string[]> = {
  darwin: [
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary',
    '/Applications/Chromium.app/Contents/MacOS/Chromium',
  ],
  win32: [
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  ],
  linux: ['/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/bin/chromium'],
}

export type BrowserChoice = {
  /** Empty string means "use Playwright's bundled Chromium". */
  executablePath: string
  /** Where the choice came from, for the setup output. */
  source: 'configured' | 'detected' | 'bundled'
  label: string
}

/**
 * Picks the browser without requiring configuration.
 *
 * Real Chrome is preferred over bundled Chromium — a genuine profile,
 * fingerprint and build string beat an approximation of one — so an installed
 * Chrome is found automatically rather than waiting to be pointed at.
 */
export function resolveBrowser(configured = process.env.CHROME_EXECUTABLE_PATH ?? ''): BrowserChoice {
  const trimmed = configured.trim()

  if (trimmed) {
    if (!exists(trimmed)) {
      throw new Error(
        `CHROME_EXECUTABLE_PATH apunta a "${trimmed}", que no existe.\n` +
          '   Dejalo vacío en .env para que se detecte solo, o corregí la ruta.',
      )
    }
    return { executablePath: trimmed, source: 'configured', label: trimmed }
  }

  const detected = (CHROME_PATHS[process.platform] ?? []).find(exists)
  if (detected) {
    return { executablePath: detected, source: 'detected', label: detected }
  }

  return {
    executablePath: '',
    source: 'bundled',
    label: 'Chromium incluido con Playwright',
  }
}

function exists(path: string): boolean {
  try {
    accessSync(path, constants.X_OK)
    return true
  } catch {
    return false
  }
}

export function agentConfig() {
  return {
    profilePath: process.env.CHROME_PROFILE_PATH ?? './.chrome-profile',
    screenshotDir: process.env.SCREENSHOT_DIR ?? './screenshots',
    headless: process.env.HEADLESS === '1',
    timezone: process.env.AGENT_TIMEZONE ?? DEFAULT_WORKING_HOURS.timezone,
    tickSeconds: positiveInt(process.env.AGENT_TICK_SECONDS, 90),
    databaseUrl: process.env.DATABASE_URL ?? '',
    anthropicKey: process.env.ANTHROPIC_API_KEY ?? '',
    accountId: process.env.DONEFY_ACCOUNT_ID ?? '',
    ownerEmail: process.env.DONEFY_EMAIL ?? '',
  }
}

/**
 * Working hours from `.env`.
 *
 * A malformed value falls back to the default rather than throwing: the agent
 * refusing to start because someone typed `9-19` instead of `09:00-19:00` is a
 * worse outcome than it running on sensible hours, and the value is echoed at
 * startup so a wrong one is visible.
 */
export function parseWorkingHours(
  hours = process.env.AGENT_ACTIVE_HOURS ?? '',
  days = process.env.AGENT_ACTIVE_DAYS ?? '',
  timezone = process.env.AGENT_TIMEZONE ?? '',
): WorkingHours {
  const match = hours.trim().match(/^(\d{1,2})(?::\d{2})?\s*-\s*(\d{1,2})(?::\d{2})?$/)
  const startHour = match ? Number(match[1]) : DEFAULT_WORKING_HOURS.startHour
  const endHour = match ? Number(match[2]) : DEFAULT_WORKING_HOURS.endHour

  const parsedDays = days
    .split(',')
    .map((d) => Number(d.trim()))
    .filter((d) => Number.isInteger(d) && d >= 1 && d <= 7)

  const valid = startHour >= 0 && startHour <= 23 && endHour >= 0 && endHour <= 23 && startHour < endHour

  return {
    timezone: timezone.trim() || DEFAULT_WORKING_HOURS.timezone,
    startHour: valid ? startHour : DEFAULT_WORKING_HOURS.startHour,
    endHour: valid ? endHour : DEFAULT_WORKING_HOURS.endHour,
    activeDays: parsedDays.length > 0 ? parsedDays : DEFAULT_WORKING_HOURS.activeDays,
  }
}

function positiveInt(value: string | undefined, fallback: number): number {
  const parsed = Number(value)
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback
}
