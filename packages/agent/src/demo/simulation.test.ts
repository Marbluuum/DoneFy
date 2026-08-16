import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { after, before, test } from 'node:test'

import { PGlite } from '@electric-sql/pglite'
import { drizzle } from 'drizzle-orm/pglite'
import { eq } from 'drizzle-orm'

import { automations, contacts, enrollments, linkedinAccounts, messages, users } from '@linkfy/db'

import {
  CAST,
  clearDemo,
  DEMO_AUTOMATION,
  DEMO_IDENTIFIER,
  ensureDemoAccount,
  runDemo,
  seedDemo,
} from './simulation.js'

/**
 * The demo is someone's first look at the product, and it writes to their real
 * database. Both halves of that deserve a test: one where it crashes is worse
 * than none, and one that leaves rows behind after `--limpiar` is worse still.
 */

let pg: PGlite
let db: ReturnType<typeof drizzle>
let accountId: string
let actions: string[]

before(async () => {
  pg = new PGlite()
  const dir = join(import.meta.dirname, '..', '..', '..', 'db', 'migrations')
  await pg.exec(
    readdirSync(dir)
      .filter((f) => f.endsWith('.sql'))
      .sort()
      .map((f) => readFileSync(join(dir, f), 'utf8'))
      .join('\n'),
  )
  db = drizzle({ client: pg } as never)

  const [user] = await db
    .insert(users)
    .values({ email: 'martin@example.com' })
    .returning({ id: users.id })
  const [account] = await db
    .insert(linkedinAccounts)
    .values({ userId: user!.id, publicIdentifier: 'martinbufczyk' })
    .returning({ id: linkedinAccounts.id })
  accountId = account!.id

  await seedDemo(db, accountId)
  const result = await runDemo({
    db,
    accountId,
    timezone: 'America/Argentina/Buenos_Aires',
    log: () => {},
  })
  actions = result.actions
})

after(async () => {
  await pg?.close()
})

test('the demo produces the whole funnel, not just the first step', async () => {
  // The point of showing it at all: someone deciding whether to trust this
  // needs to see where a comment ends up, not that a comment was noticed.
  assert.ok(
    actions.some((a) => a.startsWith('💬')),
    'respondió comentarios',
  )
  assert.ok(
    actions.some((a) => a.startsWith('🤝')),
    'mandó invitaciones',
  )
  assert.ok(
    actions.some((a) => a.startsWith('✉️')),
    'mandó DMs',
  )
})

test('the invite note names the person and quotes what they commented', () => {
  // The 300 characters the whole product is built around. A demo that sent a
  // blank invite would be demonstrating the competitor.
  const invite = actions.find((a) => a.startsWith('🤝'))
  assert.match(invite ?? '', /Wendy|Piero|Clément/)
  assert.match(invite ?? '', /demo/)
})

test('the 1st-degree contact is messaged without spending an invitation', async () => {
  // The branch that carries most of the volume on a real account, and the one
  // worth seeing: existing connections cost nothing against the weekly cap.
  const yeison = CAST.find((c) => c.degree === 1)!

  assert.ok(
    actions.some((a) => a.startsWith('✉️') && a.includes(yeison.name)),
    `esperaba un DM a ${yeison.name}: ${actions.join(' | ')}`,
  )
  assert.equal(
    actions.some((a) => a.startsWith('🤝') && a.includes(yeison.name)),
    false,
    'no gastó invitación en alguien que ya era contacto',
  )
})

test('someone who never accepts is left waiting, not messaged anyway', async () => {
  // Otherwise the demo would be showing a product that talks to people who
  // never let it in.
  const pending = CAST.find((c) => !c.accepts)!
  assert.equal(
    actions.some((a) => a.startsWith('✉️') && a.includes(pending.name)),
    false,
  )
})

test('a reply is recorded and answered, or proposed', async () => {
  const inbound = await db
    .select({ body: messages.body })
    .from(messages)
    .where(eq(messages.direction, 'inbound'))

  assert.ok(inbound.length > 0, 'quedaron respuestas de leads en el historial')

  const conversing = await db
    .select({ stage: enrollments.stage, suggestions: enrollments.suggestions })
    .from(enrollments)
    .where(eq(enrollments.state, 'replied'))

  assert.ok(conversing.length > 0, 'hay conversaciones vivas')
  assert.ok(
    conversing.some((c) => c.stage !== null),
    'con una etapa asignada por el playbook',
  )
})

test('running it twice does not duplicate anyone', async () => {
  // It is the command someone runs again when they are not sure it worked.
  const before = await db.select({ id: enrollments.id }).from(enrollments)

  await seedDemo(db, accountId)
  await runDemo({ db, accountId, timezone: 'America/Argentina/Buenos_Aires', cycles: 4, log: () => {} })

  const after = await db.select({ id: enrollments.id }).from(enrollments)
  assert.equal(after.length, before.length)
})

test('clearing it leaves no demo behind, and keeps the contacts', async () => {
  // Rows that survive a cleanup would show up in a real funnel later, where
  // nothing marks them as fake.
  const removed = await clearDemo(db, accountId)
  assert.equal(removed, 1)

  const left = await db
    .select({ id: automations.id })
    .from(automations)
    .where(eq(automations.name, DEMO_AUTOMATION))
  assert.equal(left.length, 0)

  assert.equal((await db.select({ id: enrollments.id }).from(enrollments)).length, 0)

  // Contacts stay: a contact is a person, and the history is what keeps
  // somebody from being contacted twice later.
  assert.ok((await db.select({ id: contacts.id }).from(contacts)).length > 0)
})

test('the demo provisions its own account, so LinkedIn is not a precondition', async () => {
  // The login is the one step nobody can do on someone's behalf. Requiring it
  // before the thing that shows why it is worth doing puts the hardest part
  // first, which is exactly where people stop.
  const first = await ensureDemoAccount(db)
  const again = await ensureDemoAccount(db)

  assert.equal(first, again, 'no crea una cuenta nueva cada vez')

  const [row] = await db
    .select({ identifier: linkedinAccounts.publicIdentifier })
    .from(linkedinAccounts)
    .where(eq(linkedinAccounts.id, first))
  assert.equal(row!.identifier, DEMO_IDENTIFIER)
})
