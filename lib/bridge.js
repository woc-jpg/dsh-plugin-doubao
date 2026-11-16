/**
 * The signed-request bridge.
 *
 * Doubao's risk engine wants an `a_bogus` + `msToken` pair on every chat
 * request, and both are minted by native code inside the official client: the
 * page's own `fetch` is wrapped by a preload hook that appends them, and no
 * bundle on disk carries the algorithm (a scan of all 26 loaded scripts finds
 * only the string "acrawler", never "a_bogus"). A plain Node request is
 * therefore rejected with 710022004 no matter how closely it imitates the
 * client's payload — that was measured across URL shape, body shape, cookies,
 * conversation state and model choice.
 *
 * What does work is letting the client sign for us. This module drives the
 * already-running client over the DevTools protocol: the page performs the
 * fetch itself, so its own hook adds the signature, and each body chunk is
 * pushed back through a Runtime binding as soon as it arrives. The measured
 * first byte this way is 160-220ms, faster than the unsigned path ever was.
 *
 * The bridge is optional infrastructure, not a hard dependency: when no client
 * is reachable the caller falls back to a direct request and reports whatever
 * the service says. That keeps the plugin working on machines with no client
 * installed, where a direct request is the only option anyway.
 */

const DEFAULT_PORT = 9222
const PUSH_BINDING = '__dshDoubaoPush'
const SESSION_VAR = '__dshDoubaoSession'
const CLIENT_EXE = 'D:\\Doubao\\app\\Doubao.exe'

/**
 * CDP pages we are willing to run inside.
 *
 * The client opens several targets; only the chat surface is a real window with
 * a cookie jar. The background target in particular loads the same origin with
 * a zero viewport and answers nothing useful, so matching on type alone would
 * silently pick a dud.
 */
export function pickTarget(list) {
  if (!Array.isArray(list)) return undefined
  return list.find(
    (t) =>
      t.type === 'page' &&
      /^(doubao:\/\/doubao-chat|https:\/\/www\.doubao\.com)/.test(String(t.url ?? '')),
  )
}

async function listTargets(port) {
  const res = await fetch('http://127.0.0.1:' + port + '/json/list', {
    signal: AbortSignal.timeout(1200),
  })
  if (!res.ok) return undefined
  return res.json()
}

/**
 * Launch the client with a debugging port open.
 *
 * The client is a normal Electron app; the port only exists when it was started
 * with the flag. A second launch joins the instance that is already running and
 * silently drops the flag, so against a live client this is a miss, not a fix.
 * Best-effort by design: the caller treats a miss as "no bridge".
 */
export async function launchClient(port = DEFAULT_PORT) {
  const { spawn } = await import('node:child_process')
  const { existsSync } = await import('node:fs')
  if (!existsSync(CLIENT_EXE)) return false
  try {
    const child = spawn(
      CLIENT_EXE,
      ['--remote-debugging-port=' + port, '--remote-allow-origins=*'],
      { detached: true, stdio: 'ignore' },
    )
    child.unref()
  } catch {
    return false
  }
  for (let i = 0; i < 25; i += 1) {
    await new Promise((r) => setTimeout(r, 400))
    const list = await listTargets(port).catch(() => undefined)
    if (pickTarget(list)) return true
  }
  return false
}

/** A minimal CDP client: one socket, request/response ids, event fan-out. */
class Cdp {
  constructor(socket) {
    this.socket = socket
    this.nextId = 0
    this.pending = new Map()
    this.listeners = new Set()
    this.closed = false
    socket.addEventListener('message', (ev) => {
      let msg
      try {
        msg = JSON.parse(ev.data)
      } catch {
        return
      }
      if (msg.id !== undefined && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id)
        this.pending.delete(msg.id)
        if (msg.error) reject(new Error(msg.error.message ?? 'cdp error'))
        else resolve(msg.result)
        return
      }
      for (const fn of this.listeners) fn(msg)
    })
    socket.addEventListener('close', () => {
      this.closed = true
      const draining = [...this.pending.values()]
      this.pending.clear()
      for (const { reject } of draining) reject(new Error('cdp socket closed'))
      for (const fn of this.listeners) fn({ method: '__closed' })
    })
  }

  send(method, params = {}) {
    if (this.closed) return Promise.reject(new Error('cdp socket closed'))
    const id = ++this.nextId
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject })
      this.socket.send(JSON.stringify({ id, method, params }))
      // Every call here is either trivial setup or a page program that returns
      // immediately; anything slower than this means the client is wedged.
      const timer = setTimeout(() => {
        if (!this.pending.has(id)) return
        this.pending.delete(id)
        reject(new Error('cdp timeout: ' + method))
      }, 15_000)
      timer.unref?.()
    })
  }

  on(fn) {
    this.listeners.add(fn)
    return () => this.listeners.delete(fn)
  }

  close() {
    try {
      this.socket.close()
    } catch {
      /* already gone */
    }
  }
}

async function connect(port) {
  const list = await listTargets(port)
  const target = pickTarget(list)
  if (!target?.webSocketDebuggerUrl) return undefined
  const socket = new WebSocket(target.webSocketDebuggerUrl)
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('cdp connect timeout')), 5_000)
    socket.addEventListener(
      'open',
      () => {
        clearTimeout(timer)
        resolve()
      },
      { once: true },
    )
    socket.addEventListener(
      'error',
      () => {
        clearTimeout(timer)
        reject(new Error('cdp connect failed'))
      },
      { once: true },
    )
  })
  return new Cdp(socket)
}

/** Is a client reachable right now? Cheap enough to call on every request. */
export async function bridgeAvailable(port = DEFAULT_PORT) {
  const list = await listTargets(port).catch(() => undefined)
  return pickTarget(list) !== undefined
}

/**
 * The program that runs inside the page.
 *
 * It is deliberately self-contained and defensive: a throw is reported back
 * through the binding rather than surfacing as a silent hang, because a CDP
 * evaluation that returns `'ok'` has no way to carry a later rejection.
 */
function pageProgram(url, body) {
  return `(() => {
  const push = window.${PUSH_BINDING}
  const send = (o) => { try { push(JSON.stringify(o)) } catch (e) {} }
  const ctl = new AbortController()
  window.${SESSION_VAR} = { cancel: () => ctl.abort() }
  const timer = setTimeout(() => ctl.abort(), 180000)
  ;(async () => {
    try {
      const res = await fetch(${JSON.stringify(url)}, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: ${JSON.stringify(body)},
        signal: ctl.signal,
      })
      if (!res.ok || !res.body) {
        send({ t: 'x', m: 'http ' + res.status })
        return
      }
      const reader = res.body.getReader()
      const dec = new TextDecoder()
      for (;;) {
        const { value, done } = await reader.read()
        if (done) break
        send({ t: 'c', d: dec.decode(value, { stream: true }) })
      }
      reader.cancel().catch(() => {})
      send({ t: 'e' })
    } catch (e) {
      send({ t: 'x', m: String(e) })
    } finally {
      clearTimeout(timer)
      window.${SESSION_VAR} = null
    }
  })()
  return 'ok'
})()`
}

/**
 * Ask a reachable client to perform the request and stream the body back.
 *
 * Yields the raw response text in whatever slices the client hands over, so the
 * caller can reuse its frame parser untouched. Throws on transport failure,
 * which the caller turns into a fallback rather than an error.
 */
export async function* bridgeStream({ url, body, port = DEFAULT_PORT, signal }) {
  const cdp = await connect(port)
  if (!cdp) throw new Error('no doubao client listening')

  const queue = []
  let notify = null
  let finished = false
  let failure = null

  const wake = () => {
    if (!notify) return
    const fn = notify
    notify = null
    fn()
  }

  const off = cdp.on((msg) => {
    if (msg.method === '__closed') {
      finished = true
      failure = failure ?? new Error('client page closed')
      wake()
      return
    }
    if (msg.method !== 'Runtime.bindingCalled' || msg.params?.name !== PUSH_BINDING) return
    let payload
    try {
      payload = JSON.parse(msg.params.payload ?? 'null')
    } catch {
      return
    }
    if (payload?.t === 'c' && typeof payload.d === 'string') {
      queue.push(payload.d)
    } else if (payload?.t === 'e') {
      finished = true
      wake()
    } else if (payload?.t === 'x') {
      finished = true
      failure = new Error(String(payload.m ?? 'client request failed'))
      wake()
    }
  })

  const onAbort = () => {
    finished = true
    failure = new Error('aborted')
    cdp
      .send('Runtime.evaluate', {
        expression: `try { window.${SESSION_VAR}?.cancel?.() } catch (e) {}`,
        returnByValue: true,
      })
      .catch(() => {})
    wake()
  }
  signal?.addEventListener?.('abort', onAbort, { once: true })

  try {
    await cdp.send('Runtime.enable')
    await cdp.send('Runtime.addBinding', { name: PUSH_BINDING })

    const started = await cdp.send('Runtime.evaluate', {
      expression: pageProgram(url, body),
      returnByValue: true,
    })
    if (started?.exceptionDetails) throw new Error('client rejected the request program')

    for (;;) {
      while (queue.length) yield queue.shift()
      if (finished) break
      await new Promise((resolve) => {
        notify = resolve
        const timer = setTimeout(resolve, 250)
        timer.unref?.()
      })
    }
    while (queue.length) yield queue.shift()
    if (failure) throw failure
  } finally {
    signal?.removeEventListener?.('abort', onAbort)
    off()
    cdp.close()
  }
}

export { DEFAULT_PORT }
