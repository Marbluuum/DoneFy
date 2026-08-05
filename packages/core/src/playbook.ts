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
  /**
   * They asked what you do or how you'd help — "como nos podrias ayudar?",
   * "quisiera saber que propones". This is green light, not an objection.
   *
   * Kept separate from `asks_question` deliberately: lumping them together
   * stops the sequence at the exact moment the lead asked for the pitch, which
   * is the warmest point in the whole funnel.
   */
  'invites_pitch',
  'requests_link',
  'books',
  /** Said yes but attached a constraint — "puede ser la semana que viene?". */
  'accepts_with_condition',
  /** Wants a specific fact from you: price, terms, references, credentials. */
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

  // Asking what you do is an invitation, not an objection — and it can arrive
  // at any point, often bundled with the pain ("somos malos comercialmente,
  // quisiera saber que propones"). Answer it while it's warm.
  if (intent === 'invites_pitch') {
    return { nextStage: 'pitching', autonomy: 'suggest', reason: 'lead asked for the pitch' }
  }

  // Said yes with a constraint attached — a date, a person to loop in. The
  // calendar link answers most of these, but a human confirms the terms.
  if (intent === 'accepts_with_condition') {
    return {
      nextStage: 'awaiting_booking',
      autonomy: 'suggest',
      reason: 'accepted with a condition to confirm',
    }
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
  /**
   * Their last reply was a bare "Sí" or similar. Worth one probe before moving
   * on — a lead who has said nothing about their business yet can't be ranked
   * for the invite queue, and the pitch lands better once they've described it.
   */
  replyWasTerse?: boolean
}

export function quickReplies(stage: ConversationStage, ctx: QuickReplyContext): QuickReply[] {
  const { firstName, calendarUrl } = ctx
  const opener = ctx.wasSlow ? `${firstName}! Estuve de viaje, comentame…` : `${firstName}! `

  switch (stage) {
    case 'qualifying_company': {
      const askForClients: QuickReply = {
        label: 'Preguntar por clientes',
        body: `${opener}estas en la busqueda de mas clientes?`,
        advances: true,
      }
      const probeRubro: QuickReply = {
        label: 'Profundizar el rubro',
        body: `Perfecto, exactamente a que se dedican?`,
        advances: false,
      }
      // On a one-word answer, lead with the probe rather than the next step.
      return ctx.replyWasTerse ? [probeRubro, askForClients] : [askForClients, probeRubro]
    }

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
        // The link alone doesn't close it — asking for confirmation is what
        // turns "I'll look at it" into a slot on the calendar.
        { label: 'Pedir confirmación', body: `Me avisas cuando te agendes?`, advances: false },
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

/** How this person entered the funnel. Changes only the opening line. */
export type EntryPoint =
  /** They commented a keyword on a post. */
  | 'comment'
  /** They sent the connection request. Different opener, same sequence. */
  | 'inbound_connection'

/**
 * The opening DM, sent once the connection is accepted.
 *
 * Fixed rather than generated: it is the same question every time, and the
 * personalization that matters already happened in the invite note.
 *
 * `openEnded` swaps the yes/no question for "a que te dedicas?". It costs a
 * turn — the answer can't be classified as confirm/deny — but it gets the lead
 * describing their business in their own words, which is what the invite queue
 * ranks on and what makes the later pitch land.
 */
export function openingDm(
  firstName: string,
  entry: EntryPoint = 'comment',
  openEnded = false,
): string {
  const greeting =
    entry === 'inbound_connection'
      ? `Buenas ${firstName}! Gracias por enviarme conexion,`
      : `Buenas ${firstName}! Vi que me comentaste la publicación`

  return openEnded
    ? `${greeting}${entry === 'comment' ? '…' : ' '}a que te dedicas?`
    : `${greeting}${entry === 'comment' ? ', ' : ' '}tienes una empresa de tecnología?`
}
