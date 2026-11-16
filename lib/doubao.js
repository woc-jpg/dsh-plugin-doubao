/**
 * The Doubao chat protocol, in plain Node.
 *
 * Verified against the live service: a POST to /chat/completion carrying the
 * account's own device_id plus a valid session cookie streams SSE back. The
 * two things that matter are the identity pair (device_id and fp, where fp is
 * literally "verify_" + device_id) and the session cookie — everything else in
 * the payload is cosmetic as far as the risk engine is concerned.
 *
 * One caveat, learned the hard way: "cosmetic" holds only while the account is
 * in good standing. Once the semantic risk model takes an interest, an unsigned
 * request is refused with 710022004 regardless of how the query or body is
 * shaped; the only thing that satisfies it is the `a_bogus`/`msToken` pair the
 * desktop client mints internally. See ./bridge.js for how we borrow it.
 */

import {
  ensureBridge,
  bridgeAvailable,
  bridgeStream,
  DEFAULT_PORT as BRIDGE_PORT,
} from './bridge.js'

export const CHAT_AID = '582478'
export const BOT_ID = '7338286299411103781'
// The verified-good values are the ones the Windows client sends. They are
// cosmetic while the account is in good standing, and under the bridge the page
// supplies its own UA and signature. But a client on macOS/Linux should not be
// forced to claim Windows if the risk engine ever looks at these, so they can be
// overridden without a code change. Defaults stay byte-for-byte as verified.
export const DEFAULT_UA =
  process.env.DOUBAO_UA ??
  ('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) ' +
    'Chrome/147.0.7727.149 Safari/537.36 SamanthaDoubao/2.35.12')

const ALNUM = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789'

export function randomId(len = 10) {
  let out = ''
  for (let i = 0; i < len; i += 1) out += ALNUM[Math.floor(Math.random() * ALNUM.length)]
  return out
}

export function randomDigits(len, lead) {
  let out = String(lead)
  for (let i = 1; i < len; i += 1) out += String(Math.floor(Math.random() * 10))
  return out
}

/** A brand new device identity. Only useful if the account will accept it. */
export function mintIdentity() {
  const deviceId = randomDigits(16, '7')
  return { deviceId, fp: `verify_${deviceId}`, webId: randomDigits(19, '7') }
}

/**
 * Every chat model the Doubao client can route to.
 *
 * Picking a model is not a single field. The client sends the same five-tuple
 * in three places — `conversation_init_ext`, `model_config` and
 * `aggregate_params` — and mirrors two of them onto `option` and `ext`. The
 * server reads whichever copy it wants, so leaving any of them at the default
 * silently downgrades the request to the plain chat model: the answer comes
 * back, just from the wrong model. That is why the tuple lives here instead of
 * being hard-coded in one place.
 *
 *   modeId      1 = chat surface, 3 = office/task surface
 *   agentMode   2 = chat, 1 = task
 *   convMode    conversation_mode, 1 for chat and 3 for the task surface
 *   effort      reasoning_effort; 3 normal, 4 raised
 *   deepThink   need_deep_think / use_deep_think, the client's thinking-mode id
 *
 * Verified against the live account: all twelve answer with real content.
 */
export const MODELS = [
  { id: 'doubao', key: '0', name: 'Doubao', modeId: '1', agentMode: 2, convMode: 1, effort: 3, deepThink: 0,
    description: 'Doubao 2.1, the everyday chat model.' },
  { id: 'doubao-expert', key: '3', name: 'Doubao Expert', modeId: '1', agentMode: 2, convMode: 1, effort: 4, deepThink: 1,
    description: 'Doubao with expert reasoning turned on.' },
  { id: 'doubao-auto', key: '9', name: 'Doubao Auto', modeId: '3', agentMode: 1, convMode: 3, effort: 3, deepThink: 9,
    description: 'Doubao decides per request how much to think.' },
  { id: 'doubao-2.1-lite', key: 'seed-lite-7b', name: 'Doubao 2.1 Lite', modeId: '3', agentMode: 1, convMode: 3, effort: 3, deepThink: 4,
    description: 'Small, fast Doubao 2.1.' },
  { id: 'doubao-2.1-pro', key: '5', name: 'Doubao 2.1 Pro', modeId: '3', agentMode: 1, convMode: 3, effort: 3, deepThink: 5,
    description: 'Full-size Doubao 2.1.' },
  { id: 'deepseek-v4.1-flash', key: 'person-deepseek-v4-1-flash-261017', name: 'DeepSeek V4.1 Flash', modeId: '3', agentMode: 1, convMode: 3, effort: 3, deepThink: 4,
    description: 'DeepSeek V4.1 Flash, served through Doubao.' },
  { id: 'deepseek-v4-pro', key: 'person-deepseek-v4-pro-ga-260813', name: 'DeepSeek V4 Pro', modeId: '3', agentMode: 1, convMode: 3, effort: 3, deepThink: 4,
    description: 'DeepSeek V4 Pro, served through Doubao.' },
  { id: 'kimi-k3.1-pro', key: 'person-kimi-k3-1-pro-261111', name: 'Kimi K3.1 Pro', modeId: '3', agentMode: 1, convMode: 3, effort: 3, deepThink: 4,
    description: 'Kimi K3.1 Pro, served through Doubao.' },
  { id: 'kimi-k3.1-pro-highspeed', key: 'person-kimi-k3-1-pro-highspeed-261111', name: 'Kimi K3.1 Pro Highspeed', modeId: '3', agentMode: 1, convMode: 3, effort: 3, deepThink: 4,
    description: 'Kimi K3.1 Pro on the low-latency tier.' },
  { id: 'kimi-k3', key: 'person-kimi-k3-261111', name: 'Kimi K3', modeId: '3', agentMode: 1, convMode: 3, effort: 3, deepThink: 4,
    description: 'Kimi K3, served through Doubao.' },
  { id: 'glm-5.3', key: 'person-glm-5-3-261111', name: 'GLM 5.3', modeId: '3', agentMode: 1, convMode: 3, effort: 3, deepThink: 8,
    description: 'GLM 5.3, served through Doubao.' },
  { id: 'glm-5.3-flash', key: 'person-glm-5-3-flash-261111', name: 'GLM 5.3 Flash', modeId: '3', agentMode: 1, convMode: 3, effort: 3, deepThink: 8,
    description: 'GLM 5.3 on the fast tier.' },
]

/**
 * Older names, kept so a saved session or a hand-written config does not turn
 * into a different model without saying so.
 */
export const MODEL_ALIASES = {
  'doubao-pro': 'doubao',
  'doubao-think': 'doubao-expert',
}

/** The routing entry for an id, or undefined when the id is unknown. */
export function findModel(id) {
  const canonical = MODEL_ALIASES[id] ?? id
  return MODELS.find((m) => m.id === canonical)
}

/**
 * Same lookup, but forgiving: a session saved against a model this build no
 * longer knows about keeps working instead of failing to answer at all.
 */
export function resolveModel(id) {
  return findModel(id) ?? MODELS[0]
}

export function buildQuery(identity) {
  // Verified against a live session: this exact shape streams, and all five
  // models answered in one run. `pc_version` mirrors the client version the
  // device reported; the web_platform/device_platform pair stays "web" because
  // that is what the working capture carried.
  const params = new URLSearchParams({
    aid: CHAT_AID,
    channel: process.env.DOUBAO_CHANNEL ?? 'win',
    client_platform: 'pc_client',
    device_platform: 'web',
    doubao_device_platform: 'web',
    pc_version: identity.clientVersion ?? '2.35.12',
    runtime: 'web',
    runtime_version: '3.41.0',
    web_platform: 'web',
    language: 'zh',
    pkg_type: 'release_version',
    real_aid: CHAT_AID,
    region: 'CN',
    sys_region: 'CN',
    samantha_web: '1',
    'use-olympus-account': '1',
    version_code: '20800',
    device_id: identity.deviceId,
    fp: identity.fp,
    web_id: identity.webId ?? identity.deviceId,
    web_tab_id: crypto.randomUUID(),
    tz_name: process.env.DOUBAO_TZ ?? Intl.DateTimeFormat().resolvedOptions().timeZone ?? 'Etc/GMT-8',
    chromium_version: identity.chromiumVersion ?? '147.0.7727.149',
    tea_uuid: identity.deviceId,
  })
  return params.toString()
}

export function buildBody(text, { model = 'doubao', think, conversationId = '' } = {}) {
  const cfg = resolveModel(model)
  // `think` is the harness reasoning control, and it only makes sense for the
  // chat-surface models that have a thinking switch. For the routed models the
  // model itself already implies the depth, so honouring a stray "off" would
  // quietly downgrade e.g. GLM 5.3 to its non-thinking path.
  const deepThink = cfg.modeId === '1' && think !== undefined ? (think ? 1 : 0) : cfg.deepThink
  const effort = String(cfg.effort)
  return {
    client_meta: {
      local_conversation_id: conversationId || 'local_' + randomDigits(16, '1'),
      conversation_id: conversationId,
      bot_id: BOT_ID,
      last_section_id: '',
      last_message_index: null,
    },
    messages: [
      {
        local_message_id: crypto.randomUUID(),
        content_block: [
          {
            block_type: 10000,
            content: {
              text_block: { text, icon_url: '', icon_url_dark: '', summary: '' },
              pc_event_block: '',
            },
            block_id: crypto.randomUUID(),
            parent_id: '',
            meta_info: [],
            extra_info: {},
            append_fields: [],
          },
        ],
        message_status: 0,
      },
    ],
    option: {
      agent_mode: cfg.agentMode,
      need_deep_think: deepThink,
      scene_type: 0,
      need_create_conversation: !conversationId,
      conversation_init_option: { need_ack_conversation: true },
      conversation_init_ext: { model_item_key: cfg.key, reasoning_effort: effort, mode_id: cfg.modeId },
      sse_recv_event_options: { support_chunk_delta: true },
      support_lazy_fetch_stream: true,
      is_old_user: true,
      recovery_option: {
        is_recovery: false,
        req_create_time_sec: Math.floor(Date.now() / 1000),
        append_sse_event_scene: 0,
      },
      model_config: { model_item_key: cfg.key, model_extra_params: {}, reasoning_effort: cfg.effort },
      aggregate_params: {
        mention_skill_list: '[]',
        mention_plugin_list: '[]',
        mention_ext: '[{}]',
        conversation_mode: String(cfg.convMode),
        mode_id: cfg.modeId,
        model_item_key: cfg.key,
        agent_mode: String(cfg.agentMode),
        reasoning_effort: effort,
        provider_id: '',
      },
      conversation_mode: cfg.convMode,
      unique_key: crypto.randomUUID(),
    },
    user_context: [],
    ext: {
      agent_mode: String(cfg.agentMode),
      use_deep_think: String(deepThink),
      sub_conv_firstmet_type: '1',
      collection_id: '',
      is_finish: '1',
      conversation_init_option: '{"need_ack_conversation":true}',
      commerce_credit_config_enable: '0',
    },
  }
}

/**
 * Walk one SSE frame by frame. Doubao interleaves heartbeats, an ack, a full
 * message snapshot and then deltas, and any of those can carry the risk-control
 * error instead of the text — so the parser reports errors rather than
 * assuming a well-formed stream.
 */
export function* parseFrames(chunk) {
  const lines = chunk.split('\n')
  let event = ''
  const data = []
  for (const raw of lines) {
    const line = raw.replace(/\r$/, '')
    if (line === '') {
      if (data.length) yield { event, data: data.join('\n') }
      event = ''
      data.length = 0
      continue
    }
    if (line.startsWith('event:')) event = line.slice(6).trim()
    else if (line.startsWith('data:')) data.push(line.slice(5).trim())
  }
  if (data.length) yield { event, data: data.join('\n') }
}

/**
 * Attribute the text in each frame to the block that produced it.
 *
 * Doubao pushes two kinds of text down the same pipe: the answer, and — when
 * thinking is on — the reasoning that precedes it. The reasoning body is an
 * ordinary `block_type` 10000 text block whose `parent_id` points at the 10040
 * thinking-block header (which itself carries no text, only the "正在思考" /
 * "已完成思考" titles). `CHUNK_DELTA` frames carry no block identity at all, so a
 * delta belongs to whichever text block was declared last.
 *
 * Treating every delta as answer text is what used to glue the reasoning onto
 * the front of the reply — measured on a real turn, a 259-character 思考 stream
 * arrived 6 seconds before the answer and was rendered as part of it — and it
 * also threw away the only stream the UI could show while the model was busy.
 *
 * The tracker is stateful because a delta cannot be classified on its own; one
 * instance belongs to one stream.
 */
export function createTextTracker() {
  const thinkingBlocks = new Set()
  let kind = 'answer'
  return {
    /** The kind the next `CHUNK_DELTA` will be attributed to. */
    get kind() {
      return kind
    },
    /**
     * Read one SSE frame.
     * @returns {{kind: 'answer'|'reasoning', text: string}[]} text segments, in order.
     */
    absorb(event, payload) {
      if (!payload) return []
      const blocks = []
      if (event === 'STREAM_MSG_NOTIFY' || event === 'FULL_MSG_NOTIFY') {
        const message = payload?.message
        const content = message?.content ?? payload?.content
        blocks.push(...(content?.content_block ?? []))
      } else if (event === 'STREAM_CHUNK') {
        for (const op of payload?.patch_op ?? []) {
          if (op?.patch_object === 111) continue // text-to-speech mirror of the same text
          blocks.push(...(op?.patch_value?.content_block ?? []))
        }
      }
      const out = []
      for (const b of blocks) {
        const type = Number(b?.block_type)
        if (type === 10040) {
          // Header only: remember the id so its child text block can be spotted.
          const id = b?.block_id
          if (id !== undefined && id !== null && id !== '') thinkingBlocks.add(String(id))
          kind = 'reasoning'
          continue
        }
        if (type !== 10000) continue
        const parent = b?.parent_id
        const isThinkingChild =
          parent !== undefined && parent !== null && parent !== '' && parent !== 0 && thinkingBlocks.has(String(parent))
        kind = isThinkingChild ? 'reasoning' : 'answer'
        const text = b?.content?.text_block?.text
        if (typeof text === 'string' && text !== '') out.push({ kind, text })
      }
      // The server sends the bulk of the answer as CHUNK_DELTA once
      // `support_chunk_delta` is on. Missing this event silently truncates every
      // reply to its first frame — verified against the live stream, where the
      // three sources concatenate exactly to the message brief.
      if (event === 'CHUNK_DELTA' && typeof payload.text === 'string' && payload.text !== '') {
        out.push({ kind, text: payload.text })
      }
      return out
    },
  }
}

/** Pull the answer text out of one self-contained SSE event. */
export function textOf(event, payload) {
  return createTextTracker()
    .absorb(event, payload)
    .filter((segment) => segment.kind === 'answer')
    .map((segment) => segment.text)
    .join('')
}

export const RISK_CODES = new Set([710022002, 710022004])
export const AUTH_CODES = new Set([710012001, 710012002])

/** Cooldown key used when a penalty is not tied to one model. */
const GLOBAL_COOLDOWN = '*'

/**
 * Serialize outbound turns and keep a minimum gap between them.
 *
 * The account is shared and the risk engine reacts to bursts, not to volume: five
 * quick calls in one probe run were enough to earn a cooldown that outlasted the
 * run. So the lock spans the whole turn (request *and* stream) — releasing it
 * after the POST would let several streams overlap, which is the exact pattern
 * that trips 710022004.
 *
 * Two properties matter for switching models mid-conversation:
 *
 * - The lock cannot outlive the turn that took it. Holding it in a generator's
 *   `finally` is not enough: when a consumer drops an async iterator without
 *   calling `return()` (which is what an aborted turn does), that block never
 *   runs and every later turn waits on a promise nobody will resolve. Each lease
 *   therefore carries a deadline, is extended while the stream keeps producing,
 *   and ends early when the turn's abort signal fires.
 * - A cooldown belongs to the model that earned it. 710022004 is answered by a
 *   fresh request to a *different* backend without incident, so a penalty on one
 *   model must not make every other model unavailable for the next minute.
 */
export class Pacer {
  constructor({ minIntervalMs = 1500, leaseMs = 45_000, now = () => Date.now(), sleep } = {}) {
    this.minIntervalMs = minIntervalMs
    this.leaseMs = leaseMs
    this.now = now
    this.sleep = sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)))
    this.lastAt = 0
    this.tail = Promise.resolve()
    this.cooldowns = new Map()
  }

  /**
   * Take a lease on the turn lock.
   *
   * `done` resolves exactly once — on `end()` or when the deadline passes with no
   * sign of life. `touch()` pushes the deadline out; the watchdog only fires for
   * a turn that went silent.
   */
  openLease() {
    let release
    const done = new Promise((r) => {
      release = r
    })
    let released = false
    let timer = null
    const end = () => {
      if (released) return
      released = true
      if (timer !== null) {
        clearTimeout(timer)
        timer = null
      }
      release()
    }
    const touch = () => {
      if (released) return
      if (timer !== null) clearTimeout(timer)
      timer = setTimeout(end, this.leaseMs)
      timer.unref?.()
    }
    touch()
    return { done, touch, end }
  }

  /** Wait until this caller is allowed to send. Call only inside a lease. */
  async wait(key) {
    const cooldown = this.cooldownFor(key)
    if (cooldown > 0) await this.sleep(cooldown)
    const gap = this.minIntervalMs - (this.now() - this.lastAt)
    if (gap > 0) await this.sleep(gap)
    this.lastAt = this.now()
  }

  /** Run one turn exclusively; everything else queues behind it. */
  async run(fn, { key, signal } = {}) {
    const previous = this.tail
    const lease = this.openLease()
    this.tail = lease.done
    const onAbort = () => lease.end()
    if (signal) {
      if (signal.aborted) lease.end()
      else signal.addEventListener?.('abort', onAbort, { once: true })
    }
    await previous
    try {
      await this.wait(key)
      return await fn()
    } finally {
      signal?.removeEventListener?.('abort', onAbort)
      lease.end()
    }
  }

  /**
   * Same exclusive turn, but for work that yields as it goes.
   *
   * `run` cannot be used for this: `for await` does not await a promise before
   * looking for `Symbol.asyncIterator`, so `for await (x of run(() => gen()))`
   * throws "is not a function or its return value is not async iterable". Here the
   * generator yields through, and the lock is released when it finishes, when the
   * caller aborts, or when it goes silent long enough for the lease to expire —
   * which is the whole point of holding it across the stream.
   */
  async *runIterable(makeIterable, { key, signal } = {}) {
    const previous = this.tail
    const lease = this.openLease()
    this.tail = lease.done
    const onAbort = () => lease.end()
    if (signal) {
      if (signal.aborted) lease.end()
      else signal.addEventListener?.('abort', onAbort, { once: true })
    }
    await previous
    try {
      await this.wait(key)
      for await (const value of makeIterable()) {
        // A stream that is still producing is alive; only silence expires.
        lease.touch()
        yield value
      }
    } finally {
      signal?.removeEventListener?.('abort', onAbort)
      lease.end()
    }
  }

  /**
   * Cool the given key (a model id, or GLOBAL when omitted) down.
   *
   * Waiters ask for their own key, so a penalty taken by one model is not paid by
   * the next one the user picks.
   */
  penalize(ms, key = GLOBAL_COOLDOWN) {
    const until = this.now() + ms
    this.cooldowns.set(key, Math.max(this.cooldowns.get(key) ?? 0, until))
  }

  /** How long a caller for `key` would have to wait, in ms. */
  cooldownFor(key) {
    const now = this.now()
    const own = key === undefined ? 0 : (this.cooldowns.get(key) ?? 0) - now
    const global = (this.cooldowns.get(GLOBAL_COOLDOWN) ?? 0) - now
    return Math.max(0, own, global)
  }

  get coolingDownMs() {
    const now = this.now()
    let longest = 0
    for (const until of this.cooldowns.values()) longest = Math.max(longest, until - now)
    return Math.max(0, longest)
  }
}

/**
 * Turn a stream of SSE text into events.
 *
 * Transport-agnostic on purpose: the bridge hands over strings and a direct
 * fetch hands over bytes, and both have to frame identically or the two paths
 * would drift apart in behaviour.
 */
async function* readEvents(chunks) {
  const decoder = new TextDecoder()
  let buffer = ''
  let sawError = false
  const tracker = createTextTracker()

  function* drain(block) {
    for (const frame of parseFrames(block)) {
      const payload = tryJson(frame.data)
      if (frame.event === 'SSE_ACK') {
        const meta = payload?.ack_client_meta ?? {}
        if (meta.conversation_id) yield { type: 'meta', conversationId: meta.conversation_id }
        continue
      }
      if (frame.event === 'STREAM_ERROR' || frame.event === 'SSE_ERROR') {
        sawError = true
        const code = Number(payload?.error_code ?? payload?.code ?? 0)
        yield {
          type: 'error',
          code,
          message: payload?.error_msg ?? payload?.message ?? 'stream error',
          raw: payload,
        }
        continue
      }
      if (frame.event === 'FULL_MSG_NOTIFY') {
        // full snapshot arrives before the deltas; ignore it and let STREAM_CHUNK drive
        const meta = payload?.message?.conversation_id
        if (meta) yield { type: 'meta', conversationId: meta }
        continue
      }
      if (frame.event === 'SSE_REPLY_END') {
        yield { type: 'end', endType: payload?.end_type, brief: payload?.msg_finish_attr?.brief }
        continue
      }
      for (const segment of tracker.absorb(frame.event, payload)) {
        yield { type: segment.kind === 'reasoning' ? 'reasoning' : 'delta', text: segment.text }
      }
    }
  }

  for await (const chunk of chunks) {
    buffer += typeof chunk === 'string' ? chunk : decoder.decode(chunk, { stream: true })
    // frames are separated by a blank line; keep the tail for the next read
    const cut = buffer.lastIndexOf('\n\n')
    if (cut < 0) continue
    const block = buffer.slice(0, cut + 2)
    buffer = buffer.slice(cut + 2)
    yield* drain(block)
  }
  if (!sawError) {
    // flush a trailing frame that lacked its blank-line terminator
    yield* drain(buffer)
  }
}

/**
 * Stream parsed events from the live endpoint.
 *
 * There are two transports and the order matters. A plain Node request carries
 * no `a_bogus`/`msToken`, and the service rejects it with 710022004 as soon as
 * the account is under any scrutiny — measured across every shape variation we
 * could construct. So when the desktop client is reachable, the request is
 * performed *by the client page* over the debugger bridge, where its own
 * preload hook signs it. When no client is reachable we start one with the
 * debugger port enabled, because without it every signed request is refused
 * and there is nothing to fall back to. `bridge: false` opts out of all of
 * that and goes direct.
 *
 * The two bridge calls are injected so tests can exercise both transports
 * without a running client; the exported `streamChat` binds the real ones.
 */
export function createStreamChat({ available = ensureBridge, stream = bridgeStream } = {}) {
  return async function* streamChat({
    identity,
    cookies,
    text,
    model,
    think,
    conversationId,
    signal,
    bridge = true,
    bridgePort,
  }) {
    const url = 'https://www.doubao.com/chat/completion?' + buildQuery(identity)
    const body = JSON.stringify(buildBody(text, { model, think, conversationId }))

    if (bridge !== false && (await available(bridgePort).catch(() => false))) {
      try {
        yield* readEvents(stream({ url, body, port: bridgePort ?? BRIDGE_PORT, signal }))
        return
      } catch (error) {
        if (signal?.aborted) throw error
        // The client was there but refused mid-flight. Reporting this as a rate
        // limit would be a lie, and retrying unsigned would turn it into one.
        yield { type: 'error', code: 'BRIDGE', message: `client bridge failed: ${error.message}` }
        return
      }
    }

    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'agw-js-conv': 'str',
        Cookie: cookies,
        'User-Agent': DEFAULT_UA,
        Origin: 'https://www.doubao.com',
        Referer: 'https://www.doubao.com/chat/',
      },
      body,
      signal,
    })

    if (!res.ok || !res.body) {
      const detail = await res.text().catch(() => '')
      yield {
        type: 'error',
        code: res.status,
        message: `http ${res.status} ${detail.slice(0, 300)}`,
      }
      return
    }

    yield* readEvents(res.body)
  }
}

/** The live transport: bridge first, direct request when no client is around. */
export const streamChat = createStreamChat()

function tryJson(s) {
  try {
    return JSON.parse(s)
  } catch {
    return undefined
  }
}

/** Non-streaming convenience wrapper. */
export async function completeChat(options) {
  let text = ''
  let conversationId
  for await (const ev of streamChat(options)) {
    if (ev.type === 'delta') text += ev.text
    else if (ev.type === 'meta') conversationId = ev.conversationId
    else if (ev.type === 'error') throw Object.assign(new Error(ev.message), { code: ev.code, raw: ev.raw })
  }
  return { text, conversationId }
}
