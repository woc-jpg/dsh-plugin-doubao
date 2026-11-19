/**
 * The native channel: the same one the Doubao desktop client uses.
 *
 * `/chat/completion` with `runtime_type: 2` does not stream text for a task that
 * needs to act. It answers on the chat stream with *narration* and dispatches the
 * actual work over a second, long-lived SSE connection — an outbound-only queue
 * the client is expected to drain:
 *
 *     POST /alice/office/tool_local/chunk_stream           (down)  TOOL_CALL, COMMAND
 *     POST /alice/office/tool_local/upload_tool_call_result (up)   one result per call
 *     POST /alice/office/tool_local/upload_command_result   (up)   ack for need_ack commands
 *
 * Two things about that protocol cost me a day and are worth writing down, because
 * neither is guessable from the payloads:
 *
 * - **Every dispatch must be answered or the server re-issues it forever.** A
 *   single unanswered call keeps the same command arriving with a new `id` every
 *   few hundred milliseconds; the chat stream then never produces its answer, so
 *   the failure looks like "the model went silent".
 * - **Frames are separated by CRLF CRLF.** Splitting on `\n\n` yields zero frames
 *   and an empty reply, which reads exactly like "no answer came back".
 *
 * Verified end-to-end against the live service: the model ran four `Bash` commands,
 * read their real output, and finished the turn with `is_finish: true`.
 *
 * @module
 */

import { execFile } from 'node:child_process'
import { mkdir, readdir, readFile, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'

const ORIGIN = 'https://www.doubao.com'
const SSE_PATH = '/alice/office/tool_local/chunk_stream'
const TOOL_RESULT_PATH = '/alice/office/tool_local/upload_tool_call_result'
const COMMAND_RESULT_PATH = '/alice/office/tool_local/upload_command_result'

/** Query parameters the web client sends on every call; the gateway checks them. */
const BASE_QUERY = {
  aid: '1044603',
  device_platform: 'web',
  samantha_web: '1',
  pc_version: '2.32.10',
  doubao_pc_version: '2.32.10',
  version_code: '20800',
  language: 'zh',
  region: 'CN',
  sys_region: 'CN',
}

/** Permission levels the task parameter understands. */
export const PERMISSIONS = { AlwaysAsk: 0, AskOnRisk: 1, FullAccess: 2 }

/**
 * Commands that reach outside the workspace, delete in bulk, or hand the shell to
 * a downloaded script. Refused under AskOnRisk; the model gets a normal tool error
 * and usually picks a narrower command.
 */
const RISKY_PATTERNS = [
  /\brm\s+(-[a-zA-Z]*\s+)*-[a-zA-Z]*[rf]/,
  /\bdel\s+\/[fsq]/i,
  /\brmdir\s+\/s/i,
  /\bformat\s+[a-z]:/i,
  /\bmkfs\b/i,
  /\bdd\s+if=/,
  /\b(shutdown|reboot|halt)\b/i,
  /\breg\s+(delete|add)\s+HK(LM|EY_LOCAL_MACHINE)/i,
  /\b(curl|wget|Invoke-WebRequest|iwr)\b[^|]*\|\s*(sh|bash|zsh|iex|Invoke-Expression)/i,
  /\bchmod\s+777\s+\//,
  /\bsudo\b/,
  /\bRemove-Item\b[^|;]*-(Recurse|Force)[^|;]*(C:\\|D:\\)\s*$/i,
]

/** Which tool names the service dispatches to a client runtime. */
export const NATIVE_TOOLS = ['Bash', 'Read', 'Write', 'Edit', 'Glob', 'Grep']

export function isRiskyCommand(command) {
  const text = String(command ?? '')
  return RISKY_PATTERNS.some((pattern) => pattern.test(text))
}

export function buildUrl(pathname, identity, extra = {}) {
  const url = new URL(pathname, ORIGIN)
  const deviceId = identity?.deviceId ?? ''
  const params = {
    ...BASE_QUERY,
    web_id: identity?.webId ?? deviceId,
    device_id: deviceId,
    ...extra,
  }
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, String(value))
  return url.href
}

function wireHeaders(cookies, userAgent) {
  return {
    'content-type': 'application/json',
    'Agw-Js-Conv': 'str',
    cookie: cookies,
    'user-agent': userAgent,
    origin: ORIGIN,
    referer: `${ORIGIN}/chat/`,
  }
}

/** Split an SSE byte stream into complete frames, tolerating both line endings. */
export function frameSplitter() {
  let buffer = ''
  return (chunk) => {
    buffer += chunk
    const frames = []
    let match
    // CRLF CRLF is what the service sends; LF LF appears in tests and in proxies.
    const separator = /\r?\n\r?\n/
    while ((match = separator.exec(buffer))) {
      frames.push(buffer.slice(0, match.index))
      buffer = buffer.slice(match.index + match[0].length)
    }
    return frames
  }
}

/** Read `event:` and `data:` out of one frame. */
export function readFrame(raw) {
  let event = ''
  const data = []
  for (const line of raw.split('\n')) {
    const clean = line.replace(/\r$/, '')
    if (clean.startsWith('event:')) event = clean.slice(6).trim()
    else if (clean.startsWith('data:')) data.push(clean.slice(5).replace(/^ /, ''))
  }
  return { event, data: data.join('\n') }
}

/**
 * Normalize one down-channel frame into the three things the runtime cares about.
 * @returns {{kind: 'tool'|'command'|'heartbeat'|'unknown', call?: object, command?: object}}
 */
export function classifyFrame(payload) {
  const eventType = Number(payload?.event_type)
  if (eventType === 1 && payload?.tool_call) {
    const raw = payload.tool_call
    let input = {}
    try {
      input = JSON.parse(raw.input || '{}')
    } catch {
      input = {}
    }
    return {
      kind: 'tool',
      call: { id: raw.id, name: raw.name, input, inputRaw: raw.input, option: raw.option ?? {} },
    }
  }
  if (eventType === 2 && payload?.command) {
    const raw = payload.command
    let input = {}
    try {
      input = JSON.parse(raw.input || '{}')
    } catch {
      input = {}
    }
    return {
      kind: 'command',
      command: { id: raw.id, name: raw.name, input, needAck: raw.need_ack === true, option: raw.option ?? {} },
    }
  }
  if (eventType === 3) return { kind: 'heartbeat' }
  return { kind: 'unknown' }
}

/** The task parameter that asks the service for a *local* runtime. */
export function buildNativeTaskParam({ workspace, sandboxId, deviceId, permission = 'AskOnRisk', homeDir, localMessageId, localConnectors = [] }) {
  const level = PERMISSIONS[permission] ?? PERMISSIONS.AskOnRisk
  const root = path.resolve(workspace)
  return {
    action: 0,
    thread_local_message_id: localMessageId ? [localMessageId] : [],
    client_option: {
      enable_sandbox: true,
      os: process.platform === 'darwin' ? 'Mac' : process.platform === 'win32' ? 'Windows' : 'Linux',
      shared_folder_path: [root],
      agent_workspace: { agent_workspace: root, local_skill_paths: [] },
      client_env_id: '',
      sandbox_id: sandboxId,
      workspace: root,
      sandbox_auth_type: level,
    },
    runtime_type: 2,
    agent_task_param: {
      runtime_type: 2,
      sandbox_auth_type: level,
      local_device_id: deviceId,
      workspace: root,
      device_name: 'dsh',
      local_app_id: '1044603',
    },
    agent_task_param_change: { runtime_changed: false, device_changed: false, sandbox_auth_type_changed: false },
    need_modify_conversation: false,
    task_input_json: JSON.stringify({
      agents_md: { files: [], state: 2 },
      schema_version: 1,
      home_dir: homeDir ?? root,
      project_context: {},
      localConnectors,
    }),
  }
}

function shell(command, { cwd, timeoutMs = 120_000, maxBytes = 200_000 }) {
  const isWindows = process.platform === 'win32'
  const file = isWindows ? 'powershell.exe' : '/bin/sh'
  const args = isWindows ? ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', command] : ['-c', command]
  return new Promise((resolve) => {
    execFile(file, args, { cwd, timeout: timeoutMs, maxBuffer: maxBytes, windowsHide: true }, (error, stdout, stderr) => {
      const timedOut = Boolean(error?.killed)
      const text = `${stdout ?? ''}${stderr ? `${stdout ? '\n' : ''}${stderr}` : ''}`
      resolve({ text: text || (error ? String(error.message ?? error) : ''), isError: Boolean(error) || timedOut, timedOut })
    })
  })
}

/**
 * Execute one native tool call inside the workspace.
 *
 * Confinement is the point: every path is resolved against the workspace and a
 * `..` that escapes it is refused rather than clamped, so a call cannot reach the
 * rest of the disk just because the model wrote an absolute path.
 */
export async function executeNativeTool(name, input, { workspace, permission = 'AskOnRisk' } = {}) {
  const root = path.resolve(workspace)
  const level = PERMISSIONS[permission] ?? PERMISSIONS.AskOnRisk
  const confine = (value) => {
    if (typeof value !== 'string' || value === '') return undefined
    const resolved = path.resolve(root, value)
    const relative = path.relative(root, resolved)
    if (relative.startsWith('..') || path.isAbsolute(relative)) return undefined
    return resolved
  }
  const denied = (reason) => ({ text: reason, isError: true })

  switch (name) {
    case 'Bash': {
      const command = typeof input.command === 'string' ? input.command : ''
      if (!command.trim()) return denied('Bash requires a command string.')
      if (level !== PERMISSIONS.FullAccess && isRiskyCommand(command)) {
        return denied(`Command refused by policy (permission ${permission}): it can reach outside the workspace, delete in bulk, or pipe a download into a shell.`)
      }
      const timeout = Number(input.timeout)
      const result = await shell(command, { cwd: root, timeoutMs: Number.isFinite(timeout) && timeout > 0 ? Math.min(timeout, 120_000) : 120_000 })
      return { text: result.text, isError: result.isError }
    }
    case 'Read': {
      const target = confine(input.file_path ?? input.path)
      if (!target) return denied('Read refused: the path is outside the workspace.')
      const info = await stat(target).catch(() => undefined)
      if (!info?.isFile()) return denied(`Read failed: ${target} is not a file.`)
      const text = await readFile(target, 'utf8').catch(() => undefined)
      if (text === undefined) return denied('Read failed: the file is not UTF-8 text.')
      const offset = Math.max(0, (Number(input.offset ?? input.line_offset) || 1) - 1)
      const limit = Number(input.limit)
      const lines = text.split('\n')
      const slice = lines.slice(offset, Number.isFinite(limit) && limit > 0 ? offset + limit : undefined)
      return { text: slice.join('\n') || '(empty file)', isError: false }
    }
    case 'Write': {
      const target = confine(input.file_path ?? input.path)
      if (!target) return denied('Write refused: the path is outside the workspace.')
      const content = typeof input.content === 'string' ? input.content : ''
      await mkdir(path.dirname(target), { recursive: true })
      await writeFile(target, content, 'utf8')
      return { text: `Wrote ${Buffer.byteLength(content)} bytes to ${path.relative(root, target)}.`, isError: false }
    }
    case 'Edit': {
      const target = confine(input.file_path ?? input.path)
      if (!target) return denied('Edit refused: the path is outside the workspace.')
      const before = await readFile(target, 'utf8').catch(() => undefined)
      if (before === undefined) return denied(`Edit failed: ${path.relative(root, target)} does not exist.`)
      const find = String(input.old_string ?? input.find ?? '')
      const replace = String(input.new_string ?? input.replace ?? '')
      if (!find) return denied('Edit requires old_string.')
      if (!before.includes(find)) return denied('Edit failed: old_string was not found in the file.')
      const after = before.split(find).join(replace)
      await writeFile(target, after, 'utf8')
      return { text: `Replaced ${before.split(find).length - 1} occurrence(s) in ${path.relative(root, target)}.`, isError: false }
    }
    case 'Glob': {
      const pattern = String(input.pattern ?? '*')
      const found = []
      const walk = async (dir, depth) => {
        if (depth > 6 || found.length >= 500) return
        const entries = await readdir(dir, { withFileTypes: true }).catch(() => [])
        for (const entry of entries) {
          if (entry.name === 'node_modules' || entry.name === '.git') continue
          const full = path.join(dir, entry.name)
          if (entry.isDirectory()) await walk(full, depth + 1)
          else found.push(path.relative(root, full))
        }
      }
      await walk(root, 0)
      const regex = new RegExp('^' + pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.') + '$')
      const matched = found.filter((file) => regex.test(path.basename(file)) || regex.test(file))
      return { text: matched.slice(0, 200).join('\n') || '(no matches)', isError: false }
    }
    case 'Grep': {
      const pattern = String(input.pattern ?? '')
      if (!pattern) return denied('Grep requires a pattern.')
      let regex
      try {
        regex = new RegExp(pattern, input.case_insensitive ? 'i' : '')
      } catch {
        return denied('Grep failed: the pattern is not a valid regular expression.')
      }
      const hits = []
      const walk = async (dir, depth) => {
        if (depth > 6 || hits.length >= 200) return
        const entries = await readdir(dir, { withFileTypes: true }).catch(() => [])
        for (const entry of entries) {
          if (entry.name === 'node_modules' || entry.name === '.git') continue
          const full = path.join(dir, entry.name)
          if (entry.isDirectory()) await walk(full, depth + 1)
          else {
            const text = await readFile(full, 'utf8').catch(() => undefined)
            if (text === undefined) continue
            text.split('\n').forEach((line, index) => {
              if (regex.test(line)) hits.push(`${path.relative(root, full)}:${index + 1}: ${line.slice(0, 300)}`)
            })
          }
        }
      }
      await walk(root, 0)
      return { text: hits.slice(0, 200).join('\n') || '(no matches)', isError: false }
    }
    default:
      return denied(`The tool "${name}" is not available through the local runtime.`)
  }
}

/**
 * Open the down channel and return a handle that drains it until the signal fires.
 *
 * `onCall` runs for every TOOL_CALL and must upload its own result; the ack loop
 * here only handles COMMANDs, because those are bookkeeping the model never sees.
 */
export async function openSandboxChannel({ identity, cookies, userAgent, sandboxId, workspace, signal, logger, onCall }) {
  const response = await fetch(buildUrl(SSE_PATH, identity, { sand_box_id: sandboxId, client_version: 'unspecified' }), {
    method: 'POST',
    headers: wireHeaders(cookies, userAgent),
    body: JSON.stringify({ device_id: identity.deviceId, client_attrs: { sandbox_id: sandboxId } }),
    signal,
  })
  if (!response.ok) throw new Error(`sandbox channel refused the connection: HTTP ${response.status}`)

  const upload = async (pathname, payload) => {
    const res = await fetch(buildUrl(pathname, identity), {
      method: 'POST',
      headers: wireHeaders(cookies, userAgent),
      body: JSON.stringify(payload),
      signal,
    })
    if (!res.ok) logger?.warn?.(`doubao: upload ${pathname} answered HTTP ${res.status}`)
    return res
  }

  const answer = async (call, result) => {
    await upload(TOOL_RESULT_PATH, {
      sandbox_id: sandboxId,
      device_id: identity.deviceId,
      tool_result: {
        id: call.id,
        name: call.name,
        content: [{ type: 'text', text: result.text }],
        isError: result.isError === true,
      },
    })
  }

  const acknowledge = async (command) => {
    const applied = []
    for (const operation of Array.isArray(command.input?.operations) ? command.input.operations : []) {
      const target = path.resolve(workspace, operation.path ?? '')
      const relative = path.relative(path.resolve(workspace), target)
      if (relative.startsWith('..') || path.isAbsolute(relative)) continue
      try {
        if (operation.type === 'write_file') {
          await mkdir(path.dirname(target), { recursive: true })
          await writeFile(target, operation.content ?? '', { flag: operation.mode === 'append' ? 'a' : 'w' })
        } else if (operation.type === 'ensure_dir') {
          await mkdir(target, { recursive: true })
        } else if (operation.type === 'ensure_file') {
          await mkdir(path.dirname(target), { recursive: true })
          await writeFile(target, '', { flag: 'a' })
        }
        applied.push({ path: operation.path, status: 'success' })
      } catch (error) {
        applied.push({ path: operation.path, status: 'failed', message: String(error?.message ?? error) })
      }
    }
    // Only `need_ack` commands want a reply; the rest are fire-and-forget.
    if (command.needAck !== true) return
    await upload(COMMAND_RESULT_PATH, {
      device_id: identity.deviceId,
      command_result: { id: command.id, code: 0 },
      workspace_apply_response: {
        request_id: command.input?.request_id ?? command.id,
        status: 'success',
        operation_results: applied,
        workspace_ready: true,
      },
    })
  }

  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  const split = frameSplitter()
  const tasks = []

  // Resolves on the first frame the server writes. Subscribing is asynchronous:
  // a task submitted before the stream is live gets dispatched into a channel
  // nobody drains, and the turn comes back as narration with zero executions.
  let markReady
  const ready = new Promise((resolve) => {
    markReady = resolve
  })

  const drain = (async () => {
    try {
      for (;;) {
        const { value, done } = await reader.read()
        if (done) break
        for (const raw of split(decoder.decode(value, { stream: true }))) {
          if (raw.trim() === '') continue
          markReady()
          const { data } = readFrame(raw)
          if (!data) continue
          let payload
          try {
            payload = JSON.parse(data)
          } catch {
            continue
          }
          const classified = classifyFrame(payload)
          if (classified.kind === 'tool') tasks.push(onCall(classified.call, answer))
          else if (classified.kind === 'command') tasks.push(acknowledge(classified.command))
        }
      }
    } catch (error) {
      if (signal?.aborted !== true) logger?.warn?.(`doubao: sandbox channel closed: ${error?.message ?? error}`)
    } finally {
      markReady()
    }
  })()

  return {
    upload,
    answer,
    acknowledge,
    /** Resolves once the subscription is live (or the stream has ended). */
    ready,
    /** Wait for every in-flight answer so the turn cannot report success early. */
    async settle() {
      await drain
      await Promise.allSettled(tasks)
    },
    /**
     * Give queued tool executions a bounded window to finish, without waiting
     * for the long-lived SSE stream to close. Used at the end of a turn.
     */
    async flush(timeoutMs = 3_000) {
      await Promise.race([
        Promise.allSettled(tasks),
        new Promise((resolve) => setTimeout(resolve, timeoutMs)),
      ])
    },
    close() {
      try {
        reader.cancel()
      } catch {
        /* already gone */
      }
    },
  }
}

/** Read the narration and the finish flag out of one chat frame. */
export function absorbChatFrame(event, payload) {
  const segments = []
  let finished = false
  const blocks = []
  if (event === 'STREAM_MSG_NOTIFY' || event === 'FULL_MSG_NOTIFY') {
    blocks.push(...(payload?.content?.content_block ?? payload?.message?.content?.content_block ?? []))
  } else if (event === 'STREAM_CHUNK') {
    for (const op of payload?.patch_op ?? []) {
      if (op?.patch_object === 111) continue // text-to-speech mirror of the same text
      blocks.push(...(op?.patch_value?.content_block ?? []))
    }
  }
  const thinking = new Set()
  for (const block of blocks) {
    const type = Number(block?.block_type)
    if (type === 10040) {
      const id = block?.block_id
      if (id !== undefined && id !== null && id !== '') thinking.add(String(id))
      const body = block?.content?.thinking_block?.text ?? block?.content?.thinking_block?.content
      if (typeof body === 'string' && body !== '') segments.push({ kind: 'reasoning', text: body })
      if (block?.is_finish === true) finished = true
      continue
    }
    if (type !== 10000) continue
    const parent = block?.parent_id
    const isThinkingChild = parent !== undefined && parent !== null && parent !== '' && parent !== 0 && thinking.has(String(parent))
    const text = block?.content?.text_block?.text
    if (typeof text === 'string' && text !== '') segments.push({ kind: isThinkingChild ? 'reasoning' : 'answer', text })
    if (block?.is_finish === true) finished = true
  }
  if (event === 'CHUNK_DELTA' && typeof payload?.text === 'string' && payload.text !== '') {
    segments.push({ kind: 'answer', text: payload.text })
  }
  if (event === 'SSE_REPLY_END') finished = true
  return { segments, finished }
}
