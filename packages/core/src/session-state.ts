/**
 * Reading whether a LinkedIn session is alive, from the URL alone.
 *
 * The first version asked whether an avatar element was on the page, which was
 * wrong twice over: it depended on obfuscated class names that rotate, and a
 * renamed class then reported a perfectly healthy account as signed out.
 *
 * A signed-out browser gets *redirected* off /feed/ — to a login page, an auth
 * wall, or a checkpoint. That redirect is behaviour LinkedIn cannot change
 * without changing what the site does, which makes the final URL a far more
 * stable signal than anything in the DOM. Pure, so it is testable against the
 * real URLs without a browser.
 */

export type SessionVerdict =
  | { state: 'signed_in' }
  /** No usable session — needs a human to log in. */
  | { state: 'signed_out'; reason: string }
  /** Session exists but LinkedIn wants verification. Stop; do not retry. */
  | { state: 'checkpoint'; reason: string }
  /** Somewhere unexpected. Treated as not-signed-in, but reported differently. */
  | { state: 'unknown'; reason: string }

/** Paths LinkedIn redirects to when it wants credentials. */
const SIGNED_OUT_PATTERNS = [
  '/login',
  '/uas/login',
  '/authwall',
  '/signup',
  '/home', // the logged-out landing page
] as const

/** Paths meaning "we know who you are, prove it" — a human has to intervene. */
const CHECKPOINT_PATTERNS = ['/checkpoint', '/challenge'] as const

export function readSessionFromUrl(finalUrl: string): SessionVerdict {
  let url: URL
  try {
    url = new URL(finalUrl)
  } catch {
    return { state: 'unknown', reason: `URL ilegible: ${finalUrl}` }
  }

  const path = url.pathname.toLowerCase()

  // Checkpoints first: a challenge URL can also contain "login", and the two
  // need different responses — one is "log in", the other is "go solve this".
  for (const pattern of CHECKPOINT_PATTERNS) {
    if (path.startsWith(pattern)) {
      return {
        state: 'checkpoint',
        reason: 'LinkedIn está pidiendo verificación. Resolvelo a mano en el navegador.',
      }
    }
  }

  for (const pattern of SIGNED_OUT_PATTERNS) {
    if (path === pattern || path.startsWith(`${pattern}/`)) {
      return { state: 'signed_out', reason: `LinkedIn redirigió a ${path}` }
    }
  }

  if (path.startsWith('/feed')) {
    return { state: 'signed_in' }
  }

  return { state: 'unknown', reason: `Se esperaba /feed y se llegó a ${path}` }
}
