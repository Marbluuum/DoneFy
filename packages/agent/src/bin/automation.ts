/**
 * Creates and lists automations, until the panel can do it.
 *
 *   npm run automation                              — lists what exists
 *   npm run automation -- --nueva "Guía" --palabra guia --post <url>
 *   npm run automation -- --activar <id>
 *   npm run automation -- --pausar <id>
 *
 * A post URL is optional: with none, the automation watches every post already
 * known for the account, which is what you want for a keyword you reuse.
 */

import { and, eq } from 'drizzle-orm'

import { automations, createDb, linkedinAccounts, posts } from '@donefy/db'

import { agentConfig, loadEnv } from '../config.js'

loadEnv()

const config = agentConfig()

if (!config.databaseUrl) {
  console.error('❌ Falta DATABASE_URL. Corré `npm run setup` en la raíz.')
  process.exit(1)
}
if (!config.accountId) {
  console.error('❌ Falta DONEFY_ACCOUNT_ID. Corré `npm run init -w @donefy/agent`.')
  process.exit(1)
}

const args = parseArgs(process.argv.slice(2))
const db = createDb(config.databaseUrl)

const [account] = await db
  .select({ id: linkedinAccounts.id, identifier: linkedinAccounts.publicIdentifier })
  .from(linkedinAccounts)
  .where(eq(linkedinAccounts.id, config.accountId))
  .limit(1)

if (!account) {
  console.error(`❌ No existe la cuenta ${config.accountId}. Corré \`npm run init -w @donefy/agent\`.`)
  process.exit(1)
}

if (args.activar || args.pausar) {
  const id = (args.activar ?? args.pausar)!
  const status = args.activar ? 'active' : 'paused'
  const updated = await db
    .update(automations)
    .set({ status, updatedAt: new Date() })
    .where(and(eq(automations.id, id), eq(automations.accountId, account.id)))
    .returning({ name: automations.name })

  if (updated.length === 0) {
    console.error(`❌ No encontré la automatización ${id} en esta cuenta.`)
    process.exit(1)
  }
  console.log(`✅ "${updated[0]!.name}" quedó en ${status === 'active' ? 'activa' : 'pausada'}.`)
  process.exit(0)
}

if (args.nueva) {
  if (args.palabras.length === 0) {
    console.error('❌ Falta al menos una --palabra. Sin palabra clave se dispararía con cualquier comentario.')
    process.exit(1)
  }

  const postIds: string[] = []
  for (const url of args.posts) {
    // Registered here so the automation can point at it before the agent has
    // ever scanned. Same URL-as-URN convention the repository uses.
    const [row] = await db
      .insert(posts)
      .values({ accountId: account.id, urn: url, url })
      .onConflictDoUpdate({ target: [posts.accountId, posts.urn], set: { url } })
      .returning({ id: posts.id })
    postIds.push(row!.id)
  }

  const [created] = await db
    .insert(automations)
    .values({
      accountId: account.id,
      name: args.nueva,
      // Created active on purpose: an automation you just described and that
      // then does nothing is the confusing outcome.
      status: 'active',
      keywords: args.palabras.map((k) => k.toLowerCase()),
      postIds,
      flow: {
        nodes: [
          { id: 'reply', type: 'comment_reply', config: {} },
          { id: 'invite', type: 'invite', config: {} },
          { id: 'dm', type: 'dm', config: {} },
          { id: 'book', type: 'book', config: { calendarUrl: args.agenda ?? '' } },
        ],
        edges: [
          { from: 'reply', to: 'invite' },
          { from: 'invite', to: 'dm' },
          { from: 'dm', to: 'book' },
        ],
      },
    })
    .returning({ id: automations.id })

  console.log(`✅ "${args.nueva}" creada y activa.`)
  console.log(`   id:       ${created!.id}`)
  console.log(`   palabras: ${args.palabras.join(', ')}`)
  console.log(`   posts:    ${postIds.length > 0 ? args.posts.join('\n             ') : 'todos los de la cuenta'}`)
  if (!args.agenda) {
    console.log('\n   Sin --agenda: el agente no va a tener link de calendario para pasar.')
  }
  process.exit(0)
}

// No arguments: show what is there.
const rows = await db
  .select({
    id: automations.id,
    name: automations.name,
    status: automations.status,
    keywords: automations.keywords,
    postIds: automations.postIds,
  })
  .from(automations)
  .where(eq(automations.accountId, account.id))

console.log(`Cuenta: ${account.identifier}\n`)

if (rows.length === 0) {
  console.log('No hay automatizaciones todavía. Creá una:')
  console.log('   npm run automation -- --nueva "Guía" --palabra guia --post <url del post>\n')
  process.exit(0)
}

for (const row of rows) {
  const mark = row.status === 'active' ? '●' : '○'
  console.log(`${mark} ${row.name}  (${row.status})`)
  console.log(`   id:       ${row.id}`)
  console.log(`   palabras: ${(row.keywords ?? []).join(', ') || '—'}`)
  console.log(`   posts:    ${(row.postIds ?? []).length || 'todos'}`)
  console.log()
}

process.exit(0)

type Args = {
  nueva?: string
  palabras: string[]
  posts: string[]
  agenda?: string
  activar?: string
  pausar?: string
}

/** Repeatable --palabra and --post, so several can be passed without quoting rules. */
function parseArgs(argv: string[]): Args {
  const args: Args = { palabras: [], posts: [] }

  for (let i = 0; i < argv.length; i++) {
    const value = argv[i + 1]
    switch (argv[i]) {
      case '--nueva':
        args.nueva = value
        i++
        break
      case '--palabra':
        if (value) args.palabras.push(value)
        i++
        break
      case '--post':
        if (value) args.posts.push(value)
        i++
        break
      case '--agenda':
        args.agenda = value
        i++
        break
      case '--activar':
        args.activar = value
        i++
        break
      case '--pausar':
        args.pausar = value
        i++
        break
    }
  }
  return args
}
