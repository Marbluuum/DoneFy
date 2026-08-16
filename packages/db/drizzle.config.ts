import { existsSync } from 'node:fs'
import { resolve } from 'node:path'

import type { Config } from 'drizzle-kit'

/**
 * The .env lives at the repo root, while this config runs from packages/db, so
 * nothing loads it by default — drizzle-kit would read an empty DATABASE_URL
 * and fail with a connection error that says nothing about the missing file.
 */
// Resolved from cwd rather than import.meta.dirname: drizzle-kit bundles this
// config before running it, and the module's own path does not survive that.
// Covers being run from packages/db and from the repo root alike.
for (const candidate of ['../../.env', '.env']) {
  const path = resolve(process.cwd(), candidate)
  if (existsSync(path)) {
    process.loadEnvFile(path)
    break
  }
}

// `generate` only reads the schema file and writes SQL, so requiring a database
// to produce a migration would be a barrier with nothing behind it.
const needsConnection = !process.argv.includes('generate')

if (needsConnection && !process.env.DATABASE_URL) {
  throw new Error(
    'Falta DATABASE_URL.\n' +
      '   Corré `npm run setup` en la raíz del proyecto para configurarlo.',
  )
}

export default {
  schema: './src/schema.ts',
  out: './migrations',
  dialect: 'postgresql',
  dbCredentials: { url: process.env.DATABASE_URL ?? '' },
} satisfies Config
