import {
  buildClassifyPrompt,
  parseClassification,
  type ClassifyInput,
  type Classification,
} from '@donefy/core'

import { textOf, type Llm } from './client.js'

/**
 * Reads the lead's reply.
 *
 * Uses structured outputs so the response is schema-valid by construction
 * rather than by hope. `parseClassification` still runs on the result — it is
 * the layer that clamps confidence and refuses to trust an unrecognized intent
 * label, and neither of those is something a schema can express.
 */

const CLASSIFICATION_SCHEMA = {
  type: 'object',
  properties: {
    intent: {
      type: 'string',
      enum: [
        'confirms',
        'denies',
        'shares_pain',
        'invites_pitch',
        'requests_link',
        'books',
        'accepts_with_condition',
        'asks_question',
        'objects',
        'not_interested',
        'unclear',
      ],
    },
    confidence: { type: 'number' },
    signals: {
      type: 'object',
      properties: {
        company: { type: ['string', 'null'] },
        pain: { type: ['string', 'null'] },
        timeline: { type: ['string', 'null'] },
        website: { type: ['string', 'null'] },
      },
      required: ['company', 'pain', 'timeline', 'website'],
      additionalProperties: false,
    },
    rationale: { type: 'string' },
  },
  required: ['intent', 'confidence', 'signals', 'rationale'],
  additionalProperties: false,
} as const

export async function classifyReply(llm: Llm, input: ClassifyInput): Promise<Classification> {
  const response = await llm.client.messages.create({
    model: llm.classifierModel,
    max_tokens: 4096,
    // Reading a short reply against a known set of intents does not need deep
    // reasoning, and this call runs on every inbound message.
    output_config: {
      effort: 'low',
      format: { type: 'json_schema', schema: CLASSIFICATION_SCHEMA },
    },
    messages: [{ role: 'user', content: buildClassifyPrompt(input) }],
  })

  return parseClassification(textOf(response))
}

/**
 * Classification failures route to a human rather than to a guess.
 *
 * An API error here is indistinguishable, from the lead's side, from a reply
 * nobody understood — and the orchestrator already knows what to do with an
 * unreadable message.
 */
export async function classifyReplySafe(
  llm: Llm,
  input: ClassifyInput,
): Promise<Classification> {
  try {
    return await classifyReply(llm, input)
  } catch (error) {
    return {
      intent: 'unclear',
      confidence: 0,
      signals: {},
      rationale: `no se pudo clasificar: ${error instanceof Error ? error.message : 'error desconocido'}`,
    }
  }
}
