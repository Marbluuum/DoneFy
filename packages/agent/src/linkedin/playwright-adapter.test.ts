import assert from 'node:assert/strict'
import { after, before, test } from 'node:test'

import { chromium, type Browser, type BrowserContext } from 'playwright'

import { AdapterError } from './adapter.js'
import { extractConversations, extractThreadMessages } from './extract.js'
import { PlaywrightLinkedInAdapter } from './playwright-adapter.js'

/**
 * Adapter behaviour that does not need LinkedIn: pacing, and how missing
 * elements are classified. The page-reading paths need the real site and are
 * covered by the DOM tests and by running against a signed-in profile.
 */

const CONVERSATIONS = `<!doctype html><html><body>
  <ul>
    <li class="msg-conversation-listitem">
      <a class="msg-conversation-listitem__link" href="/messaging/thread/2-abc123/">
        <h3 class="msg-conversation-listitem__participant-names">Diego Perez</h3>
        <p class="msg-conversation-card__message-snippet">Tú: te paso el calendario</p>
        <time class="msg-conversation-listitem__time-stamp" datetime="2026-08-01T10:00:00Z">1 ago</time>
      </a>
    </li>
    <li class="msg-conversation-listitem">
      <a class="msg-conversation-listitem__link" href="/messaging/thread/2-def456/">
        <h3 class="msg-conversation-listitem__participant-names">Wendy Castillo</h3>
        <p class="msg-conversation-card__message-snippet">dale, gracias!</p>
        <time class="msg-conversation-listitem__time-stamp" datetime="2026-07-20T09:00:00Z">20 jul</time>
      </a>
    </li>
  </ul>
</body></html>`

const THREAD = `<!doctype html><html><body>
  <ul>
    <li class="msg-s-message-list__event">
      <span class="msg-s-message-group__name">Martin Bufczyk</span>
      <p class="msg-s-event-listitem__body">tienes una empresa de tecnología?</p>
      <time datetime="2026-07-22T10:57:00Z"></time>
    </li>
    <li class="msg-s-message-list__event">
      <span class="msg-s-message-group__name">Diego Perez</span>
      <p class="msg-s-event-listitem__body">Si tengo una empresa de desarrollo</p>
      <time datetime="2026-07-22T10:58:00Z"></time>
    </li>
    <li class="msg-s-message-list__event">
      <p class="msg-s-event-listitem__body">Más de 10 años en el mercado.</p>
      <time datetime="2026-07-22T10:58:30Z"></time>
    </li>
  </ul>
</body></html>`

let browser: Browser | undefined
let context: BrowserContext | undefined
let unavailable = ''

before(async () => {
  try {
    browser = await chromium.launch({
      executablePath: process.env.CHROME_EXECUTABLE_PATH || undefined,
    })
    context = await browser.newContext()
  } catch (error) {
    unavailable = error instanceof Error ? error.message.split('\n')[0]! : String(error)
  }
})

after(async () => {
  await browser?.close()
})

function adapterOn(ctx: BrowserContext, sleeps: number[]) {
  return new PlaywrightLinkedInAdapter({
    context: ctx,
    random: () => 0.5,
    sleep: async (ms) => {
      sleeps.push(ms)
    },
  })
}

test('every action pauses before it runs', async (t) => {
  if (!context) return t.skip(`sin navegador: ${unavailable}`)

  // A burst of instant actions is the clearest signal a session is not a
  // person, so pacing is not optional politeness — it is load-bearing.
  const sleeps: number[] = []
  const adapter = adapterOn(context, sleeps)

  // Reaching a page is itself an action LinkedIn sees, so the pause has to come
  // before navigation — an earlier version paced only before the click, which
  // left the navigation burst unpaced.
  await adapter.listConversations({ limit: 10 }).catch(() => {})
  await adapter.sendMessage('nobody', 'hola').catch(() => {})

  assert.ok(sleeps.length >= 2, `se esperaban pausas antes de navegar, hubo ${sleeps.length}`)
  for (const ms of sleeps) {
    assert.ok(ms >= 3000 && ms <= 9000, `pausa fuera de rango: ${ms}ms`)
  }
})

test('a missing message button is reported as blocked, not as a crash', async (t) => {
  if (!context) return t.skip(`sin navegador: ${unavailable}`)

  // Someone who is not a 1st-degree connection has no message button. That is
  // an expected outcome the queue should record, not an exception.
  const page = await context.newPage()
  await page.setContent('<!doctype html><html><body><h1>Sin botón</h1></body></html>')

  const adapter = adapterOn(context, [])
  await assert.rejects(
    () => adapter.sendMessage('someone', 'hola'),
    (error: unknown) => error instanceof AdapterError && ['blocked', 'transient'].includes(error.kind),
  )
  await page.close()
})

test('withdrawing an invite fails loudly rather than pretending to work', async (t) => {
  if (!context) return t.skip(`sin navegador: ${unavailable}`)

  // The withdraw controls are not in the DOM on load, so this is unimplemented
  // on purpose. Silently returning false would look like "nothing to withdraw".
  const adapter = adapterOn(context, [])
  await assert.rejects(
    () => adapter.withdrawInvite('someone'),
    (error: unknown) => error instanceof AdapterError && error.kind === 'selector',
  )
})

test('conversations are read with sender and timestamp', async (t) => {
  if (!context) return t.skip(`sin navegador: ${unavailable}`)

  const page = await context.newPage()
  await page.setContent(CONVERSATIONS)

  const conversations = await extractConversations(page)
  assert.equal(conversations.length, 2)

  const diego = conversations.find((c) => c.threadId === '2-abc123')
  // "Tú:" marks the owner as the last speaker — which decides whether the
  // playbook could still pick the thread up.
  assert.equal(diego?.lastMessageFromOwner, true)

  const wendy = conversations.find((c) => c.threadId === '2-def456')
  assert.equal(wendy?.lastMessageFromOwner, false)
  assert.equal(wendy?.lastMessageAt.toISOString(), '2026-07-20T09:00:00.000Z')

  await page.close()
})

test('a thread attributes each message to the right side', async (t) => {
  if (!context) return t.skip(`sin navegador: ${unavailable}`)

  // LinkedIn labels the sender only on the first message of a run, so an
  // unlabelled message continues whoever spoke last. Getting this wrong would
  // feed the classifier the owner's own words as if the lead had said them.
  const page = await context.newPage()
  await page.setContent(THREAD)

  const messages = await extractThreadMessages(page, 'Martin Bufczyk')
  assert.equal(messages.length, 3)
  assert.deepEqual(
    messages.map((m) => m.from),
    ['owner', 'lead', 'lead'],
  )
  assert.equal(messages[2]?.body, 'Más de 10 años en el mercado.')

  await page.close()
})
