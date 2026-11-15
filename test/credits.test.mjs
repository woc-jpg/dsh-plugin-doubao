/**
 * The remaining-credit readout, in two halves: the upstream parse and the route
 * that carries it across to the browser.
 *
 * The fixture is a real answer from `/alice/commerce/sale/subscription/quota/summary/`,
 * trimmed to the fields the readout uses — amounts are thousand-separated
 * strings there, which is the whole reason `amountOf` exists.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

const { amountOf, creditsFromSummary, formatAmount } = await import('../lib/credits.js')
const { registerCreditsRoute, CREDITS_PATH } = await import('../lib/index.js')

/** The shape the endpoint returns, with the interesting numbers intact. */
function summaryPayload(overrides = {}) {
  return {
    data: {
      current_subscription: {
        sku_key: 'doubao_personal_std',
        display: { product_name: '个人订阅', short_name: '免费体验' },
        end_time: 1799239779799,
        status: 3,
      },
      incentive_quota_section: {
        window_limit_groups: [
          {
            feature_group: 'doubao_activity_reward_quota',
            feature_group_name: '活动赠送额度',
            window_limits: [{ total_amount: '1,200', used_amount: '407', used_percent: 33, end_time: 1795423082587 }],
          },
        ],
      },
      window_limit_section: {
        window_limit_groups: [
          {
            feature_group: 'monthly_quota',
            feature_group_name: '',
            window_limits: [{ total_amount: '9,000', used_amount: '0', used_percent: 0, end_time: 1796734179799 }],
          },
        ],
      },
      ...overrides,
    },
  }
}

test('amountOf reads the thousand-separated spelling and refuses the rest', () => {
  assert.equal(amountOf('1,200'), 1200)
  assert.equal(amountOf('9,000'), 9000)
  assert.equal(amountOf('0'), 0)
  assert.equal(amountOf(12), 12)
  assert.equal(amountOf('abc'), undefined)
  assert.equal(amountOf(undefined), undefined)
  assert.equal(amountOf(null), undefined)
})

test('creditsFromSummary turns quota windows into remaining credit', () => {
  const credits = creditsFromSummary(summaryPayload())
  assert.equal(credits.limit, 10200)
  assert.equal(credits.used, 407)
  assert.equal(credits.remaining, 9793)
  assert.equal(credits.plan, '免费体验')
  assert.deepEqual(
    credits.groups.map((g) => [g.key, g.remaining, g.limit]),
    [
      ['doubao_activity_reward_quota', 793, 1200],
      ['monthly_quota', 9000, 9000],
    ],
  )
})

test('a group with no upstream label still gets a readable name', () => {
  const credits = creditsFromSummary(summaryPayload())
  // monthly_quota ships feature_group_name: '' — the dictionary fills it in
  assert.equal(credits.groups[1].label, '月度额度')
  assert.equal(credits.groups[0].label, '活动赠送额度')
})

test('over-used allowance clamps at zero instead of printing a negative balance', () => {
  const payload = summaryPayload({
    incentive_quota_section: {
      window_limit_groups: [
        {
          feature_group: 'doubao_activity_reward_quota',
          feature_group_name: '活动赠送额度',
          window_limits: [{ total_amount: '100', used_amount: '150', used_percent: 100 }],
        },
      ],
    },
    window_limit_section: { window_limit_groups: [] },
  })
  const credits = creditsFromSummary(payload)
  assert.equal(credits.remaining, 0)
  assert.equal(credits.groups[0].used, 150)
})

test('an unrecognised payload yields undefined, not an empty balance', () => {
  assert.equal(creditsFromSummary({}), undefined)
  assert.equal(creditsFromSummary({ data: {} }), undefined)
  assert.equal(creditsFromSummary({ data: { status: 'ok' } }), undefined)
})

test('formatAmount prints the client spelling and an em dash when unknown', () => {
  assert.equal(formatAmount(9793), '9,793')
  assert.equal(formatAmount(0), '0')
  assert.equal(formatAmount(undefined), '—')
  assert.equal(formatAmount(Number.NaN), '—')
})

/**
 * A fake webServer that records the registered route and lets a test drive it.
 */
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

/** A minimal `req`/`res` pair, with the socket local address a real request has. */
function exchange({ method = 'GET', host = '127.0.0.1:59210', origin, localAddress = '127.0.0.1' } = {}) {
  const headers = { ...(host === undefined ? {} : { host }), ...(origin === undefined ? {} : { origin }) }
  const chunks = []
  let status
  const res = {
    writeHead: (code) => {
      status = code
    },
    end: (payload) => chunks.push(payload ?? ''),
  }
  return { req: { method, headers, socket: { localAddress } }, res, result: () => ({ status, body: chunks.join('') }) }
}

function mount(read) {
  const { ctx, routes, effects } = fakeWebServer()
  registerCreditsRoute(ctx, read, undefined)
  for (const effect of effects) effect()
  return { route: routes.get(CREDITS_PATH), routes }
}

test('the credits route answers on the documented path only', async () => {
  const { route, routes } = mount(async () => ({ remaining: 9793 }))
  assert.ok(route, `register should have used ${CREDITS_PATH}`)
  assert.equal(routes.size, 1)
})

test('the credits route returns the balance the reader produced', async () => {
  const { route } = mount(async () => ({ remaining: 9793, limit: 10200, groups: [] }))
  const { req, res, result } = exchange()
  await route.handler(req, res)
  const { status, body } = result()
  assert.equal(status, 200)
  assert.equal(JSON.parse(body).credits.remaining, 9793)
})

test('an unreadable balance is null, never zero', async () => {
  const { route } = mount(async () => undefined)
  const { req, res, result } = exchange()
  await route.handler(req, res)
  const { status, body } = result()
  assert.equal(status, 200)
  assert.equal(JSON.parse(body).credits, null)
})

test('a throwing reader still answers, with null and a reason', async () => {
  const { route } = mount(async () => {
    throw new Error('upstream exploded')
  })
  const { req, res, result } = exchange()
  await route.handler(req, res)
  const { status, body } = result()
  assert.equal(status, 200)
  assert.equal(JSON.parse(body).credits, null)
  assert.equal(JSON.parse(body).error, 'read-failed')
})

test('the credits route is loopback-only and GET-only', async () => {
  const { route } = mount(async () => ({ remaining: 1 }))

  const posted = exchange({ method: 'POST' })
  await route.handler(posted.req, posted.res)
  assert.equal(posted.result().status, 405)

  const foreignHost = exchange({ host: 'evil.example.com' })
  await route.handler(foreignHost.req, foreignHost.res)
  assert.equal(foreignHost.result().status, 403)
  assert.equal(JSON.parse(foreignHost.result().body).error, 'host-not-trusted')

  const foreignOrigin = exchange({ origin: 'https://evil.example.com' })
  await route.handler(foreignOrigin.req, foreignOrigin.res)
  assert.equal(foreignOrigin.result().status, 403)
  assert.equal(JSON.parse(foreignOrigin.result().body).error, 'origin-not-trusted')

  // the same local answers still pass: this is the plugin's own fetch shape
  const local = exchange({ origin: 'http://127.0.0.1:59210' })
  await route.handler(local.req, local.res)
  assert.equal(local.result().status, 200)
})

test('a missing Origin passes — that is what a non-browser client looks like', async () => {
  const { route } = mount(async () => ({ remaining: 1 }))
  const { req, res, result } = exchange({ origin: undefined })
  await route.handler(req, res)
  assert.equal(result().status, 200)
})

test('disposing the fiber removes the route', async () => {
  const { ctx, routes } = fakeWebServer()
  const registered = []
  ctx.effect = (fn) => {
    // cordis hands the effect body a disposer it must return; capture it here
    registered.push(fn())
  }
  registerCreditsRoute(ctx, async () => ({ remaining: 1 }), undefined)
  assert.ok(routes.has(CREDITS_PATH))
  for (const dispose of registered) dispose()
  assert.equal(routes.has(CREDITS_PATH), false)
})
