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

    const clean = (text: string | null | undefined) => (text ?? '').trim().replace(/\s+/g, ' ')

    // LinkedIn repeats the name inside the link for screen readers — "Wendy
    // Castillo perfil Premium 1erWendy Castillo • 1er…" — so the visible name
    // is the run before the first badge word rather than the link's full text.
    const linkText = clean(profileLink.textContent)
    const authorName =
      linkText.split(/\s+(?:perfil|•|\d+(?:er|do|ro))/)[0]?.trim() ||
      clean(profileLink.getAttribute('aria-label'))

    const time = best.querySelector('time')
    const timeValue = time?.getAttribute('datetime') ?? null

    /**
     * The comment body, by document order.
     *
     * Two heuristics failed before this. "Longest text in the container"
     * resolved to the container itself; "longest leaf" then picked the author's
     * headline, because a headline like "Account Manager en Excelia | Strategic
     * Business Development" is far longer than a comment that says "software".
     * Length was never the signal.
     *
     * Order is. A comment card always reads: name, headline, timestamp, body,
     * actions. So the body is the last run of text before the reply button —
     * a fact about how a comment is read, which LinkedIn cannot change without
     * changing what a comment looks like.
     */
    const noise =
      /^(Responder|Reply|Recomendar|Like|Me gusta|Autor|Author|Premium|Verificado|Verified|Editado|Edited|\d+\s*(er|do|ro|th|st|nd)|•|·|\d+\s*(s|m|h|d|sem|mes|a|w|mo|y)$)/i

    const walker = document.createTreeWalker(best, NodeFilter.SHOW_TEXT)
    const beforeButton: string[] = []
    while (walker.nextNode()) {
      const node = walker.currentNode
      // Keep only text that precedes the reply button in document order.
      const buttonFollows =
        node.compareDocumentPosition(button) & Node.DOCUMENT_POSITION_FOLLOWING
      if (!buttonFollows) continue

      const text = clean(node.textContent)
      if (!text || noise.test(text)) continue
      // Relative timestamps ("hace 2 días", "1 semana") sit between the
      // headline and the body and would otherwise win as the last run.
      if (/^(hace\s|\d+\s*(semana|mes|día|dia|hora|minuto|año))/i.test(text)) continue
      beforeButton.push(text)
    }

    // Drop the name and the screen-reader repeat of it that open every card.
    const withoutName = beforeButton.filter(
      (text) => !authorName || (!text.startsWith(authorName) && text !== authorName),
    )

    const body = withoutName.at(-1) ?? ''
    // Everything between the name and the body is the headline.
    const candidates = withoutName.slice(0, -1)

    // Any stable per-comment id LinkedIn exposes; falls back to the href plus
    // a body fingerprint, which is stable enough to dedupe replies against.
    const urn =
      best.getAttribute('data-id') ??
      best.getAttribute('data-urn') ??
      best.querySelector('[data-id]')?.getAttribute('data-id') ??
      `${profileLink.getAttribute('href')}#${body.slice(0, 40)}`

    // The headline is the longest run between the name and the body. Optional —
    // it feeds invite-queue ranking, never a send decision.
    const headline = candidates.reduce(
      (longest, text) => (text.length > longest.length ? text : longest),
      '',
    )

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
 * Reads the conversation list off whatever page is loaded.
 *
 * Separate from navigation on purpose. Folding the two together made the
 * parsing untestable — every call reached for the network first — and hid that
 * navigation is itself an action LinkedIn observes and so needs pacing of its
 * own.
 */
export async function extractConversations(page: Page): Promise<
  Array<{
    threadId: string
    participantPublicIdentifier: string
    participantName: string
    lastMessageAt: Date
    lastMessageFromOwner: boolean
    snippet: string
  }>
> {
  const items = await page
    .locator('li.msg-conversation-listitem, .msg-conversations-container__convo-item')
    .evaluateAll((nodes) => {
      const clean = (t: string | null | undefined) => (t ?? '').trim().replace(/\s+/g, ' ')
      return nodes.map((node) => {
        const link = node.querySelector('a[href*="/messaging/thread/"], a[href*="/in/"]')
        const name = node.querySelector('.msg-conversation-listitem__participant-names, h3')
        const snippet = node.querySelector(
          '.msg-conversation-card__message-snippet, .msg-conversation-listitem__message-snippet',
        )
        return {
          href: link?.getAttribute('href') ?? '',
          name: clean(name?.textContent),
          snippet: clean(snippet?.textContent),
          datetime: node.querySelector('time')?.getAttribute('datetime') ?? '',
        }
      })
    })

  return items
    .map((item) => ({
      threadId: item.href.match(/\/messaging\/thread\/([^/?#]+)/)?.[1] ?? item.href,
      participantPublicIdentifier: publicIdentifierFromHref(item.href),
      participantName: item.name,
      lastMessageAt: item.datetime ? new Date(item.datetime) : new Date(),
      // LinkedIn prefixes the snippet with "Tú:" when the owner spoke last —
      // which decides whether the playbook could still pick the thread up.
      lastMessageFromOwner: /^(Tú|Tu|You)\s*:/i.test(item.snippet),
      snippet: item.snippet,
    }))
    .filter((c) => c.threadId)
}

/** Reads one thread's messages off whatever page is loaded. */
export async function extractThreadMessages(
  page: Page,
  ownerName: string,
): Promise<Array<{ from: 'owner' | 'lead'; body: string; at: Date }>> {
  const messages = await page
    .locator('li.msg-s-message-list__event, .msg-s-event-listitem')
    .evaluateAll((nodes) => {
      const clean = (t: string | null | undefined) => (t ?? '').trim().replace(/\s+/g, ' ')
      // LinkedIn labels the sender only on the first message of a run, so an
      // unlabelled message continues whoever spoke last.
      let lastSender = ''
      return nodes.map((node) => {
        const sender = clean(
          node.querySelector('.msg-s-message-group__name, .msg-s-event-listitem__name')?.textContent,
        )
        if (sender) lastSender = sender
        return {
          sender: lastSender,
          body: clean(node.querySelector('.msg-s-event-listitem__body, .msg-s-event__content')?.textContent),
          datetime: node.querySelector('time')?.getAttribute('datetime') ?? '',
        }
      })
    })

  return messages
    .filter((m) => m.body)
    .map((m) => ({
      from: ownerName && m.sender === ownerName ? ('owner' as const) : ('lead' as const),
      body: m.body,
      at: m.datetime ? new Date(m.datetime) : new Date(),
    }))
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

/** Runs in the page. Keep self-contained: no imports, no closures. */
function extractPendingInvitesInPage(): string[] {
  // The sent-invitations page has no stable container names either, but every
  // row is anchored on a link to the invited profile. Scoped to <main> so the
  // navigation bar's own profile link does not count as an invitation.
  const root = document.querySelector('main') ?? document.body
  const hrefs = Array.from(root.querySelectorAll<HTMLAnchorElement>('a[href*="/in/"]'))
  return hrefs.map((a) => a.getAttribute('href') ?? '')
}

/**
 * Public identifiers with an invitation still pending.
 *
 * One page read covers every outstanding invite, which is the whole point:
 * the alternative is visiting up to eighty profiles to learn that nothing
 * changed.
 *
 * Absence from this list is treated as a hint, never as proof — a selector
 * change or a half-loaded page also produces an empty list, and acting on that
 * directly would mark every pending invitation as resolved at once.
 */
export async function extractPendingInvites(page: Page): Promise<string[]> {
  const hrefs = await page.evaluate(extractPendingInvitesInPage)
  const identifiers = hrefs
    .map((href) => publicIdentifierFromHref(href))
    .filter((identifier) => identifier.length > 0)
  return [...new Set(identifiers)]
}
