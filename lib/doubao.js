/**
 * The Doubao chat protocol, in plain Node.
 *
 * Verified against the live service: a POST to /chat/completion carrying the
 * account's own device_id plus a valid session cookie streams SSE back. The
 * two things that matter are the identity pair (device_id and fp, where fp is
 * literally "verify_" + device_id) and the session cookie — everything else in
 * the payload is cosmetic as far as the risk engine is concerned.
 */

export const CHAT_AID = '582478'
export const BOT_ID = '7338286299411103781'
export const DEFAULT_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) ' +
  'Chrome/147.0.7727.149 Safari/537.36 SamanthaDoubao/2.35.12'

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
 * Model routing is done by `model_item_key`; the risk engine does not care
 * which one we pick, so the mapping lives here rather than in config.
 */
export const MODELS = [
  { id: 'doubao', key: '0', name: 'Doubao', think: false },
  { id: 'doubao-think', key: '1', name: 'Doubao (thinking)', think: true },
  { id: 'doubao-expert', key: '3', name: 'Doubao Expert', think: true },
  { id: 'kimi-k3.1-pro', key: 'person-kimi-k3-1-pro-261111', name: 'Kimi K3.1 Pro', think: true },
  { id: 'glm-5.3', key: 'person-glm-5-3-261111', name: 'GLM 5.3', think: true },
]

export function resolveModel(id) {
  return MODELS.find((m) => m.id === id) ?? MODELS[0]
}

export function buildQuery(identity) {
  // Verified against a live session: this exact shape streams, and all five
  // models answered in one run. `pc_version` mirrors the client version the
  // device reported; the web_platform/device_platform pair stays "web" because
  // that is what the working capture carried.
  const params = new URLSearchParams({
    aid: CHAT_AID,
    channel: 'win',
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
    tz_name: 'Etc/GMT-8',
    chromium_version: identity.chromiumVersion ?? '147.0.7727.149',
    tea_uuid: identity.deviceId,
  })
  return params.toString()
}

export function buildBody(text, { model = 'doubao', think, conversationId = '' } = {}) {
  const cfg = resolveModel(model)
  const deepThink = think ?? cfg.think
  const reasoning = deepThink ? '3' : '1'
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
      agent_mode: cfg.key.startsWith('person-') ? 2 : 2,
      need_deep_think: deepThink ? 1 : 0,
      scene_type: 0,
      need_create_conversation: !conversationId,
      conversation_init_option: { need_ack_conversation: true },
      conversation_init_ext: { model_item_key: cfg.key, reasoning_effort: reasoning, mode_id: '1' },
      sse_recv_event_options: { support_chunk_delta: true },
      support_lazy_fetch_stream: true,
      is_old_user: true,
      recovery_option: {
        is_recovery: false,
        req_create_time_sec: Math.floor(Date.now() / 1000),
        append_sse_event_scene: 0,
      },
      model_config: { model_item_key: cfg.key, model_extra_params: {}, reasoning_effort: deepThink ? 3 : 1 },
      aggregate_params: {
        mention_skill_list: '[]',
        mention_plugin_list: '[]',
        mention_ext: '[{}]',
        conversation_mode: '1',
        mode_id: '1',
        model_item_key: cfg.key,
        agent_mode: '2',
        reasoning_effort: reasoning,
        provider_id: '',
      },
      conversation_mode: 1,
      unique_key: crypto.randomUUID(),
    },
    user_context: [],
    ext: {
      agent_mode: '2',
      use_deep_think: deepThink ? '1' : '0',
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

/** Pull the assistant text out of one SSE event. */
export function textOf(event, payload) {
  if (!payload) return ''
  if (event === 'STREAM_MSG_NOTIFY' || event === 'FULL_MSG_NOTIFY') {
    const blocks = payload?.message?.content?.content_block ?? payload?.content?.content_block ?? []
    return blocksText(blocks)
  }
  // The server sends the bulk of the answer as CHUNK_DELTA once
  // `support_chunk_delta` is on. Missing this event silently truncates every
  // reply to its first frame — verified against the live stream, where the
  // three sources below concatenate exactly to the message brief.
  if (event === 'CHUNK_DELTA') {
    return typeof payload.text === 'string' ? payload.text : ''
  }
  if (event === 'STREAM_CHUNK') {
    const ops = payload?.patch_op ?? []
    let out = ''
    for (const op of ops) {
      if (op?.patch_object === 111) continue // text-to-speech mirror of the same text
      out += blocksText(op?.patch_value?.content_block ?? [])
    }
    return out
  }
  return ''
}

function blocksText(blocks) {
  let out = ''
  for (const b of blocks ?? []) {
    const tb = b?.content?.text_block
    if (tb && typeof tb.text === 'string' && b?.block_type === 10000) out += tb.text
  }
  return out
}

export const RISK_CODES = new Set([710022002, 710022004])
export const AUTH_CODES = new Set([710012001, 710012002])

/**
 * Serialize outbound turns and keep a minimum gap between them.
 *
 * The account is shared and the risk engine reacts to bursts, not to volume: five
 * quick calls in one probe run were enough to earn a cooldown that outlasted the
 * run. So the lock spans the whole turn (request *and* stream) — releasing it
 * after the POST would let several streams overlap, which is the exact pattern
 * that trips 710022004.
 */
export class Pacer {
  constructor({ minIntervalMs = 6000, now = () => Date.now(), sleep } = {}) {
    this.minIntervalMs = minIntervalMs
    this.now = now
    this.sleep = sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)))
    this.lastAt = 0
    this.tail = Promise.resolve()
    this.cooldownUntil = 0
  }

  /** Wait until this caller is allowed to send. Call only inside `run`. */
  async wait() {
    const cooldown = this.cooldownUntil - this.now()
    if (cooldown > 0) await this.sleep(cooldown)
    const gap = this.minIntervalMs - (this.now() - this.lastAt)
    if (gap > 0) await this.sleep(gap)
    this.lastAt = this.now()
  }

  /** Run one turn exclusively; everything else queues behind it. */
  async run(fn) {
    const previous = this.tail
    let release
    this.tail = new Promise((r) => {
      release = r
    })
    await previous
    try {
      await this.wait()
      return await fn()
    } finally {
      release()
    }
  }

  /**
   * Same exclusive turn, but for work that yields as it goes.
   *
   * `run` cannot be used for this: `for await` does not await a promise before
   * looking for `Symbol.asyncIterator`, so `for await (x of run(() => gen()))`
   * throws "is not a function or its return value is not async iterable". Here the
   * generator yields through, and the lock is released only when it finishes or is
   * abandoned — which is the whole point of holding it across the stream.
   */
  async *runIterable(makeIterable) {
    const previous = this.tail
    let release
    this.tail = new Promise((r) => {
      release = r
    })
    await previous
    try {
      await this.wait()
      yield* makeIterable()
    } finally {
      release()
    }
  }

  penalize(ms) {
    this.cooldownUntil = Math.max(this.cooldownUntil, this.now() + ms)
  }

  get coolingDownMs() {
    return Math.max(0, this.cooldownUntil - this.now())
  }
}

/** Stream parsed events from the live endpoint. */
export async function* streamChat({ identity, cookies, text, model, think, conversationId, signal }) {
  const res = await fetch('https://www.doubao.com/chat/completion?' + buildQuery(identity), {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'agw-js-conv': 'str',
      Cookie: cookies,
      'User-Agent': DEFAULT_UA,
      Origin: 'https://www.doubao.com',
      Referer: 'https://www.doubao.com/chat/',
    },
    body: JSON.stringify(buildBody(text, { model, think, conversationId })),
    signal,
  })

  if (!res.ok || !res.body) {
    const detail = await res.text().catch(() => '')
    yield { type: 'error', code: res.status, message: `http ${res.status} ${detail.slice(0, 300)}` }
    return
  }

  const decoder = new TextDecoder()
  let buffer = ''
  let sawError = false
  for await (const chunk of res.body) {
    buffer += decoder.decode(chunk, { stream: true })
    // frames are separated by a blank line; keep the tail for the next read
    let cut = buffer.lastIndexOf('\n\n')
    if (cut < 0) continue
    const block = buffer.slice(0, cut + 2)
    buffer = buffer.slice(cut + 2)
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
        yield { type: 'error', code, message: payload?.error_msg ?? payload?.message ?? 'stream error', raw: payload }
        continue
      }
      if (frame.event === 'FULL_MSG_NOTIFY') {
        // full snapshot arrives before the deltas; ignore it and let STREAM_CHUNK drive
        const meta = payload?.message?.conversation_id
        if (meta) yield { type: 'meta', conversationId: meta }
        continue
      }
      if (frame.event === 'SSE_REPLY_END') {
        const endType = payload?.end_type
        yield { type: 'end', endType, brief: payload?.msg_finish_attr?.brief }
        continue
      }
      const text = textOf(frame.event, payload)
      if (text) yield { type: 'delta', text }
    }
  }
  if (!sawError) {
    // flush a trailing frame that lacked its blank-line terminator
    for (const frame of parseFrames(buffer)) {
      const text = textOf(frame.event, tryJson(frame.data))
      if (text) yield { type: 'delta', text }
    }
  }
}

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
