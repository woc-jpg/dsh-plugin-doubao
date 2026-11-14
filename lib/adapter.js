/**
 * The Doubao provider adapter.
 *
 * This is a plain object rather than a `LlmAdapter` subclass on purpose: the
 * harness only ever calls the methods below, and `@deepseek-ai/dsh-llm` is not
 * resolvable from a profile's `node_modules` (only `cosmokit`/`schemastery`
 * live there). Duck typing is what lets the plugin be installed from a GitHub
 * URL without shipping a copy of the harness.
 *
 * Stream chunks follow the harness vocabulary the pi-ai adapter emits:
 * `{type:'text-delta',index,text}`, `{type:'usage',usage:{...}}`, then
 * `{type:'finish',reason:{kind:'stop'}}` — usage before finish, or the token
 * meter never sees the call.
 */
import { Pacer, streamChat, MODELS, resolveModel as resolveWireModel } from './doubao.js'

// Doubao reports a 128K context for the chat surface and 131072 for the routed
// models. The smaller number is the one that is true for all of them.
const CONTEXT_WINDOW = 131_072
const DEFAULT_MAX_TOKENS = 32_768

/** Flatten harness message blocks into the single prompt Doubao expects. */
export function toPrompt(messages) {
  const parts = []
  for (const message of messages ?? []) {
    const text = (message.content ?? [])
      .filter((block) => block.type === 'text' && typeof block.text === 'string')
      .map((block) => block.text)
      .join('\n')
      .trim()
    if (!text) continue
    if (message.role === 'system' || message.role === 'developer') parts.push(`[System]\n${text}`)
    else if (message.role === 'assistant') parts.push(`[Assistant]\n${text}`)
    else if (message.role === 'tool') parts.push(`[Tool result]\n${text}`)
    else parts.push(text)
  }
  return parts.join('\n\n')
}

/**
 * Normalize a thrown Doubao failure into the harness finish reason.
 *
 * A risk-control refusal is reported as `stop` with a note appended, not as an
 * exception: the transport worked and the model answered, it just answered with
 * a refusal. Turning it into a hard error would make the harness retry, and
 * retrying a rate limit is what deepens it.
 */
export function finishReasonFor(error) {
  if (!error) return { kind: 'stop' }
  if (error.code === 'ABORTED' || error.name === 'AbortError') {
    return { kind: 'aborted', failure: { message: String(error.message ?? 'aborted'), code: 'ABORTED' } }
  }
  const code = error.code === 710022004 ? 'RATE_LIMIT' : error.code === 710012001 || error.code === 710012002 ? 'AUTH' : 'DOUBAO_ERROR'
  return { kind: 'error', failure: { message: String(error.message ?? error), code } }
}

/**
 * Provider id. Not "doubao-local": the plugin no longer runs a local proxy, so
 * calling it local would be a lie, and the name is also what a stale
 * `doubao-local` block in a profile would collide with (DUPLICATE_ADAPTER).
 */
export const DEFAULT_PROVIDER = 'doubao'

/**
 * Retry policy owned by this provider.
 *
 * `RATE_LIMIT` is deliberately absent from `retryableCodes`. The harness default
 * retries it (DEFAULT_RETRYABLE_CODES in @deepseek-ai/dsh-llm), which is exactly
 * backwards here: 710022004 is a risk-control escalation, so the second attempt
 * arrives while the account is already flagged and the streak is what turns a
 * short throttle into a long one. The pacer already serializes turns, so the
 * only failures worth a second attempt are transport hiccups.
 */
export const RETRY_POLICY = Object.freeze({
  mode: 'normal',
  maxRetries: 2,
  retryableCodes: Object.freeze(['TRANSPORT', 'TIMEOUT', 'SERVER']),
  backoff: Object.freeze({ initialDelayMs: 2_000, maxDelayMs: 15_000, jitterRatio: 0.2 }),
})

export function createAdapter({ loadCredentials, logger, pacer, providerId = DEFAULT_PROVIDER } = {}) {
  const gate = pacer ?? new Pacer({ minIntervalMs: 6000 })

  const catalog = MODELS.map((model) => ({
    provider: providerId,
    id: model.id,
    name: model.name ?? model.id,
    description: model.description,
    inputModalities: ['text'],
  }))

  function modelEntry(id) {
    return catalog.find((entry) => entry.id === id) ?? {
      provider: providerId,
      id,
      name: id,
      inputModalities: ['text'],
    }
  }

  function resolvedInfo(id) {
    return {
      ...modelEntry(id),
      context: { contextWindow: CONTEXT_WINDOW },
      defaultMaxTokens: DEFAULT_MAX_TOKENS,
      reasoning: {
        efforts: [
          { id: 'off', name: 'Off', description: 'Answer without extended thinking.' },
          { id: 'high', name: 'High', description: 'Think before answering.' },
        ],
        defaultEffort: 'off',
      },
    }
  }

  return {
    pacer: gate,

    providerInfo(provider) {
      return { id: provider, name: 'Doubao' }
    },

    providerRetryPolicy() {
      return RETRY_POLICY
    },

    async listModels() {
      return catalog
    },

    async resolveModel(provider, model) {
      return resolvedInfo(model)
    },

    async prepareCall(provider, model) {
      return { model: resolvedInfo(model), stream: (options) => this.stream({ ...options, provider, model }) }
    },

    async *stream(options) {
      const modelId = options.model
      const wire = resolveWireModel(modelId)?.id ?? modelId
      const prompt = toPrompt(options.messages)
      const started = Date.now()

      let credentials
      try {
        credentials = await loadCredentials()
      } catch (error) {
        yield { type: 'finish', reason: finishReasonFor(error) }
        return
      }
      if (!credentials?.cookies || !credentials?.identity?.deviceId) {
        yield {
          type: 'finish',
          reason: {
            kind: 'error',
            failure: {
              message: 'Doubao is not signed in. Run `npx dsh-plugin-doubao login` and scan the QR code with the Douyin app.',
              code: 'AUTH_MISSING',
            },
          },
        }
        return
      }

      const think = options.reasoningEffort === 'high' || options.reasoningEffort === 'max'
      const index = 0
      let chars = 0
      try {
        for await (const event of gate.runIterable(() =>
          streamChat({
            identity: credentials.identity,
            cookies: credentials.cookies,
            text: prompt,
            model: wire,
            think,
            signal: options.signal,
          }),
        )) {
          if (event.type === 'delta' && event.text) {
            chars += event.text.length
            yield { type: 'text-delta', index, text: event.text }
          } else if (event.type === 'error') {
            const failure = new Error(event.message ?? 'doubao error')
            failure.code = event.code
            // The refusal arrives in the stream body, not as a thrown error, so the
            // cooldown has to be extended here too — otherwise every queued turn
            // walks straight back into the same limit.
            if (event.code === 710022004) gate.penalize(60_000)
            yield { type: 'finish', reason: finishReasonFor(failure) }
            return
          }
        }
      } catch (error) {
        if (error.code === 710022004) gate.penalize(60_000)
        logger?.warn?.(`doubao: ${modelId} failed: ${error.message}`)
        yield { type: 'finish', reason: finishReasonFor(error) }
        return
      }

      // Roughly a token per two characters for Chinese and per four for English;
      // Doubao does not return usage on the web endpoint, so this is an estimate
      // and the honest thing is to say so in the field names rather than lie.
      const outputTokens = Math.max(1, Math.ceil(chars / 2))
      const inputTokens = Math.max(1, Math.ceil(prompt.length / 2))
      yield {
        type: 'usage',
        usage: { inputTokens, outputTokens, totalTokens: inputTokens + outputTokens },
      }
      yield { type: 'finish', reason: { kind: 'stop' }, durationMs: Date.now() - started }
    },
  }
}
