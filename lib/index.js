/**
 * Doubao provider for DSH.
 *
 * The plugin talks to doubao.com with the account's own session and registers
 * itself as an LLM provider.
 *
 * Two credentials are required, and they come from different places:
 *   - the session cookie, from a QR scan with the Douyin app (see lib/login.js)
 *   - the device id, from the installed client's leveldb (see lib/identity.js)
 * A freshly minted device id is rejected with 710022004, which is why the second
 * half cannot be fabricated.
 *
 * There is also a third thing, discovered the hard way: the service wants an
 * `a_bogus`/`msToken` pair that only the client can mint. While the account is
 * in good standing an unsigned request goes through anyway, which is why this
 * plugin shipped without it; once the semantic risk model takes an interest,
 * every unsigned request is refused regardless of payload shape. So when the
 * client happens to be running, requests are routed through its page over the
 * debugger bridge (lib/bridge.js) and its own hook signs them. When it is not
 * running, the plugin falls back to a plain request — the only option there,
 * since nothing could sign it.
 */
import { join } from 'node:path'
import { homedir } from 'node:os'
import { createAdapter, DEFAULT_PROVIDER } from './adapter.js'
import { readCredentials, runLoginServer, credentialsPath } from './login.js'
import { findClientIdentity, toIdentity } from './identity.js'
import { Pacer } from './doubao.js'
import { fetchCredits } from './credits.js'

export const name = 'doubao'
export const inject = ['llm']

/** Where the composer's readout asks for the balance. */
export const CREDITS_PATH = '/plugins/dsh-plugin-doubao/credits'

const DEFAULTS = {
  providerId: DEFAULT_PROVIDER,
  displayName: 'Doubao',
  // The pacer exists to keep bursts off the account, and it holds its lock for
  // the whole turn (request *and* stream), so this number is also the floor
  // between two consecutive questions. Measured on the live account: at 6000 a
  // follow-up turn started 2.6s later than at 0 with no risk-control difference,
  // because a turn already takes ~3.5s to first token on its own. 1500 keeps a
  // gap without making every message wait for the previous one to age out; the
  // 710022004 cooldown below is the real protection and stays intact.
  minIntervalMs: 1500,
  credentialsPath: join(process.env.DSH_HOME ?? join(homedir(), '.dsh'), 'doubao-local', 'credentials.json'),
  loginPort: 8899,
  // The client's DevTools port. Only used when the client is already running:
  // its page signs requests this plugin cannot sign itself (see lib/bridge.js).
  bridgePort: 9222,
}

export function resolveConfig(config = {}) {
  return {
    providerId: config.providerId ?? DEFAULTS.providerId,
    displayName: config.displayName ?? DEFAULTS.displayName,
    minIntervalMs: config.minIntervalMs ?? DEFAULTS.minIntervalMs,
    credentialsPath: config.credentialsPath ?? process.env.DOUBAO_CREDENTIALS ?? DEFAULTS.credentialsPath,
    loginPort: config.loginPort ?? DEFAULTS.loginPort,
    bridgePort: config.bridgePort ?? DEFAULTS.bridgePort,
  }
}

/**
 * Load what a chat call needs, preferring what login stored.
 *
 * The device id is re-read from the client on every call rather than trusted from
 * the saved file: a client reinstall changes it, and a stale id fails as
 * 710022004 — indistinguishable from a rate limit, and much harder to diagnose.
 */
export function createCredentialLoader(settings, logger) {
  return async function loadCredentials() {
    const store = { DSH_HOME: process.env.DSH_HOME }
    const saved = readCredentials(store)
    if (!saved) return undefined
    const found = findClientIdentity(store)
    const identity = found.found ? toIdentity(found.info) : saved.identity
    if (found.found && saved.identity?.deviceId && saved.identity.deviceId !== identity.deviceId) {
      logger?.warn?.(
        `doubao: the client's device id (${identity.deviceId}) differs from the stored one ` +
          `(${saved.identity.deviceId}); using the client's, which is the one the account trusts`,
      )
    }
    return { cookies: saved.cookies, identity, account: saved.account }
  }
}

/**
 * Whether a request may read the balance.
 *
 * The route answers with the account's remaining credit, so it is loopback-only
 * in both directions: the `Host` must name this listener (a page that resolves
 * `localhost` to a foreign address cannot ride the browser's trust of it) and a
 * present `Origin` must be local too. An ABSENT `Origin` passes — that is what
 * the plugin's own fetch and a test client look like.
 */
function hostIsLocal(host, localAddress) {
  if (typeof host !== 'string' || host.trim() === '') return false
  const bracket = host.startsWith('[') ? host.indexOf(']') : -1
  const bare = (bracket !== -1 ? host.slice(1, bracket) : host.split(':')[0]).trim().toLowerCase()
  if (bare === 'localhost' || bare === '::1' || bare === '127.0.0.1') return true
  if (bare === '0.0.0.0' || bare === '::') return false
  return typeof localAddress === 'string' && bare === localAddress.trim().toLowerCase()
}

function originIsLocal(origin, localAddress) {
  if (typeof origin !== 'string' || origin.trim() === '') return true
  try {
    return hostIsLocal(new URL(origin).host, localAddress)
  } catch {
    return false
  }
}

function sendJson(res, status, body, extraHeaders = {}) {
  const payload = JSON.stringify(body)
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(payload),
    ...extraHeaders,
  })
  res.end(payload)
}

/**
 * Mount `GET /plugins/dsh-plugin-doubao/credits`.
 *
 * Registered through `ctx.effect` so the route is removed with the fiber — a
 * disposed plugin must not leave a URL answering with a credential it no longer
 * owns.
 */
export function registerCreditsRoute(webCtx, read, logger) {
  webCtx.effect(() => {
    const dispose = webCtx.webServer.register({
      kind: 'exact',
      path: CREDITS_PATH,
      handler: async (req, res) => {
        if (req.method !== 'GET') {
          sendJson(res, 405, { error: 'method not allowed' })
          return
        }
        const localAddress = req.socket?.localAddress
        if (!hostIsLocal(req.headers.host, localAddress)) {
          sendJson(res, 403, { error: 'host-not-trusted' })
          return
        }
        if (!originIsLocal(req.headers.origin, localAddress)) {
          sendJson(res, 403, { error: 'origin-not-trusted' })
          return
        }
        try {
          const credits = await read()
          // `credits: null` means "could not read it right now"; the readout
          // draws an em dash. A missing key would read as zero instead.
          sendJson(res, 200, { credits: credits ?? null }, { 'Cache-Control': 'no-store' })
        } catch (error) {
          logger?.warn?.(`doubao: credit readout failed (${error?.message ?? error})`)
          sendJson(res, 200, { credits: null, error: 'read-failed' }, { 'Cache-Control': 'no-store' })
        }
      },
    })
    return () => dispose()
  })
}

export async function apply(ctx, config = {}) {
  const settings = resolveConfig(config)
  const logger = ctx.logger ?? console

  const loadCredentials = createCredentialLoader(settings, logger)
  const pacer = new Pacer({ minIntervalMs: settings.minIntervalMs })
  const adapter = createAdapter({
    loadCredentials,
    logger,
    pacer,
    providerId: settings.providerId,
    bridgePort: settings.bridgePort,
  })

  const existing = ctx.llm?.listProviders?.() ?? []
  if (existing.some((p) => p.id === settings.providerId)) {
    logger.warn?.(
      `doubao: provider "${settings.providerId}" is already registered by another plugin; ` +
        `set providerId in this plugin's config to something else (the adapter would be rejected as DUPLICATE_ADAPTER)`,
    )
  }

  // registerAdapter wires its own ctx.effect, so the route disappears with the
  // plugin fiber — no manual disposer, and no chance of leaking a stale provider.
  ctx.llm.registerAdapter([settings.providerId], adapter)

  // The remaining-credit readout the composer shows. One upstream read per
  // request: the number changes with every turn, so caching it inside the host
  // would only serve a stale balance to the very panel that exists to be current.
  const credits = async () => {
    const credential = await loadCredentials()
    if (!credential) return undefined
    return fetchCredits({ identity: credential.identity, cookies: credential.cookies, logger })
  }
  ctx.provide?.('doubaoCredits', { read: credits })

  // The composer's readout is a browser component, so the balance has to cross
  // the host's HTTP surface. `ctx.inject` (not a direct `ctx.webServer` touch)
  // keeps the route alive regardless of whether webServer was up at plugin start.
  ctx.inject?.(['webServer'], (webCtx) => registerCreditsRoute(webCtx, credits, logger))

  const saved = readCredentials({ DSH_HOME: process.env.DSH_HOME })
  if (!saved) {
    logger.log?.(
      `doubao: not signed in yet — run \`npx dsh-plugin-doubao login\` and scan the QR with the Douyin app. ` +
        `Credentials will be written to ${settings.credentialsPath}`,
    )
  } else {
    const found = findClientIdentity({ DSH_HOME: process.env.DSH_HOME })
    logger.log?.(
      found.found
        ? `doubao: provider "${settings.providerId}" ready (device ${toIdentity(found.info).deviceId})`
        : `doubao: signed in, but no Doubao desktop client identity was found — calls will be refused until ` +
            `the client is installed and has signed in once`,
    )
  }

  // A tool so the URL is reachable from inside a session, where the user may be
  // running DSH without a terminal in front of them.
  let login

  async function ensureLoginUrl() {
    if (login) return login.url
    login = await runLoginServer({
      port: settings.loginPort,
      logger,
      onCredentials() {
        logger.log?.('doubao: sign-in complete; the provider is ready to use')
      },
    })
    return login.url
  }

  ctx.provide?.('doubao', {
    async status() {
      const store = { DSH_HOME: process.env.DSH_HOME }
      const credential = readCredentials(store)
      const found = findClientIdentity(store)
      return {
        providerId: settings.providerId,
        signedIn: Boolean(credential?.cookies),
        credentialsPath: credentialsPath(store),
        account: credential?.account,
        deviceId: found.found ? toIdentity(found.info).deviceId : credential?.identity?.deviceId,
        deviceSource: found.found ? 'client' : credential ? 'stored' : 'none',
        cooldownMs: pacer.coolingDownMs,
        loginUrl: login?.url,
      }
    },
    async login() {
      return ensureLoginUrl()
    },
  })

}

export { createAdapter, readCredentials }
