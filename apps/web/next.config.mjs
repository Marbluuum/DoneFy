import { existsSync } from 'node:fs'
import { resolve } from 'node:path'

/**
 * The .env lives at the repo root, shared with the agent. Next only looks
 * inside the app directory, so without this the panel finds no DATABASE_URL,
 * falls back to the fixtures, and shows demo data forever — while the agent,
 * reading the same file it always did, works fine. Two halves of one product
 * disagreeing about whether it is configured.
 *
 * Both candidates are tried because `next dev` runs from apps/web while
 * `npm run dev -w @linkfy/web` runs from the repo root.
 */
for (const candidate of [
  resolve(import.meta.dirname, '..', '..', '.env'),
  resolve(process.cwd(), '.env'),
]) {
  if (existsSync(candidate)) {
    process.loadEnvFile(candidate)
    break
  }
}

/** @type {import('next').NextConfig} */
const nextConfig = {
  transpilePackages: ['@linkfy/core', '@linkfy/db'],
}

export default nextConfig
