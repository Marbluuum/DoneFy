'use server'

import { revalidatePath } from 'next/cache'

import { and, eq, inArray, notInArray } from 'drizzle-orm'

import { TERMINAL_STATES } from '@linkfy/core'
import { automations, contacts, createDb, enrollments, jobs, posts, type Db } from '@linkfy/db'

/**
 * What the panel can do.
 *
 * None of it touches LinkedIn. The panel writes a job; the agent on the
 * owner's machine is the only thing that ever acts on the account. That
 * separation is the product's whole safety story — a panel that could send
 * would need the session, and the session never leaves the laptop.
 *
 * It also means a click works while the agent is asleep: the job waits.
 */

const NOT_CONFIGURED = 'No hay una cuenta conectada. Corré `npm run init`.'

async function scope() {
  const url = process.env.DATABASE_URL
  const accountId = process.env.LINKFY_ACCOUNT_ID ?? process.env.DONEFY_ACCOUNT_ID
  if (!url || !accountId) return null
  return { db: createDb(url), accountId }
}

/**
 * Loads one enrollment, scoped to the configured account.
 *
 * The id arrives from the browser, so it is never trusted to belong here —
 * every action goes through this rather than querying by id alone.
 */
async function ownedEnrollment(db: Db, accountId: string, enrollmentId: string) {
  const [row] = await db
    .select({
      id: enrollments.id,
      stage: enrollments.stage,
      state: enrollments.state,
      suggestions: enrollments.suggestions,
      publicIdentifier: contacts.publicIdentifier,
    })
    .from(enrollments)
    .innerJoin(automations, eq(enrollments.automationId, automations.id))
    .innerJoin(contacts, eq(enrollments.contactId, contacts.id))
    .where(and(eq(enrollments.id, enrollmentId), eq(automations.accountId, accountId)))
    .limit(1)
  return row ?? null
}

export type ActionResult = { ok: true } | { ok: false; error: string }

/**
 * Queues a reply for the agent to send.
 *
 * The stage it leads to comes from the stored suggestion, not from the
 * browser: the playbook already decided, and letting the client name the next
 * stage would let a stale tab move a conversation somewhere it never agreed to
 * go. Text typed by hand simply leaves the stage where it is.
 */
export async function sendReply(enrollmentId: string, body: string): Promise<ActionResult> {
  const trimmed = body.trim()
  if (!trimmed) return { ok: false, error: 'El mensaje está vacío.' }

  const ctx = await scope()
  if (!ctx) return { ok: false, error: NOT_CONFIGURED }

  const enrollment = await ownedEnrollment(ctx.db, ctx.accountId, enrollmentId)
  if (!enrollment) return { ok: false, error: 'Esa conversación no existe en tu cuenta.' }
  if (TERMINAL_STATES.has(enrollment.state as never)) {
    return { ok: false, error: 'Esa conversación ya está cerrada.' }
  }

  const chosen = (enrollment.suggestions ?? []).find((s: { body: string }) => s.body === trimmed)

  // Not claimed by any agent, so whichever one is running picks it up. Queued
  // for now rather than paced: the owner just decided, and the pacing that
  // matters is between the agent's own actions.
  await ctx.db.insert(jobs).values({
    accountId: ctx.accountId,
    enrollmentId,
    type: 'send_reply',
    payload: {
      publicIdentifier: enrollment.publicIdentifier,
      body: trimmed,
      nextStage: chosen?.nextStage ?? enrollment.stage ?? 'qualifying_company',
    },
    status: 'pending',
    runAfter: new Date(),
  })

  revalidatePath('/inbox')
  return { ok: true }
}

/** Turns unattended replying on or off for a single conversation. */
export async function setAutoReply(enrollmentId: string, enabled: boolean): Promise<ActionResult> {
  const ctx = await scope()
  if (!ctx) return { ok: false, error: NOT_CONFIGURED }

  const enrollment = await ownedEnrollment(ctx.db, ctx.accountId, enrollmentId)
  if (!enrollment) return { ok: false, error: 'Esa conversación no existe en tu cuenta.' }

  await ctx.db
    .update(enrollments)
    .set({ autoReply: enabled ? 1 : 0 })
    .where(eq(enrollments.id, enrollmentId))

  revalidatePath('/inbox')
  return { ok: true }
}

/**
 * Stops everything for one conversation and hands it to the owner.
 *
 * Separate from opting the contact out: this is "I will take it from here",
 * not "never contact this person".
 */
export async function takeOver(enrollmentId: string): Promise<ActionResult> {
  const ctx = await scope()
  if (!ctx) return { ok: false, error: NOT_CONFIGURED }

  const enrollment = await ownedEnrollment(ctx.db, ctx.accountId, enrollmentId)
  if (!enrollment) return { ok: false, error: 'Esa conversación no existe en tu cuenta.' }

  await ctx.db
    .update(enrollments)
    .set({ state: 'handed_off', nextActionAt: null, suggestions: [] })
    .where(eq(enrollments.id, enrollmentId))

  // Queued work for this conversation is pointless now, and a reply that goes
  // out after "I'll take this" is worse than one that never went out.
  await ctx.db
    .update(jobs)
    .set({ status: 'failed', lastError: 'conversación tomada por el dueño' })
    .where(
      and(
        eq(jobs.enrollmentId, enrollmentId),
        inArray(jobs.status, ['pending', 'leased']),
        notInArray(jobs.type, ['check_connection']),
      ),
    )

  revalidatePath('/inbox')
  return { ok: true }
}


/**
 * Creates an automation from the panel.
 *
 * Active from the moment it is created: an automation you just described that
 * then sits there doing nothing is the confusing outcome, and pausing is one
 * click away.
 */
export async function createAutomation(input: {
  name: string
  keywords: string
  postUrl: string
  calendarUrl: string
}): Promise<ActionResult> {
  const ctx = await scope()
  if (!ctx) return { ok: false, error: NOT_CONFIGURED }

  const name = input.name.trim()
  if (!name) return { ok: false, error: 'Ponele un nombre.' }

  // Split on commas so several keywords can be typed in one field, lowercased
  // because matching is case- and accent-insensitive downstream.
  const keywords = input.keywords
    .split(',')
    .map((k) => k.trim().toLowerCase())
    .filter(Boolean)

  if (keywords.length === 0) {
    return {
      ok: false,
      error: 'Hace falta al menos una palabra clave. Sin una, se dispararía con cualquier comentario.',
    }
  }

  const url = input.postUrl.trim()
  if (url && !url.includes('linkedin.com')) {
    return { ok: false, error: 'Esa no parece una URL de LinkedIn.' }
  }

  const postIds: string[] = []
  if (url) {
    // Registered here so the automation can point at the post before the agent
    // has ever scanned it. Same URL-as-URN convention the agent uses.
    const [post] = await ctx.db
      .insert(posts)
      .values({ accountId: ctx.accountId, urn: url, url })
      .onConflictDoUpdate({ target: [posts.accountId, posts.urn], set: { url } })
      .returning({ id: posts.id })
    postIds.push(post!.id)
  }

  await ctx.db.insert(automations).values({
    accountId: ctx.accountId,
    name,
    status: 'active',
    keywords,
    postIds,
    flow: {
      nodes: [
        { id: 'reply', type: 'comment_reply', config: {} },
        { id: 'invite', type: 'invite', config: {} },
        { id: 'dm', type: 'dm', config: {} },
        { id: 'book', type: 'book', config: { calendarUrl: input.calendarUrl.trim() } },
      ],
      edges: [
        { from: 'reply', to: 'invite' },
        { from: 'invite', to: 'dm' },
        { from: 'dm', to: 'book' },
      ],
    },
  })

  revalidatePath('/automations')
  return { ok: true }
}

/**
 * Pauses or resumes an automation.
 *
 * Pausing stops new people entering. Conversations already under way keep
 * going — cutting off someone mid-exchange because a rule was paused would
 * leave a real person waiting on an answer that never comes.
 */
export async function setAutomationStatus(
  automationId: string,
  status: 'active' | 'paused',
): Promise<ActionResult> {
  const ctx = await scope()
  if (!ctx) return { ok: false, error: NOT_CONFIGURED }

  const updated = await ctx.db
    .update(automations)
    .set({ status, updatedAt: new Date() })
    .where(and(eq(automations.id, automationId), eq(automations.accountId, ctx.accountId)))
    .returning({ id: automations.id })

  if (updated.length === 0) return { ok: false, error: 'Esa automatización no es de tu cuenta.' }

  revalidatePath('/automations')
  return { ok: true }
}
