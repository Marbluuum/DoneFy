import assert from 'node:assert/strict'
import { after, before, test } from 'node:test'

import { chromium, type Browser, type Page } from 'playwright'

import { extractComments, extractOwnPosts, extractPendingInvites } from './extract.js'

/**
 * Runs the extractor against a synthetic DOM built to match what LinkedIn
 * actually serves: hashed class names, the author's name repeated for screen
 * readers, a headline much longer than the comment, and no semantic container.
 *
 * Every earlier version of this extractor was validated by pasting output from
 * a real machine, which meant a round trip per attempt and two wrong answers
 * shipped along the way. The structure is reproducible, so it belongs in a test.
 */

const COMMENT_CARD = (author: string, slug: string, headline: string, body: string) => `
  <div class="_72c8d2e3 _37d1e1ab">
    <div class="_77ec265a f9a2c2bc">
      <div class="fccf4a5f _021da188">
        <a href="https://www.linkedin.com/in/${slug}" class="ffe5a08f _0c11ce24">
          <span>${author} perfil Premium 1er</span><span>${author} • 1er</span>
        </a>
        <div class="_8c7a6377"><span>${headline}</span></div>
        <span class="_1c4bbe35">hace 2 días</span>
      </div>
      <div class="_03b24418 f86e7ed3"><span dir="ltr">${body}</span></div>
      <div class="e2a0d240 _5213c67d">
        <button class="_1d3b4f9f" type="button" aria-label="Recomendar">Recomendar</button>
        <button class="_6a706e0a" type="button" aria-label="Responder">Responder</button>
      </div>
    </div>
  </div>`

const PAGE = `<!doctype html><html><body><div class="_421c992c">
  ${COMMENT_CARD('Wendy Castillo', 'wendy-castillo', 'Account Manager en Excelia | Strategic Business Development, Strategy', 'software')}
  ${COMMENT_CARD('Martin Bufczyk', 'martinbufczyk', 'Founder &amp; CEO | Conectando empresas de tecnología con empresas', 'Wendy Castillo enviado')}
  ${COMMENT_CARD('Gabriel Durán', 'gabo-duran', 'Founder @ SVR Data Technologies · Digitalización de procesos', 'sistema, me interesa mucho como lo hacen')}
</div></body></html>`

let browser: Browser | undefined
let page: Page | undefined
/** Set when no browser is installed, so CI without one reports skip, not fail. */
let unavailable = ''

before(async () => {
  try {
    browser = await chromium.launch({
      executablePath: process.env.CHROME_EXECUTABLE_PATH || undefined,
    })
    page = await browser.newPage()
    await page.setContent(PAGE)
  } catch (error) {
    unavailable = error instanceof Error ? error.message.split('\n')[0]! : String(error)
  }
})

after(async () => {
  await browser?.close()
})

/** Fails on a real assertion failure; skips only when there is no browser. */
async function comments(t: { skip: (reason?: string) => void }) {
  if (!page) {
    t.skip(`sin navegador: ${unavailable}`)
    return null
  }
  return extractComments(page)
}

test('one comment is extracted per reply button', async (t) => {
  const found = await comments(t)
  if (!found) return
  assert.equal(found.length, 3)
})

test('the body is the comment, not the headline', async (t) => {
  // The bug this test exists for: a headline is routinely longer than the
  // comment, so picking by length returned "Account Manager en Excelia…"
  // where the person had written "software".
  const found = await comments(t)
  if (!found) return
  const wendy = found.find((c) => c.authorPublicIdentifier === 'wendy-castillo')

  assert.equal(wendy?.body, 'software')
  assert.ok(!wendy?.body.includes('Account Manager'))
})

test('the author name drops the screen-reader repeat and the badges', async (t) => {
  const found = await comments(t)
  if (!found) return
  const wendy = found.find((c) => c.authorPublicIdentifier === 'wendy-castillo')

  assert.equal(wendy?.authorName, 'Wendy Castillo')
})

test('the headline is captured separately from the body', async (t) => {
  const found = await comments(t)
  if (!found) return
  const wendy = found.find((c) => c.authorPublicIdentifier === 'wendy-castillo')

  assert.match(wendy?.authorHeadline ?? '', /Account Manager en Excelia/)
})

test('a relative timestamp is not mistaken for the comment', async (t) => {
  // "hace 2 días" sits between the headline and the body, so a naive
  // last-run-of-text rule would return it.
  const found = await comments(t)
  if (!found) return
  for (const comment of found) {
    assert.ok(!/^hace /.test(comment.body), comment.body)
  }
})

test('every comment keeps its own author and body', async (t) => {
  // The container is found by climbing until a subtree holds exactly one reply
  // button; if that boundary were wrong, cards would bleed into each other.
  const found = await comments(t)
  if (!found) return
  const bodies = Object.fromEntries(found.map((c) => [c.authorPublicIdentifier, c.body]))

  assert.equal(bodies['wendy-castillo'], 'software')
  assert.equal(bodies['martinbufczyk'], 'Wendy Castillo enviado')
  assert.equal(bodies['gabo-duran'], 'sistema, me interesa mucho como lo hacen')
})

test('a long comment is still preferred over the headline', async (t) => {
  const found = await comments(t)
  if (!found) return
  const gabo = found.find((c) => c.authorPublicIdentifier === 'gabo-duran')
  assert.equal(gabo?.body, 'sistema, me interesa mucho como lo hacen')
})

test('pending invitations are read from the profile links, not a container name', async (t) => {
  if (!page) {
    t.skip(`sin navegador: ${unavailable}`)
    return
  }

  // The sent-invitations page ships hashed class names like everything else,
  // so the only stable anchor is the link to the invited profile. Scoped to
  // <main> because the navigation bar links to the owner's own profile, and
  // counting that would look like an invitation to yourself.
  await page.setContent(`<html><body>
    <nav><a href="/in/martinbufczyk/">Yo</a></nav>
    <main>
      <ul>
        <li><a href="/in/wendy-torres/">Wendy Torres</a>
            <a href="/in/wendy-torres/">foto</a></li>
        <li><a href="/in/piero-storace?trk=x">Piero Storace</a></li>
      </ul>
    </main>
  </body></html>`)

  const pending = await extractPendingInvites(page)
  assert.deepEqual(pending.sort(), ['piero-storace', 'wendy-torres'])
})

test('an invitations page with nobody on it reads as empty, not as an error', async (t) => {
  if (!page) {
    t.skip(`sin navegador: ${unavailable}`)
    return
  }

  await page.setContent('<html><body><main><p>No tenés invitaciones pendientes</p></main></body></html>')
  assert.deepEqual(await extractPendingInvites(page), [])
})

test('own posts are read from the activity URN, wherever it is carried', async (t) => {
  if (!page) {
    t.skip(`sin navegador: ${unavailable}`)
    return
  }

  // LinkedIn puts the URN in `data-urn` on some surfaces and only in a
  // permalink on others. Both survive a class rename, because routing depends
  // on them, so both are read rather than picking one and hoping.
  await page.setContent(`<html><body>
    <div data-urn="urn:li:activity:7000">
      <p>Las empresas de tecnología no tienen un problema de producto, tienen uno de distribución.</p>
    </div>
    <div>
      <a href="/feed/update/urn:li:activity:7001/">
        <span>Cold calling is NOT rocket science. So stop acting like it is, por favor.</span>
      </a>
    </div>
  </body></html>`)

  const own = await extractOwnPosts(page)
  assert.deepEqual(
    own.map((p) => p.urn),
    ['urn:li:activity:7000', 'urn:li:activity:7001'],
  )
  assert.match(own[0]!.excerpt, /distribución/)
  assert.equal(own[0]!.url, 'https://www.linkedin.com/feed/update/urn:li:activity:7000/')
})

test('the same post carried twice is returned once', async (t) => {
  if (!page) {
    t.skip(`sin navegador: ${unavailable}`)
    return
  }

  // A post usually carries its URN on the container *and* on its permalink.
  // Counting both would show every publication twice in the picker.
  await page.setContent(`<html><body>
    <div data-urn="urn:li:activity:7002">
      <p>Un texto suficientemente largo como para servir de extracto del post.</p>
      <a href="/feed/update/urn:li:activity:7002/">Ver publicación</a>
    </div>
  </body></html>`)

  assert.equal((await extractOwnPosts(page)).length, 1)
})
