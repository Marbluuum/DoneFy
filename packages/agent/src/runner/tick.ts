import {
  assessHealth,
  checkEligibility,
  decide,
  DEFAULT_POLICY,
  isTerminal,
  matchesKeyword,
  openingDm,
  orchestrate,
  type ConversationStage,
  type ConversationTurn,
  type EnrollmentState,
  type OrchestratorMode,
  type WorkingHours,
} from '@linkfy/core'

import { AdapterError, type LinkedInAdapter } from '../linkedin/adapter.js'
import type { Classifier, NoteWriter, PendingEnrollment, Repository } from './ports.js'

/**
 * One cycle of the agent.
 *
 * Four phases, in this order and for a reason:
 *
 *   1. health   — refuse to act at all if the account is in trouble
 *   2. scan     — find new keyword comments and enroll who qualifies
 *   3. listen   — read what leads wrote back
 *   4. converse — let the playbook answer, or propose an answer
 *   5. reconcile— notice who accepted the invitation
 *   6. schedule — ask the engine what each enrollment needs next
 *   7. execute  — do the queued work
 *
 * Health first because every later phase can send something, and a restricted
 * account should discover that before it acts, not after. Scanning before
 * scheduling so a comment posted a minute ago is handled in the same cycle
 * rather than waiting a full tick. Listening before scheduling because a reply
 * that arrived overnight has to cancel the follow-up that would otherwise be
 * queued this afternoon — getting that order wrong means answering someone by
 * chasing them.
 *
 * Nothing here is a loop: a tick does a bounded amount of work and returns. The
 * loop lives in the runner, which makes this testable and means a crash costs
 * one cycle rather than the process.
 */

export type TickDeps = {
  accountId: string
  repo: Repository
  linkedin: LinkedInAdapter
  classifier: Classifier
  writer: NoteWriter
  workingHours: WorkingHours
  /** How much the agent may do on its own. Defaults to proposing everything. */
  mode?: OrchestratorMode
  now: () => Date
  /** Identifies this agent when claiming jobs. */
  leaseHolder: string
  /** Ceilings so one cycle cannot run away. */
  maxCommentsPerPost?: number
  maxJobsPerTick?: number
  maxEnrollmentsPerTick?: number
  maxConversationsPerTick?: number
  /** Profile visits spent per cycle confirming acceptances. */
  maxAcceptanceChecksPerTick?: number
  log?: (message: string, data?: Record<string, unknown>) => void
}

export type TickResult = {
  health: 'healthy' | 'warning' | 'throttled' | 'stopped'
  enrolled: number
  scheduled: number
  executed: number
  failed: number
  /** Lead messages read for the first time. */
  inbound: number
  /** Replies the agent proposed rather than sent. */
  proposed: number
  /** Invitations found to have been accepted this cycle. */
  accepted: number
  skipped: string[]
}

export async function runTick(deps: TickDeps): Promise<TickResult> {
  const log = deps.log ?? (() => {})
  const now = deps.now()
  const result: TickResult = {
    health: 'healthy',
    enrolled: 0,
    scheduled: 0,
    executed: 0,
    failed: 0,
    inbound: 0,
    proposed: 0,
    accepted: 0,
    skipped: [],
  }

  // --- 1. health --------------------------------------------------------
  await deps.linkedin.assertSignedIn()
  // Recorded before any decision to skip work, so a throttled account still
  // looks alive in the panel instead of looking crashed.
  await deps.repo.touchAccount(deps.accountId, now)

  const health = assessHealth(await deps.repo.healthWindow(deps.accountId))
  result.health = health.state
  if (health.state !== 'healthy') {
    log(`salud de cuenta: ${health.state}`, { reasons: health.reasons })
    await deps.repo.recordEvent(deps.accountId, 'health', { state: health.state, reasons: health.reasons })
  }
  if (!health.allowSends) {
    // Stopped means LinkedIn is already refusing us. Reading more would only
    // add to whatever pattern triggered it.
    result.skipped.push(`cuenta detenida: ${health.reasons[0] ?? ''}`)
    return result
  }

  // --- 2. scan ----------------------------------------------------------
  const automations = await deps.repo.activeAutomations(deps.accountId)
  const ownIdentifier = await deps.repo.ownIdentifier(deps.accountId)

  await syncOwnPosts(deps, ownIdentifier, now, log)

  for (const automation of automations) {
    for (const postUrl of automation.postUrls) {
      const comments = await deps.linkedin
        .readComments(postUrl, deps.maxCommentsPerPost ?? 100)
        .catch((error: unknown) => {
          log(`no se pudieron leer comentarios de ${postUrl}`, { error: String(error) })
          return []
        })

      for (const comment of comments) {
        const keyword = matchesKeyword(comment.body, automation.keywords)
        if (!keyword) continue

        if (await deps.repo.isCommentEnrolled(automation.id, comment.urn)) continue

        const contact = await deps.repo.contactByIdentifier(
          deps.accountId,
          comment.authorPublicIdentifier,
        )

        const verdict = checkEligibility({
          history: {
            hasActiveEnrollment: contact?.hasActiveEnrollment ?? false,
            everInvited: contact?.everInvited ?? false,
            everMessaged: contact?.everMessaged ?? false,
            lastOutcome: contact?.lastOutcome ?? null,
            lastContactedAt: contact?.lastContactedAt ?? null,
            optedOut: contact?.optedOut ?? false,
            isSelf: comment.authorPublicIdentifier === ownIdentifier,
          },
          health,
          now,
        })

        if (!verdict.eligible) {
          result.skipped.push(`${comment.authorPublicIdentifier}: ${verdict.reason}`)
          continue
        }

        await deps.repo.createEnrollment({
          accountId: deps.accountId,
          automationId: automation.id,
          publicIdentifier: comment.authorPublicIdentifier,
          fullName: comment.authorName,
          headline: comment.authorHeadline,
          commentUrn: comment.urn,
          commentText: comment.body,
          matchedKeyword: keyword,
          postUrl,
        })
        result.enrolled++

        if (result.enrolled >= (deps.maxEnrollmentsPerTick ?? 50)) break
      }
    }
  }

  // --- 3. listen --------------------------------------------------------
  // Reading before scheduling, because a reply that arrived overnight has to
  // stop the follow-up that would otherwise be queued for this afternoon.
  result.inbound += await readInbound(deps, log)

  // --- 4. converse ------------------------------------------------------
  result.proposed += await advanceConversations(deps, automations, now, log)

  // --- 5. reconcile -----------------------------------------------------
  // Acceptance produces no event of any kind: LinkedIn simply makes you a 1st
  // degree connection. Nothing here would ever notice, and the lead who said
  // yes would wait forever for a DM that was never queued.
  result.accepted += await reconcileInvites(deps, now, log)

  // --- 6. schedule ------------------------------------------------------
  const due = await deps.repo.dueEnrollments(deps.accountId, now, 100)
  const usage = await deps.repo.usage(deps.accountId, now)

  for (const enrollment of due) {
    const decision = decide(
      {
        id: enrollment.id,
        state: enrollment.state,
        enteredStateAt: enrollment.enteredStateAt,
        commentText: enrollment.commentText,
        degree: enrollment.degree,
        optedOut: enrollment.optedOut,
        attempts: enrollment.attempts,
      },
      { now, usage, workingHours: deps.workingHours },
    )

    switch (decision.kind) {
      case 'enqueue':
        await deps.repo.enqueueJob({
          accountId: deps.accountId,
          enrollmentId: enrollment.id,
          type: decision.job,
          payload: {
            publicIdentifier: enrollment.publicIdentifier,
            postUrl: enrollment.postUrl,
            commentUrn: enrollment.commentUrn,
            nextState: decision.nextState,
          },
          runAfter: decision.runAt,
        })
        // Parked until the job runs. Without this the row stays due and the
        // next tick — a minute later — queues the same work again, which for
        // send_invite means inviting the same person twice.
        await deps.repo.setEnrollmentState(enrollment.id, enrollment.state, null)
        result.scheduled++
        break
      case 'transition':
        await deps.repo.setEnrollmentState(enrollment.id, decision.nextState, isTerminal(decision.nextState) ? null : now)
        break
      case 'wait':
        await deps.repo.setEnrollmentState(enrollment.id, enrollment.state, decision.until)
        break
      case 'idle':
        await deps.repo.setEnrollmentState(enrollment.id, enrollment.state, null)
        break
    }
  }

  // --- 7. execute -------------------------------------------------------
  const jobs = await deps.repo.claimJobs(
    deps.accountId,
    now,
    deps.maxJobsPerTick ?? 10,
    deps.leaseHolder,
  )

  for (const job of jobs) {
    try {
      await executeJob(job, deps, health.allowInvites)
      await deps.repo.completeJob(job.id)
      result.executed++
    } catch (error) {
      result.failed++
      const adapterError = error instanceof AdapterError ? error : null
      // A broken selector is our bug and retrying will not help; a timeout is
      // worth another attempt. Getting this backwards either spins forever on
      // a bad selector or discards work over a blip.
      const retryable = adapterError ? adapterError.kind === 'transient' : true

      await deps.repo.failJob(job.id, error instanceof Error ? error.message : String(error), retryable)
      await deps.repo.recordEvent(deps.accountId, 'job_failed', {
        job: job.type,
        kind: adapterError?.kind ?? 'unknown',
        message: error instanceof Error ? error.message : String(error),
      })

      // An auth failure invalidates the rest of the cycle: every remaining job
      // would fail the same way and each would look like its own problem.
      if (adapterError?.kind === 'auth') {
        result.skipped.push('sesión caída, se corta el ciclo')
        break
      }
    }
  }

  return result
}

async function executeJob(
  job: Awaited<ReturnType<Repository['claimJobs']>>[number],
  deps: TickDeps,
  allowInvites: boolean,
): Promise<void> {
  const payload = job.payload as {
    publicIdentifier: string
    postUrl?: string
    commentUrn?: string
    body?: string
    nextStage?: ConversationStage
    nextState: EnrollmentState
  }
  const enrollmentId = job.enrollmentId!
  const now = deps.now()

  const advance = (state: EnrollmentState) =>
    deps.repo.setEnrollmentState(enrollmentId, state, isTerminal(state) ? null : now)

  switch (job.type) {
    case 'check_connection': {
      const profile = await deps.linkedin.readProfile(payload.publicIdentifier)
      if (profile.degree) {
        const contact = await deps.repo.contactByIdentifier(deps.accountId, payload.publicIdentifier)
        if (contact) await deps.repo.setContactDegree(contact.id, profile.degree)
      }
      // Deliberately does not advance: the engine re-decides next tick now
      // that it knows the degree, which is what routes invite versus DM.
      await deps.repo.setEnrollmentState(enrollmentId, 'comment_replied', now)
      return
    }

    case 'reply_comment': {
      const enrollment = await findEnrollment(deps, enrollmentId)
      const firstName = enrollment?.firstName ?? ''
      const body = `${firstName} enviado`.trim()

      // Liked first, in the same page visit. It costs no navigation, it shows
      // up in their notifications before the reply does, and not liking a
      // comment you are about to answer is the part that looks automated.
      // Deliberately not awaited into the failure path: see below.
      await deps.linkedin
        .likeComment(payload.postUrl!, payload.commentUrn!)
        .catch(() => false)

      await deps.linkedin.replyToComment(payload.postUrl!, payload.commentUrn!, body)
      await deps.repo.countAction(deps.accountId, 'comment_reply', now)
      if (enrollment) {
        await deps.repo.recordMessage({
          contactId: enrollment.contactId,
          enrollmentId,
          channel: 'comment_reply',
          direction: 'outbound',
          body,
          generated: false,
        })
      }
      await advance(payload.nextState)
      return
    }

    case 'send_invite': {
      if (!allowInvites) {
        // Health said no since this was queued. Park it rather than spend a
        // slot the breaker just decided we should not spend.
        await deps.repo.setEnrollmentState(enrollmentId, 'invite_queued', now)
        return
      }

      const enrollment = await findEnrollment(deps, enrollmentId)
      const note = enrollment
        ? await deps.writer.inviteNote({
            firstName: enrollment.firstName,
            headline: enrollment.headline,
            comment: enrollment.commentText ?? '',
            matchedKeyword: enrollment.matchedKeyword ?? '',
            postExcerpt: enrollment.postUrl ?? '',
          })
        : undefined

      const outcome = await deps.linkedin.sendInvite(payload.publicIdentifier, note)

      if (!outcome.sent) {
        if (outcome.reason === 'weekly_limit') {
          await deps.repo.setEnrollmentState(enrollmentId, 'invite_queued', now)
          return
        }
        // Already connected or no button: the DM path applies instead.
        await deps.repo.setEnrollmentState(enrollmentId, 'connected', now)
        return
      }

      await deps.repo.countAction(deps.accountId, 'invite', now)
      await deps.repo.markInvited(enrollmentId, now)
      if (enrollment && note) {
        await deps.repo.recordMessage({
          contactId: enrollment.contactId,
          enrollmentId,
          channel: 'invite_note',
          direction: 'outbound',
          body: note,
          generated: true,
        })
      }
      await advance(payload.nextState)
      return
    }

    case 'send_dm': {
      const enrollment = await findEnrollment(deps, enrollmentId)
      const body = openingDm(enrollment?.firstName ?? '')

      await deps.linkedin.sendMessage(payload.publicIdentifier, body)
      await deps.repo.countAction(deps.accountId, 'dm', now)
      if (enrollment) {
        await deps.repo.recordMessage({
          contactId: enrollment.contactId,
          enrollmentId,
          channel: 'dm',
          direction: 'outbound',
          body,
          generated: false,
        })
      }
      await advance(payload.nextState)
      return
    }

    case 'send_reply': {
      const body = String(payload.body ?? '')
      if (!body) throw new AdapterError('selector', 'send_reply sin texto')

      const enrollment = await findEnrollment(deps, enrollmentId)
      await deps.linkedin.sendMessage(payload.publicIdentifier, body)
      await deps.repo.countAction(deps.accountId, 'dm', now)

      if (enrollment) {
        await deps.repo.recordMessage({
          contactId: enrollment.contactId,
          enrollmentId,
          channel: 'dm',
          direction: 'outbound',
          body,
          generated: true,
        })
      }

      const stage = payload.nextStage as ConversationStage
      await deps.repo.setStage(enrollmentId, stage)

      // A conversation that ended also ends the enrollment; leaving it in
      // `replied` would keep offering replies to someone who already booked.
      const finalState = STAGE_TO_STATE[stage]
      if (finalState) await advance(finalState)
      return
    }

    case 'withdraw_invite':
      await deps.linkedin.withdrawInvite(payload.publicIdentifier)
      await advance(payload.nextState)
      return

    default:
      throw new AdapterError('selector', `Tipo de job no implementado: ${job.type}`)
  }
}


/**
 * Reads inbound messages and attaches them to the conversation they belong to.
 *
 * A message arrives identified by who sent it, never by which enrollment it
 * belongs to, so the matching happens here. Anything from someone who is not
 * in a flow is ignored rather than enrolled: this product only ever talks to
 * people who reached out first.
 */
async function readInbound(
  deps: TickDeps,
  log: (message: string, data?: Record<string, unknown>) => void,
): Promise<number> {
  const conversations = await deps.linkedin
    .listConversations({ limit: deps.maxConversationsPerTick ?? 25 })
    .catch((error: unknown) => {
      log('no se pudieron leer las conversaciones', { error: String(error) })
      return []
    })

  let recorded = 0

  for (const conversation of conversations) {
    if (conversation.lastMessageFromOwner) continue

    const enrollment = await deps.repo.openEnrollmentFor(
      deps.accountId,
      conversation.participantPublicIdentifier,
    )
    if (!enrollment) continue

    const thread = await deps.linkedin.readThread(conversation.threadId).catch(() => [])
    const known = await deps.repo.history(enrollment.id)

    // Matched on sender and text rather than on a timestamp: LinkedIn renders
    // times as "hace 2 h", so the same message read twice carries two
    // different instants and would be stored twice.
    const fresh = thread.filter(
      (message) => !known.some((seen) => seen.from === message.from && seen.body === message.body),
    )

    for (const message of fresh) {
      await deps.repo.recordMessage({
        contactId: enrollment.contactId,
        enrollmentId: enrollment.id,
        channel: 'dm',
        direction: message.from === 'lead' ? 'inbound' : 'outbound',
        body: message.body,
        generated: false,
      })
      if (message.from === 'lead') recorded++
    }

    if (fresh.some((m) => m.from === 'lead') && enrollment.state !== 'replied') {
      // A reply ends the outbound sequence, whatever it was about to do next.
      await deps.repo.setEnrollmentState(enrollment.id, 'replied', deps.now())
      await deps.repo.recordEvent(deps.accountId, 'lead_replied', {
        enrollment: enrollment.id,
        from: enrollment.publicIdentifier,
      })
    }
  }

  return recorded
}

/** How often the account's own posts are re-read. */
const POST_SYNC_MS = 6 * 60 * 60 * 1000

/**
 * Keeps the list of the owner's own posts current.
 *
 * It exists so nobody pastes an activity URL by hand — the step where one bad
 * copy produces an automation watching a post that does not exist, which
 * reports no error and simply never fires.
 *
 * Rate-limited because publications change a few times a week and the activity
 * feed is a page load: doing it every ninety seconds is traffic that buys
 * nothing.
 */
async function syncOwnPosts(
  deps: TickDeps,
  ownIdentifier: string,
  now: Date,
  log: (message: string, data?: Record<string, unknown>) => void,
): Promise<void> {
  if (!ownIdentifier) return

  const last = await deps.repo.postsSyncedAt(deps.accountId)
  if (last && now.getTime() - last.getTime() < POST_SYNC_MS) return

  try {
    const own = await deps.linkedin.listOwnPosts(ownIdentifier, 20)
    if (own.length === 0) return
    const saved = await deps.repo.savePosts(deps.accountId, own, now)
    log(`publicaciones sincronizadas: ${saved}`)
  } catch (error) {
    // Never fatal. Automations already pointing at a post keep working; only
    // the picker in the panel goes stale.
    log('no se pudieron leer tus publicaciones', { error: String(error) })
  }
}

/** How long before a pending invitation is worth looking at again. */
const ACCEPTANCE_RECHECK_MS = 6 * 60 * 60 * 1000

/**
 * Notices which invitations were accepted.
 *
 * Two steps, because each alone is wrong. The sent-invitations page lists
 * everyone still pending in one read — cheap, but its absences are not proof:
 * a changed selector or a half-loaded page produces an empty list too, and
 * acting on that directly would mark every outstanding invitation as accepted
 * at once. So absence only selects who is worth a profile visit, and the
 * profile — where the degree is stated outright — decides.
 *
 * Anyone still listed as pending costs nothing but a timestamp.
 */
async function reconcileInvites(
  deps: TickDeps,
  now: Date,
  log: (message: string, data?: Record<string, unknown>) => void,
): Promise<number> {
  const candidates = await deps.repo.invitesAwaitingAcceptance(
    deps.accountId,
    new Date(now.getTime() - ACCEPTANCE_RECHECK_MS),
    deps.maxAcceptanceChecksPerTick ?? 5,
  )
  if (candidates.length === 0) return 0

  let pending: Set<string>
  try {
    pending = new Set(await deps.linkedin.listPendingInvites())
  } catch (error) {
    // Unreadable is not "nobody is pending". Leaving the timestamps alone
    // means the same candidates come back next cycle instead of every
    // outstanding invitation being resolved on a bad page load.
    log('no se pudo leer la lista de invitaciones enviadas', { error: String(error) })
    return 0
  }

  let accepted = 0

  for (const enrollment of candidates) {
    if (pending.has(enrollment.publicIdentifier)) {
      await deps.repo.markAcceptanceChecked(enrollment.id, now)
      continue
    }

    const profile = await deps.linkedin
      .readProfile(enrollment.publicIdentifier)
      .catch(() => null)

    // Unreadable profile: no timestamp, so it is retried rather than being
    // silently written off as a declined invitation.
    if (!profile) continue

    await deps.repo.markAcceptanceChecked(enrollment.id, now)
    if (profile.degree) await deps.repo.setContactDegree(enrollment.contactId, profile.degree)

    if (profile.degree === 1) {
      // `connected` rather than straight to the DM: the engine holds it for a
      // couple of hours first, because nothing reads as automated like a
      // message that lands the second someone accepts.
      await deps.repo.setEnrollmentState(enrollment.id, 'connected', now)
      await deps.repo.recordEvent(deps.accountId, 'invite_accepted', {
        enrollment: enrollment.id,
        lead: enrollment.publicIdentifier,
      })
      accepted++
      continue
    }

    // Gone from the pending list and still not connected: withdrawn from the
    // other side, declined, or expired. The slot is free either way.
    await deps.repo.setEnrollmentState(enrollment.id, 'invite_expired', null)
    await deps.repo.recordEvent(deps.accountId, 'invite_resolved_unaccepted', {
      enrollment: enrollment.id,
      lead: enrollment.publicIdentifier,
    })
  }

  return accepted
}

/** The stage a conversation starts in, before anything has been read. */
const FIRST_STAGE: ConversationStage = 'qualifying_company'

/** Conversation outcomes that also end the enrollment. */
const STAGE_TO_STATE: Partial<Record<ConversationStage, EnrollmentState>> = {
  booked: 'booked',
  disqualified: 'disqualified',
  handed_off: 'handed_off',
  abandoned: 'closed',
}

/**
 * Runs the playbook over every live conversation.
 *
 * What comes out is a decision, not a message: in copilot mode — the default —
 * everything is proposed and the owner clicks. That is deliberate. The moment
 * this sends unattended it is answering a real person in your name, and the
 * cost of being wrong is not a wasted invite, it is a burnt lead.
 */
async function advanceConversations(
  deps: TickDeps,
  automations: Awaited<ReturnType<Repository['activeAutomations']>>,
  now: Date,
  log: (message: string, data?: Record<string, unknown>) => void,
): Promise<number> {
  const calendars = new Map(automations.map((a) => [a.id, a.calendarUrl]))
  const modes = new Map(automations.map((a) => [a.id, a.mode]))
  const conversing = await deps.repo.conversingEnrollments(
    deps.accountId,
    deps.maxConversationsPerTick ?? 25,
  )

  let proposed = 0

  for (const enrollment of conversing) {
    const history: ConversationTurn[] = await deps.repo.history(enrollment.id)
    const latest = history.at(-1)

    // Nothing to answer: either silence, or we already spoke last. The
    // orchestrator would refuse anyway, but classifying our own message would
    // spend a call to be told so.
    if (!latest || latest.from !== 'lead') continue

    // Already read, and nothing new since. Re-classifying would spend a model
    // call per lead per cycle to reach the same conclusion about the same
    // message — and overwrite suggestions the owner may be looking at.
    if (enrollment.conversationReadAt && latest.at <= enrollment.conversationReadAt) continue

    const stage = enrollment.stage ?? FIRST_STAGE

    let classification
    try {
      classification = await deps.classifier.classify({
        stage,
        history: history.slice(0, -1),
        latest: latest.body,
      })
    } catch (error) {
      log('no se pudo clasificar la respuesta', {
        lead: enrollment.publicIdentifier,
        error: error instanceof Error ? error.message : String(error),
      })
      continue
    }

    const decision = orchestrate(
      {
        stage,
        history,
        optedOut: enrollment.optedOut,
        firstName: enrollment.firstName,
        calendarUrl: calendars.get(enrollment.automationId) ?? '',
      },
      classification,
      {
        ...DEFAULT_POLICY,
        // Three levels, most specific first: this one conversation switched to
        // autopilot from the inbox, then the automation it came from, then the
        // account-wide default. Each only ever raises the ceiling — the
        // step-level rules still apply, so the pitch stays manual throughout.
        mode: enrollment.autoReply
          ? 'autopilot'
          : (modes.get(enrollment.automationId) ?? deps.mode ?? 'copilot'),
        workingHours: deps.workingHours,
      },
      now,
    )

    await deps.repo.saveConversationRead({
      enrollmentId: enrollment.id,
      stage,
      intent: classification.intent,
      confidence: classification.confidence,
      suggestions: decision.action.kind === 'suggest' ? decision.action.options : [],
      nextStage: decision.nextStage,
      notes: decision.notes,
    })

    switch (decision.action.kind) {
      case 'send':
        await deps.repo.enqueueJob({
          accountId: deps.accountId,
          enrollmentId: enrollment.id,
          type: 'send_reply',
          payload: {
            publicIdentifier: enrollment.publicIdentifier,
            body: decision.action.body,
            nextStage: decision.nextStage,
          },
          runAfter: decision.action.sendAt,
        })
        break

      case 'suggest':
        proposed++
        break

      case 'handoff':
        await deps.repo.setEnrollmentState(enrollment.id, 'handed_off', null)
        await deps.repo.recordEvent(deps.accountId, 'handed_off', {
          enrollment: enrollment.id,
          reason: decision.action.reason,
        })
        break

      case 'none':
        break
    }
  }

  return proposed
}

async function findEnrollment(deps: TickDeps, id: string): Promise<PendingEnrollment | undefined> {
  return (await deps.repo.enrollmentById(id)) ?? undefined
}
