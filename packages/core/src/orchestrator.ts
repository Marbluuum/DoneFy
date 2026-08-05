import type { Classification } from './classifier.js'
import type { ConversationTurn } from './classifier.js'
import {
  TERMINAL_STAGES,
  advance,
  quickReplies,
  type Autonomy,
  type ConversationStage,
  type PlaybookStep,
  type QuickReply,
} from './playbook.js'
import { isWithinWorkingHours, nextWorkingMoment, type WorkingHours } from './timing.js'

/**
 * The orchestrator.
 *
 * Sits between "a lead replied" and "something goes out". It takes the
 * classifier's read, asks the playbook where that leads, and then decides how
 * much freedom the agent actually gets — which is usually less than the
 * playbook alone would allow.
 *
 * Pure. The classifier runs before it, sending happens after it.
 */

export type OrchestratorMode =
  /** Everything is proposed, nothing sends itself. Where you start. */
  | 'copilot'
  /** Low-risk steps send on their own; the pitch and anything odd still wait. */
  | 'assisted'
  /** Anything the playbook marks `auto` sends unattended. */
  | 'autopilot'

export type OrchestratorPolicy = {
  mode: OrchestratorMode
  /** Below this classifier confidence, autonomy is revoked. */
  confidenceFloor: number
  /** Below this, it does not even suggest — a human reads it cold. */
  handoffFloor: number
  /** Cap on messages the owner's side sends in one conversation. */
  maxOwnerMessages: number
  workingHours: WorkingHours
}

export const DEFAULT_POLICY: Omit<OrchestratorPolicy, 'workingHours'> = {
  // Start supervised. Watch what it would have sent for a week, then loosen
  // the steps you trust. Loosening is one field; an unwanted send is not
  // retractable.
  mode: 'copilot',
  confidenceFloor: 0.75,
  handoffFloor: 0.4,
  maxOwnerMessages: 8,
}

export type ConversationView = {
  stage: ConversationStage
  history: ConversationTurn[]
  optedOut: boolean
  firstName: string
  calendarUrl: string
}

export type OrchestratorAction =
  /** Send this now. */
  | { kind: 'send'; body: string; sendAt: Date }
  /** Show these in the inbox and wait for a click. */
  | { kind: 'suggest'; options: QuickReply[] }
  /** A human reads and answers this one. */
  | { kind: 'handoff'; reason: string }
  /** Nothing to do. */
  | { kind: 'none'; reason: string }

export type OrchestratorDecision = {
  action: OrchestratorAction
  nextStage: ConversationStage
  /** What the playbook alone would have allowed. */
  playbookStep: PlaybookStep
  /** What it gets after mode, confidence and guards. */
  effectiveAutonomy: Autonomy
  /** Human-readable trail for the panel. */
  notes: string[]
}

/** Autonomy ordering, so combining constraints is just "take the lower one". */
const RANK: Record<Autonomy, number> = { handoff: 0, suggest: 1, auto: 2 }

function lower(a: Autonomy, b: Autonomy): Autonomy {
  return RANK[a] <= RANK[b] ? a : b
}

function ceilingFor(mode: OrchestratorMode): Autonomy {
  switch (mode) {
    case 'copilot':
      return 'suggest'
    case 'assisted':
    case 'autopilot':
      return 'auto'
  }
}

export function orchestrate(
  conversation: ConversationView,
  classification: Classification,
  policy: OrchestratorPolicy,
  now: Date,
): OrchestratorDecision {
  const notes: string[] = []
  const step = advance(conversation.stage, classification.intent)

  const done = (action: OrchestratorAction, autonomy: Autonomy = 'handoff'): OrchestratorDecision => ({
    action,
    nextStage: step.nextStage,
    playbookStep: step,
    effectiveAutonomy: autonomy,
    notes,
  })

  if (conversation.optedOut) {
    notes.push('el contacto pidió no recibir mensajes')
    return done({ kind: 'none', reason: 'contact opted out' })
  }

  if (TERMINAL_STAGES.has(conversation.stage)) {
    notes.push(`conversación cerrada en ${conversation.stage}`)
    return done({ kind: 'none', reason: `stage ${conversation.stage} is terminal` })
  }

  // Never send twice without hearing back. A lead who has not answered is not
  // waiting for more from us, and back-to-back messages are the clearest tell
  // of an unattended bot.
  const last = conversation.history.at(-1)
  if (last?.from === 'owner') {
    notes.push('el último mensaje es nuestro, no corresponde insistir')
    return done({ kind: 'none', reason: 'awaiting the lead' })
  }

  const ownerMessages = conversation.history.filter((t) => t.from === 'owner').length
  if (ownerMessages >= policy.maxOwnerMessages) {
    notes.push(`${ownerMessages} mensajes enviados, límite alcanzado`)
    return done({ kind: 'handoff', reason: 'conversation length cap reached' })
  }

  // Confidence gates the playbook, not the other way round. A shaky read has no
  // business acting unattended even on a step the playbook considers safe.
  let autonomy = lower(step.autonomy, ceilingFor(policy.mode))
  if (autonomy !== step.autonomy) {
    notes.push(`modo ${policy.mode}: autonomía limitada a ${autonomy}`)
  }

  if (classification.confidence < policy.handoffFloor) {
    notes.push(`confianza ${classification.confidence.toFixed(2)} muy baja, pasa a humano`)
    autonomy = 'handoff'
  } else if (classification.confidence < policy.confidenceFloor) {
    const limited = lower(autonomy, 'suggest')
    if (limited !== autonomy) {
      notes.push(`confianza ${classification.confidence.toFixed(2)} bajo el piso, solo sugiere`)
    }
    autonomy = limited
  }

  if (autonomy === 'handoff') {
    return done({ kind: 'handoff', reason: step.reason }, 'handoff')
  }

  // Reaching a terminal stage means the sequence is over, not that there is a
  // closing message to send. Anything worth saying at that point is the
  // owner's to say.
  if (TERMINAL_STAGES.has(step.nextStage)) {
    notes.push(`la conversación termina en ${step.nextStage}`)
    return done({ kind: 'none', reason: `reached terminal stage ${step.nextStage}` }, autonomy)
  }

  // Indexed by the stage being left, not the one being entered: quick replies
  // are the messages that *cause* the transition. Keying them by destination
  // skips a step — confirming they are a tech company would jump straight to
  // the pitch, without ever asking about the pain.
  const options = quickReplies(conversation.stage, {
    firstName: conversation.firstName,
    calendarUrl: conversation.calendarUrl,
    wasSlow: isSlow(conversation.history, now),
  })

  if (options.length === 0) {
    notes.push(`sin respuestas sugeridas para ${conversation.stage}`)
    return done({ kind: 'handoff', reason: `no quick replies for ${conversation.stage}` }, 'handoff')
  }

  if (autonomy === 'suggest') {
    return done({ kind: 'suggest', options }, 'suggest')
  }

  // Auto: take the option that advances the stage, since that is the one the
  // playbook just decided on.
  const chosen = options.find((o) => o.advances) ?? options[0]!
  const sendAt = nextWorkingMoment(now, policy.workingHours)
  if (!isWithinWorkingHours(now, policy.workingHours)) {
    notes.push('fuera de horario, se envía en la próxima ventana')
  }
  return done({ kind: 'send', body: chosen.body, sendAt }, 'auto')
}

/** True when the lead has been waiting long enough to deserve acknowledging. */
function isSlow(history: ConversationTurn[], now: Date, hoursThreshold = 20): boolean {
  const lastLead = [...history].reverse().find((t) => t.from === 'lead')
  if (!lastLead) return false
  return now.getTime() - lastLead.at.getTime() >= hoursThreshold * 60 * 60 * 1000
}
