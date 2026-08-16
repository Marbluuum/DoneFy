import { jitteredDelayMs } from '@linkfy/core'
import type { BrowserContext, Page } from 'playwright'

import {
  AdapterError,
  type ConversationSummary,
  type InviteResult,
  type OwnPost,
  type LinkedInAdapter,
  type PostComment,
  type ProfileSummary,
  type ThreadMessage,
} from './adapter.js'
import { assertSignedIn, findFirst, navigate, requireFirst, typeHumanly } from './browser.js'
import {
  extractComments,
  extractConversations,
  extractOwnPosts,
  extractPendingInvites,
  extractThreadMessages,
  findSendButton,
} from './extract.js'
import { SELECTORS, URLS, anyOf } from './selectors.js'

/**
 * The Playwright implementation of LinkedInAdapter.
 *
 * Two extraction strategies live side by side, because LinkedIn is mid-
 * migration. Messaging still ships real class names and is read with
 * selectors. Comments, profiles and invitations ship hashed CSS-module names
 * that change every deploy, and are read structurally from anchors that
 * describe behaviour — an aria-label, an href shape. Which strategy applies is
 * a property of the page, not a preference.
 *
 * Every action pauses for a human-ish interval first. This is not politeness:
 * a burst of instant actions is the single clearest signal that a session is
 * not a person.
 */

export type PlaywrightAdapterOptions = {
  context: BrowserContext
  screenshotDir?: string
  minGapSeconds?: number
  maxGapSeconds?: number
  /** Injected in tests so pacing is deterministic. */
  random?: () => number
  /** Injected in tests so the suite does not actually wait. */
  sleep?: (ms: number) => Promise<void>
}

export class PlaywrightLinkedInAdapter implements LinkedInAdapter {
  private readonly context: BrowserContext
  private readonly screenshotDir?: string
  private readonly minGap: number
  private readonly maxGap: number
  private readonly random: () => number
  private readonly sleep: (ms: number) => Promise<void>

  constructor(options: PlaywrightAdapterOptions) {
    this.context = options.context
    this.screenshotDir = options.screenshotDir
    this.minGap = options.minGapSeconds ?? 3
    this.maxGap = options.maxGapSeconds ?? 9
    this.random = options.random ?? Math.random
    this.sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)))
  }

  private async page(): Promise<Page> {
    return this.context.pages()[0] ?? (await this.context.newPage())
  }

  /** A pause before acting. Bursts are what make a session look automated. */
  private async pace(): Promise<void> {
    await this.sleep(jitteredDelayMs(this.minGap, this.maxGap, this.random))
  }

  async assertSignedIn(): Promise<void> {
    await assertSignedIn(await this.page(), this.screenshotDir)
  }

  // --- comments -----------------------------------------------------------

  async readComments(postUrl: string, limit: number): Promise<PostComment[]> {
    const page = await this.page()
    await this.pace()
    await navigate(page, postUrl)
    await page.waitForTimeout(4000)

    // Comments paginate behind a "load more" button. Each click is paced like
    // any other action, and the loop stops as soon as the count stops growing
    // so a missing button never becomes an infinite loop.
    let previous = -1
    for (let round = 0; round < 20; round++) {
      const comments = await extractComments(page)
      if (comments.length >= limit || comments.length === previous) break
      previous = comments.length

      const more = await findFirst(page, SELECTORS.post.loadMoreComments, 2500)
      if (!more) break
      await this.pace()
      await more.click().catch(() => {})
      await page.waitForTimeout(2500)
    }

    return (await extractComments(page)).slice(0, limit)
  }

  async replyToComment(postUrl: string, commentUrn: string, body: string): Promise<void> {
    const page = await this.page()
    if (!page.url().startsWith(postUrl)) {
      await this.pace()
      await navigate(page, postUrl)
      await page.waitForTimeout(4000)
    }

    // Find the reply button belonging to *this* comment. Reply buttons are
    // indistinguishable from each other, so the comment is located first by
    // the identity the extractor assigned it.
    const comments = await extractComments(page)
    const index = comments.findIndex((c) => c.urn === commentUrn)
    if (index === -1) {
      throw new AdapterError('selector', `No se encontró el comentario ${commentUrn} en ${postUrl}`)
    }

    // The extractor walks reply buttons in document order, so the nth comment
    // it returned is opened by the nth button — the only correspondence
    // available, since the buttons are identical to each other.
    await this.pace()
    const replyButtons = page.locator(anyOf(SELECTORS.post.replyButton))
    await replyButtons.nth(index).click()
    await page.waitForTimeout(1200)

    await requireFirst(page, SELECTORS.post.replyEditor, 'el editor de respuesta', this.screenshotDir)
    await typeHumanly(page, anyOf(SELECTORS.post.replyEditor), body, this.random)

    const submit = await requireFirst(page, SELECTORS.post.replySubmit, 'el botón de publicar respuesta', this.screenshotDir)
    await this.pace()
    await submit.click()
    await page.waitForTimeout(2500)
  }

  async listOwnPosts(publicIdentifier: string, limit: number): Promise<OwnPost[]> {
    const page = await this.page()
    await this.pace()
    await navigate(page, URLS.recentActivity(publicIdentifier))
    await page.waitForTimeout(3500)
    return extractOwnPosts(page, limit)
  }

  async likeComment(postUrl: string, commentUrn: string): Promise<boolean> {
    const page = await this.page()
    if (!page.url().startsWith(postUrl)) {
      await this.pace()
      await navigate(page, postUrl)
      await page.waitForTimeout(4000)
    }

    const comments = await extractComments(page)
    const index = comments.findIndex((c) => c.urn === commentUrn)
    if (index === -1) return false

    // Same document-order correspondence the reply uses: the nth comment the
    // extractor returned is liked by the nth like button.
    const buttons = page.locator(anyOf(SELECTORS.post.likeButton))
    if ((await buttons.count()) <= index) return false

    const button = buttons.nth(index)
    // The same button unlikes. Pressing it on an already-liked comment would
    // quietly remove a like the owner may have left by hand.
    if ((await button.getAttribute('aria-pressed')) === 'true') return false

    await this.pace()
    await button.click()
    await page.waitForTimeout(1200)
    return true
  }

  // --- profile ------------------------------------------------------------

  async readProfile(publicIdentifier: string): Promise<ProfileSummary> {
    const page = await this.page()
    await this.pace()
    await navigate(page, URLS.profile(publicIdentifier))
    await page.waitForTimeout(3500)

    // Profile pages carry the same hashed classes as comments, so degree and
    // headline are read from text rather than from a container.
    const data = await page.evaluate(() => {
      const clean = (t: string | null | undefined) => (t ?? '').trim().replace(/\s+/g, ' ')
      const heading = document.querySelector('h1')
      const fullName = clean(heading?.textContent)

      // "· 1er" / "· 2do" / "· 3ro" sits beside the name in every layout.
      const bodyText = clean(document.body.innerText).slice(0, 4000)
      const degreeMatch = bodyText.match(/·?\s*([123])(?:er|do|ro|°|do grado|st|nd|rd)\b/i)

      // The headline is the first substantial line after the name.
      const lines = (document.body.innerText ?? '')
        .split('\n')
        .map((l) => l.trim())
        .filter(Boolean)
      const nameIndex = lines.findIndex((l) => l === fullName)
      const headline =
        nameIndex >= 0
          ? lines.slice(nameIndex + 1).find((l) => l.length > 10 && !/^\d/.test(l) && l !== fullName)
          : undefined

      return { fullName, headline: headline ?? '', degree: degreeMatch?.[1] ?? null }
    })

    if (!data.fullName) {
      throw new AdapterError(
        'selector',
        `No se pudo leer el perfil de ${publicIdentifier}`,
        undefined,
      )
    }

    return {
      publicIdentifier,
      fullName: data.fullName,
      headline: data.headline || undefined,
      company: undefined,
      degree: data.degree ? Number(data.degree) : null,
    }
  }

  // --- invitations --------------------------------------------------------

  async sendInvite(publicIdentifier: string, note?: string): Promise<InviteResult> {
    const page = await this.page()
    await this.pace()
    await navigate(page, URLS.profile(publicIdentifier))
    await page.waitForTimeout(3500)

    const connect = await findFirst(page, SELECTORS.profile.connectButton, 3000)
    if (!connect) {
      // Absent for two different reasons — already connected, or the control
      // is behind the "More" menu. Both are normal, neither is an error.
      const more = await findFirst(page, SELECTORS.profile.moreActionsButton, 2000)
      if (!more) return { sent: false, reason: 'no_invite_button' }
      await this.pace()
      await more.click()
      await page.waitForTimeout(1200)
      const inMenu = await findFirst(page, SELECTORS.profile.connectButton, 2500)
      if (!inMenu) return { sent: false, reason: 'no_invite_button' }
      await inMenu.click()
    } else {
      await this.pace()
      await connect.click()
    }

    await page.waitForTimeout(1500)

    // LinkedIn refuses before the dialog when the weekly cap is spent. Reported
    // as a distinct outcome so the health breaker sees a cap, not a failure.
    if (await page.locator(anyOf(SELECTORS.invite.limitReached)).count()) {
      return { sent: false, reason: 'weekly_limit' }
    }

    let withNote = false
    if (note) {
      const addNote = await findFirst(page, SELECTORS.invite.addNoteButton, 2500)
      if (addNote) {
        await addNote.click()
        await page.waitForTimeout(800)
        const textarea = await findFirst(page, SELECTORS.invite.noteTextarea, 2500)
        if (textarea) {
          await typeHumanly(page, anyOf(SELECTORS.invite.noteTextarea), note, this.random)
          withNote = true
        }
      }
    }

    const send = await requireFirst(page, SELECTORS.invite.sendButton, 'el botón de enviar invitación', this.screenshotDir)
    await this.pace()
    await send.click()
    await page.waitForTimeout(2000)

    return { sent: true, withNote }
  }

  async listPendingInvites(): Promise<string[]> {
    const page = await this.page()
    await this.pace()
    await navigate(page, URLS.sentInvitations)
    return extractPendingInvites(page)
  }

  async withdrawInvite(_publicIdentifier: string): Promise<boolean> {
    // Not implemented: the withdraw controls are not in the DOM on load — the
    // sent-invitations page renders ten rows with zero buttons inside them, so
    // they most likely appear on hover. Withdrawing only reclaims cap headroom,
    // so it stays unimplemented rather than guessed at.
    throw new AdapterError('selector', 'Retirar invitaciones todavía no está implementado')
  }

  // --- messaging ----------------------------------------------------------

  async sendMessage(publicIdentifier: string, body: string): Promise<void> {
    const page = await this.page()
    await this.pace()
    await navigate(page, URLS.profile(publicIdentifier))
    await page.waitForTimeout(3500)

    const messageButton = await findFirst(page, SELECTORS.profile.messageButton, 3000)
    if (!messageButton) {
      throw new AdapterError(
        'blocked',
        `No hay botón de mensaje para ${publicIdentifier} — puede que no sea contacto de 1er grado`,
      )
    }

    await this.pace()
    await messageButton.click()
    await page.waitForTimeout(2000)

    await requireFirst(page, SELECTORS.messaging.composer, 'el campo de mensaje', this.screenshotDir)
    await typeHumanly(page, anyOf(SELECTORS.messaging.composer), body, this.random)

    const send = await findSendButton(page)
    await this.pace()
    await send.click()
    await page.waitForTimeout(2000)
  }

  async listConversations(options: { limit: number; before?: Date }): Promise<ConversationSummary[]> {
    const page = await this.page()
    await this.pace()
    await navigate(page, URLS.messaging)
    await page.waitForTimeout(4000)

    const conversations = await extractConversations(page)
    return conversations
      .filter((c) => !options.before || c.lastMessageAt < options.before)
      .slice(0, options.limit)
  }

  async readThread(threadId: string): Promise<ThreadMessage[]> {
    const page = await this.page()
    await this.pace()
    await navigate(page, `${URLS.messaging}thread/${threadId}/`)
    await page.waitForTimeout(3500)

    const ownerName = await page
      .evaluate(() => document.querySelector('img[alt]')?.getAttribute('alt') ?? '')
      .catch(() => '')

    return extractThreadMessages(page, ownerName)
  }

  async close(): Promise<void> {
    await this.context.close()
  }
}
