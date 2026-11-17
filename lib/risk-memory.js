/**
 * Short-lived memory of "this account is under risk control".
 *
 * A direct request to doubao.com is enough while the account is in good
 * standing. Once it returns 710022004, retrying the unsigned path only deepens
 * the flag — so we remember the state and route that account through the signed
 * bridge for a while instead of probing again on every turn.
 *
 * The flag expires. Accounts do recover (a completed slider, a different
 * network), and a permanent memory would keep a recovered account on the
 * bridge — and keep launching the client — forever. Persistence across DSH
 * restarts is optional: pass a `file` and the table is a small JSON object on
 * disk, otherwise it lives only for the process.
 */

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'

export const DEFAULT_TTL_MS = 30 * 60 * 1000

/**
 * @param {object}   opts
 * @param {string}  [opts.file]    optional JSON file to persist the table
 * @param {number}  [opts.ttlMs]   how long a flag stays valid
 * @param {Function}[opts.now]     injectable clock for tests
 * @param {object}  [opts.logger]
 */
export function createRiskMemory({ file, ttlMs = DEFAULT_TTL_MS, now = Date.now, logger } = {}) {
  let data = {}
  if (file) {
    try {
      const parsed = JSON.parse(readFileSync(file, 'utf8'))
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) data = parsed
    } catch {
      // Missing, empty or corrupt: start clean. A flag we cannot trust is worse
      // than one extra direct probe against an already-recovered account.
      data = {}
    }
  }

  let dirty = false
  function flush() {
    if (!file || !dirty) return
    try {
      mkdirSync(dirname(file), { recursive: true })
      writeFileSync(file, JSON.stringify(data), 'utf8')
      dirty = false
    } catch (error) {
      logger?.warn?.(`doubao: could not persist risk flags (${error?.message ?? error})`)
    }
  }

  return {
    /** True only while a still-valid flag exists for `key`. */
    isFlagged(key) {
      const until = data[key]
      if (typeof until !== 'number') return false
      if (until <= now()) {
        delete data[key]
        dirty = true
        flush()
        return false
      }
      return true
    },
    /** Record a fresh flag for `key`. */
    mark(key) {
      data[key] = now() + ttlMs
      dirty = true
      flush()
    },
    /** Forget one key, or every key when called with no argument. */
    clear(key) {
      if (key === undefined) data = {}
      else delete data[key]
      dirty = true
      flush()
    },
    /** Debug/test view of the raw table. */
    snapshot() {
      return { ...data }
    },
  }
}
