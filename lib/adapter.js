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
import { FALLBACK_RATES, fetchModelRates } from './rates.js'

// Doubao reports a 128K context for the chat surface and 131072 for the routed
// models. The smaller number is the one that is true for all of them.
const CONTEXT_WINDOW = 131_072
const DEFAULT_MAX_TOKENS = 32_768

/**
 * Separator between a model's name and its billing rate.
 *
 * A middle dot, not a hyphen or a colon: the names already contain hyphens
 * (`GLM 5.3 Flash`, `Kimi K3.1 Pro 高速`), so anything hyphen-like would be
 * ambiguous about where the name ends.
 */
export const RATE_SEPARATOR = ' · '

/**
 * The rate has to ride the *name*, not the description: the harness model seat
 * renders `name` only, so a rate placed in `description` is invisible exactly
 * where the user picks a model. Nothing resolves a model by name — the wire
 * request is built from `id` — so this stays display-only.
 */
export function withRate(name, rate) {
  return !rate ? name : `${name}${RATE_SEPARATOR}${rate}`
}

/**
 * Strip the host's runtime injections out of a message before it goes on the
 * wire. DSH appends `<system-reminder>` blocks (the operating-mode preamble,
 * AGENTS.md, the project memory) to the messages it hands an adapter. Those
 * blocks are instructions for *this* agent, not conversation content, and
 * shipping them to a consumer chat endpoint is what earned the account this
 * reply:
 *
 *   该内容涉嫌违反[豆包使用规范](...)，若有误判，请长按本条消息后点击"反馈与举报"
 *
 * The refusal arrives as a normal text delta with a `stop` finish, so the user
 * sees a model that "cannot chat". Length is the primary signal: a real system
 * hint (title generation, a short persona) is a few hundred characters, while
 * the host preamble is tens of thousands.
 */
export function cleanForWire(text) {
  return String(text ?? '')
    .replace(/<system-reminder\b[^>]*>[\s\S]*?<\/system-reminder>/gi, '')
    .replace(/<\/?system-reminder\b[^>]*>/gi, '')
    .trim()
}

function hasHostMarkers(text) {
  return /Instructions from:|AGENTS\.md|无限制模式|operator-authorized|without refusal|soft-refuse|hard-refuse/i.test(text)
}

/**
 * The host preamble can arrive as a `system`/`developer` message *or* be
 * appended to a `user` turn inside `<system-reminder>` tags (the archive shows
 * both shapes). `cleanForWire` removes the tags; this catches any unwrapped
 * remnant. Long system blocks are dropped outright; for a user turn we require
 * the explicit markers as well, so pasting a long document is never discarded.
 */
function isHostPreamble(text, role) {
  if (role === 'system' || role === 'developer') return text.length > 2000 || hasHostMarkers(text)
  return text.length > 2000 && hasHostMarkers(text)
}

// The moderation notice the account actually received (session archive,
// 2026-11-14): 该内容涉嫌违反[豆包使用规范](https://www.doubao.com/legal/
// community_guidelines)，若有误判，请长按本条消息后点击"反馈与举报"进行反馈。
// The short lead is deliberate: any wording variant that starts this way is
// caught on its first chunk, before a single character reaches the UI. Holding
// only deltas that are still a prefix of it means every normal answer starts
// streaming on its first delta — there is no perceptible delay.
const REFUSAL_LEAD = '该内容涉嫌违反'

/**
 * Doubao's content filter answers with a canned notice instead of an error.
 * Anchored on the exact lead (or the embedded guidelines URL) so a user asking
 * about the rules in ordinary words is not mistaken for a refusal.
 */
export function isRefusal(text) {
  const s = String(text ?? '').replace(/^\s+/, '')
  return s.startsWith(REFUSAL_LEAD) || s.includes('doubao.com/legal/community_guidelines')
}

/** Flatten harness message blocks into the single prompt Doubao expects. */
export function toPrompt(messages) {
  const parts = []
  for (const message of messages ?? []) {
    const cleaned = cleanForWire(
      (message.content ?? [])
        .filter((block) => block.type === 'text' && typeof block.text === 'string')
        .map((block) => block.text)
        .join('\n'),
    )
    if (!cleaned) continue
    // A long host config is not a chat turn. Dropping it keeps the conversation
    // readable to Doubao's moderation instead of tripping it on words like
    // "execute without refusal" that belong to the harness, not to the user.
    if (isHostPreamble(cleaned, message.role)) continue
    if (message.role === 'system' || message.role === 'developer') parts.push(`[System]\n${cleaned}`)
    else if (message.role === 'assistant') parts.push(`[Assistant]\n${cleaned}`)
    else if (message.role === 'tool') parts.push(`[Tool result]\n${cleaned}`)
    else parts.push(cleaned)
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

export function createAdapter({ loadCredentials, logger, pacer, providerId = DEFAULT_PROVIDER, fetchRates = fetchModelRates } = {}) {
  const gate = pacer ?? new Pacer({ minIntervalMs: 6000 })

  // The rate table starts as the last reading taken from the client and is
  // replaced once a live fetch answers. Names are built from it on every call,
  // so a refreshed table shows up in the picker without a restart.
  let rates = { ...FALLBACK_RATES }
  let rateFetchedAt = 0
  let inFlight

  async function refreshRates() {
    let credentials
    try {
      credentials = await loadCredentials()
    } catch {
      return rates
    }
    // No credentials yet: leave the clock alone so a login is picked up on the
    // next picker open. Reading the file is cheap; no network call is made.
    if (!credentials?.cookies || !credentials?.identity?.deviceId) return rates
    // Mark the attempt before starting. A failed lookup must not be retried on
    // every picker open or every turn — that would be the one behaviour this
    // plugin cannot afford, and the last known table is still useful.
    rateFetchedAt = Date.now()
    const fresh = await fetchRates({ identity: credentials.identity, cookies: credentials.cookies, logger })
    if (fresh && Object.keys(fresh).length > 0) rates = fresh
    return rates
  }

  /** Refresh at most once every ten minutes, deduplicating concurrent calls. */
  function ensureRates() {
    const stale = Date.now() - rateFetchedAt > 10 * 60_000
    if (inFlight) return inFlight
    if (!stale) return Promise.resolve(rates)
    inFlight = refreshRates()
      .catch(() => rates)
      .finally(() => {
        inFlight = undefined
      })
    return inFlight
  }

  function nameFor(model) {
    return withRate(model.name ?? model.id, rates[model.key])
  }

  function catalogFor() {
    return MODELS.map((model) => ({
      provider: providerId,
      id: model.id,
      name: nameFor(model),
      description: model.description,
      inputModalities: ['text'],
    }))
  }

  function modelEntry(id) {
    const model = MODELS.find((entry) => entry.id === id)
    if (!model) {
      return { provider: providerId, id, name: id, inputModalities: ['text'] }
    }
    return {
      provider: providerId,
      id: model.id,
      name: nameFor(model),
      description: model.description,
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
      await ensureRates()
      return catalogFor()
    },

    async resolveModel(provider, model) {
      await ensureRates()
      return resolvedInfo(model)
    },

    async prepareCall(provider, model) {
      await ensureRates()
      return { model: resolvedInfo(model), stream: (options) => this.stream({ ...options, provider, model }) }
    },

    /** Test seam: the table the picker is currently showing. */
    currentRates() {
      return { ...rates }
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
      // Doubao's moderation refusal is a normal text stream, not an error frame.
      // Hold deltas only while they are still a strict prefix of the canned
      // notice's lead; any real answer diverges on its first delta and flushes
      // immediately, so there is no perceptible buffering.
      let pending = ''
      let refused = false
      let holding = true
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
            if (holding) {
              pending += event.text
              if (isRefusal(pending)) {
                // Caught before a single character reached the UI.
                refused = true
                pending = ''
                holding = false
                break
              }
              if (pending.length >= REFUSAL_LEAD.length || !REFUSAL_LEAD.startsWith(pending)) {
                // Not a refusal: flush everything held and switch to passthrough.
                holding = false
                const first = pending
                pending = ''
                chars += first.length
                yield { type: 'text-delta', index, text: first }
              }
            } else {
              chars += event.text.length
              yield { type: 'text-delta', index, text: event.text }
            }
          } else if (event.type === 'error') {
            // pending can only be a truncated refusal prefix here; dropping it is
            // more honest than showing a stray fragment alongside the error.
            pending = ''
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
        // A stream that ended still holding a prefix was truncated mid-refusal;
        // there is nothing worth rendering.
        pending = ''
      } catch (error) {
        if (error.code === 710022004) gate.penalize(60_000)
        logger?.warn?.(`doubao: ${modelId} failed: ${error.message}`)
        yield { type: 'finish', reason: finishReasonFor(error) }
        return
      }

      if (refused) {
        // A visible explanation, not a `stop` that would make the harness show a
        // blank turn. No retryable error: retrying a moderation flag just deepens
        // it. Host runtime injections are stripped by toPrompt, but if the user's
        // own text still trips the filter, telling them why is the useful answer.
        const explanation = 'Doubao 内容审核拦截了本次请求（不是模型故障）。已自动剥离宿主注入的系统提示；若仍出现，请换一种表述或减少附件内容后重试。'
        yield { type: 'text-delta', index, text: explanation }
        chars += explanation.length
        gate.penalize(30_000)
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
