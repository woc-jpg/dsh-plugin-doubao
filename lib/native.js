/**
 * The native task transport: one turn, executed on this machine.
 *
 * The desktop client does not stream a text answer for a task that needs to act.
 * It submits the task with `runtime_type: 2`, the service dispatches tool calls
 * over the sandbox channel, the client runs them locally and uploads the results,
 * and the chat stream carries only the narration around them. That is the
 * difference between "the model talks about running a command" and "the model ran
 * it": on `/chat/completion` alone there is no tool protocol at all, so anything
 * the model says about its own capabilities is just prose.
 *
 * This module owns the wiring — channel, task body, narration parsing — and
 * delegates the two halves to `sandbox.js` (`openSandboxChannel`,
 * `executeNativeTool`). It yields the same event shape the adapter's text path
 * yields, so the adapter can pick either transport without special-casing.
 *
 * @module
 */

import { randomUUID } from 'node:crypto'
import {
  absorbChatFrame,
  buildNativeTaskParam,
  buildUrl,
  executeNativeTool,
  frameSplitter,
  openSandboxChannel,
  readFrame,
} from './sandbox.js'
import { BOT_ID } from './doubao.js'

/** How the local runtime reports a tool it executed, for the host log. */
function describeCall(call) {
  const input = call.input ?? {}
  const detail = input.command ?? input.file_path ?? input.path ?? input.pattern ?? ''
  return `${call.name}(${String(detail).replace(/\s+/g, ' ').slice(0, 120)})`
}

/**
 * The task parameter for one turn.
 *
 * `permission` maps straight onto the service's own scale, so the sandbox allows
 * exactly what the user chose and the model is told so. A risky command is still
 * refused locally under `AskOnRisk` — the service's scale is advisory, the local
 * check is the one that actually runs the shell.
 */
export function buildNativeBody({ text, entry, level, taskParam, localMessageId }) {
  // On the work surface (agent_mode 1) the client always sends 9, regardless of
  // the per-model deep-think value on the chat surface. That number is what makes
  // the service dispatch a local task instead of answering in prose; use the
  // model's own value only for the chat models.
  const deepThink = entry.agentMode === 1 ? 9 : entry.deepThink
  return {
    client_meta: {
      local_conversation_id: 'local_' + Date.now() + '_' + randomUUID(),
      conversation_id: '',
      bot_id: BOT_ID,
      last_section_id: '',
      last_message_index: null,
    },
    messages: [
      {
        local_message_id: localMessageId,
        content_block: [
          {
            block_type: 10000,
            content: { text_block: { text } },
            block_id: randomUUID(),
          },
        ],
        message_status: 0,
      },
    ],
    option: {
      create_time_ms: Date.now(),
      agent_mode: entry.agentMode,
      need_deep_think: deepThink,
      unique_key: randomUUID(),
      recovery_option: {
        is_recovery: false,
        req_create_time_sec: Math.floor(Date.now() / 1000),
        append_sse_event_scene: 0,
      },
      need_create_conversation: true,
      is_old_user: true,
      message_from: 0,
      sse_recv_event_options: { support_chunk_delta: true },
      general_task_param: taskParam,
      conversation_init_option: { need_ack_conversation: true },
      conversation_init_ext: {
        mode_id: entry.modeId,
        model_item_key: entry.key,
        reasoning_effort: String(level),
        agent_task_param: JSON.stringify(taskParam.agent_task_param),
      },
      model_config: {
        model_item_key: entry.key,
        model_extra_params: entry.extraParams ?? {},
        reasoning_effort: level,
      },
      aggregate_params: {
        mention_skill_list: '[]',
        mention_plugin_list: '[]',
        mention_ext: '[{}]',
        conversation_mode: String(entry.convMode),
        mode_id: entry.modeId,
        model_item_key: entry.key,
        agent_mode: String(entry.agentMode),
        reasoning_effort: String(level),
        provider_id: '',
      },
      conversation_mode: entry.convMode,
    },
    user_context: [],
    ext: {
      general_task_param: JSON.stringify(taskParam),
      agent_mode: String(entry.agentMode),
      use_deep_think: String(deepThink),
      sub_conv_firstmet_type: '1',
      collection_id: '',
      is_finish: '1',
      conversation_init_option: '{"need_ack_conversation":true}',
      commerce_credit_config_enable: '0',
    },
  }
}

function wireHeaders(cookies, userAgent) {
  return {
    'content-type': 'application/json',
    'Agw-Js-Conv': 'str',
    cookie: cookies,
    'user-agent': userAgent,
    origin: 'https://www.doubao.com',
    referer: 'https://www.doubao.com/chat/',
  }
}

/**
 * Run one turn natively.
 *
 * Yields `{type:'reasoning'|'delta', text}`, `{type:'executed', call, result}` for
 * each local execution, and `{type:'error', code, message}` on failure. The
 * caller turns `executed` into whatever the host should see.
 */
export async function* streamNativeTask({
  identity,
  cookies,
  userAgent,
  text,
  entry,
  level,
  workspace,
  permission = 'AskOnRisk',
  homeDir,
  signal,
  logger,
  fetchImpl = (...args) => fetch(...args),
}) {
  const sandboxId = 'route-' + randomUUID()
  const localMessageId = randomUUID()
  const executed = []

  // Kept outside the try only as a declaration: opening the channel can fail
  // (network, abort), and that error must be yielded to the caller, never left
  // as an unhandled rejection from a generator the adapter is awaiting.
  let channel
  try {
    channel = await openSandboxChannel({
      identity,
      cookies,
      userAgent,
      sandboxId,
      workspace,
      signal,
      logger,
      onCall: async (call, answer) => {
        let result
        try {
          result = await executeNativeTool(call.name, call.input, { workspace, permission })
        } catch (error) {
          result = { text: `${call.name} failed: ${error?.message ?? error}`, isError: true }
        }
        executed.push({ call, result })
        // Every dispatch must be answered or the service re-issues it forever
        // and the turn never finishes. This is the one rule of the channel.
        await answer(call, result)
      },
    })

    // The SSE POST must have reached the server before the task is submitted:
    // calls are routed by sandboxId, so a task submitted before the channel is
    // live dispatches into the void and the turn ends with no executions.
    await new Promise((resolve) => setTimeout(resolve, 500))

    const taskParam = buildNativeTaskParam({
      workspace,
      sandboxId,
      deviceId: identity.deviceId,
      permission,
      homeDir,
      localMessageId,
    })
    const body = buildNativeBody({ text, entry, level, taskParam, localMessageId })

    // The native task path needs the sandbox aid (1044603), not the chat aid.
    // Using the chat query here routes the request through a different backend
    // that answers in prose but never dispatches to the sandbox channel.
    const response = await fetchImpl(buildUrl('/chat/completion', identity), {
      method: 'POST',
      headers: wireHeaders(cookies, userAgent),
      body: JSON.stringify(body),
      signal,
    })
    if (!response.ok || !response.body) {
      const detail = await response.text().catch(() => '')
      yield { type: 'error', code: response.status, message: `http ${response.status} ${detail.slice(0, 300)}` }
      return
    }

    const split = frameSplitter()
    const decoder = new TextDecoder()
    let reported = 0
    for await (const chunk of response.body) {
      for (const raw of split(decoder.decode(chunk, { stream: true }))) {
        const { event, data } = readFrame(raw)
        if (!data) continue
        let payload
        try {
          payload = JSON.parse(data)
        } catch {
          continue
        }
        // Surface each execution as soon as it has happened, so a long
        // command is visible while the model is still working.
        while (reported < executed.length) {
          const done = executed[reported++]
          logger?.info?.(`doubao: ran ${describeCall(done.call)}`)
          yield { type: 'executed', call: done.call, result: done.result }
        }
        const absorbed = absorbChatFrame(event, payload)
        for (const segment of absorbed.segments) {
          yield segment.kind === 'answer'
            ? { type: 'delta', text: segment.text }
            : { type: 'reasoning', text: segment.text }
        }
      }
    }
    // The sandbox channel drains asynchronously and may stay open after the
    // reply. Closing it ends the reader loop; the tasks already queued still
    // resolve. Give them a short, bounded window to land, then report whatever
    // executed. A lingering channel must never hang the model's turn.
    channel.close()
    await channel.flush(3_000)
    while (reported < executed.length) {
      const done = executed[reported++]
      logger?.info?.(`doubao: ran ${describeCall(done.call)}`)
      yield { type: 'executed', call: done.call, result: done.result }
    }
  } catch (error) {
    if (signal?.aborted !== true) {
      yield { type: 'error', code: 0, message: `native task failed: ${error?.message ?? error}` }
    }
  } finally {
    channel?.close()
  }
}
