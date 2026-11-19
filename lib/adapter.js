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
import { homedir } from 'node:os'
import { Pacer, streamChat, MODELS, RISK_CODE, resolveModel as resolveWireModel, DEFAULT_UA } from './doubao.js'
import { streamNativeTask } from './native.js'
import { catalogFromBrief, effortsFor, EFFORT_ID_LEVEL } from './catalog.js'
import { createRiskMemory } from './risk-memory.js'
import { FALLBACK_RATES, fetchBrief, fetchModelRates } from './rates.js'

// Doubao reports a 128K context for the chat surface and 256K/300K for the
// routed models. This is the floor: `resolveModel` prefers the window the brief
// states for the model, so the number here only applies before sign-in.
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
  // assistant/tool turns are agent-generated: if one carries the harness's own
  // markers it is meta-discussion about DSH, not something the user said. Keep
  // user turns unless they are BOTH long and marked, so a pasted document or a
  // short question about AGENTS.md is never silently discarded.
  if (role === 'assistant' || role === 'tool') return hasHostMarkers(text)
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

/**
 * Hard cap on the flattened prompt, in characters.
 *
 * Doubao's `/chat/completion` is a stateless single-turn endpoint: the harness
 * hands us EVERY visible message (including compressed-block summaries, tool
 * results and injected time/runtime context) and `toPrompt` joins them into one
 * `text_block.text`. A long-lived session measured 2,236,328 characters across
 * 1,497 blocks; the endpoint answers that with `common invalid param` at the
 * parameter-validation layer, before any model or risk logic runs. A fresh
 * session is ~900 characters and answers normally.
 *
 * The workbuddy connect plugin solves the same class of failure with
 * `applyContextBudgets` / `keepPromptLast`: keep the recent turns, keep the
 * system head, drop the middle. 32K characters is ~16K tokens at the Chinese
 * 2-chars-per-token estimate, comfortably inside every model's window and far
 * below whatever body limit the gateway enforces.
 */
export const MAX_PROMPT_CHARS = 32_000

/**
 * Messages the harness injects into the transcript but which are not a human
 * turn: time sampling, runtime-context snapshots, billion-context compression
 * records and efficiency nudges. DSH already renders them separately; shipping
 * them inside the prompt only wastes the budget and (for the operating-mode
 * preamble) trips content moderation. The patterns are measured from the
 * session archive, matching workbuddy's `INJECTED_BUILT_IN_PREFIXES`.
 */
const INJECTED_TURN = /^(?:Time sampled while preparing turn \d|Current runtime context\.|<system-reminder>|\[Compressed conversation section\]|This is an automatically generated checkpoint|This is an efficiency nudge|\[model changed:|\[ACP status:|\[ACP )/

function isInjectedTurn(text) {
  return INJECTED_TURN.test(text)
}

// ---------------------------------------------------------------- tool calling
//
// Doubao's web `/chat/completion` has no native function-calling field: the
// request body carries a single text block and the SSE stream only ever yields
// text/reasoning deltas. Function Calling on Doubao lives on the separate
// (paid) Volcengine Ark API, which this plugin deliberately does not use.
//
// So tool support is a prompt-injection bridge: serialize the harness tool
// schemas into the prompt, ask the model to answer tool calls with a strict
// `[TOOL_CALL]{...}[/TOOL_CALL]` marker, then translate those markers back into
// the harness's `tool-call` chunk protocol. The harness agent loop executes the
// call and feeds `role:'tool'` results into the next turn; `toPrompt` already
// renders those as `[Tool result]` text, so the loop closes without a wire
// protocol for tools.

export const TOOL_CALL_OPEN = '[TOOL_CALL]'
export const TOOL_CALL_CLOSE = '[/TOOL_CALL]'

/** Active tools only: deferLoading entries are not available this turn. */
export function activeTools(tools) {
  return (Array.isArray(tools) ? tools : []).filter(
    (tool) => tool && typeof tool.name === 'string' && tool.name.length > 0 && tool.deferLoading !== true,
  )
}

/** The protocol preamble prepended to the prompt when tools are available. */
export function toolInstructions(tools) {
  const defs = tools.map((tool) => ({
    name: tool.name,
    description: typeof tool.description === 'string' ? tool.description : '',
    parameters: tool.parameters && typeof tool.parameters === 'object' ? tool.parameters : { type: 'object', properties: {} },
  }))
  return [
    '你可以使用下面的工具完成任务（例如执行终端命令、读写文件、查询信息）。You have the tools below; use them whenever the task needs one.',
    'TOOL DEFINITIONS (JSON):',
    JSON.stringify(defs),
    '',
    `To call a tool, emit exactly one block in this form, with nothing else inside it:`,
    `${TOOL_CALL_OPEN}{"name":"<exact tool name>","arguments":{...JSON matching that tool's parameters...}}${TOOL_CALL_CLOSE}`,
    '',
    'Rules:',
    '- "name" must be copied exactly from the definitions.',
    '- "arguments" must be a JSON object valid against that tool\'s "parameters" schema.',
    '- Do not wrap the marker in markdown code fences and do not add commentary inside it.',
    '- Emit one marker per call; several calls may appear one after another.',
    '- If no tool is needed, answer normally with no marker at all.',
  ].join('\n')
}

/**
 * With dozens of tools the JSON definitions are tens of thousands of chars long.
 * Doubao reads the *end* of the prompt most attentively, so a marker protocol
 * buried before that wall of JSON gets ignored — the model answers "I can't
 * access your files" in prose instead of calling anything. Re-state the one
 * rule that matters immediately after the user's question. Measured against the
 * live 59-tool prompt: without this tail the model emits no marker; with it the
 * model emits a well-formed call (choosing an appropriate tool on its own).
 */
export const TOOL_CALL_REMINDER = [
  '',
  '[System: act, do not explain] You have real executable tools listed above.',
  `If this task needs an action, emit exactly one ${TOOL_CALL_OPEN}{"name":"<exact name>","arguments":{...}}${TOOL_CALL_CLOSE} block now.`,
  'Do NOT claim you lack access or ask the user to run it themselves. Use plain prose only when the task truly needs no tool.',
].join('\n')

/**
 * Longest suffix of `text` that is also a prefix of `marker`. While streaming,
 * this is the piece of text we must hold back: it could still grow into the
 * tool-call marker with the next delta. Everything before it is safe to emit.
 */
export function heldMarkerPrefix(text, marker) {
  const max = Math.min(text.length, marker.length - 1)
  for (let n = max; n > 0; n--) {
    if (text.slice(text.length - n) === marker.slice(0, n)) return n
  }
  return 0
}

function parseToolCallPayload(jsonText) {
  let payload
  try {
    payload = JSON.parse(jsonText)
  } catch {
    return undefined
  }
  if (!payload || typeof payload !== 'object') return undefined
  const name = typeof payload.name === 'string' ? payload.name.trim() : ''
  if (!name) return undefined
  let args = payload.arguments
  if (args === undefined || args === null) args = {}
  let argumentsString
  if (typeof args === 'string') argumentsString = args
  else {
    try {
      argumentsString = JSON.stringify(args)
    } catch {
      argumentsString = '{}'
    }
  }
  return { name, arguments: argumentsString }
}

/**
 * Incremental translator from Doubao's plain text stream to harness tool-call
 * chunks. Text outside `[TOOL_CALL]…[/TOOL_CALL]` is emitted unchanged; a closed
 * marker becomes a complete tool-call block (start + delta + end). When no tools
 * are active it is a transparent passthrough, so ordinary turns are unaffected.
 *
 * `allocIndex(key)` reserves a distinct, stable block index per emitted block.
 */
export class ToolCallStream {
  constructor({ tools = [], allocIndex = () => 0 } = {}) {
    this.active = activeTools(tools).length > 0
    this.allocIndex = allocIndex
    this.buffer = ''
    this.callCount = 0
  }

  get hasCalls() {
    return this.callCount > 0
  }

  *feed(text) {
    if (!this.active) {
      if (text) yield { type: 'text', text }
      return
    }
    if (text) this.buffer += text
    yield* this.#drain(false)
  }

  *end() {
    if (!this.active) return
    yield* this.#drain(true)
  }

  *#drain(final) {
    for (;;) {
      if (!this.buffer) return
      const open = this.buffer.indexOf(TOOL_CALL_OPEN)
      if (open < 0) {
        if (final) {
          const rest = this.buffer
          this.buffer = ''
          if (rest) yield { type: 'text', text: rest }
          return
        }
        // Hold back a partial marker prefix — the next delta may complete it.
        const held = heldMarkerPrefix(this.buffer, TOOL_CALL_OPEN)
        const cut = this.buffer.length - held
        if (cut > 0) {
          const text = this.buffer.slice(0, cut)
          this.buffer = this.buffer.slice(cut)
          yield { type: 'text', text }
        }
        return
      }
      // Everything before a complete marker is plain text.
      if (open > 0) {
        const text = this.buffer.slice(0, open)
        this.buffer = this.buffer.slice(open)
        yield { type: 'text', text }
      }
      const bodyStart = TOOL_CALL_OPEN.length
      const close = this.buffer.indexOf(TOOL_CALL_CLOSE, bodyStart)
      if (close < 0) {
        if (final) {
          // An unclosed marker is not a tool call: show the model's words rather
          // than silently dropping them.
          const rest = this.buffer
          this.buffer = ''
          yield { type: 'text', text: rest }
        }
        return
      }
      const jsonText = this.buffer.slice(bodyStart, close)
      this.buffer = this.buffer.slice(close + TOOL_CALL_CLOSE.length)
      const call = parseToolCallPayload(jsonText)
      if (call) {
        const index = this.allocIndex(`tool-${this.callCount}`)
        const id = `call-${index}`
        this.callCount++
        yield { type: 'block-start', index, blockType: 'tool-call' }
        yield { type: 'tool-call-delta', index, id, name: call.name, argumentsDelta: call.arguments }
        yield { type: 'block-end', index, block: { type: 'tool-call', id, name: call.name, arguments: call.arguments } }
      } else {
        // Malformed payload: show the marker verbatim instead of losing it.
        yield { type: 'text', text: `${TOOL_CALL_OPEN}${jsonText}${TOOL_CALL_CLOSE}` }
      }
    }
  }
}

/**
 * Flatten harness message blocks into the single prompt Doubao expects, with a
 * context budget: when the flattened history is too large, keep the leading
 * system hint and the most recent turns, and insert a marker where the middle
 * was dropped. The last user turn is NEVER dropped — that is the question.
 */
function toPromptCore(messages, { maxChars = MAX_PROMPT_CHARS, tools = [] } = {}) {
  const parts = []
  const toolsForPrompt = activeTools(tools)
  if (toolsForPrompt.length > 0) parts.push(`[Tool instructions]\n${toolInstructions(toolsForPrompt)}`)
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
    if (isInjectedTurn(cleaned)) continue
    if (message.role === 'system' || message.role === 'developer') parts.push(`[System]\n${cleaned}`)
    else if (message.role === 'assistant') parts.push(`[Assistant]\n${cleaned}`)
    else if (message.role === 'tool') parts.push(`[Tool result]\n${cleaned}`)
    else parts.push(cleaned)
  }

  // Re-state the call protocol at the very END, right after the user's question.
  // With dozens of tools the JSON definitions are tens of thousands of chars and
  // Doubao only attends to the prompt tail — a marker rule buried before that
  // wall of JSON is ignored and the model answers in prose. As the last part it
  // is also the most protected during trimming (recent parts are kept first).
  if (toolsForPrompt.length > 0) parts.push(TOOL_CALL_REMINDER.trim())

  const joined = parts.join('\n\n')
  if (joined.length <= maxChars) return joined

  // Keep the leading system/tool-instruction hints (if any) plus as many recent
  // parts as fit. Tool definitions MUST survive trimming — dropping them while
  // still expecting a tool call would guarantee a malformed answer. The newest
  // part is collected first, so the current question is always kept.
  const headParts = []
  let tailStart = 0
  while (
    tailStart < parts.length &&
    (parts[tailStart].startsWith('[System]\n') || parts[tailStart].startsWith('[Tool instructions]\n'))
  ) {
    headParts.push(parts[tailStart])
    tailStart++
  }
  const head = headParts.length ? headParts.join('\n\n') : undefined
  // Tool definitions and system hints are essential and must never be chopped
  // in the middle of their JSON. If the essentials alone fill the budget, send
  // them whole: an over-budget request is rejected cleanly, but a half-written
  // tool schema makes the model emit a malformed call.
  if (head !== undefined && head.length >= maxChars) {
    // ...but the conversation still has to ride along. With many tools the
    // definitions alone exceed `maxChars`; returning `head` by itself leaves
    // the model staring at a toolbox with no question, so it invents one
    // ("just send your request"). Keep every remaining turn; if that is huge,
    // keep its tail so the newest user message survives. The call reminder is
    // separated and re-appended last: it must stay at the very end regardless
    // of how the conversation tail is trimmed.
    const tailParts = parts.slice(tailStart)
    const reminder = toolsForPrompt.length > 0 && tailParts.at(-1) === TOOL_CALL_REMINDER.trim()
      ? tailParts.pop()
      : undefined
    const rest = tailParts.join('\n\n')
    // Reserve space for the reminder, but the *last user message* wins over it:
    // a cut must end on the question, with the (short) reminder appended after.
    const room = reminder && reminder.length < maxChars ? maxChars - reminder.length - 2 : maxChars
    const keptRest = rest.length > room ? `…${rest.slice(rest.length - room)}` : rest
    const tail = [keptRest, reminder && reminder.length < maxChars ? reminder : undefined]
      .filter(Boolean)
      .join('\n\n')
    return tail ? `${head}\n\n${tail}` : head
  }
  const marker = '[… earlier turns omitted to fit the Doubao request limit …]'
  const fixed = (head === undefined ? 0 : head.length + 2) + marker.length + 2

  // The call reminder is protocol glue, not conversation. Keep it OUT of the
  // recent-first collection below and reserve its space up front, so it can
  // never displace the user's question — and is never itself squeezed out when
  // the tail budget is tight. Without this tail reminder, Doubao ignores a rule
  // buried behind tens of thousands of chars of tool JSON.
  let reminder
  let last = parts.length - 1
  if (toolsForPrompt.length > 0 && parts[last] === TOOL_CALL_REMINDER.trim()) {
    reminder = parts[last]
    last--
  }
  const reminderRoom = reminder && reminder.length + 2 <= maxChars ? reminder.length + 2 : 0
  const budget = Math.max(1, maxChars - fixed - 2 - reminderRoom)

  const kept = []
  let used = 0
  for (let i = last; i >= tailStart; i--) {
    let part = parts[i]
    const size = part.length + 2
    if (kept.length && used + size > budget) break
    if (!kept.length && size > budget) {
      // A single turn (the question, or a pasted document) is bigger than the
      // whole budget. Trim its HEAD and keep its TAIL — the instruction the user
      // actually cares about lives at the end. A global slice would cut that off.
      part = '…' + part.slice(part.length - (budget - 3))
    }
    kept.unshift(part)
    used += part.length + 2
  }
  const core = [head, marker, ...kept].filter((p) => p !== undefined).join('\n\n')
  if (reminderRoom) return `${core}\n\n${reminder}`
  return core.slice(0, maxChars)
}

/**
 * Build the prompt sent on the wire. Re-state the call protocol at the very end
 * when tools are active: the definitions are far longer than Doubao's attention
 * to the middle of the prompt, and a marker rule that is not last gets ignored.
 */
export function toPrompt(messages, options = {}) {
  return toPromptCore(messages, options)
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
  const isAuth = error.code === 710012001 || error.code === 710012002
  const code =
    error.code === 710022004
      ? 'RATE_LIMIT'
      : isAuth
        ? 'AUTH'
        : // A bridge fault is local (the client page went away or refused), so it
          // is safe to retry: no risk-control state is involved and a fresh
          // connection usually clears it.
          error.code === 'BRIDGE'
          ? 'TRANSPORT'
          : 'DOUBAO_ERROR'
  // The service answers an expired cookie with a bare numeric code. Carry the
  // raw detail but add the one action that actually fixes it, otherwise the
  // user sees "710012001" and has no idea the login needs refreshing.
  const raw = String(error.message ?? error)
  const message = isAuth
    ? `${raw}（Doubao 登录态已失效，请在插件目录运行 \`node bin/login.js\` 重新扫码登录，见 README。）`
    : raw
  return { kind: 'error', failure: { message, code } }
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

export function createAdapter({
  loadCredentials,
  logger,
  pacer,
  providerId = DEFAULT_PROVIDER,
  fetchRates = fetchModelRates,
  // The same brief carries the model rows, so the catalog refresh shares one
  // request with the rate refresh. Injected separately for tests that only care
  // about one of the two.
  fetchCatalog = async (options) => catalogFromBrief(await fetchBrief(options)),
  bridgePort,
  // Per-adapter memory by default so direct createAdapter callers (tests, and
  // anyone embedding the adapter) do not share risk state through the module's
  // live `streamChat`. The plugin passes a persistent one from index.js.
  riskMemory = createRiskMemory(),
  // true (default): direct first, fall back to the signed bridge on 710022004.
  // false: direct only, never launch or probe the Doubao client — for people who
  // would rather switch models than have the client started for them.
  allowBridge = true,
  // Native local-sandbox transport for tool-bearing turns (see index.js DEFAULTS).
  nativeEnabled = true,
  nativeWorkspace = process.cwd(),
  nativePermission = 'AskOnRisk',
  nativeHomeDir,
  // Injectable for tests; production uses the real local-sandbox transport.
  runNativeTask = streamNativeTask,
} = {}) {
  // Matches DEFAULTS.minIntervalMs in index.js: the plugin always passes its own
  // pacer, so this fallback only matters for direct callers of createAdapter.
  const gate = pacer ?? new Pacer({ minIntervalMs: 1500 })

  // The rate table starts as the last reading taken from the client and is
  // replaced once a live fetch answers. Names are built from it on every call,
  // so a refreshed table shows up in the picker without a restart.
  let rates = { ...FALLBACK_RATES }
  // Same for the catalog: the shipped reading keeps the picker populated before
  // sign-in, and the live one replaces it as soon as the account answers. A
  // model Doubao adds then appears without a release, and one it retires goes
  // away on its own.
  let models = MODELS
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
    const options = { identity: credentials.identity, cookies: credentials.cookies, logger }
    const [fresh, catalog] = await Promise.all([
      fetchRates(options),
      fetchCatalog(options).catch(() => undefined),
    ])
    if (fresh && Object.keys(fresh).length > 0) rates = fresh
    if (Array.isArray(catalog) && catalog.length > 0) models = catalog
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
    return models.map((model) => ({
      provider: providerId,
      id: model.id,
      name: nameFor(model),
      description: model.description,
      inputModalities: ['text'],
    }))
  }

  /** The live entry for an id, falling back to the shipped reading. */
  function entryFor(id) {
    return models.find((entry) => entry.id === id)
  }

  function modelEntry(id) {
    const model = entryFor(id)
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

  /**
   * The thinking depths this model actually accepts.
   *
   * Every model now gets `Off` plus its own list from the brief. That is not
   * cosmetic: Doubao numbers the tiers per model (3/4/5 on the Doubao rows,
   * 3/5/7 on GLM, 3/5/6 on Qwen), the level travels to the service as that
   * number, and asking for a tier a model does not list is simply not an option
   * the picker can offer. `Off` is always present so a saved call that still
   * passes it validates instead of failing with UNSUPPORTED_REASONING_EFFORT.
   */
  function reasoningFor(model) {
    const efforts = effortsFor(model)
    return { efforts, defaultEffort: 'off' }
  }

  function resolvedInfo(id) {
    const model = entryFor(id)
    return {
      ...modelEntry(id),
      context: { contextWindow: model?.contextWindow ?? CONTEXT_WINDOW },
      defaultMaxTokens: DEFAULT_MAX_TOKENS,
      reasoning: reasoningFor(model),
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
      // Deliberately not awaited: a stale rate table costs one `brief_list`
      // round trip, and this method sits between "user pressed enter" and the
      // request going out. The picker still gets an accurate table from
      // listModels/resolveModel, which do await; here the rate only decorates
      // the name on the turn record, so a background refresh is enough.
      ensureRates().catch(() => rates)
      return { model: resolvedInfo(model), stream: (options) => this.stream({ ...options, provider, model }) }
    },

    /** Test seam: the table the picker is currently showing. */
    currentRates() {
      return { ...rates }
    },

    async *stream(options) {
      const modelId = options.model
      const entry = entryFor(resolveWireModel(modelId)?.id ?? modelId) ?? resolveWireModel(modelId)
      const tools = Array.isArray(options.tools) ? options.tools : []
      const prompt = toPrompt(options.messages, { tools })
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
              message: 'Doubao is not signed in. Run `node bin/login.js` from the plugin directory and scan the QR with the Douyin app (see README).',
              code: 'AUTH_MISSING',
            },
          },
        }
        return
      }

      // Any explicit tier means "think"; `off` (or an absent effort) means the
      // model's own default. The level is what actually carries the depth: the
      // service numbers its tiers per model, so the id is translated back to the
      // number that model listed. A level the model does not offer (reachable
      // only if a caller bypasses the harness validation against
      // `reasoning.efforts`) falls back to the model's default rather than
      // sending a tier the service would reject.
      const requestedEffort = options.reasoningEffort
      const think = requestedEffort !== undefined && requestedEffort !== 'off'
      const requestedLevel = EFFORT_ID_LEVEL[requestedEffort]
      const level = entry?.levels?.includes(requestedLevel) ? requestedLevel : entry?.effort
      let chars = 0
      // One block per kind of text, numbered in the order they first appear. The
      // reasoning block is opened as soon as Doubao starts thinking, which is
      // seconds before the answer exists — that early chunk is what makes the
      // turn look alive instead of stalled.
      const blockIndex = new Map()
      function indexFor(kind) {
        if (!blockIndex.has(kind)) blockIndex.set(kind, blockIndex.size)
        return blockIndex.get(kind)
      }
      const opened = new Set()
      function* begin(kind) {
        if (opened.has(kind)) return
        opened.add(kind)
        yield { type: 'block-start', index: indexFor(kind), blockType: kind === 'reasoning' ? 'reasoning' : 'text' }
      }
      // Tool calls must own their block indexes. text/reasoning blocks claiming
      // indexes lazily while a call is emitted would otherwise reuse the same
      // number and collapse two content blocks into one in the assembler.
      let toolIndexCursor = 1000
      const toolStream = new ToolCallStream({
        tools,
        allocIndex: () => toolIndexCursor++,
      })
      function* emitText(text) {
        if (!text) return
        // The live reminder restates the protocol at the very end of the prompt;
        // the model sometimes echoes it back in prose. Strip that echo so a text
        // answer never carries the marker syntax as visible text.
        text = text.replace(/\[System:\s*act,\s*do not explain\][^\n]*\n?/gi, '')
          .replace(/^If this task needs an action, emit exactly one .*$/gim, '')
          .replace(/^Do NOT claim you lack access.*$/gim, '')
        if (!text) return
        chars += text.length
        yield* begin('answer')
        yield { type: 'text-delta', index: indexFor('answer'), text }
      }
      function* consumeTranslator(events) {
        for (const piece of events) {
          if (piece.type === 'text') yield* emitText(piece.text)
          else yield piece
        }
      }

      // ---- Native local-sandbox transport ---------------------------------
      // A tool-bearing turn on a work-surface model is not a prose answer: the
      // Doubao service dispatches each tool to a local sandbox channel and the
      // model only answers once it has the real results. Running that channel
      // here means the tools actually execute on this machine, instead of the
      // model merely describing what it would do. Everything is buffered until
      // the turn settles, so a failed native channel can fall back to the text
      // bridge below without having already emitted half an answer.
      if (nativeEnabled && tools.length > 0 && entry?.agentMode === 1) {
        // The native channel carries its own tool protocol: the service decides
        // which local tools to dispatch from the task itself. The text-bridge
        // prompt injects a `[Tool instructions]` schema and a
        // "emit [TOOL_CALL]" reminder, which are meaningless here and bloat the
        // single text block enough that the gateway refuses to dispatch at all.
        // Send the clean conversation instead — exactly what a native task has.
        const nativeText = toPrompt(options.messages)
        const nativeEvents = []
        let nativeThrow = null
        try {
          // Bound the native turn: a stuck SSE stream must hand control back to
          // the text bridge instead of holding the agent loop hostage. The
          // caller's signal takes precedence when it aborts sooner.
          const nativeAbort = new AbortController()
          const onAbort = () => nativeAbort.abort()
          options.signal?.addEventListener?.('abort', onAbort, { once: true })
          const timer = setTimeout(() => nativeAbort.abort(), 60_000)
          try {
            for await (const event of runNativeTask({
              identity: credentials.identity,
              cookies: credentials.cookies,
              userAgent: DEFAULT_UA,
              text: nativeText,
              entry,
              level,
              workspace: nativeWorkspace,
              permission: nativePermission,
              homeDir: nativeHomeDir ?? homedir(),
              signal: nativeAbort.signal,
              logger,
            })) {
              nativeEvents.push(event)
            }
          } finally {
            clearTimeout(timer)
            options.signal?.removeEventListener?.('abort', onAbort)
          }
        } catch (error) {
          nativeThrow = error
        }
        const nativeError = nativeEvents.find((e) => e.type === 'error')
        const answer = nativeEvents.filter((e) => e.type === 'delta').map((e) => e.text).join('')
        const reasoning = nativeEvents.filter((e) => e.type === 'reasoning').map((e) => e.text).join('')
        const runs = nativeEvents.filter((e) => e.type === 'executed')

        if (!nativeThrow && !nativeError && answer.trim()) {
          if (reasoning) {
            yield* begin('reasoning')
            chars += reasoning.length
            yield { type: 'reasoning-delta', index: indexFor('reasoning'), text: reasoning }
          }
          for (const run of runs) {
            const input = run.call?.input ?? {}
            const detail = input.command ?? input.file_path ?? input.path ?? input.pattern ?? ''
            const line = `执行 ${run.call?.name ?? 'tool'}(${String(detail).replace(/\s+/g, ' ').slice(0, 120)})`
            yield* begin('reasoning')
            chars += line.length
            yield { type: 'reasoning-delta', index: indexFor('reasoning'), text: line }
          }
          yield* emitText(answer)
          const outTokens = Math.max(1, Math.ceil(chars / 2))
          const inTokens = Math.max(1, Math.ceil(prompt.length / 2))
          yield {
            type: 'usage',
            usage: { inputTokens: inTokens, outputTokens: outTokens, totalTokens: inTokens + outTokens },
          }
          // The tools already ran in the sandbox: report `stop`, never
          // `tool-calls`, or the host would execute them a second time.
          yield { type: 'finish', reason: { kind: 'stop' }, durationMs: Date.now() - started }
          return
        }
        logger?.warn?.(
          `doubao: native transport unavailable for ${modelId} ` +
            `(${nativeError?.message ?? nativeThrow?.message ?? 'no answer'}); using text bridge`,
        )
        // Fall through to the text bridge with no output emitted yet.
      }

      // Doubao's moderation refusal is a normal text stream, not an error frame.
      // Hold deltas only while they are still a strict prefix of the canned
      // notice's lead; any real answer diverges on its first delta and flushes
      // immediately, so there is no perceptible buffering.
      let pending = ''
      let refused = false
      let holding = true
      try {
        for await (const event of gate.runIterable(
          () =>
            streamChat({
              identity: credentials.identity,
              cookies: credentials.cookies,
              text: prompt,
              model: entry?.id ?? modelId,
              entry,
              effort: level,
              think,
              signal: options.signal,
              bridgePort,
              riskMemory,
              bridge: allowBridge,
            }),
          // The lock is per turn, the cooldown is per model: a penalty taken here
          // must not be paid by whichever model the user picks next.
          { key: modelId, signal: options.signal },
        )) {
          if (event.type === 'reasoning' && event.text) {
            // Reasoning is never the canned notice: pass it straight through.
            yield* begin('reasoning')
            chars += event.text.length
            yield { type: 'reasoning-delta', index: indexFor('reasoning'), text: event.text }
          } else if (event.type === 'delta' && event.text) {
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
                yield* consumeTranslator(toolStream.feed(first))
              }
            } else {
              yield* consumeTranslator(toolStream.feed(event.text))
            }
          } else if (event.type === 'error') {
            // pending can only be a truncated refusal prefix here; dropping it is
            // more honest than showing a stray fragment alongside the error.
            pending = ''
            const failure = new Error(event.message ?? 'doubao error')
            // `common invalid param` is the gateway's parameter-validation reply
            // to an oversized single text_block; it carries no error_code. Make
            // any recurrence self-diagnosing instead of an opaque message.
            if (/common invalid param|invalid param/i.test(failure.message)) {
              failure.message = `Doubao rejected the request: ${failure.message} (wire prompt was ${prompt.length} chars, budget ${MAX_PROMPT_CHARS})`
            }
            failure.code = event.code
            // The refusal arrives in the stream body, not as a thrown error, so the
            // cooldown has to be extended here too — otherwise this model walks
            // straight back into the same limit. It stays scoped to this model.
            if (event.code === RISK_CODE) gate.penalize(60_000, modelId)
            yield { type: 'finish', reason: finishReasonFor(failure) }
            return
          }
        }
        // A stream that ended still holding a prefix was truncated mid-refusal;
        // there is nothing worth rendering.
        pending = ''
        // Flush any held marker prefix or complete marker the model left in the
        // final delta, so a tool call split across the last chunk is not lost.
        yield* consumeTranslator(toolStream.end())
      } catch (error) {
        if (error.code === RISK_CODE) gate.penalize(60_000, modelId)
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
        yield* begin('answer')
        yield { type: 'text-delta', index: indexFor('answer'), text: explanation }
        chars += explanation.length
        gate.penalize(30_000, modelId)
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
      // A turn that produced at least one tool call must report `tool-calls`,
      // otherwise the agent loop treats the parsed blocks as plain prose and
      // never executes them. No tools configured → unchanged `stop` behaviour.
      const finishReason = toolStream.hasCalls ? { kind: 'tool-calls' } : { kind: 'stop' }
      yield { type: 'finish', reason: finishReason, durationMs: Date.now() - started }
    },
  }
}
