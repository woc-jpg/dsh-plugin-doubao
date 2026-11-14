import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import { Pacer, parseFrames, textOf, buildQuery, buildBody, resolveModel, MODELS } from '../lib/doubao.js'
import { createAdapter, toPrompt, finishReasonFor, DEFAULT_PROVIDER } from '../lib/adapter.js'
import { scanLocalStorage, toIdentity, findClientIdentity, credentialPath } from '../lib/identity.js'
import { readCredentials, writeCredentials, parseHint, credentialsPath } from '../lib/login.js'

const IDENTITY = {
  deviceId: '1708008151711915',
  fp: 'verify_1708008151711915',
  webId: '1708008151711915',
  chromiumVersion: '147.0.7727.149',
  clientVersion: '2.35.12',
}

function tempDir() {
  return mkdtempSync(join(tmpdir(), 'doubao-test-'))
}

// ---------------------------------------------------------------- prompt shaping

test('toPrompt labels each role and drops empty blocks', () => {
  const prompt = toPrompt([
    { role: 'system', content: [{ type: 'text', text: 'be brief' }] },
    { role: 'user', content: [{ type: 'text', text: 'hi' }] },
    { role: 'assistant', content: [{ type: 'text', text: 'hello' }] },
    { role: 'tool', content: [{ type: 'text', text: '42' }] },
    { role: 'user', content: [{ type: 'image', data: 'x' }] },
  ])
  assert.equal(prompt, '[System]\nbe brief\n\nhi\n\n[Assistant]\nhello\n\n[Tool result]\n42')
})

test('toPrompt survives missing content', () => {
  assert.equal(toPrompt([{ role: 'user' }]), '')
  assert.equal(toPrompt(undefined), '')
})

// ------------------------------------------------------------------ error mapping

test('finishReasonFor maps the codes the service actually returns', () => {
  assert.deepEqual(finishReasonFor(undefined), { kind: 'stop' })
  const abort = Object.assign(new Error('gone'), { name: 'AbortError' })
  assert.equal(finishReasonFor(abort).kind, 'aborted')
  assert.equal(finishReasonFor(Object.assign(new Error('rate'), { code: 710022004 })).failure.code, 'RATE_LIMIT')
  assert.equal(finishReasonFor(Object.assign(new Error('auth'), { code: 710012001 })).failure.code, 'AUTH')
  assert.equal(finishReasonFor(new Error('boom')).failure.code, 'DOUBAO_ERROR')
})

// ------------------------------------------------------------------- model catalog

test('the catalog satisfies the host model contract', async () => {
  const adapter = createAdapter({ loadCredentials: async () => undefined })
  const models = await adapter.listModels()
  assert.equal(models.length, MODELS.length)
  for (const model of models) {
    assert.equal(model.provider, DEFAULT_PROVIDER, 'provider must match the registered id')
    assert.ok(model.id && model.name, 'id and name are required')
  }
  // resolveModel is what normalizeModelInfo validates field by field
  for (const { id } of MODELS) {
    const info = await adapter.resolveModel(DEFAULT_PROVIDER, id)
    assert.equal(info.provider, DEFAULT_PROVIDER)
    assert.equal(info.id, id)
    assert.ok(Number.isInteger(info.context.contextWindow) && info.context.contextWindow > 0)
    assert.ok(Number.isInteger(info.defaultMaxTokens) && info.defaultMaxTokens > 0)
    const efforts = info.reasoning.efforts
    assert.equal(new Set(efforts.map((e) => e.id)).size, efforts.length, 'effort ids must be unique')
    assert.ok(efforts.some((e) => e.id === info.reasoning.defaultEffort), 'defaultEffort must exist')
  }
})

test('providerInfo agrees with the provider id it is asked about', () => {
  const adapter = createAdapter({ loadCredentials: async () => undefined })
  assert.equal(adapter.providerInfo(DEFAULT_PROVIDER).id, DEFAULT_PROVIDER)
  assert.ok(adapter.providerInfo(DEFAULT_PROVIDER).name.length > 0)
})

test('the retry policy refuses to retry a risk-control refusal', () => {
  const adapter = createAdapter({ loadCredentials: async () => undefined })
  const policy = adapter.providerRetryPolicy(DEFAULT_PROVIDER)
  // The host defaults to retrying RATE_LIMIT; retrying an escalation is what
  // turns a short throttle into a long one, so this must not be in the list.
  assert.ok(!policy.retryableCodes.includes('RATE_LIMIT'), 'RATE_LIMIT must not be retried')
  assert.ok(policy.retryableCodes.includes('TRANSPORT'))
  assert.ok(Number.isInteger(policy.maxRetries) && policy.maxRetries >= 0)
  // Registering validates the policy through resolveRetryPolicy, which rejects an
  // empty list, duplicates, non-positive delays, and initial > max.
  assert.ok(policy.backoff.initialDelayMs > 0)
  assert.ok(policy.backoff.initialDelayMs <= policy.backoff.maxDelayMs)
  assert.equal(new Set(policy.retryableCodes).size, policy.retryableCodes.length)
})

// --------------------------------------------------------------- streaming surface

/** A fake fetch that answers with the SSE frame sequence the service really sends. */
function fakeFetch(frames) {
  return async () => ({
    ok: true,
    body: (async function* () {
      for (const frame of frames) yield Buffer.from(frame, 'utf8')
    })(),
  })
}

test('a normal turn emits text deltas, then usage, then finish', async () => {
  const original = globalThis.fetch
  globalThis.fetch = fakeFetch([
    'event: SSE_ACK\ndata: {"ack_client_meta":{"conversation_id":"c1"}}\n\n',
    'event: STREAM_MSG_NOTIFY\ndata: {"message":{"content":{"content_block":[{"block_type":10000,"content":{"text_block":{"text":"4"}}}]}}}\n\n',
    'event: CHUNK_DELTA\ndata: {"text":"2"}\n\n',
    'event: CHUNK_DELTA\ndata: {"text":"!"}\n\n',
    'event: SSE_REPLY_END\ndata: {"end_type":1,"msg_finish_attr":{"brief":"42!"}}\n\n',
  ])
  try {
    const adapter = createAdapter({
      loadCredentials: async () => ({ cookies: 'a=b', identity: IDENTITY }),
      logger: { warn() {} },
    })
    const seen = []
    for await (const chunk of adapter.stream({
      model: 'doubao',
      messages: [{ role: 'user', content: [{ type: 'text', text: 'q' }] }],
    })) {
      seen.push(chunk)
    }
    const text = seen.filter((c) => c.type === 'text-delta').map((c) => c.text).join('')
    assert.equal(text, '42!')
    const usageAt = seen.findIndex((c) => c.type === 'usage')
    const finishAt = seen.findIndex((c) => c.type === 'finish')
    assert.ok(usageAt >= 0, 'usage must be emitted')
    assert.ok(usageAt < finishAt, 'usage must precede finish or the token meter misses the call')
    assert.equal(seen[finishAt].reason.kind, 'stop')
    const usage = seen[usageAt].usage
    assert.ok(usage.inputTokens > 0 && usage.outputTokens > 0)
    assert.equal(usage.totalTokens, usage.inputTokens + usage.outputTokens)
  } finally {
    globalThis.fetch = original
  }
})

test('the TTS mirror is not duplicated into the answer', async () => {
  const original = globalThis.fetch
  globalThis.fetch = fakeFetch([
    'event: STREAM_CHUNK\ndata: {"patch_op":[{"patch_object":1,"patch_value":{"content_block":[{"block_type":10000,"content":{"text_block":{"text":"hi"}}}]}}]}\n\n',
    'event: STREAM_CHUNK\ndata: {"patch_op":[{"patch_object":111,"patch_value":{"content_block":[{"block_type":10000,"content":{"text_block":{"text":"hi"}}}]}}]}\n\n',
    'event: SSE_REPLY_END\ndata: {"end_type":1}\n\n',
  ])
  try {
    const adapter = createAdapter({
      loadCredentials: async () => ({ cookies: 'a=b', identity: IDENTITY }),
      logger: { warn() {} },
    })
    let text = ''
    for await (const chunk of adapter.stream({ model: 'doubao', messages: [{ role: 'user', content: [] }] })) {
      if (chunk.type === 'text-delta') text += chunk.text
    }
    assert.equal(text, 'hi', 'patch_object 111 is the same text again, spoken')
  } finally {
    globalThis.fetch = original
  }
})

test('a risk-control refusal is reported as an error finish, not thrown', async () => {
  const original = globalThis.fetch
  globalThis.fetch = fakeFetch([
    'event: STREAM_ERROR\ndata: {"error_code":710022004,"error_msg":"rate limited"}\n\n',
  ])
  try {
    const penalized = []
    const pacer = new Pacer({ minIntervalMs: 0 })
    const spy = { penalize: (ms) => penalized.push(ms) }
    Object.setPrototypeOf(spy, pacer)
    const adapter = createAdapter({
      loadCredentials: async () => ({ cookies: 'a=b', identity: IDENTITY }),
      logger: { warn() {} },
      pacer: spy,
    })
    const seen = []
    for await (const chunk of adapter.stream({ model: 'doubao', messages: [{ role: 'user', content: [] }] })) {
      seen.push(chunk)
    }
    assert.equal(seen.length, 1)
    assert.equal(seen[0].type, 'finish')
    assert.equal(seen[0].reason.kind, 'error')
    assert.equal(seen[0].reason.failure.code, 'RATE_LIMIT')
    assert.deepEqual(penalized, [60_000], 'a rate limit must extend the cooldown')
  } finally {
    globalThis.fetch = original
  }
})

test('a missing credential explains how to fix it instead of failing obscurely', async () => {
  const adapter = createAdapter({ loadCredentials: async () => undefined })
  const seen = []
  for await (const chunk of adapter.stream({ model: 'doubao', messages: [{ role: 'user', content: [] }] })) {
    seen.push(chunk)
  }
  assert.equal(seen.length, 1)
  assert.equal(seen[0].reason.failure.code, 'AUTH_MISSING')
  assert.match(seen[0].reason.failure.message, /login/)
  assert.match(seen[0].reason.failure.message, /Douyin/)
})

test('a credential without a device id is treated as missing', async () => {
  const adapter = createAdapter({ loadCredentials: async () => ({ cookies: 'a=b', identity: {} }) })
  const seen = []
  for await (const chunk of adapter.stream({ model: 'doubao', messages: [{ role: 'user', content: [] }] })) {
    seen.push(chunk)
  }
  assert.equal(seen[0].reason.failure.code, 'AUTH_MISSING')
})

// ------------------------------------------------------------------------- pacer

test('the pacer keeps turns strictly serialized', async () => {
  const pacer = new Pacer({ minIntervalMs: 0 })
  const order = []
  await Promise.all([
    pacer.run(async () => {
      order.push('a-start')
      await new Promise((r) => setTimeout(r, 20))
      order.push('a-end')
    }),
    pacer.run(async () => {
      order.push('b-start')
      order.push('b-end')
    }),
  ])
  assert.deepEqual(order, ['a-start', 'a-end', 'b-start', 'b-end'])
})

test('the pacer holds the lock across a whole stream', async () => {
  const pacer = new Pacer({ minIntervalMs: 0 })
  const order = []
  async function* slow() {
    order.push('stream-start')
    await new Promise((r) => setTimeout(r, 20))
    order.push('stream-end')
  }
  await Promise.all([
    (async () => {
      for await (const _ of pacer.runIterable(slow)) void _
    })(),
    pacer.run(async () => order.push('second')),
  ])
  assert.deepEqual(order, ['stream-start', 'stream-end', 'second'])
})

test('an abandoned stream still releases the lock', async () => {
  const pacer = new Pacer({ minIntervalMs: 0 })
  async function* endless() {
    for (;;) yield 'x'
  }
  for await (const _ of pacer.runIterable(endless)) {
    void _
    break
  }
  await pacer.run(async () => {})
})

test('the pacer honours the minimum gap and the cooldown', async () => {
  let clock = 0
  const waited = []
  const pacer = new Pacer({ minIntervalMs: 6000, now: () => clock, sleep: async (ms) => { waited.push(ms); clock += ms } })
  await pacer.run(async () => {})
  await pacer.run(async () => {})
  assert.ok(waited.includes(6000), `expected a 6000ms gap, saw ${JSON.stringify(waited)}`)
  pacer.penalize(30_000)
  assert.ok(pacer.coolingDownMs > 0)
  waited.length = 0
  await pacer.run(async () => {})
  assert.ok(waited[0] >= 30_000, 'the cooldown must be waited out first')
})

// --------------------------------------------------------------------- framing

test('parseFrames splits on blank lines and keeps multi-line data', () => {
  const frames = [...parseFrames('event: A\ndata: {"a":1}\n\nevent: B\ndata: l1\ndata: l2\n\n')]
  assert.equal(frames.length, 2)
  assert.deepEqual(frames[0], { event: 'A', data: '{"a":1}' })
  assert.deepEqual(frames[1], { event: 'B', data: 'l1\nl2' })
})

test('textOf reads the stringified content FULL_MSG_NOTIFY carries', () => {
  const payload = {
    message: { content: { content_block: [{ block_type: 10000, content: { text_block: { text: 'hello' } } }] } },
  }
  assert.equal(textOf('FULL_MSG_NOTIFY', payload), 'hello')
  assert.equal(textOf('CHUNK_DELTA', { text: 'part' }), 'part')
  assert.equal(textOf('SSE_HEARTBEAT', {}), '')
  assert.equal(textOf('CHUNK_DELTA', { text: 42 }), '')
})

// -------------------------------------------------------------------- wire shape

test('buildQuery carries the identity pair the risk engine checks', () => {
  const query = new URLSearchParams(buildQuery(IDENTITY))
  assert.equal(query.get('device_id'), IDENTITY.deviceId)
  assert.equal(query.get('fp'), `verify_${IDENTITY.deviceId}`)
  assert.equal(query.get('tea_uuid'), IDENTITY.deviceId)
  assert.equal(query.get('aid'), '582478')
})

test('buildBody selects the model by key, and only person-* models use agent_mode 2', () => {
  const normal = buildBody('hi', { model: 'doubao' })
  assert.equal(normal.option.model_config.model_item_key, '0')
  assert.equal(normal.option.need_deep_think, 0)
  const person = buildBody('hi', { model: 'glm-5.3' })
  assert.equal(person.option.model_config.model_item_key, 'person-glm-5-3-261111')
  assert.equal(resolveModel('nope').id, 'doubao', 'unknown ids fall back rather than crash')
})

// ---------------------------------------------------------------------- identity

/** Write a leveldb-shaped file: the key, then the value, back to back. */
function fakeLeveldb(dir, records) {
  mkdirSync(dir, { recursive: true })
  const parts = []
  for (const [key, value] of Object.entries(records)) {
    parts.push(Buffer.from(key, 'latin1'))
    parts.push(Buffer.from(typeof value === 'string' ? value : JSON.stringify(value), 'utf8'))
  }
  writeFileSync(join(dir, '000515.log'), Buffer.concat(parts))
}

test('the device id is recovered from the leveldb the client keeps', () => {
  const dir = tempDir()
  try {
    fakeLeveldb(dir, {
      client_device_info: {
        deviceId: '1708008151711915',
        deviceIdCustom: '1708008151711915',
        chromiumVersion: '147.0.7727.149',
        clientVersion: '2.35.12',
      },
      __tea_cache_tokens_582478: { web_id: '7683145566511203880' },
      s_v_web_id: 'verify_mtso4zbn_x',
    })
    const info = scanLocalStorage(dir)
    assert.equal(info.deviceId, '1708008151711915')
    assert.equal(info.webId, '7683145566511203880')
    assert.equal(info.legacyFp, 'verify_mtso4zbn_x')
    const identity = toIdentity(info)
    assert.equal(identity.fp, 'verify_1708008151711915', 'fp is verify_ + device id, not the cookie')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('a device id embedded in a longer record still parses', () => {
  const dir = tempDir()
  try {
    // leveldb appends records back to back; the object must not swallow the next one
    fakeLeveldb(dir, {
      client_device_info: { deviceId: '1708008151711915', nested: { a: [1, 2, { b: '}' }] } },
      unrelated_key: 'other',
    })
    assert.equal(scanLocalStorage(dir).deviceId, '1708008151711915')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('findClientIdentity reports every place it looked when nothing is found', () => {
  const env = { LOCALAPPDATA: 'Z:/definitely/not/here', APPDATA: 'Z:/nope' }
  const result = findClientIdentity(env)
  assert.equal(result.found, false)
  assert.ok(result.tried.length > 0, 'the failure must say where it looked')
})

// ------------------------------------------------------------------ credentials

test('credentials round-trip through the store, BOM and all', () => {
  const home = tempDir()
  try {
    const env = { DSH_HOME: home }
    assert.equal(readCredentials(env), undefined, 'nothing stored yet')
    const path = writeCredentials({ cookies: 'sessionid=abc', identity: IDENTITY, account: 'someone' }, env)
    assert.equal(path, credentialPath(env))
    // PowerShell-written files carry a BOM; reading must survive it
    writeFileSync(path, '\uFEFF' + readFileSync(path, 'utf8'))
    const back = readCredentials(env)
    assert.equal(back.cookies, 'sessionid=abc')
    assert.equal(back.identity.deviceId, IDENTITY.deviceId)
    assert.equal(back.account, 'someone')
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('an incomplete credential is rejected rather than half-used', () => {
  const home = tempDir()
  try {
    const env = { DSH_HOME: home }
    const path = credentialsPath(env)
    mkdirSync(join(home, 'doubao-local'), { recursive: true })
    writeFileSync(path, JSON.stringify({ cookies: 'a=b' }))
    assert.equal(readCredentials(env), undefined, 'no device id means the cookie is useless')
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('parseHint cleans the emphasis markup out of the server copy', () => {
  const hint = parseHint('{"desc":"请使用[color=red]「抖音 APP」[/]扫码验证"}')
  assert.equal(hint, '请使用「抖音 APP」扫码验证')
  assert.equal(parseHint('not json'), undefined)
})
