#!/usr/bin/env node
/**
 * `dsh-plugin-doubao` — sign in to Doubao without talking to the agent.
 *
 * The plugin can serve its sign-in page from inside a DSH session, but that is a
 * chicken-and-egg problem: you install it, the model list appears, and every
 * request fails with AUTH_MISSING until you sign in — which you were told to do
 * by chatting with the very agent that cannot answer. This entry point breaks
 * that loop: run it once after install, scan a QR, and the session is stored
 * where the plugin reads it. No conversation, no harness, no restart needed.
 */
import { spawn } from 'node:child_process'
import { runLoginServer, readCredentials, credentialsPath } from '../lib/login.js'
import { findClientIdentity, toIdentity } from '../lib/identity.js'

const args = process.argv.slice(2)
const has = (...flags) => flags.some((f) => args.includes(f))
const force = has('--force', '-f')
const statusOnly = has('--status', '-s')
const noOpen = has('--no-open')
const portAt = args.indexOf('--port')
const port = portAt >= 0 ? Number(args[portAt + 1]) : Number(process.env.DOUBAO_LOGIN_PORT ?? 8899)
const store = { DSH_HOME: process.env.DSH_HOME }

/**
 * Read the expiry out of the sid_guard cookie when present. Its shape is
 * `id|createdEpoch|durationSeconds|ExpiryDateGMT` — field[1] is the CREATION
 * time, not the expiry, so prefer the explicit date in field[3] and fall back
 * to created + duration.
 */
function expiryOf(cred) {
  const match = /(?:^|;\s*)sid_guard=([^;]+)/.exec(cred?.cookies ?? '')
  if (!match) return undefined
  const parts = decodeURIComponent(match[1]).split('|')
  if (parts[3]) {
    const parsed = new Date(parts[3].replace(/\+/g, ' '))
    if (!Number.isNaN(parsed.getTime())) return parsed
  }
  const seconds = Number(parts[1]) + Number(parts[2] || 0)
  return Number.isFinite(seconds) && seconds > 0 ? new Date(seconds * 1000) : undefined
}

function describe(cred) {
  const path = credentialsPath(store)
  const exp = expiryOf(cred)
  const days = exp ? Math.ceil((exp.getTime() - Date.now()) / 86_400_000) : undefined
  return [
    `Signed in: ${path}`,
    `Device:    ${cred.identity?.deviceId ?? '?'}`,
    exp ? `Expires:   ${exp.toISOString()}${days > 0 ? ` (${days} days left)` : ' (EXPIRED — run with --force)'}` : null,
  ].filter(Boolean).join('\n')
}

function openBrowser(url) {
  try {
    const child = process.platform === 'win32'
      ? spawn('cmd', ['/c', 'start', '""', url], { detached: true, stdio: 'ignore' })
      : process.platform === 'darwin'
        ? spawn('open', [url], { detached: true, stdio: 'ignore' })
        : spawn('xdg-open', [url], { detached: true, stdio: 'ignore' })
    child.unref()
    return true
  } catch {
    return false
  }
}

const existing = readCredentials(store)

if (statusOnly) {
  if (!existing) {
    console.log('Not signed in. Run `dsh-plugin-doubao` (or double-click the login launcher).')
    process.exit(0)
  }
  console.log(describe(existing))
  process.exit(0)
}

if (existing && !force) {
  console.log(describe(existing))
  console.log('Run with --force to scan again, or --status to check this any time.')
  process.exit(0)
}

const found = findClientIdentity(store)
if (!found.found) {
  console.error('No Doubao desktop client identity found on this machine.')
  console.error('Doubao refuses requests from device ids the account has never seen (710022004),')
  console.error('so the client must be installed and signed in at least once. Looked in:')
  for (const dir of found.tried) console.error(`  ${dir}`)
  process.exit(1)
}
console.log(`Device identity: ${toIdentity(found.info).deviceId} (from the installed client)`)

const server = await runLoginServer({
  port,
  logger: console,
  onCredentials() {
    console.log('Saved. You can use Doubao models in DSH now — no restart, no chat needed.')
    setTimeout(() => {
      server.close()
      process.exit(0)
    }, 1800)
  },
})

console.log(`\nOpen ${server.url} and scan with the Douyin app (not Doubao).`)
if (!noOpen && openBrowser(server.url)) {
  console.log('Browser opened for you. If it did not appear, copy the URL above.')
}

// Keep the process alive; runLoginServer owns the event loop.
