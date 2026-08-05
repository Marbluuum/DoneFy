import type { Page } from 'playwright'

import type { PostComment } from './adapter.js'

/**
 * Extraction for the parts of LinkedIn with no usable class names.
 *
 * The feed, comments and invitations now render with hashed CSS-module class
 * names — `.bedba3e3`, `._03b24418` — which change on every LinkedIn deploy.
 * A selector written against those is broken before it ships, so no amount of
 * fallbacks helps: the whole approach has to go for these surfaces.
 *
 * What survives is what the markup has to keep for accessibility and routing:
 * an `aria-label` on the reply button, an `href` shaped like `/in/…`, a `<time>`
 * element. Those describe what an element *is*, so LinkedIn cannot rename them
 * without changing behaviour.
 *
 * The catch is that anchors alone do not give you a comment — you need the
 * container, and the container is exactly what has no name. So instead of
 * naming it, we find it structurally: walk up from a reply button and stop at
 * the highest ancestor still holding exactly one of them. One reply button per
 * comment makes that boundary unambiguous, and it is defined entirely by
 * structure, so a class rename cannot touch it.
 *
 * Messaging still has real class names and keeps using selectors — this runs
 * where that no longer works.
 */

/** Runs in the page. Keep self-contained: no imports, no closures. */
function extractCommentsInPage(replyLabels: string[]): Array<{
  urn: string
  authorHref: string
  authorName: string
  authorHeadline: string
  body: string
  postedAt: string | null
}> {
  const buttons = Array.from(
    document.querySelectorAll<HTMLElement>(
      replyLabels.map((label) => `button[aria-label*="${label}"]`).join(', '),
    ),
  )

  const results: ReturnType<typeof extractCommentsInPage> = []

  for (const button of buttons) {
    // Climb while this subtree still holds exactly one reply button. One more
    // level up and we would have swallowed the sibling comment.
    let container: HTMLElement | null = button.parentElement
    let best: HTMLElement | null = null
    for (let depth = 0; container && depth < 12; depth++) {
      const replies = container.querySelectorAll('button[aria-label*="Responder"], button[aria-label*="Reply"]')
      if (replies.length > 1) break
      best = container
      container = container.parentElement
    }
    if (!best) continue

    const profileLink = best.querySelector<HTMLAnchorElement>('a[href*="/in/"]')
    if (!profileLink) continue

    // The author's name is the link's own text; the headline is the sibling
    // text next to it. Both are read as text so no class is involved.
    const linkText = (profileLink.textContent ?? '').trim().replace(/\s+/g, ' ')
    const authorName = linkText.split('\n')[0]?.trim() ?? ''

    const time = best.querySelector('time')
    const timeValue = time?.getAttribute('datetime') ?? null

    // The comment body is the longest text block that is not the author's name
    // or the action bar. Longest wins because names and buttons are short.
    const candidates = Array.from(best.querySelectorAll<HTMLElement>('span[dir="ltr"], p, div'))
      .map((el) => (el.textContent ?? '').trim().replace(/\s+/g, ' '))
      .filter((text) => text.length > 0 && text !== authorName)
      .filter((text) => !/^(Responder|Reply|Recomendar|Like|Me gusta)$/i.test(text))

    const body = candidates.reduce((longest, text) => (text.length > longest.length ? text : longest), '')

    // Any stable per-comment id LinkedIn exposes; falls back to the href plus
    // a body fingerprint, which is stable enough to dedupe replies against.
    const urn =
      best.getAttribute('data-id') ??
      best.getAttribute('data-urn') ??
      best.querySelector('[data-id]')?.getAttribute('data-id') ??
      `${profileLink.getAttribute('href')}#${body.slice(0, 40)}`

    // A headline sits between the name and the body — shorter than the body,
    // longer than a button label.
    const headline =
      candidates.find((text) => text !== body && text.length > 3 && text.length < 200) ?? ''

    results.push({
      urn,
      authorHref: profileLink.getAttribute('href') ?? '',
      authorName,
      authorHeadline: headline,
      body,
      postedAt: timeValue,
    })
  }

  return results
}

const REPLY_LABELS = ['Responder', 'Reply']

export async function extractComments(page: Page): Promise<PostComment[]> {
  const raw = await page.evaluate(extractCommentsInPage, REPLY_LABELS)

  return raw
    .map((item) => ({
      urn: item.urn,
      authorPublicIdentifier: publicIdentifierFromHref(item.authorHref),
      authorName: item.authorName,
      authorHeadline: item.authorHeadline || undefined,
      body: item.body,
      postedAt: item.postedAt ? new Date(item.postedAt) : undefined,
    }))
    .filter((c) => c.authorPublicIdentifier && c.body)
}

/**
 * `/in/martin-bufczyk/` → `martin-bufczyk`.
 *
 * Exported and pure because it is the one piece of this file that can be
 * tested without a browser, and it is the identifier every dedup rule keys on.
 */
export function publicIdentifierFromHref(href: string): string {
  const match = href.match(/\/in\/([^/?#]+)/)
  return match?.[1] ? decodeURIComponent(match[1]) : ''
}

/**
 * The send button in the message composer.
 *
 * Six buttons matched inside the form and none carried a usable label, so it
 * is identified by position instead: the last button in the composer, which is
 * where send sits in every LinkedIn layout to date. Verified by reading the
 * live form rather than assumed.
 */
export async function findSendButton(page: Page) {
  const inForm = page.locator('form.msg-form button').last()
  if (await inForm.count()) return inForm

  return page.locator('button[aria-label*="Enviar"], button[aria-label*="Send"]').last()
}
