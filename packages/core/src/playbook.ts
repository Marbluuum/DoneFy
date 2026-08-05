/**
 * The conversation playbook.
 *
 * Modelled directly on how the account owner actually sells: two qualifying
 * questions, then a short pitch, then asking permission to send the calendar.
 * The product never pitches before the lead has named their own problem — that
 * ordering is the whole method, so it is enforced here rather than left to a
 * prompt to remember.
 */

export const CONVERSATION_STAGES = [
  /** Opening DM sent: "tenes una empresa de tecnologia?" */
  'qualifying_company',
  /** They fit the profile. Looking for the pain: "estas buscando mas clientes?" */
  'qualifying_pain',
  /** They named the pain. Short pitch plus asking to send the calendar. */
  'pitching',
  /** Calendar link sent. */
  'awaiting_booking',

  // --- terminal ---
  'booked',
  /** Not the target profile, or no pain. Closed politely. */
  'disqualified',
  /** Something off-script. A human owns it now. */
  'handed_off',
  'abandoned',
] as const

export type ConversationStage = (typeof CONVERSATION_STAGES)[number]

export const TERMINAL_STAGES: ReadonlySet<ConversationStage> = new Set([
  'booked',
  'disqualified',
  'handed_off',
  'abandoned',
])

/** What the lead's last message meant. Classified by the LLM, acted on here. */
export const LEAD_INTENTS = [
  'confirms',
  'denies',
  'shares_pain',
  'requests_link',
  'books',
  'asks_question',
  'objects',
  'not_interested',
  'unclear',
] as const

export type LeadIntent = (typeof LEAD_INTENTS)[number]

/**
 * How much latitude the agent has at a given point.
 *
 * `auto` is reserved for moves that are safe to get slightly wrong — asking a
 * qualifying question, sending a link the lead just asked for. Anything
 * involving an objection, a question, or an unclear reply goes to a human. An
 * AI improvising an answer about pricing or scope in the owner's name is a
 * worse outcome than a reply that arrives an hour later.
 */
export type Autonomy = 'auto' | 'suggest' | 'handoff'

export type PlaybookStep = {
  nextStage: ConversationStage
  autonomy: Autonomy
  /** Why, for the panel's activity log. */
  reason: string
}

export function advance(stage: ConversationStage, intent: LeadIntent): PlaybookStep {
  if (TERMINAL_STAGES.has(stage)) {
    return { nextStage: stage, autonomy: 'handoff', reason: 'conversation already closed' }
  }

  // These override the stage entirely — they mean the same thing anywhere.
  if (intent === 'not_interested') {
    return { nextStage: 'disqualified', autonomy: 'auto', reason: 'lead is not interested' }
  }
  if (intent === 'objects' || intent === 'asks_question' || intent === 'unclear') {
    return { nextStage: 'handed_off', autonomy: 'handoff', reason: `off-script reply: ${intent}` }
  }
  if (intent === 'books') {
    return { nextStage: 'booked', autonomy: 'auto', reason: 'meeting booked' }
  }

  switch (stage) {
    case 'qualifying_company':
      if (intent === 'confirms' || intent === 'shares_pain') {
        // Volunteering the pain skips a step — no reason to ask what they just
        // told you.
        return intent === 'shares_pain'
          ? { nextStage: 'pitching', autonomy: 'suggest', reason: 'pain volunteered early' }
          : { nextStage: 'qualifying_pain', autonomy: 'auto', reason: 'profile confirmed' }
      }
      if (intent === 'denies') {
        return { nextStage: 'disqualified', autonomy: 'auto', reason: 'not a tech company' }
      }
      break

    case 'qualifying_pain':
      if (intent === 'shares_pain' || intent === 'confirms') {
        return { nextStage: 'pitching', autonomy: 'suggest', reason: 'pain confirmed' }
      }
      if (intent === 'denies') {
        return { nextStage: 'disqualified', autonomy: 'auto', reason: 'not looking for clients' }
      }
      break

    case 'pitching':
      if (intent === 'confirms' || intent === 'requests_link') {
        return { nextStage: 'awaiting_booking', autonomy: 'auto', reason: 'calendar requested' }
      }
      if (intent === 'denies') {
        return { nextStage: 'handed_off', autonomy: 'handoff', reason: 'declined the meeting' }
      }
      break

    case 'awaiting_booking':
      if (intent === 'requests_link') {
        return { nextStage: 'awaiting_booking', autonomy: 'auto', reason: 'link re-sent' }
      }
      if (intent === 'denies') {
        return { nextStage: 'handed_off', autonomy: 'handoff', reason: 'backed out after the link' }
      }
      break

    default:
      break
  }

  return { nextStage: 'handed_off', autonomy: 'handoff', reason: `no rule for ${stage} + ${intent}` }
}

/**
 * Quick replies for the inbox — the ManyChat-style button row.
 *
 * Templates rather than generated text on purpose: at these stages the owner
 * says nearly the same thing every time, so a template is instant, free, and
 * sounds more like them than a model paraphrasing them would. The LLM is kept
 * for where personalization actually pays: the invite note and the opening DM.
 */
export type QuickReply = {
  label: string
  body: string
  /** True when sending it also advances the stage. */
  advances: boolean
}

export type QuickReplyContext = {
  firstName: string
  calendarUrl: string
  /** Set when the lead has been waiting, so the reply can acknowledge it. */
  wasSlow?: boolean
}

export function quickReplies(stage: ConversationStage, ctx: QuickReplyContext): QuickReply[] {
  const { firstName, calendarUrl } = ctx
  const opener = ctx.wasSlow ? `${firstName}! Estuve de viaje, comentame…` : `${firstName}! `

  switch (stage) {
    case 'qualifying_company':
      return [
        {
          label: 'Preguntar por clientes',
          body: `${opener}estas en la busqueda de mas clientes?`,
          advances: true,
        },
        {
          label: 'Preguntar rubro',
          body: `${firstName}! Que tipo de desarrollo hacen?`,
          advances: false,
        },
      ]

    case 'qualifying_pain':
      return [
        {
          label: 'Pitch + cierre',
          body: `Entiendo, nosotros conseguimos clientes mediante un sistema propio y personalizado para empresas de tecnología...si quieres te envío mi calendario para que agendes una reunión? Quieres?`,
          advances: true,
        },
        {
          label: 'Profundizar el dolor',
          body: `${firstName}! Y hoy como estan consiguiendo clientes?`,
          advances: false,
        },
      ]

    case 'pitching':
      return [
        { label: 'Mandar calendario', body: calendarUrl, advances: true },
        {
          label: 'Reforzar y cerrar',
          body: `Te paso el calendario y coordinamos, te parece?`,
          advances: true,
        },
      ]

    case 'awaiting_booking':
      return [
        { label: 'Reenviar calendario', body: calendarUrl, advances: false },
        {
          label: 'Recordatorio suave',
          body: `${firstName}! Pudiste ver la agenda? Cualquier horario que te sirva lo tomamos.`,
          advances: false,
        },
      ]

    default:
      return []
  }
}

/**
 * The opening DM, sent once the connection is accepted.
 *
 * Fixed rather than generated: it is the same question every time, and the
 * personalization that matters at this point already happened in the invite
 * note.
 */
export function openingDm(firstName: string): string {
  return `Buenas! Vi que me comentaste la publicación, tienes una empresa de tecnología?`.replace(
    'Buenas!',
    `Buenas ${firstName}!`,
  )
}
