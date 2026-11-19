/**
 * The in-DSH sign-in panel talks to three loopback JSON routes. These tests
 * drive them with a fake webServer, reusing the fixture shape from
 * credits.test.mjs: the route must be bound to the documented path, must carry
 * the values the host functions produced, must reject foreign origins, and
 * must disappear when the fiber is disposed.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

const { registerLoginRoutes, STATUS_PATH, LOGIN_STATE_PATH, LOGIN_START_PATH } = await import('../lib/index.js')

function fakeWebServer() {
  const routes = new Map()
  const effects = []
  const ctx = {
    effect: (fn) => {
      effects.push(fn)
    },
    webServer: {
      register: (route) => {
        routes.set(route.path, route)
        return () => routes.delete(route.path)
      },
    },
  }
  return { ctx, routes, effects }
}

/** req doubles as an async iterable so the POST body reader works. */
function exchange({
  method = 'GET',
  host = '127.0.0.1:59210',
  origin,
  localAddress = '127.0.0.1',
  body,
} = {}) {
  const headers = { ...(host === undefined ? {} : { host }), ...(origin === undefined ? {} : { origin }) }
  const chunks = []
  let status
  let resHeaders
  const res = {
    writeHead: (code, headers = {}) => {
      status = code
      resHeaders = headers
    },
    end: (payload) => chunks.push(payload ?? ''),
  }
  const raw = body === undefined ? '' : typeof body === 'string' ? body : JSON.stringify(body)
  const req = {
    method,
    headers,
    socket: { localAddress },
    async *[Symbol.asyncIterator]() {
      if (raw) yield Buffer.from(raw)
    },
  }
  return {
    req,
    res,
    result: () => ({ status, headers: resHeaders ?? {}, body: chunks.join('') }),
  }
}

function mount({ status = async () => ({}), state = () => ({}), start = async () => ({}) } = {}) {
  const { ctx, routes, effects } = fakeWebServer()
  registerLoginRoutes(ctx, { status, state, start })
  for (const effect of effects) effect()
  return { routes, effects }
}

test('all three sign-in routes mount on their documented paths', () => {
  const { routes } = mount()
  assert.equal(routes.size, 3)
  for (const path of [STATUS_PATH, LOGIN_STATE_PATH, LOGIN_START_PATH]) {
    assert.ok(routes.get(path), `missing route ${path}`)
    assert.equal(routes.get(path).kind, 'exact')
  }
})

test('GET status returns the host status payload, no-store', async () => {
  const payload = { signedIn: true, deviceId: '1708008151711915', deviceSource: 'desktop-client' }
  const { routes } = mount({ status: async () => payload })
  const { req, res, result } = exchange()
  await routes.get(STATUS_PATH).handler(req, res)
  const out = result()
  assert.equal(out.status, 200)
  assert.deepEqual(JSON.parse(out.body), payload)
  assert.equal(out.headers['Cache-Control'], 'no-store')
})

test('a throwing status reader answers signedIn:false rather than hanging the panel', async () => {
  const { routes } = mount({ status: async () => { throw new Error('boom') } })
  const { req, res, result } = exchange()
  await routes.get(STATUS_PATH).handler(req, res)
  const out = JSON.parse(result().body)
  assert.equal(out.signedIn, false)
  assert.equal(out.error, 'read-failed')
})

test('GET login-state returns the live QR state for the modal to poll', async () => {
  const payload = { status: 'new', png: 'iVBORw0KGgo=', at: 123, hint: '', verdict: '' }
  const { routes } = mount({ state: () => payload })
  const { req, res, result } = exchange()
  await routes.get(LOGIN_STATE_PATH).handler(req, res)
  assert.equal(JSON.parse(result().body).png, 'iVBORw0KGgo=')
})

test('POST login-start forwards force:true and returns the new login url', async () => {
  let seen
  const { routes } = mount({
    start: async (opts) => {
      seen = opts
      return { started: true, url: 'http://127.0.0.1:8899/login' }
    },
  })
  const { req, res, result } = exchange({ method: 'POST', body: { force: true } })
  await routes.get(LOGIN_START_PATH).handler(req, res)
  assert.deepEqual(seen, { force: true })
  assert.equal(JSON.parse(result().body).started, true)
})

test('POST login-start defaults force to false on an empty body', async () => {
  let seen
  const { routes } = mount({ start: async (opts) => { seen = opts; return { started: false } } })
  const { req, res } = exchange({ method: 'POST' })
  await routes.get(LOGIN_START_PATH).handler(req, res)
  assert.deepEqual(seen, { force: false })
})

test('methods are enforced per route', async () => {
  const { routes } = mount()
  for (const [path, wrongMethod] of [
    [STATUS_PATH, 'POST'],
    [LOGIN_STATE_PATH, 'POST'],
    [LOGIN_START_PATH, 'GET'],
  ]) {
    const { req, res, result } = exchange({ method: wrongMethod })
    await routes.get(path).handler(req, res)
    assert.equal(result().status, 405, `${path} should reject ${wrongMethod}`)
  }
})

test('all three routes reject a foreign host and a foreign origin', async () => {
  const { routes } = mount()
  for (const [path, method] of [
    [STATUS_PATH, 'GET'],
    [LOGIN_STATE_PATH, 'GET'],
    [LOGIN_START_PATH, 'POST'],
  ]) {
    for (const opts of [{ host: 'evil.example.com' }, { origin: 'https://evil.example.com' }]) {
      const { req, res, result } = exchange({ method, ...opts })
      await routes.get(path).handler(req, res)
      assert.equal(result().status, 403, `${path} should reject ${JSON.stringify(opts)}`)
      assert.equal(JSON.parse(result().body).error, 'host-or-origin-not-trusted')
    }
  }
})

test('disposing the fiber removes every sign-in route', () => {
  const { routes, effects } = mount()
  assert.equal(routes.size, 3)
  for (const effect of effects) {
    const dispose = effect()
    dispose()
  }
  assert.equal(routes.size, 0)
})
