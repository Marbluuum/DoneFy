import Anthropic from '@anthropic-ai/sdk'

/**
 * The two LLM calls this product makes, and why they are configured differently.
 *
 * Reading a reply is cheap and happens on every inbound message. Writing the
 * 300-character invite note happens once per lead and is the single piece of
 * text that decides whether they accept — so it gets more room to think.
 */

export const MODELS = {
  /** Reads the lead's reply. High volume, low stakes per call. */
  classifier: 'claude-opus-5',
  /** Writes the invite note. Low volume, and the highest-leverage text here. */
  writer: 'claude-opus-5',
} as const

export type LlmConfig = {
  apiKey: string
  classifierModel?: string
  writerModel?: string
}

export function createLlm(config: LlmConfig) {
  const client = new Anthropic({ apiKey: config.apiKey })
  return {
    client,
    classifierModel: config.classifierModel ?? MODELS.classifier,
    writerModel: config.writerModel ?? MODELS.writer,
  }
}

export type Llm = ReturnType<typeof createLlm>

/**
 * Pull the text out of a response, guarding the two things that make
 * `content[0].text` unsafe: a refusal returns no content at all, and a
 * thinking-enabled response puts a thinking block first.
 */
export function textOf(response: Anthropic.Message): string {
  if (response.stop_reason === 'refusal') {
    throw new RefusalError(response.stop_details?.explanation ?? 'request refused')
  }
  return response.content
    .filter((block): block is Anthropic.TextBlock => block.type === 'text')
    .map((block) => block.text)
    .join('')
}

export class RefusalError extends Error {
  override readonly name = 'RefusalError'
}
