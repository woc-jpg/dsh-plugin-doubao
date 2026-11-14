/**
 * Apply-level test: does the plugin actually wire itself into a cordis context?
 *
 * The harness exposes `llm`, `effect` and `provide` through its context, but the
 * real ones are awkward to instantiate in a test, so this fakes exactly those and
 * asserts on what the plugin does with them.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const { apply, resolveConfig } = await import('../lib/index.js')

function fakeContext({ providers = [], DSH_HOME } = {}) {
  const registered = []
  const effects = []
  const provided = new Map()
  const logs = []
  const previous = process.env.DSH_HOME
  if (DSH_HOME) process.env.DSH_HOME = DSH_HOME
  const restore = () => {
    if (previous === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previous
  }
  const ctx = {
    logger: {
      log: (m) => logs.push(String(m)),
      warn: (m) => logs.push(`WARN ${m}`),
      error: (m) => logs.push(`ERROR ${m}`),
    },
    llm: {
      listProviders: () => providers,
      registerAdapter: (ids, adapter) => {
        registered.push({ ids, adapter })
      },
    },
    effect: (fn) => {
      effects.push(fn)
    },
    provide: (key, value) => provided.set(key, value),
  }
  return { ctx, registered, effects, provided, logs, restore }
}

test('apply registers exactly one provider with a valid adapter', async () => {
  const home = mkdtempSync(join(tmpdir(), 'doubao-apply-'))
  const { ctx, registered, provided, restore } = fakeContext({ DSH_HOME: home })
  try {
    await apply(ctx, {})
    assert.equal(registered.length, 1)
    const [{ ids, adapter }] = registered
    assert.deepEqual(ids, ['doubao'])
    // the host rejects an adapter whose providerInfo disagrees with the id
    for (const id of ids) {
      assert.equal(adapter.providerInfo(id).id, id)
      assert.ok(adapter.providerInfo(id).name)
    }
    assert.ok(provided.has('doubao'), 'the service must exist even before sign-in')
    const status = await provided.get('doubao').status()
    assert.equal(status.providerId, 'doubao')
    assert.equal(status.signedIn, false)
    assert.ok(status.deviceId, 'this machine has the client installed, so an id should be found')
  } finally {
    restore()
    rmSync(home, { recursive: true, force: true })
  }
})

test('apply never mounts a tool that would need the tools service', async () => {
  // inject is ['llm'] only; a tools dependency would make the plugin fail to
  // activate in a headless context.
  const mod = await import('../lib/index.js')
  assert.deepEqual(mod.inject, ['llm'])
})

test('a provider id collision is reported, not crashed on', async () => {
  const home = mkdtempSync(join(tmpdir(), 'doubao-apply-'))
  const { ctx, logs, restore } = fakeContext({ providers: [{ id: 'doubao', name: 'Other' }], DSH_HOME: home })
  try {
    await apply(ctx, {})
    assert.ok(logs.some((l) => l.includes('already registered')), `saw: ${logs.join(' | ')}`)
  } finally {
    restore()
    rmSync(home, { recursive: true, force: true })
  }
})

test('the provider id is configurable, and config reaches the adapter', async () => {
  const home = mkdtempSync(join(tmpdir(), 'doubao-apply-'))
  const { ctx, registered, provided, restore } = fakeContext({ DSH_HOME: home })
  try {
    await apply(ctx, { providerId: 'doubao-work', displayName: 'Work Doubao' })
    assert.deepEqual(registered[0].ids, ['doubao-work'])
    const models = await registered[0].adapter.listModels()
    assert.ok(models.every((m) => m.provider === 'doubao-work'))
    assert.equal((await provided.get('doubao').status()).providerId, 'doubao-work')
  } finally {
    restore()
    rmSync(home, { recursive: true, force: true })
  }
})

test('resolveConfig falls through to defaults and honours overrides', () => {
  const defaults = resolveConfig({})
  assert.equal(defaults.providerId, 'doubao')
  assert.equal(defaults.minIntervalMs, 6000)
  assert.ok(defaults.credentialsPath.endsWith('credentials.json'))
  const custom = resolveConfig({ providerId: 'x', minIntervalMs: 1, credentialsPath: 'C:/c.json', loginPort: 1234 })
  assert.deepEqual(
    {
      providerId: custom.providerId,
      minIntervalMs: custom.minIntervalMs,
      credentialsPath: custom.credentialsPath,
      loginPort: custom.loginPort,
    },
    { providerId: 'x', minIntervalMs: 1, credentialsPath: 'C:/c.json', loginPort: 1234 },
  )
})

test('without a credential the status says so and names the fix', async () => {
  const home = mkdtempSync(join(tmpdir(), 'doubao-apply-'))
  const { ctx, provided, logs, restore } = fakeContext({ DSH_HOME: home })
  try {
    await apply(ctx, {})
    const status = await provided.get('doubao').status()
    assert.equal(status.signedIn, false)
    assert.ok(logs.some((l) => l.includes('not signed in')), `saw: ${logs.join(' | ')}`)
    assert.ok(logs.some((l) => l.includes('Douyin')), 'the banner should say which app to scan with')
  } finally {
    restore()
    rmSync(home, { recursive: true, force: true })
  }
})
