/**
 * Doubao provider for DSH.
 *
 * The plugin is self-contained: it talks to doubao.com over plain HTTP with the
 * account's session, and registers itself as an LLM provider. It deliberately
 * does not launch the Doubao desktop client — the client is only ever *read*
 * (its Local Storage carries the device id the account already trusts) and never
 * started, stopped or driven.
 *
 * Two credentials are required, and they come from different places:
 *   - the session cookie, from a QR scan with the Douyin app (see lib/login.js)
 *   - the device id, from the installed client's leveldb (see lib/identity.js)
 * A freshly minted device id is rejected with 710022004, which is why the second
 * half cannot be fabricated.
 */
import { join } from 'node:path'
import { homedir } from 'node:os'
import { createAdapter, DEFAULT_PROVIDER } from './adapter.js'
import { readCredentials, runLoginServer, credentialsPath } from './login.js'
import { findClientIdentity, toIdentity } from './identity.js'
import { Pacer } from './doubao.js'

export const name = 'doubao'
export const inject = ['llm']

const DEFAULTS = {
  providerId: DEFAULT_PROVIDER,
  displayName: 'Doubao',
  minIntervalMs: 6000,
  credentialsPath: join(process.env.DSH_HOME ?? join(homedir(), '.dsh'), 'doubao-local', 'credentials.json'),
  loginPort: 8899,
}

export function resolveConfig(config = {}) {
  return {
    providerId: config.providerId ?? DEFAULTS.providerId,
    displayName: config.displayName ?? DEFAULTS.displayName,
    minIntervalMs: config.minIntervalMs ?? DEFAULTS.minIntervalMs,
    credentialsPath: config.credentialsPath ?? process.env.DOUBAO_CREDENTIALS ?? DEFAULTS.credentialsPath,
    loginPort: config.loginPort ?? DEFAULTS.loginPort,
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

export async function apply(ctx, config = {}) {
  const settings = resolveConfig(config)
  const logger = ctx.logger ?? console

  const loadCredentials = createCredentialLoader(settings, logger)
  const pacer = new Pacer({ minIntervalMs: settings.minIntervalMs })
  const adapter = createAdapter({ loadCredentials, logger, pacer, providerId: settings.providerId })

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
