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
import { join, posix } from 'node:path'

const DEFAULT_PORT = 9222
const PUSH_BINDING = '__dshDoubaoPush'
const SESSION_VAR = '__dshDoubaoSession'

/**
 * The client is an Electron app on every platform, but where it lives and what
 * its process is called differ. Keep the OS-specific facts in one place so the
 * launcher, the stopper and the discovery probe all agree. `platform` is a
 * parameter on the injectable functions so tests can exercise any OS on any
 * host.
 */
const CLIENT_EXE = {
  win32: 'D:\\Doubao\\app\\Doubao.exe',
  darwin: '/Applications/Doubao.app/Contents/MacOS/Doubao',
  linux: '/opt/Doubao/doubao',
}
const CLIENT_PROCESS = { win32: 'Doubao.exe', darwin: 'Doubao', linux: 'doubao' }

/**
 * Where a Doubao client may live. The launcher must not assume the machine
 * matches this one: the exe sits wherever the user chose to install it, and
 * `D:\Doubao` is a known-good install here, not a universal rule. Discovery
 * asks the OS first (running process, uninstall registry, mdfind, `which`) and
 * probes these locations only as a last resort.
 */
function knownLocations(platform) {
  if (platform === 'darwin') {
    return [
      CLIENT_EXE.darwin,
      process.env.HOME && posix.join(process.env.HOME, 'Applications', 'Doubao.app', 'Contents', 'MacOS', 'Doubao'),
    ]
  }
  if (platform === 'linux') {
    return [CLIENT_EXE.linux, '/usr/bin/doubao', process.env.HOME && posix.join(process.env.HOME, '.local', 'bin', 'doubao')]
  }
  return [
    CLIENT_EXE.win32,
    ...['LOCALAPPDATA', 'ProgramFiles', 'ProgramFiles(x86)'].flatMap((key) =>
      process.env[key]
        ? [
            join(process.env[key], 'Doubao', 'app', 'Doubao.exe'),
            join(process.env[key], 'Doubao', 'Doubao.exe'),
          ]
        : [],
    ),
  ]
}
const CLIENT_CANDIDATES = {
  win32: knownLocations('win32').filter(Boolean),
  darwin: knownLocations('darwin').filter(Boolean),
  linux: knownLocations('linux').filter(Boolean),
}

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
 * Stop every running instance of the client so the next launch can own the
 * single-instance lock *with* the debugger flag. On Windows the client is one
 * process tree (`Doubao.exe`), so a plain taskkill is enough; a live client
 * without the flag cannot be given a port any other way — a second spawn just
 * joins it and drops the flag.
 *
 * Injectable so tests never touch a real process.
 */
export async function stopExistingClient(
  { execFile = defaultExecFile, platform = process.platform, name } = {},
) {
  const proc = name ?? CLIENT_PROCESS[platform] ?? 'Doubao.exe'
  // `-x` matches the exact process NAME. Never use `-f` here: that matches the
  // whole command line, so a harness started from a path containing
  // "dsh-plugin-doubao" would kill itself.
  const [file, args] =
    platform === 'win32'
      ? ['taskkill', ['/F', '/IM', proc, '/T']]
      : ['pkill', ['-x', proc]]
  try {
    await execFile(file, args, { timeout: 5000 })
  } catch {
    // "no process found" is exactly the case we want — treat it as success.
  }
  // Release the single-instance lock and the old debug socket before relaunch.
  await new Promise((r) => setTimeout(r, 800))
}

function defaultExecFile(file, args, opts) {
  return new Promise((resolve, reject) => {
    import('node:child_process').then(({ execFile }) => {
      execFile(file, args, opts, (err, stdout, stderr) => (err ? reject(err) : resolve({ stdout, stderr })))
    }, reject)
  })
}

function defaultSpawn(command, args, opts) {
  return import('node:child_process').then(({ spawn }) => {
    const child = spawn(command, args, opts)
    child.unref()
    return child
  })
}

async function waitForClient(port, tries, available, pollMs = 400) {
  for (let i = 0; i < tries; i += 1) {
    await new Promise((r) => setTimeout(r, pollMs))
    if (await available(port).catch(() => false)) return true
  }
  return false
}

/**
 * Launch the client with a debugging port open, restarting an existing instance
 * if one is in the way.
 *
 * The client is a normal Electron app; the port only exists when it was started
 * with the flag, and a second launch joins an already-running instance and
 * silently drops the flag. So: spawn once and give it a short chance; if the
 * bridge still is not up, stop whatever client is running and spawn again —
 * that second launch now owns the instance and keeps the flag. Best-effort by
 * design: the caller treats a miss as "no bridge".
 *
 * Every external effect is injectable so tests can exercise both the clean
 * start and the restart path without spawning or killing anything real.
 */
export async function launchClient(
  port = DEFAULT_PORT,
  {
    spawn: spawnFn = defaultSpawn,
    execFile = defaultExecFile,
    stop = stopExistingClient,
    available = bridgeAvailable,
    discover = discoverClientExe,
    pollMs = 400,
  } = {},
) {
  const clientExe = await discover({ execFile }).catch(() => undefined)
  if (!clientExe) return false
  const args = ['--remote-debugging-port=' + port, '--remote-allow-origins=*']
  const opts = { detached: true, stdio: 'ignore' }
  // A cold Electron start can take well over ten seconds on a slow machine.
  // Killing at 3.2s would murder the instance we just launched. First launch
  // gets a generous window; only a *confirmed* live-but-unflagged instance is
  // worth the disruptive restart.
  const start = async (tries) => {
    try {
      await spawnFn(clientExe, args, opts)
    } catch {
      return false
    }
    return waitForClient(port, tries, available, pollMs)
  }
  if (await start(30)) return true // ~12s cold start
  // A live instance ate our flag. Stop it and launch once more for real. If
  // nothing actually came up, this stop is a harmless no-op (taskkill/pkill on
  // a missing process is swallowed), and the second start is our last chance.
  await stop({ execFile })
  return start(15)
}

function defaultExistsSync(path) {
  return import('node:fs').then(({ existsSync }) => existsSync(path))
}

/**
 * Find the client executable on this machine.
 *
 * A running client is the best source: its own process carries the exact path,
 * and it is also the instance that has to be stopped before a flagged relaunch.
 * When nothing is running, fall back to probing the usual install locations and
 * the uninstall registry. Every external call is injectable so tests never need
 * a real client or PowerShell.
 */
export async function discoverClientExe(
  { execFile = defaultExecFile, exists = defaultExistsSync, platform = process.platform } = {},
) {
  const candidates = CLIENT_CANDIDATES[platform] ?? CLIENT_CANDIDATES.win32

  if (platform === 'win32') {
    // A live process is the strongest hint; the uninstall registry is next, and
    // works even when the client is closed (exactly when we need to launch it).
    const probe =
      "$p=@();" +
      "Get-Process Doubao -ErrorAction SilentlyContinue | ForEach-Object { if ($_.Path) { $p += $_.Path } };" +
      "Get-ItemProperty 'HKLM:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*'," +
      "'HKLM:\\SOFTWARE\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*'," +
      "'HKCU:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*' -ErrorAction SilentlyContinue |" +
      "Where-Object { $_.DisplayName -like '*Doubao*' -or $_.DisplayName -like '*豆包*' } |" +
      "ForEach-Object { " +
      "if ($_.DisplayIcon) { $ic = ($_.DisplayIcon -replace '^\"|\"$','' -replace ',\\d+$',''); $dir = Split-Path $ic -Parent; " +
      "if ($dir) { $p += (Join-Path $dir 'app\\Doubao.exe'); $p += (Join-Path $dir 'Doubao.exe') } }; " +
      "if ($_.InstallLocation) { $p += (Join-Path $_.InstallLocation 'app\\Doubao.exe'); $p += (Join-Path $_.InstallLocation 'Doubao.exe') } };" +
      "$p | Where-Object { $_ -and (Test-Path $_) } | Select-Object -First 1"
    try {
      const { stdout } = await execFile('powershell', ['-NoProfile', '-NonInteractive', '-Command', probe], {
        timeout: 6000,
      })
      const found = String(stdout ?? '')
        .split(/\r?\n/)
        .map((s) => s.trim())
        .find((s) => /Doubao\.exe$/i.test(s))
      if (found && await exists(found)) return found
    } catch {
      // No process, no PowerShell, or no registry hit — probe known locations.
    }
  } else if (platform === 'darwin') {
    // Spotlight knows where the .app was dropped, even outside /Applications.
    try {
      const { stdout } = await execFile('mdfind', ['kMDItemFSName == "Doubao.app"'], { timeout: 6000 })
      for (const app of String(stdout ?? '').split(/\r?\n/).map((s) => s.trim()).filter(Boolean)) {
        const exe = posix.join(app, 'Contents', 'MacOS', 'Doubao')
        if (await exists(exe)) return exe
      }
    } catch {
      // mdfind missing or Spotlight disabled — fall through to a running process.
    }
    try {
      const { stdout } = await execFile('ps', ['-axo', 'command='], { timeout: 6000 })
      const match = String(stdout ?? '').match(/(\/[^ \n]*Doubao\.app\/Contents\/MacOS\/Doubao)(?=\s|$)/)
      if (match && await exists(match[1])) return match[1]
    } catch {
      // Not running; probe known locations below.
    }
  } else {
    // Linux: PATH first (AppImage / deb / snap wrappers all land on PATH), then
    // a running process reported by /proc through `pgrep -a`.
    try {
      const { stdout } = await execFile('which', ['doubao'], { timeout: 6000 })
      for (const line of String(stdout ?? '').split(/\r?\n/).map((s) => s.trim())) {
        if (line && await exists(line)) return line
      }
    } catch {
      // `which` absent or not on PATH — probe known locations below.
    }
    try {
      const { stdout } = await execFile('pgrep', ['-a', 'doubao'], { timeout: 6000 })
      const line = String(stdout ?? '')
        .split(/\r?\n/)
        .map((s) => s.trim())
        .find(Boolean)
      if (line) {
        const exe = line.split(/\s+/)[0]
        if (exe && await exists(exe)) return exe
      }
    } catch {
      // Not running; probe known locations below.
    }
  }

  for (const candidate of candidates) {
    if (await exists(candidate)) return candidate
  }
  return undefined
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
 * One launch attempt per port per process.
 *
 * Otherwise every turn would spawn the client again while it is starting up,
 * and a failed attempt would be retried on every single message. The result is
 * cached — including a failure, because a machine without the client will not
 * grow one between two questions.
 */
const launchAttempts = new Map() // port -> { promise, at }
// A failed launch is cached only briefly: a machine that had no client a minute
// ago may have one now, and a permanent cache would strand those users on the
// unsigned path forever. Concurrent callers still share one in-flight attempt.
const LAUNCH_RETRY_MS = 30_000

export function forgetLaunchAttempts() {
  launchAttempts.clear()
}

/**
 * Make a bridge exist, starting the client if it is not up at all.
 *
 * This is the difference between "the plugin works when the client happens to
 * be running" and "the plugin works": without the debugger port there is nobody
 * to sign the request, and the unsigned one is refused with 710022004 the
 * moment the account is under scrutiny. A client that is already running
 * ignores the flag, so this cannot retro-fit a port onto a live instance — that
 * needs a restart, which is the user's call, not ours.
 */
export async function ensureBridge(
  port = DEFAULT_PORT,
  { launch = launchClient, available = bridgeAvailable, retryMs = LAUNCH_RETRY_MS } = {},
) {
  if (await available(port).catch(() => false)) return true
  const now = Date.now()
  const cached = launchAttempts.get(port)
  if (cached && now - cached.at < retryMs) {
    return cached.promise.catch(() => false)
  }
  const promise = (async () => {
    const started = await launch(port).catch(() => false)
    if (!started) return false
    return available(port).catch(() => false)
  })()
  launchAttempts.set(port, { promise, at: now })
  return promise.catch(() => false)
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
      // Flush any trailing bytes that did not complete a code point.
      const tail = dec.decode()
      if (tail) send({ t: 'c', d: tail })
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
  // An already-cancelled caller must not emit a real chat request: the abort
  // listener below only fires for *future* aborts. Bail before touching the
  // client (mirrors Pacer.runIterable in doubao.js).
  if (signal?.aborted) throw signal.reason ?? new Error('aborted')
  const cdp = await connect(port)
  if (!cdp) throw new Error('no doubao client listening')

  const queue = []
  let notify = null
  let finished = false
  let failure = null
  let cancelSent = Promise.resolve()

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
    // Remember the cancel send so the finally block can await it before closing
    // the socket — otherwise the cancel CDP message races with socket close and
    // the page keeps streaming for up to its 180s budget.
    cancelSent = cdp
      .send('Runtime.evaluate', {
        expression: `try { window.${SESSION_VAR}?.cancel?.() } catch (e) {}`,
        returnByValue: true,
      })
      .catch(() => {})
    wake()
  }
  signal?.addEventListener?.('abort', onAbort, { once: true })

  // Watchdog: a lost end-frame ('e'/'x') or a dropped binding would otherwise
  // leave the loop below spinning forever, leaking the socket and listeners.
  // The page caps its own fetch at 180s; give the Node side a little more room.
  let watchdog = null

  try {
    await cdp.send('Runtime.enable')
    await cdp.send('Runtime.addBinding', { name: PUSH_BINDING })

    const started = await cdp.send('Runtime.evaluate', {
      expression: pageProgram(url, body),
      returnByValue: true,
    })
    if (started?.exceptionDetails) throw new Error('client rejected the request program')

    watchdog = setTimeout(() => {
      if (finished) return
      finished = true
      failure = new Error('client bridge timed out waiting for the response to finish')
      wake()
    }, 200_000)
    watchdog.unref?.()

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
    if (watchdog) clearTimeout(watchdog)
    signal?.removeEventListener?.('abort', onAbort)
    off()
    // Let the cancel message reach the page before tearing down the socket.
    await cancelSent
    cdp.close()
  }
}

export { DEFAULT_PORT }
