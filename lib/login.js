/**
 * Sign-in: get a session cookie for an account, without the desktop client.
 *
 * What a credential needs to be is subtle, and we learned it the hard way:
 *  - no identity at all                -> 710012001 "login invalid"
 *  - a fresh device_id + valid cookie   -> 710022004 (the account never saw it)
 *  - the device_id the client installed -> works
 * So a login alone is not enough; the device id must come from somewhere the
 * account already trusts. This module therefore pairs a scanned session with the
 * device identity recovered from the installed client, and stores the pair.
 *
 * Scanning requires the Douyin app, not the Doubao app — Doubao's own QR
 * endpoint says so in its copywriting, and scanning with Doubao simply fails.
 */
import { createServer } from 'node:http'
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { homedir } from 'node:os'
import { credentialPath, findClientIdentity, toIdentity } from './identity.js'

const PASSPORT_AID = '497858'
const BROWSER_UA =
  process.env.DOUBAO_LOGIN_UA ??
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/147.0.7727.149 Safari/537.36'
const NEXT = 'https://www.doubao.com'

/** A cookie jar that survives redirects, which is all a passport flow needs. */
function makeJar() {
  const jar = new Map()
  return {
    jar,
    header: () => [...jar].map(([k, v]) => `${k}=${v}`).join('; '),
    absorb(res) {
      for (const raw of res.headers.getSetCookie?.() ?? []) {
        const pair = raw.split(';')[0]
        const i = pair.indexOf('=')
        if (i > 0) jar.set(pair.slice(0, i).trim(), pair.slice(i + 1).trim())
      }
    },
  }
}

async function passportGet(jar, url, headers = {}) {
  const res = await fetch(url, {
    headers: {
      'User-Agent': BROWSER_UA,
      Accept: 'application/json, text/plain, */*',
      'Accept-Language': 'zh-CN,zh;q=0.9',
      Referer: 'https://www.doubao.com/chat/login',
      Origin: 'https://www.doubao.com',
      ...(jar.jar.size ? { Cookie: jar.header() } : {}),
      ...headers,
    },
  })
  jar.absorb(res)
  return { status: res.status, body: await res.text() }
}

/**
 * Fetch one login QR. The `next` and `aid` pair is what makes the code scan into
 * this product; the csrf header is required or the endpoint answers an error.
 */
export async function fetchQr(jar = makeJar()) {
  await passportGet(jar, 'https://www.doubao.com/chat/')
  if (!jar.jar.has('passport_csrf_token')) {
    await passportGet(jar, `https://www.doubao.com/passport/safe/csrf_token/?aid=${PASSPORT_AID}`)
  }
  const csrf = jar.jar.get('passport_csrf_token') ?? ''
  const query = new URLSearchParams({ aid: PASSPORT_AID, next: NEXT }).toString()
  const res = await passportGet(
    jar,
    `https://www.doubao.com/passport/web/get_qrcode/?${query}`,
    csrf ? { 'x-tt-passport-csrf-token': csrf } : {},
  )
  let data = {}
  try {
    data = JSON.parse(res.body)?.data ?? {}
  } catch {
    throw new Error(`QR request failed: ${res.body.slice(0, 200)}`)
  }
  const raw = data.qrcode || data.qrcode_url || ''
  if (!data.token || !raw) throw new Error(`QR request returned no code: ${res.body.slice(0, 200)}`)
  return {
    jar,
    csrf,
    token: data.token,
    png: raw.startsWith('data:') ? raw.split(',', 2)[1] : raw,
    // The server states, in this field, which app may scan the code.
    hint: parseHint(data.copywriting),
  }
}

/** The QR response embeds its own instruction text as a JSON string. */
export function parseHint(copywriting) {
  if (typeof copywriting !== 'string' || !copywriting) return undefined
  try {
    const parsed = JSON.parse(copywriting)
    return parsed?.desc ? String(parsed.desc).replace(/\[[^\]]*\]/g, '') : undefined
  } catch {
    return undefined
  }
}

const STATUS_TEXT = {
  new: 'waiting for scan',
  scanned: 'scanned — confirm on your phone',
  confirmed: 'confirmed',
  expired: 'expired',
}

/** Poll one QR until it is confirmed or expires (~60 s). */
export async function pollQr(jar, csrf, token, { intervalMs = 1500, timeoutMs = 62_000, onStatus } = {}) {
  const started = Date.now()
  let last
  while (Date.now() - started < timeoutMs) {
    const query = new URLSearchParams({ aid: PASSPORT_AID, next: NEXT, token }).toString()
    const res = await passportGet(
      jar,
      `https://www.doubao.com/passport/web/check_qrconnect/?${query}`,
      csrf ? { 'x-tt-passport-csrf-token': csrf } : {},
    )
    let data = {}
    try {
      data = JSON.parse(res.body)?.data ?? {}
    } catch {
      // a transient parse failure is not a terminal state; keep polling
    }
    if (data.status && data.status !== last) {
      last = data.status
      onStatus?.(data.status, STATUS_TEXT[data.status] ?? data.status)
    }
    if (data.status === 'confirmed') return { status: 'confirmed', data }
    if (data.status === 'expired' || data.status === 'canceled') return { status: data.status, data }
    await new Promise((r) => setTimeout(r, intervalMs))
  }
  return { status: 'timeout' }
}

/**
 * Follow the post-confirmation redirect so the session cookies land in the jar.
 *
 * The redirect target is the site root, and the cookies arrive on the hops; a
 * plain `redirect: 'follow'` loses the intermediate Set-Cookie headers in some
 * runtimes, so each hop is walked explicitly.
 */
export async function harvestSession(jar, redirectUrl, limit = 6) {
  let url = redirectUrl
  for (let hop = 0; hop < limit && url; hop += 1) {
    const res = await fetch(url, {
      redirect: 'manual',
      headers: {
        'User-Agent': BROWSER_UA,
        Accept: 'text/html,application/xhtml+xml',
        ...(jar.jar.size ? { Cookie: jar.header() } : {}),
      },
    })
    jar.absorb(res)
    const location = res.headers.get('location')
    await res.text().catch(() => '')
    if (!location) break
    url = location.startsWith('http') ? location : new URL(location, url).toString()
  }
  return jar.header()
}

/** Where the credential is written. Kept outside the plugin so upgrades survive. */
export function credentialsPath(env = process.env) {
  return credentialPath(env)
}

export function readCredentials(env = process.env) {
  const path = credentialsPath(env)
  if (!existsSync(path)) return undefined
  try {
    const raw = JSON.parse(readFileSync(path, 'utf8').replace(/^\uFEFF/, ''))
    if (!raw?.cookies || !raw?.identity?.deviceId) return undefined
    return raw
  } catch {
    return undefined
  }
}

export function writeCredentials(credential, env = process.env) {
  const path = credentialsPath(env)
  mkdirSync(dirname(path), { recursive: true })
  const payload = {
    cookies: credential.cookies,
    identity: credential.identity,
    account: credential.account,
    savedAt: new Date().toISOString(),
  }
  writeFileSync(path, JSON.stringify(payload, null, 2), { mode: 0o600 })
  return path
}

/** Identity for the chat call: the client's device id, never a minted one. */
export function resolveIdentity(env = process.env) {
  const found = findClientIdentity(env)
  if (found.found) return { identity: toIdentity(found.info), source: 'client', info: found.info }
  return { identity: undefined, source: 'none' }
}

/**
 * Run the whole flow in a browser window at `http://127.0.0.1:<port>/`.
 *
 * The code expires every ~60 s, so a one-shot screenshot is useless; the page
 * reissues in the background and the user scans whenever they are ready.
 */
export async function runLoginServer({ port = 8899, env = process.env, logger = console, onCredentials } = {}) {
  let state = { png: '', status: 'init', at: 0, hint: '', verdict: '', saved: '' }
  let jar
  let token = ''
  let csrf = ''
  let confirmed = false
  let issuing = false
  let lastIssue = 0
  let closed = false
  let polling = false

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

  const set = (patch) => {
    state = { ...state, ...patch }
  }

  async function issue() {
    if (issuing || confirmed) return
    issuing = true
    try {
      const fresh = makeJar()
      const qr = await fetchQr(fresh)
      jar = fresh
      token = qr.token
      csrf = qr.csrf
      lastIssue = Date.now()
      set({ png: qr.png, status: 'new', at: Date.now(), hint: qr.hint ?? '' })
      logger.log?.(`doubao: new QR code (expires in ~60s)`)
    } catch (error) {
      set({ status: `error: ${error.message}`, at: Date.now() })
    } finally {
      issuing = false
    }
  }

  async function confirm(data) {
    if (confirmed) return
    confirmed = true
    set({ status: 'confirmed', at: Date.now() })
    const cookies = data.redirect_url ? await harvestSession(jar, data.redirect_url) : jar.header()
    const resolved = resolveIdentity(env)
    if (!resolved.identity) {
      set({
        verdict:
          'Cookie captured, but no Doubao desktop client identity was found on this machine. ' +
          'Doubao binds each account to the device id the client registered, so sign-in cannot complete without it.',
      })
      return
    }
    const credential = { cookies, identity: resolved.identity }
    const path = writeCredentials(credential, env)
    set({ verdict: `saved to ${path}`, saved: path })
    logger.log?.(`doubao: credentials saved to ${path}`)
    onCredentials?.(credential)
  }

  const page = `<!doctype html><meta charset="utf-8"><title>Sign in to Doubao</title>
<style>
 body{margin:0;min-height:100vh;display:grid;place-items:center;background:#0f172a;color:#e2e8f0;
      font:15px/1.65 system-ui,"Segoe UI",sans-serif}
 .card{background:#1e293b;border-radius:16px;padding:26px 32px;text-align:center;max-width:430px;
       box-shadow:0 24px 60px rgba(0,0,0,.45)}
 h1{font-size:17px;margin:0 0 6px;font-weight:600}
 p{margin:0 0 16px;color:#94a3b8;font-size:13px}
 img{width:272px;height:272px;border-radius:10px;background:#fff;padding:9px;display:block;margin:0 auto}
 .st{margin-top:14px;font-size:13px;color:#38bdf8;min-height:20px}
 .ok{color:#34d399}.bad{color:#f87171}
 .v{margin-top:10px;font-size:12px;color:#cbd5e1;word-break:break-all}
</style>
<div class="card">
  <h1>Scan with the Douyin app</h1>
  <p id="hint">Doubao QR sign-in accepts only the Douyin app — scanning with Doubao fails.</p>
  <img id="q" alt="QR code">
  <div class="st" id="s">starting…</div>
  <div class="v" id="v"></div>
</div>
<script>
let seen = ''
const labels = {init:'starting…',new:'waiting for scan',scanned:'scanned — confirm on your phone',
                confirmed:'signed in',expired:'expired, refreshing…'}
async function tick(){
  let r
  try { r = await fetch('/state',{cache:'no-store'}).then(r=>r.json()) } catch { return }
  if(r.png && r.at !== seen){ seen = r.at; document.getElementById('q').src = 'data:image/png;base64,' + r.png }
  if(r.hint) document.getElementById('hint').textContent = r.hint
  const el = document.getElementById('s')
  el.textContent = labels[r.status] || r.status
  el.className = 'st' + (r.status === 'confirmed' ? ' ok' : r.status.startsWith('error') ? ' bad' : '')
  const v = document.getElementById('v')
  v.textContent = r.verdict || ''
  v.className = 'v' + (r.verdict.includes('saved') ? ' ok' : '')
}
tick(); setInterval(tick, 1200)
</script>`

  const server = createServer((req, res) => {
    if (req.url === '/state') {
      res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' })
      res.end(JSON.stringify({ png: state.png, at: state.at, status: state.status, hint: state.hint, verdict: state.verdict }))
      return
    }
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' })
    res.end(page)
  })

  const timer = setInterval(async () => {
    if (confirmed || closed || polling) return
    polling = true
    try {
      if (!token) {
        await issue()
        return
      }
      const result = await pollQr(jar, csrf, token, {
        timeoutMs: 4000,
        onStatus(status, text) {
          set({ status, at: state.at })
          logger.log?.(`doubao: ${text}`)
        },
      })
      if (result.status === 'confirmed') await confirm(result.data)
      else if (result.status === 'expired' || result.status === 'timeout') {
        if (Date.now() - lastIssue > 45_000) await issue()
      }
    } catch (error) {
      logger.warn?.(`doubao: login poll failed: ${error.message}`)
    } finally {
      polling = false
    }
  }, 1500)

  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(port, '127.0.0.1', resolve)
  })
  const address = server.address()
  const boundPort = typeof address === 'object' && address ? address.port : port
  logger.log?.(`doubao: open http://127.0.0.1:${boundPort}/ and scan with the Douyin app`)
  await issue()

  return {
    url: `http://127.0.0.1:${boundPort}/`,
    get state() {
      return state
    },
    close() {
      closed = true
      clearInterval(timer)
      server.close()
    },
  }
}

/** Default credential path used by tests and the CLI banner. */
export const DEFAULT_CREDENTIALS = join(
  process.env.DSH_HOME ?? join(homedir(), '.dsh'),
  'doubao-local',
  'credentials.json',
)
