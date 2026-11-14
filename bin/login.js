#!/usr/bin/env node
/**
 * `dsh-plugin-doubao login` — get a session without the harness running.
 *
 * The harness itself is happy to serve this page in-session, but a plugin that
 * can only be signed in from inside the app is annoying to set up: you install
 * it, the model list appears, and every request fails with AUTH_MISSING. This
 * entry point exists so the sign-in can be done first, from a terminal.
 */
import { runLoginServer, readCredentials, credentialsPath } from '../lib/login.js'
import { findClientIdentity, toIdentity } from '../lib/identity.js'

const port = Number(process.env.DOUBAO_LOGIN_PORT ?? 8899)
const store = { DSH_HOME: process.env.DSH_HOME }

const existing = readCredentials(store)
if (existing && !process.argv.includes('--force')) {
  console.log(`Already signed in: ${credentialsPath(store)}`)
  console.log('Re-run with --force to sign in again.')
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
    console.log('Saved. Start DSH and pick a Doubao model — no restart needed.')
    setTimeout(() => {
      server.close()
      process.exit(0)
    }, 1200)
  },
})

console.log(`\nOpen ${server.url} and scan with the Douyin app (not Doubao).\n`)
