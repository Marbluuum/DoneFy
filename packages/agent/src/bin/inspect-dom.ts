/**
 * Reports which selectors match on the live site — and discovers replacements
 * for the ones that don't.
 *
 * Selectors are the one part of this codebase that cannot be verified without
 * a signed-in browser on a real machine. The first version only checked
 * candidates I had guessed, which taught nothing when every candidate missed.
 * Now, when a group has no hit, it anchors on something that *does* exist
 * nearby and reports the real class names around it — so the fix is read off
 * the DOM instead of guessed again.
 *
 *   npm run inspect-dom -w @donefy/agent
 *   npm run inspect-dom -w @donefy/agent -- "https://www.linkedin.com/feed/update/urn:li:share:123/"
 *
 * Reports counts, tag names and class names. Never anyone's message content.
 */

import type { BrowserContext, Page } from 'playwright'

import { agentConfig, loadEnv, resolveBrowser } from '../config.js'
import { launchBrowser } from '../linkedin/browser.js'
import { extractComments } from '../linkedin/extract.js'
import { SELECTORS, URLS } from '../linkedin/selectors.js'

loadEnv()

const { profilePath, screenshotDir, headless } = agentConfig()
const postUrl = process.argv[2]

const browser = resolveBrowser()
let context: BrowserContext
try {
  context = await launchBrowser({
    profilePath,
    executablePath: browser.executablePath,
    headless,
    screenshotDir,
  })
} catch (error) {
  console.error('❌ No se pudo abrir el navegador:', error instanceof Error ? error.message : error)
  process.exit(1)
}

const page = context.pages()[0] ?? (await context.newPage())

/**
 * Anchors that are known to exist and are described by what they *do* — an
 * aria-label, an href shape — rather than by a class that can be renamed.
 * When a selector group misses, the DOM around its anchor is dumped instead.
 */
const DISCOVERY_ANCHORS: Record<string, { anchor: string; note: string }> = {
  comment: { anchor: 'button[aria-label*="Responder"]', note: 'contenedor del comentario' },
  commentAuthorLink: { anchor: 'a[href*="/in/"]', note: 'link al perfil del autor' },
  commentBody: { anchor: 'button[aria-label*="Responder"]', note: 'texto del comentario' },
  sendButton: { anchor: 'div[role="textbox"]', note: 'botón de enviar' },
  row: { anchor: 'a[href*="/in/"]', note: 'fila de invitación' },
  loggedIn: { anchor: 'a[href*="/feed"]', note: 'barra de navegación' },
}

async function goTo(url: string, label: string) {
  console.log(`\n${'═'.repeat(60)}\n${label}`)
  await page.goto(url, { waitUntil: 'domcontentloaded' })
  // LinkedIn hydrates well after domcontentloaded; without this the page looks
  // empty and every selector reports a false miss.
  await page.waitForTimeout(5000).catch(() => {})
  console.log(`URL final: ${page.url()}`)
}

async function probe(groups: Record<string, readonly string[]>) {
  for (const [name, selectors] of Object.entries(groups)) {
    const lines: string[] = []
    let hit = false
    for (const selector of selectors) {
      const count = await page.locator(selector).count().catch(() => 0)
      if (count > 0) hit = true
      lines.push(`${count > 0 ? '✅' : '  '} ${String(count).padStart(4)}  ${selector}`)
    }
    console.log(`\n  ${hit ? '✅' : '❌'} ${name}`)
    for (const line of lines) console.log(`     ${line}`)

    if (!hit) await discover(name)
  }
}

/**
 * Walks up from a known-present anchor, printing the tag and classes of each
 * ancestor. Whichever level repeats once per item is the container.
 */
async function discover(groupName: string) {
  const spec = DISCOVERY_ANCHORS[groupName]
  if (!spec) return

  const anchorCount = await page.locator(spec.anchor).count().catch(() => 0)
  if (anchorCount === 0) {
    console.log(`     🔍 sin ancla para descubrir (${spec.anchor} tampoco existe)`)
    return
  }

  console.log(`     🔍 buscando ${spec.note} desde ${spec.anchor} (${anchorCount} encontrados):`)

  const ancestry = await page
    .locator(spec.anchor)
    .first()
    .evaluate((el) => {
      const out: string[] = []
      let node: Element | null = el
      for (let depth = 0; node && depth < 7; depth++) {
        const classes = (node.className ?? '').toString().trim().split(/\s+/).filter(Boolean)
        // Hashed CSS-module names change on every LinkedIn deploy, so reporting
        // them as candidates is worse than reporting nothing — they look like
        // a fix and break on the next release.
        const hashed = (c: string) => /^_?[0-9a-f]{6,10}$/i.test(c) || /^ember\d|^css-|^\d/.test(c)
        const usable = classes.filter((c) => !hashed(c)).slice(0, 6)
        const hashedCount = classes.length - usable.length

        // Attributes that survive a rename, which is what a selector should use.
        const stable = ['aria-label', 'role', 'data-id', 'data-urn', 'data-view-name', 'href', 'type']
          .map((attr) => {
            const value = node!.getAttribute(attr)
            return value ? `[${attr}="${value.slice(0, 45)}"]` : ''
          })
          .filter(Boolean)
          .join(' ')

        const classText = usable.length ? '.' + usable.join(' .') : hashedCount ? `(${hashedCount} clases hasheadas)` : '(sin clases)'
        out.push(`${'  '.repeat(depth)}<${node.tagName.toLowerCase()}> ${classText} ${stable}`.trimEnd())
        node = node.parentElement
      }
      return out
    })
    .catch(() => [] as string[])

  for (const line of ancestry) console.log(`        ${line}`)
}

try {
  await goTo(URLS.feed, 'FEED')
  await probe({ loggedIn: SELECTORS.loggedIn, authWall: SELECTORS.authWall })

  await goTo(URLS.sentInvitations, 'INVITACIONES ENVIADAS')
  await probe(SELECTORS.invitationsSent)

  await goTo(URLS.messaging, 'MENSAJES')
  await probe(SELECTORS.messaging)

  if (postUrl) {
    await goTo(postUrl, 'PUBLICACIÓN')
    await probe(SELECTORS.post)

    // The real test. Selector counts say whether an element was found; this
    // says whether a usable comment came out the other side, which is the only
    // thing the agent actually needs from this page.
    console.log('\n── EXTRACCIÓN DE COMENTARIOS ──')
    const comments = await extractComments(page)
    console.log(`\n  ${comments.length > 0 ? '✅' : '❌'} ${comments.length} comentarios extraídos`)
    for (const c of comments.slice(0, 5)) {
      console.log(`\n     @${c.authorPublicIdentifier}  (${c.authorName})`)
      console.log(`       titular: ${c.authorHeadline?.slice(0, 60) ?? '(sin dato)'}`)
      console.log(`       texto:   ${c.body.slice(0, 60)}`)
      console.log(`       fecha:   ${c.postedAt?.toISOString() ?? '(sin dato)'}`)
    }
    if (comments.length > 5) console.log(`\n     …y ${comments.length - 5} más`)
  } else {
    console.log('\n⚠️  Sin URL de publicación: los selectores de comentarios no se probaron.')
  }

  // The withdraw control had no matching label, so list what the buttons on
  // that page actually say rather than guessing at another aria-label.
  await goTo(URLS.sentInvitations, 'BOTONES EN INVITACIONES')
  const buttonInfo = await page
    .locator('button')
    .evaluateAll((nodes) =>
      nodes
        .slice(0, 40)
        .map((n) => ({
          label: n.getAttribute('aria-label') ?? '',
          text: (n.textContent ?? '').trim().replace(/\s+/g, ' ').slice(0, 30),
        }))
        .filter((b) => b.label || b.text),
    )
    .catch(() => [])

  const seen = new Set<string>()
  for (const b of buttonInfo) {
    const key = `${b.label}|${b.text}`
    if (seen.has(key)) continue
    seen.add(key)
    console.log(`     texto="${b.text}"  aria-label="${b.label}"`)
  }

  console.log(`\n${'═'.repeat(60)}`)
  console.log('Copiá todo y pegámelo. Los 🔍 muestran el DOM real donde falló.')
} catch (error) {
  console.error('\n❌ Error:', error instanceof Error ? error.message : error)
  process.exitCode = 1
} finally {
  await page.waitForTimeout(1000)
  await context.close()
}
