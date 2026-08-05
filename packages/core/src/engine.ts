import { checkQuota, type QuotaConfig, type UsageSnapshot, DEFAULT_QUOTA } from './quota.js'
import {
  DAY_MS,
  DEFAULT_TIMING,
  DEFAULT_WORKING_HOURS,
  MINUTE_MS,
  jitteredDelayMs,
  nextWorkingMoment,
  type TimingConfig,
  type WorkingHours,
} from './timing.js'
import { isTerminal, type EnrollmentState, type JobType } from './states.js'

/**
 * The decision function.
 *
 * Pure: given an enrollment and a snapshot of the world, it returns what should
 * happen next. It performs no I/O and never touches LinkedIn, so the entire
 * sequencing logic — the part that is genuinely hard to get right — is testable
 * without a browser or a network.
 */

export type EnrollmentView = {
  id: string
  state: EnrollmentState
  enteredStateAt: Date
  commentText: string | null
  /** Null until the agent has observed it. */
  degree: number | null
  optedOut: boolean
  attempts: number
}

export type DecisionContext = {
  now: Date
  usage: UsageSnapshot
  quota?: QuotaConfig
  timing?: TimingConfig
  workingHours?: WorkingHours
  /** Injected for deterministic tests. */
  random?: () => number
  /** Stop retrying a step after this many failures. */
  maxAttempts?: number
}

export type Decision =
  /** Enqueue work for the agent, and move to `nextState` once it succeeds. */
  | { kind: 'enqueue'; job: JobType; runAt: Date; nextState: EnrollmentState }
  /** Move state with no side effect. */
  | { kind: 'transition'; nextState: EnrollmentState; reason: string }
  /** Nothing to do yet; look again at `until`. */
  | { kind: 'wait'; until: Date; reason: string }
  /** Terminal. */
  | { kind: 'idle'; reason: string }

export function decide(enrollment: EnrollmentView, ctx: DecisionContext): Decision {
  const timing = ctx.timing ?? DEFAULT_TIMING
  const quota = ctx.quota ?? DEFAULT_QUOTA
  const hours = ctx.workingHours ?? DEFAULT_WORKING_HOURS
  const random = ctx.random ?? Math.random
  const maxAttempts = ctx.maxAttempts ?? 3
  const { now } = ctx

  // Opt-out and terminal states win over everything, including retries.
  if (enrollment.optedOut && !isTerminal(enrollment.state)) {
    return { kind: 'transition', nextState: 'opted_out', reason: 'contact opted out' }
  }
  if (isTerminal(enrollment.state)) {
    return { kind: 'idle', reason: `terminal state: ${enrollment.state}` }
  }
  if (enrollment.attempts >= maxAttempts) {
    return { kind: 'transition', nextState: 'failed', reason: `${enrollment.attempts} failed attempts` }
  }

  /** Schedule `job` after a human-ish gap, snapped into working hours. */
  const soon = (job: JobType, nextState: EnrollmentState): Decision => {
    const gap = jitteredDelayMs(timing.minGapSeconds, timing.maxGapSeconds, random)
    return { kind: 'enqueue', job, runAt: nextWorkingMoment(new Date(now.getTime() + gap), hours), nextState }
  }

  const elapsed = now.getTime() - enrollment.enteredStateAt.getTime()

  switch (enrollment.state) {
    case 'detected': {
      if (!checkQuota('comment_reply', ctx.usage, quota).allowed) {
        return { kind: 'wait', until: new Date(now.getTime() + DAY_MS), reason: 'comment reply cap reached' }
      }
      return soon('reply_comment', 'comment_replied')
    }

    case 'comment_replied': {
      // The branch that matters. Existing 1st-degree connections get a DM
      // straight away and cost nothing against the invite cap — on an account
      // with a real audience this is most of the volume.
      if (enrollment.degree === 1) {
        if (!checkQuota('dm', ctx.usage, quota).allowed) {
          return { kind: 'wait', until: new Date(now.getTime() + DAY_MS), reason: 'DM cap reached' }
        }
        return soon('send_dm', 'dm_sent')
      }

      if (enrollment.degree === null) {
        return soon('check_connection', 'comment_replied')
      }

      const verdict = checkQuota('invite', ctx.usage, quota)
      if (!verdict.allowed) {
        // Park it rather than dropping it. The scheduler ranks everything in
        // `invite_queued` by priority when slots free up.
        return { kind: 'transition', nextState: 'invite_queued', reason: `invite ${verdict.reason}` }
      }
      return soon('send_invite', 'invite_sent')
    }

    case 'invite_queued': {
      const verdict = checkQuota('invite', ctx.usage, quota)
      if (!verdict.allowed) {
        return {
          kind: 'wait',
          until: new Date(now.getTime() + verdict.retryAfterDays * DAY_MS),
          reason: `still ${verdict.reason}`,
        }
      }
      return soon('send_invite', 'invite_sent')
    }

    case 'invite_sent': {
      // Acceptance arrives as an external event, so all this branch does is
      // decide when to give up and reclaim the slot.
      if (elapsed >= timing.withdrawInviteAfterDays * DAY_MS) {
        return soon('withdraw_invite', 'invite_expired')
      }
      return {
        kind: 'wait',
        until: new Date(enrollment.enteredStateAt.getTime() + timing.withdrawInviteAfterDays * DAY_MS),
        reason: 'waiting for the invite to be accepted',
      }
    }

    case 'connected': {
      // Never fire the DM the instant they accept — nothing else looks as
      // mechanical, and there is no upside to being fast here.
      const waitMs = jitteredDelayMs(
        timing.dmAfterConnectMinMinutes * 60,
        timing.dmAfterConnectMaxMinutes * 60,
        random,
      )
      if (elapsed < waitMs) {
        return {
          kind: 'wait',
          until: new Date(enrollment.enteredStateAt.getTime() + waitMs),
          reason: 'cooling off after connection accepted',
        }
      }
      if (!checkQuota('dm', ctx.usage, quota).allowed) {
        return { kind: 'wait', until: new Date(now.getTime() + DAY_MS), reason: 'DM cap reached' }
      }
      return soon('send_dm', 'dm_sent')
    }

    case 'dm_sent': {
      if (elapsed < timing.followup1AfterDays * DAY_MS) {
        return {
          kind: 'wait',
          until: new Date(enrollment.enteredStateAt.getTime() + timing.followup1AfterDays * DAY_MS),
          reason: 'waiting for a reply before follow-up 1',
        }
      }
      return soon('send_dm', 'followup_1_sent')
    }

    case 'followup_1_sent': {
      if (elapsed < timing.followup2AfterDays * DAY_MS) {
        return {
          kind: 'wait',
          until: new Date(enrollment.enteredStateAt.getTime() + timing.followup2AfterDays * DAY_MS),
          reason: 'waiting for a reply before follow-up 2',
        }
      }
      return soon('send_dm', 'followup_2_sent')
    }

    case 'followup_2_sent': {
      // Two unanswered follow-ups is the end of it. Chasing further is how
      // inbound turns into the spam this product exists to avoid.
      return { kind: 'transition', nextState: 'closed', reason: 'sequence exhausted without a reply' }
    }

    case 'replied': {
      // Live conversation. The outbound scheduler has no business here — the
      // playbook drives from this point, one lead message at a time.
      return { kind: 'idle', reason: 'conversation owned by the playbook' }
    }

    default: {
      const exhaustive: never = enrollment.state as never
      return { kind: 'idle', reason: `unhandled state: ${String(exhaustive)}` }
    }
  }
}

/**
 * Events that arrive from outside the state machine and override it.
 * A reply always wins: the moment someone writes back, automation stops.
 */
export type ExternalEvent =
  | { type: 'invite_accepted' }
  | { type: 'contact_replied' }
  | { type: 'contact_opted_out' }

export function applyExternalEvent(
  state: EnrollmentState,
  event: ExternalEvent,
): EnrollmentState | null {
  if (isTerminal(state)) return null

  switch (event.type) {
    case 'contact_replied':
      // Already conversing: further messages are the playbook's business, not
      // a state change. Returning 'replied' here would reset enteredStateAt and
      // re-fire anything keyed to entering the state.
      return state === 'replied' ? null : 'replied'
    case 'contact_opted_out':
      return 'opted_out'
    case 'invite_accepted':
      return state === 'invite_sent' || state === 'invite_queued' ? 'connected' : null
  }
}

export const MESSAGE_LIMITS = {
  /** LinkedIn caps the invitation note at 300 characters, all plan tiers. */
  inviteNote: 300,
} as const
