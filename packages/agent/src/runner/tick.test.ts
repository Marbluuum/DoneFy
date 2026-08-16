import assert from 'node:assert/strict'
import { test } from 'node:test'

import { DEFAULT_WORKING_HOURS, type EnrollmentState } from '@donefy/core'

import { AdapterError, type LinkedInAdapter, type PostComment } from '../linkedin/adapter.js'
import type { PendingEnrollment, QueuedJob, Repository } from './ports.js'
import { runTick, type TickDeps } from './tick.js'

/**
 * The tick is where ordering, guards and failure handling live — the code that
 * most needs testing and least tolerates being run for real. A fake repository
 * and a fake adapter make that possible without a database or an account.
 */

const NOW = new Date('2026-08-05T14:00:00Z') // Wednesday, working hours
const ACCOUNT = 'acc-1'

function comment(overrides: Partial<PostComment> = {}): PostComment {
  return {
    urn: 'c1',
    authorPublicIdentifier: 'diego-perez',
    authorName: 'Diego Perez',
    authorHeadline: 'CEO en Global SI',
    body: 'software',
    ...overrides,
  }
}

type FakeState = {
  comments: PostComment[]
  enrolled: Array<{ publicIdentifier: string; commentUrn: string }>
  jobs: QueuedJob[]
  enqueued: Array<{ type: string; enrollmentId: string }>
  states: Array<{ id: string; state: EnrollmentState }>
  failures: Array<{ jobId: string; retryable: boolean }>
  actions: string[]
  health: { accepted: number; resolved: number; failures: number; attempted: number }
  contacts: Record<string, Partial<import('./ports.js').ContactSnapshot>>
  due: PendingEnrollment[]
}

function fakeRepo(state: FakeState): Repository {
  return {
    activeAutomations: async () => [
      {
        id: 'auto-1',
        accountId: ACCOUNT,
        keywords: ['software'],
        postUrls: ['https://www.linkedin.com/posts/x'],
        calendarUrl: 'https://enbiconsulting.com/agenda-software',
      },
    ],
    ownIdentifier: async () => 'martinbufczyk',
    contactByIdentifier: async (_a, id) => {
      const c = state.contacts[id]
      if (!c) return null
      return {
        id: `contact-${id}`,
        publicIdentifier: id,
        hasActiveEnrollment: false,
        everInvited: false,
        everMessaged: false,
        optedOut: false,
        ...c,
      }
    },
    isCommentEnrolled: async (_a, urn) => state.enrolled.some((e) => e.commentUrn === urn),
    createEnrollment: async (input) => {
      state.enrolled.push({ publicIdentifier: input.publicIdentifier, commentUrn: input.commentUrn })
      return `enr-${state.enrolled.length}`
    },
    dueEnrollments: async () => state.due,
    enqueueJob: async (input) => {
      state.enqueued.push({ type: input.type, enrollmentId: input.enrollmentId })
    },
    claimJobs: async () => state.jobs,
    completeJob: async () => {},
    failJob: async (jobId, _e, retryable) => {
      state.failures.push({ jobId, retryable })
    },
    setEnrollmentState: async (id, s) => {
      state.states.push({ id, state: s })
    },
    setContactDegree: async () => {},
    recordMessage: async () => {},
    usage: async () => ({ today: { invite: 0, dm: 0, comment_reply: 0 }, invitesTrailingWeek: 0 }),
    healthWindow: async () => ({
      invitesResolved: state.health.resolved,
      invitesAccepted: state.health.accepted,
      invitesPending: 5,
      actionFailures: state.health.failures,
      actionsAttempted: state.health.attempted,
    }),
    countAction: async (_a, action) => {
      state.actions.push(action)
    },
    recordEvent: async () => {},
    conversingEnrollments: async () => [],
  }
}

function fakeAdapter(overrides: Partial<LinkedInAdapter> = {}, state?: FakeState): LinkedInAdapter {
  return {
    assertSignedIn: async () => {},
    readComments: async () => state?.comments ?? [],
    replyToComment: async () => {},
    readProfile: async (publicIdentifier) => ({
      publicIdentifier,
      fullName: 'Diego Perez',
      degree: 2,
    }),
    sendInvite: async () => ({ sent: true, withNote: true }),
    withdrawInvite: async () => true,
    sendMessage: async () => {},
    listConversations: async () => [],
    readThread: async () => [],
    close: async () => {},
    ...overrides,
  }
}

function baseState(overrides: Partial<FakeState> = {}): FakeState {
  return {
    comments: [comment()],
    enrolled: [],
    jobs: [],
    enqueued: [],
    states: [],
    failures: [],
    actions: [],
    health: { accepted: 80, resolved: 100, failures: 0, attempted: 200 },
    contacts: {},
    due: [],
    ...overrides,
  }
}

function deps(state: FakeState, adapter?: Partial<LinkedInAdapter>): TickDeps {
  return {
    accountId: ACCOUNT,
    repo: fakeRepo(state),
    linkedin: fakeAdapter(adapter, state),
    classifier: { classify: async () => ({ intent: 'unclear', confidence: 0, signals: {}, rationale: '' }) },
    writer: { inviteNote: async () => 'Diego! te mando la conexión.' },
    workingHours: { ...DEFAULT_WORKING_HOURS, timezone: 'UTC' },
    now: () => NOW,
    leaseHolder: 'test',
  }
}

test('a keyword comment enrolls the commenter', async () => {
  const state = baseState()
  const result = await runTick(deps(state))

  assert.equal(result.enrolled, 1)
  assert.equal(state.enrolled[0]?.publicIdentifier, 'diego-perez')
})

test('a comment without the keyword is ignored', async () => {
  const state = baseState({ comments: [comment({ body: 'felicitaciones!' })] })
  const result = await runTick(deps(state))
  assert.equal(result.enrolled, 0)
})

test('the account owner is never enrolled by their own reply', async () => {
  // The owner replies "X enviado" under every comment, so without this the
  // agent would enrol itself once per lead.
  const state = baseState({
    comments: [comment({ authorPublicIdentifier: 'martinbufczyk', body: 'software' })],
  })
  const result = await runTick(deps(state))
  assert.equal(result.enrolled, 0)
})

test('a comment already enrolled is not enrolled twice', async () => {
  const state = baseState({ enrolled: [{ publicIdentifier: 'diego-perez', commentUrn: 'c1' }] })
  const result = await runTick(deps(state))
  assert.equal(result.enrolled, 0)
})

test('someone contacted recently is skipped with a reason', async () => {
  const state = baseState({
    contacts: {
      'diego-perez': { lastContactedAt: new Date(NOW.getTime() - 10 * 24 * 60 * 60 * 1000) },
    },
  })
  const result = await runTick(deps(state))

  assert.equal(result.enrolled, 0)
  assert.match(result.skipped.join(' '), /contactado hace/)
})

test('a stopped account does nothing at all', async () => {
  // Health runs first precisely so a restricted account finds out before it
  // acts, not after.
  const state = baseState({ health: { accepted: 0, resolved: 100, failures: 50, attempted: 100 } })
  const result = await runTick(deps(state))

  assert.equal(result.health, 'stopped')
  assert.equal(result.enrolled, 0)
  assert.equal(result.executed, 0)
})

test('a throttled account keeps working but does not spend an invite', async () => {
  // Acceptance below the floor stops invitations; conversations already under
  // way are not punished for it.
  const state = baseState({
    health: { accepted: 20, resolved: 100, failures: 0, attempted: 200 },
    jobs: [
      {
        id: 'job-1',
        accountId: ACCOUNT,
        enrollmentId: 'enr-1',
        type: 'send_invite',
        payload: { publicIdentifier: 'diego-perez', nextState: 'invite_sent' },
        attempts: 0,
      },
    ],
  })

  const result = await runTick(deps(state))
  assert.equal(result.health, 'throttled')
  assert.ok(!state.actions.includes('invite'))
  assert.ok(state.states.some((s) => s.state === 'invite_queued'))
})

test('a broken selector is not retried; a timeout is', async () => {
  // Backwards, this either spins forever on a bad selector or throws away work
  // over a network blip.
  for (const [kind, retryable] of [
    ['selector', false],
    ['transient', true],
    ['blocked', false],
  ] as const) {
    const state = baseState({
      comments: [],
      jobs: [
        {
          id: 'job-1',
          accountId: ACCOUNT,
          enrollmentId: 'enr-1',
          type: 'send_dm',
          payload: { publicIdentifier: 'diego-perez', nextState: 'dm_sent' },
          attempts: 0,
        },
      ],
    })

    await runTick(
      deps(state, {
        sendMessage: async () => {
          throw new AdapterError(kind, 'falló')
        },
      }),
    )

    assert.equal(state.failures[0]?.retryable, retryable, kind)
  }
})

test('a dead session ends the cycle instead of failing every job', async () => {
  // Each remaining job would fail identically and look like its own problem.
  const jobs: QueuedJob[] = [1, 2, 3].map((n) => ({
    id: `job-${n}`,
    accountId: ACCOUNT,
    enrollmentId: `enr-${n}`,
    type: 'send_dm' as const,
    payload: { publicIdentifier: 'x', nextState: 'dm_sent' },
    attempts: 0,
  }))
  const state = baseState({ comments: [], jobs })

  const result = await runTick(
    deps(state, {
      sendMessage: async () => {
        throw new AdapterError('auth', 'sesión caída')
      },
    }),
  )

  assert.equal(result.failed, 1)
  assert.match(result.skipped.join(' '), /sesión caída/)
})

test('unreadable comments on one post do not stop the others', async () => {
  const state = baseState()
  const result = await runTick(
    deps(state, {
      readComments: async () => {
        throw new AdapterError('transient', 'timeout')
      },
    }),
  )
  assert.equal(result.enrolled, 0)
  assert.equal(result.health, 'healthy')
})

test('a due enrollment gets its next job queued', async () => {
  const state = baseState({
    comments: [],
    due: [
      {
        id: 'enr-1',
        accountId: ACCOUNT,
        automationId: 'auto-1',
        contactId: 'contact-1',
        publicIdentifier: 'diego-perez',
        firstName: 'Diego',
        state: 'detected',
        enteredStateAt: NOW,
        commentUrn: 'c1',
        commentText: 'software',
        matchedKeyword: 'software',
        postUrl: 'https://www.linkedin.com/posts/x',
        degree: null,
        optedOut: false,
        attempts: 0,
      },
    ],
  })

  const result = await runTick(deps(state))
  assert.equal(result.scheduled, 1)
  assert.equal(state.enqueued[0]?.type, 'reply_comment')
})
