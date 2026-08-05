import type { ConversationStage, LeadIntent } from './playbook.js'
import type { VoiceProfile } from './voice.js'

/**
 * Reading the lead's reply.
 *
 * The model's only job here is to classify and extract — it never writes the
 * outgoing message. Keeping those separate means a misread reply produces a
 * wrong *route*, which the orchestrator's confidence gate catches, rather than
 * a wrong *message* already sitting in someone's inbox.
 */

export type ConversationTurn = {
  from: 'owner' | 'lead'
  body: string
  at: Date
}

/** Facts worth keeping, pulled from what the lead said in their own words. */
export type LeadSignals = {
  /** e.g. "empresa de desarrollo, 10 años en el mercado" */
  company?: string
  /** In their words: "tengo dos clientes pero no me permite crecer" */
  pain?: string
  /** Anything about urgency or timing. */
  timeline?: string
  website?: string
}

export type Classification = {
  intent: LeadIntent
  /** 0–1. Below the orchestrator's floor, autonomy is revoked. */
  confidence: number
  signals: LeadSignals
  /** One line, in Spanish, for the panel's activity log. */
  rationale: string
}

export type ClassifyInput = {
  stage: ConversationStage
  /** Oldest first. */
  history: ConversationTurn[]
  /** The message being classified. */
  latest: string
  voice: VoiceProfile
}

export type Classifier = (input: ClassifyInput) => Promise<Classification>

const INTENT_GUIDE: Record<LeadIntent, string> = {
  confirms: 'Responde que sí a lo que se le preguntó, o describe su empresa sin nombrar ningún problema.',
  denies: 'Responde que no a lo que se le preguntó.',
  shares_pain:
    'Describe un problema propio: le faltan clientes, no puede crecer, depende de pocas cuentas, "somos malos comercialmente".',
  invites_pitch:
    'Pide que le cuentes tu propuesta: "como nos podrias ayudar?", "quisiera saber que propones", "contame mas". Está abriendo la puerta, no objetando.',
  requests_link: 'Pide la agenda, el calendario o los horarios.',
  books: 'Dice que ya agendó o que reservó un horario.',
  accepts_with_condition:
    'Acepta la reunión pero pone una condición: una fecha concreta, un horario, sumar a otra persona. "Puede ser la semana que viene?"',
  asks_question:
    'Pide un dato concreto tuyo: precio, formas de pago, plazos, casos de éxito, referencias, quiénes son. Distinto de invites_pitch.',
  objects: 'Pone una objeción: caro, sin tiempo, ya trabajo con alguien, no me sirve.',
  not_interested: 'Pide que no le escriban más, o corta el tema.',
  unclear: 'No se entiende, o no encaja en ninguna de las anteriores.',
}

/**
 * The classification prompt.
 *
 * Biased toward `unclear` on purpose: an honest "no sé" routes to a human,
 * which costs an hour. A confident misread sends the wrong message under the
 * owner's name, which costs the lead.
 */
export function buildClassifyPrompt(input: ClassifyInput): string {
  const history = input.history
    .map((t) => `${t.from === 'owner' ? 'YO' : 'LEAD'}: ${t.body}`)
    .join('\n')

  const intents = Object.entries(INTENT_GUIDE)
    .map(([intent, guide]) => `- ${intent}: ${guide}`)
    .join('\n')

  return `Sos el analista de conversaciones de una consultora B2B. Clasificás la última respuesta de un lead en LinkedIn.

ETAPA ACTUAL: ${input.stage}

CONVERSACIÓN HASTA AHORA:
${history || '(sin mensajes previos)'}

ÚLTIMO MENSAJE DEL LEAD:
${input.latest}

INTENCIONES POSIBLES:
${intents}

Devolvé JSON, sin texto alrededor:
{
  "intent": "<una de las anteriores>",
  "confidence": <0 a 1>,
  "signals": {
    "company": "<qué contó de su empresa, o null>",
    "pain": "<el problema EN SUS PALABRAS, o null>",
    "timeline": "<urgencia o plazos, o null>",
    "website": "<url que haya compartido, o null>"
  },
  "rationale": "<una línea en español>"
}

REGLAS:
- "shares_pain" solo si el lead nombra un problema propio. Que confirme ser del rubro NO es dolor.
- Distinguí bien "invites_pitch" de "asks_question": pedir que le cuentes tu propuesta abre la conversación; pedir un dato concreto (precio, plazos, referencias) necesita que responda un humano.
- Si el mensaje mezcla dolor y pedido de propuesta ("somos malos comercialmente, quisiera saber que propones"), usá "invites_pitch": ya pasó la etapa del dolor.
- Si el mensaje mezcla varias cosas, elegí la que hace avanzar la conversación.
- Ante la duda usá "unclear" con confidence baja. Preferimos que lo lea un humano antes que arriesgar una respuesta equivocada.
- No inventes datos en "signals": si no lo dijo, va null.`
}

/** Parses the model's JSON, clamping anything out of range. */
export function parseClassification(raw: string): Classification {
  const match = raw.match(/\{[\s\S]*\}/)
  if (!match) {
    return {
      intent: 'unclear',
      confidence: 0,
      signals: {},
      rationale: 'no se pudo interpretar la respuesta del modelo',
    }
  }

  let parsed: Record<string, unknown>
  try {
    parsed = JSON.parse(match[0]) as Record<string, unknown>
  } catch {
    return { intent: 'unclear', confidence: 0, signals: {}, rationale: 'JSON inválido' }
  }

  const intent = parsed.intent
  const known: LeadIntent[] = [
    'confirms', 'denies', 'shares_pain', 'invites_pitch', 'requests_link',
    'books', 'accepts_with_condition', 'asks_question', 'objects',
    'not_interested', 'unclear',
  ]
  // An unrecognized label is itself a reason not to trust the call.
  const safeIntent = known.includes(intent as LeadIntent) ? (intent as LeadIntent) : 'unclear'

  const rawConfidence = Number(parsed.confidence)
  const confidence = Number.isFinite(rawConfidence)
    ? Math.min(1, Math.max(0, rawConfidence))
    : 0

  const rawSignals = (parsed.signals ?? {}) as Record<string, unknown>
  const signals: LeadSignals = {}
  for (const key of ['company', 'pain', 'timeline', 'website'] as const) {
    const value = rawSignals[key]
    if (typeof value === 'string' && value.trim() && value !== 'null') {
      signals[key] = value.trim()
    }
  }

  return {
    intent: safeIntent,
    confidence: safeIntent === intent ? confidence : 0,
    signals,
    rationale: typeof parsed.rationale === 'string' ? parsed.rationale : '',
  }
}
