import {
  assessHealth,
  checkEligibility,
  decide,
  isTerminal,
  matchesKeyword,
  openingDm,
  type EnrollmentState,
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
 *   3. schedule — ask the engine what each enrollment needs next
 *   4. execute  — do the queued work
 *
 * Health first because every later phase can send something, and a restricted
 * account should discover that before it acts, not after. Scanning before
 * scheduling so a comment posted a minute ago is handled in the same cycle
 * rather than waiting a full tick.
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
  now: () => Date
  /** Identifies this agent when claiming jobs. */
  leaseHolder: string
  /** Ceilings so one cycle cannot run away. */
  maxCommentsPerPost?: number
  maxJobsPerTick?: number
  maxEnrollmentsPerTick?: number
  log?: (message: string, data?: Record<string, unknown>) => void
}

export type TickResult = {
  health: 'healthy' | 'warning' | 'throttled' | 'stopped'
  enrolled: number
  scheduled: number
  executed: number
  failed: number
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

  // --- 3. schedule ------------------------------------------------------
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

  // --- 4. execute -------------------------------------------------------
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

    case 'withdraw_invite':
      await deps.linkedin.withdrawInvite(payload.publicIdentifier)
      await advance(payload.nextState)
      return

    default:
      throw new AdapterError('selector', `Tipo de job no implementado: ${job.type}`)
  }
}

async function findEnrollment(deps: TickDeps, id: string): Promise<PendingEnrollment | undefined> {
  return (await deps.repo.enrollmentById(id)) ?? undefined
}
