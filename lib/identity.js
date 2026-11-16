/**
 * Recover the machine's Doubao device identity from the installed client.
 *
 * Why this has to exist: the chat endpoint keys its risk engine on a device
 * fingerprint. A request with no identity gets `710012001 login invalid`; a
 * freshly minted device_id with a perfectly valid session gets `710022004`,
 * because the account has never seen that device before. Only the device id the
 * client itself registered is accepted, and there is no API that hands it out —
 * the client keeps it in Local Storage.
 *
 * Chromium stores Local Storage in a leveldb. Its Cookies SQLite is exclusively
 * locked while the client runs (EBUSY, even for a read-only handle, and SQLite's
 * `immutable=1` cannot open it either), but the leveldb `.log`/`.ldb` files are
 * ordinary append-only files that stay readable on a live client. So this module
 * can work while the user has Doubao open — it never starts or stops it.
 *
 * Two sources are consulted, in this order:
 *
 *   1. `Local State` — a plain JSON file next to the profiles, carrying
 *      `aha.device.device_id`. Always present and never locked.
 *   2. the leveldb files, for `client_device_info`.
 *
 * The order matters. leveldb blocks are written with prefix compression, so once
 * the client compacts (its `.log` folds into an `.ldb`) the key
 * `client_device_info` is no longer a contiguous byte run and a scan finds
 * nothing — which is exactly what happened here after a restart. `Local State`
 * survived it, so it is the primary source and leveldb is the fallback for the
 * extra fields.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, posix } from 'node:path'
import { homedir } from 'node:os'

/**
 * Where the client keeps its data. The Electron shell is installed in a few
 * different places depending on how it was installed, so several profiles are
 * probed in order.
 */
export function candidateUserDataDirs(env = process.env, platform = process.platform) {
  const home = homedir()
  if (platform === 'darwin') {
    // Electron/Chromium apps on macOS put their user data under Application
    // Support. Doubao uses the bundle name; older builds used lowercase.
    const support = posix.join(home, 'Library', 'Application Support')
    return [
      posix.join(support, 'Doubao', 'User Data'),
      posix.join(support, 'doubao', 'User Data'),
      posix.join(support, 'Doubao'),
      posix.join(support, 'doubao'),
    ]
  }
  if (platform === 'linux') {
    // XDG_CONFIG_HOME is the standard override; ~/.config is the default.
    const config = env.XDG_CONFIG_HOME ?? posix.join(home, '.config')
    return [
      posix.join(config, 'doubao'),
      posix.join(config, 'Doubao'),
      posix.join(home, '.doubao'),
      posix.join(home, '.config', 'doubao', 'User Data'),
    ]
  }
  const local = env.LOCALAPPDATA ?? join(home, 'AppData', 'Local')
  const roaming = env.APPDATA ?? join(home, 'AppData', 'Roaming')
  return [
    join(local, 'Doubao', 'User Data'),
    join(roaming, 'Doubao', 'User Data'),
    join(local, 'Doubao'),
    join(roaming, 'Doubao'),
  ]
}

export function localStorageDirs(env = process.env, profiles = ['Default'], platform = process.platform) {
  const out = []
  for (const root of candidateUserDataDirs(env, platform)) {
    for (const profile of profiles) out.push(join(root, profile, 'Local Storage', 'leveldb'))
  }
  return out
}

/**
 * The identity the client wrote to `Local State`.
 *
 * `aha.device` holds the device id in plain JSON, alongside the install id and
 * the machine's own identifiers. Chromium rewrites this file in place rather
 * than through a compaction log, so the value stays readable across restarts and
 * while the client runs.
 */
export function readLocalStateIdentity(userDataDir) {
  const path = join(userDataDir, 'Local State')
  let raw
  try {
    raw = readFileSync(path, 'utf8')
  } catch {
    return undefined
  }
  let parsed
  try {
    parsed = JSON.parse(raw.replace(/^\uFEFF/, ''))
  } catch {
    return undefined
  }
  const device = parsed?.aha?.device
  const deviceId = device?.device_id
  if (typeof deviceId !== 'string' || deviceId.length === 0) return undefined
  return {
    deviceId,
    deviceModel: undefined,
    source: path,
  }
}

/**
 * Read the first JSON object starting at `at`, respecting nesting and strings.
 *
 * A fixed-size slice does not work: leveldb appends records back to back, so the
 * bytes after the object we want belong to unrelated keys, and the object itself
 * may contain braces inside string values.
 */
function jsonAt(buf, at) {
  const open = buf.indexOf(0x7b, at) // '{'
  if (open < 0) return undefined
  let depth = 0
  let inString = false
  let escaped = false
  const limit = Math.min(buf.length, open + 200_000)
  for (let i = open; i < limit; i += 1) {
    const c = buf[i]
    if (inString) {
      if (escaped) escaped = false
      else if (c === 0x5c) escaped = true
      else if (c === 0x22) inString = false
      continue
    }
    if (c === 0x22) inString = true
    else if (c === 0x7b) depth += 1
    else if (c === 0x7d) {
      depth -= 1
      if (depth === 0) {
        try {
          return JSON.parse(buf.toString('utf8', open, i + 1))
        } catch {
          return undefined
        }
      }
    }
  }
  return undefined
}

function valueAfter(buf, key) {
  const at = buf.indexOf(key, 0, 'latin1')
  if (at < 0) return undefined
  const from = at + key.length
  // leveldb prefixes the payload with a type byte and a length varint, so the
  // quote or brace we want is a few bytes along, not immediately after the key.
  const window = Math.min(buf.length, from + 16)
  for (let i = from; i < window; i += 1) {
    if (buf[i] === 0x7b) return jsonAt(buf, i) // '{'
    if (buf[i] === 0x22) {
      const end = buf.indexOf(0x22, i + 1)
      if (end < 0) return undefined
      return buf.toString('utf8', i + 1, end)
    }
  }
  // Some values (s_v_web_id) are stored as a bare string with no quotes at all.
  let i = from
  while (i < buf.length && (buf[i] < 0x20 || buf[i] === 0x7f)) i += 1
  let end = i
  while (end < buf.length && buf[end] >= 0x20 && end - i < 128) end += 1
  if (end <= i) return undefined
  const bare = buf.toString('utf8', i, end)
  // Anything starting with a closing brace is the tail of a neighbouring record,
  // not a value for this key — reporting it would make the caller trust junk.
  if (/^[}\]),;]/.test(bare)) return undefined
  return bare
}

/** Newest first, and prefer live `.log` files over compacted `.ldb` ones. */
function leveldbFiles(dir) {
  let names
  try {
    names = readdirSync(dir).filter((f) => /\.(ldb|log)$/i.test(f))
  } catch {
    return []
  }
  const withStat = []
  for (const name of names) {
    try {
      withStat.push({ name, stat: statSync(join(dir, name)) })
    } catch {
      // a file can vanish between readdir and stat while leveldb compacts
    }
  }
  withStat.sort((a, b) => {
    const aLog = a.name.endsWith('.log')
    const bLog = b.name.endsWith('.log')
    if (aLog !== bLog) return aLog ? -1 : 1
    return b.stat.mtimeMs - a.stat.mtimeMs
  })
  return withStat
}

/**
 * Scan one profile's leveldb for the identity keys.
 *
 * `client_device_info` carries `deviceId` and the browser build the client
 * reports; `__tea_cache_tokens_582478` carries the `web_id` the web client would
 * use. We do not need the cookies from here — those come from a login.
 */
export function scanLocalStorage(dir) {
  const info = {}
  for (const { name } of leveldbFiles(dir)) {
    let buf
    try {
      buf = readFileSync(join(dir, name))
    } catch {
      continue // locked or permission-denied; try the next file
    }
    if (!info.deviceId) {
      const dev = valueAfter(buf, 'client_device_info')
      if (dev && typeof dev === 'object' && dev.deviceId) {
        info.deviceId = String(dev.deviceId)
        if (dev.deviceIdCustom) info.deviceIdCustom = String(dev.deviceIdCustom)
        if (dev.chromiumVersion) info.chromiumVersion = String(dev.chromiumVersion)
        if (dev.clientVersion) info.clientVersion = String(dev.clientVersion)
        if (dev.deviceModel) info.deviceModel = String(dev.deviceModel)
        info.source = join(dir, name)
      }
    }
    if (!info.webId) {
      const tea = valueAfter(buf, '__tea_cache_tokens_582478')
      if (tea && typeof tea === 'object') {
        const web = tea.web_id ?? tea.webId
        if (web) info.webId = String(web)
      }
    }
    if (!info.legacyFp) {
      const fp = valueAfter(buf, 's_v_web_id')
      if (typeof fp === 'string' && fp) info.legacyFp = fp
    }
    if (info.deviceId && info.webId) break
  }
  return info
}

/** Probe every known profile directory and return the first hit. */
export function findClientIdentity(env = process.env, platform = process.platform) {
  const tried = []
  for (const root of candidateUserDataDirs(env, platform)) {
    const fromState = readLocalStateIdentity(root)
    if (fromState) {
      // Local State only carries the id; the leveldb still has the browser build
      // the client reports, which the request has to echo back.
      const extra = scanLocalStorage(join(root, 'Default', 'Local Storage', 'leveldb'))
      const info = { ...extra, ...fromState }
      if (!info.chromiumVersion) info.chromiumVersion = extra.chromiumVersion
      if (!info.clientVersion) info.clientVersion = extra.clientVersion
      return { found: true, info, dir: root, tried }
    }
    tried.push(join(root, 'Local State'))
  }
  for (const dir of localStorageDirs(env, ['Default'], platform)) {
    const info = scanLocalStorage(dir)
    if (info.deviceId) return { found: true, info, dir, tried }
    tried.push(dir)
  }
  return { found: false, info: {}, tried }
}

/**
 * The three query parameters the risk engine actually checks. `fp` is not the
 * `s_v_web_id` cookie value — it is literally `verify_` + the device id, which is
 * what the desktop client sends.
 */
export function toIdentity(info) {
  const deviceId = info?.deviceId ?? info?.deviceIdCustom
  if (!deviceId) return undefined
  return {
    deviceId,
    fp: `verify_${deviceId}`,
    webId: info?.webId ?? deviceId,
    chromiumVersion: info?.chromiumVersion ?? '147.0.7727.149',
    clientVersion: info?.clientVersion ?? '2.35.12',
  }
}

/** Where to cache minted credentials so they survive a restart. */
export function credentialPath(env = process.env) {
  const base = env.DSH_HOME ?? join(homedir(), '.dsh')
  return join(base, 'doubao-local', 'credentials.json')
}
