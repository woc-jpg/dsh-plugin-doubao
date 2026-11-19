/**
 * The model catalog, read from the same brief the Doubao client renders.
 *
 * `/alice/slot/action_bar_v3/brief_list` is the menu payload behind the model
 * picker: every row carries the wire key (`model_item_key`), the display name,
 * the surface it belongs to (`default_mode`), the context window
 * (`model_extra_params.total_window_size`) and — the part this plugin used to
 * hard-code away — `reasoning_effort_config.option_list`, which is the real list
 * of thinking depths that model accepts.
 *
 * Reading it instead of shipping a table has three consequences worth stating:
 *
 *   - a model Doubao adds (Qwen, GLM, whatever lands next) shows up without a
 *     release, and one it retires disappears on its own;
 *   - the reasoning levels are the account's real ones, per model. The tiers are
 *     not uniform: GLM offers 3/5/7 while Qwen offers 3/5/6, so any fixed ladder
 *     would either offer a level the model rejects or hide one it accepts;
 *   - `model_extra_params` can be forwarded verbatim, which is what tells the
 *     service how much memory to reserve for the request.
 *
 * `FALLBACK_MODELS` is the reading taken on 2026-11-19, used only until a live
 * fetch succeeds — the same rule `rates.js` follows, for the same reason: an
 * unreachable endpoint must not empty the picker.
 */

/** Reading of 2026-11-19, in the order the client lists them. */
export const FALLBACK_MODELS = Object.freeze([
  { id: 'doubao', key: '0', name: '快速', modeId: '1', agentMode: 2, convMode: 1, effort: 3, deepThink: 0, levels: [3, 4, 5], extraParams: undefined, contextWindow: 131_072 },
  { id: 'doubao-expert', key: '3', name: '专家', modeId: '1', agentMode: 2, convMode: 1, effort: 3, deepThink: 1, levels: [3, 4, 5], extraParams: undefined, contextWindow: 131_072 },
  { id: 'doubao-auto', key: '9', name: '自动', modeId: '3', agentMode: 1, convMode: 3, effort: 3, deepThink: 9, levels: [3, 4, 5], extraParams: { total_window_size: '256000' }, contextWindow: 256_000 },
  { id: 'doubao-2.1-lite', key: 'seed-lite-7b', name: '豆包 2.1 Lite', modeId: '3', agentMode: 1, convMode: 3, effort: 3, deepThink: 4, levels: [3, 4, 5], extraParams: { memory_profile: '256k', total_window_size: '256000' }, contextWindow: 256_000 },
  { id: 'doubao-2.1-pro', key: '5', name: '豆包 2.1 Pro', modeId: '3', agentMode: 1, convMode: 3, effort: 3, deepThink: 5, levels: [3, 4, 5], extraParams: { total_window_size: '256000' }, contextWindow: 256_000 },
  { id: 'deepseek-v4.1-flash', key: 'person-deepseek-v4-1-flash-261017', name: 'DeepSeek V4.1 Flash', modeId: '3', agentMode: 1, convMode: 3, effort: 3, deepThink: 4, levels: [3, 4, 5, 6, 7], extraParams: { memory_profile: '300k_230', total_window_size: '300000' }, contextWindow: 300_000 },
  { id: 'qwen4-max', key: 'person-qwen4-max', name: 'Qwen 4 Max', modeId: '3', agentMode: 1, convMode: 3, effort: 3, deepThink: 4, levels: [3, 5, 6], extraParams: { memory_profile: '300k_230', total_window_size: '300000' }, contextWindow: 300_000 },
  { id: 'kimi-k3.1-pro', key: 'person-kimi-k3-1-pro-261111', name: 'Kimi K3.1 Pro', modeId: '3', agentMode: 1, convMode: 3, effort: 3, deepThink: 4, levels: [3, 4, 5, 6, 7], extraParams: { memory_profile: '300k_230', total_window_size: '300000' }, contextWindow: 300_000 },
  { id: 'kimi-k3.1-pro-highspeed', key: 'person-kimi-k3-1-pro-highspeed-261111', name: 'Kimi K3.1 Pro 高速', modeId: '3', agentMode: 1, convMode: 3, effort: 3, deepThink: 4, levels: [3, 4, 5, 6, 7], extraParams: { memory_profile: '300k_230', total_window_size: '300000' }, contextWindow: 300_000 },
  { id: 'kimi-k3', key: 'person-kimi-k3-261111', name: 'Kimi K3', modeId: '3', agentMode: 1, convMode: 3, effort: 3, deepThink: 4, levels: [3, 4, 5, 6, 7], extraParams: { memory_profile: '300k_230', total_window_size: '300000' }, contextWindow: 300_000 },
  { id: 'glm-5.3', key: 'person-glm-5-3-261111', name: 'GLM 5.3', modeId: '3', agentMode: 1, convMode: 3, effort: 3, deepThink: 8, levels: [3, 5, 7], extraParams: { memory_profile: '300k_230', total_window_size: '300000' }, contextWindow: 300_000 },
  { id: 'glm-5.3-flash', key: 'person-glm-5-3-flash-261111', name: 'GLM 5.3 Flash', modeId: '3', agentMode: 1, convMode: 3, effort: 3, deepThink: 8, levels: [3, 5, 7], extraParams: { memory_profile: '300k_230', total_window_size: '300000' }, contextWindow: 300_000 },
  { id: 'deepseek-v4-pro', key: 'person-deepseek-v4-pro-ga-260813', name: 'DeepSeek V4 Pro', modeId: '3', agentMode: 1, convMode: 3, effort: 3, deepThink: 4, levels: [3, 4, 5, 6, 7], extraParams: { memory_profile: '300k_230', total_window_size: '300000' }, contextWindow: 300_000 },
  { id: 'qwen3.8-max', key: 'person-qwen3-8-max', name: 'Qwen 3.8 Max', modeId: '3', agentMode: 1, convMode: 3, effort: 3, deepThink: 4, levels: [3, 5, 6], extraParams: { memory_profile: '300k_230', total_window_size: '300000' }, contextWindow: 300_000 },
  { id: 'qwen3.8-flash', key: 'person-qwen3-8-flash', name: 'Qwen 3.8 Flash', modeId: '3', agentMode: 1, convMode: 3, effort: 3, deepThink: 4, levels: [3, 5, 6], extraParams: { memory_profile: '300k_230', total_window_size: '300000' }, contextWindow: 300_000 },
].map(Object.freeze))

/**
 * Stable id per wire key.
 *
 * The twelve rows that predate the dynamic catalog keep the ids they always had,
 * because those ids are what a saved session and a hand-written config contain —
 * changing them would silently move a user onto a different model. New rows get
 * a derived slug.
 */
export const ID_BY_KEY = Object.freeze({
  '0': 'doubao',
  '3': 'doubao-expert',
  '9': 'doubao-auto',
  'seed-lite-7b': 'doubao-2.1-lite',
  '5': 'doubao-2.1-pro',
  'person-deepseek-v4-1-flash-261017': 'deepseek-v4.1-flash',
  'person-deepseek-v4-pro-ga-260813': 'deepseek-v4-pro',
  'person-kimi-k3-1-pro-261111': 'kimi-k3.1-pro',
  'person-kimi-k3-1-pro-highspeed-261111': 'kimi-k3.1-pro-highspeed',
  'person-kimi-k3-261111': 'kimi-k3',
  'person-glm-5-3-261111': 'glm-5.3',
  'person-glm-5-3-flash-261111': 'glm-5.3-flash',
  'person-qwen4-max': 'qwen4-max',
  'person-qwen3-8-max': 'qwen3.8-max',
  'person-qwen3-8-flash': 'qwen3.8-flash',
})

/** Key -> id, or a derived slug for a model this build has never seen. */
export function idForKey(key) {
  const known = ID_BY_KEY[key]
  if (known) return known
  return String(key)
    .replace(/^person-/, '')
    .replace(/-\d{6}$/, '')
    .replace(/_/g, '-')
}

/**
 * Reasoning level -> effort id.
 *
 * The service speaks numbers (3..7); the harness speaks ids. `low`/`medium`/
 * `high`/`xhigh`/`max` keep their usual meaning and map onto that ladder, so a
 * level a model does not offer is simply never advertised for it.
 */
export const LEVEL_EFFORT_ID = Object.freeze({
  3: 'low',
  4: 'medium',
  5: 'high',
  6: 'xhigh',
  7: 'max',
})

/** Effort id -> level, the inverse of the table above. */
export const EFFORT_ID_LEVEL = Object.freeze(
  Object.fromEntries(Object.entries(LEVEL_EFFORT_ID).map(([level, id]) => [id, Number(level)])),
)

/** Level -> the name Doubao itself prints for that tier. */
const LEVEL_NAME = Object.freeze({ 3: '低', 4: '中', 5: '高', 6: '极高', 7: '最高' })

/** Depth ids kept for the two chat-surface models, which use a switch instead. */
const DEEP_THINK_BY_KEY = Object.freeze({ '0': 0, '3': 1, '9': 9, 'seed-lite-7b': 4, '5': 5, 'person-glm-5-3-261111': 8, 'person-glm-5-3-flash-261111': 8 })

/**
 * Descriptions stay local: the brief has no such field, and a description
 * written from the model's own name would only repeat it. Anything not listed
 * gets a one-line generic description rather than an empty string, which the
 * picker renders as a blank row.
 */
const DESCRIPTIONS = Object.freeze({
  doubao: 'Doubao 2.1, the everyday chat model.',
  'doubao-expert': 'Doubao with extended thinking turned on.',
  'doubao-auto': 'Doubao decides per request how much to think.',
  'doubao-2.1-lite': 'Small, fast Doubao 2.1.',
  'doubao-2.1-pro': 'Full-size Doubao 2.1.',
  'deepseek-v4.1-flash': 'DeepSeek V4.1 Flash, served through Doubao.',
  'deepseek-v4-pro': 'DeepSeek V4 Pro, served through Doubao.',
  'kimi-k3.1-pro': 'Kimi K3.1 Pro, served through Doubao.',
  'kimi-k3.1-pro-highspeed': 'Kimi K3.1 Pro on the low-latency tier.',
  'kimi-k3': 'Kimi K3, served through Doubao.',
  'glm-5.3': 'GLM 5.3, served through Doubao.',
  'glm-5.3-flash': 'GLM 5.3 on the fast tier.',
})

function windowsOf(extraParams) {
  const raw = extraParams && typeof extraParams === 'object' ? extraParams.total_window_size : undefined
  const value = Number(raw)
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : undefined
}

/**
 * Level list for one row.
 *
 * `option_list` is the account's truth. When a row omits it (older payloads, and
 * the two chat-surface models on some builds) the historical 3/4/5 ladder is
 * assumed — that is what those models accepted before the levels were exposed.
 */
function levelsOf(item) {
  const config = item?.reasoning_effort_config
  const options = Array.isArray(config?.option_list) ? config.option_list : []
  const levels = options
    .map((option) => Number(option?.level))
    .filter((level) => Number.isFinite(level) && LEVEL_EFFORT_ID[level] !== undefined)
  const unique = [...new Set(levels)].sort((a, b) => a - b)
  return unique.length > 0 ? unique : [3, 4, 5]
}

function defaultLevelOf(item, levels) {
  const value = Number(item?.reasoning_effort_config?.default_level)
  return levels.includes(value) ? value : levels[0]
}

/** Walk a payload and return the first `model_list.item_list` array. */
function findModelRows(payload) {
  let found
  const visit = (node) => {
    if (found || !node || typeof node !== 'object') return
    if (Array.isArray(node.model_list?.item_list) && node.model_list.item_list.length > 0) {
      found = node.model_list.item_list
      return
    }
    for (const value of Object.values(node)) visit(value)
  }
  visit(payload)
  return found
}

/** agent_mode lives on the mode rows, keyed by item_id. */
function agentModesOf(payload) {
  const modes = {}
  let list
  const visit = (node) => {
    if (list || !node || typeof node !== 'object') return
    if (Array.isArray(node.menu_conf?.item_list)) {
      list = node.menu_conf.item_list
      return
    }
    for (const value of Object.values(node)) visit(value)
  }
  visit(payload)
  for (const entry of list ?? []) {
    const id = String(entry?.item_id ?? '')
    const mode = Number(entry?.agent_mode)
    if (id && Number.isFinite(mode) && modes[id] === undefined) modes[id] = mode
  }
  return modes
}

/**
 * Turn a brief payload into catalog entries.
 *
 * Returns `undefined` when the payload carries no model rows at all, so the
 * caller can tell "the service answered with nothing useful" apart from "the
 * account really has zero models" (which it never has) and keep its last table.
 */
export function catalogFromBrief(payload) {
  const rows = findModelRows(payload)
  if (!rows) return undefined
  const agentModes = agentModesOf(payload)
  const entries = []
  const seen = new Set()
  for (const item of rows) {
    const key = item?.model_item_key
    if (typeof key !== 'string' && typeof key !== 'number') continue
    const keyText = String(key)
    if (seen.has(keyText)) continue
    seen.add(keyText)
    const id = idForKey(keyText)
    const levels = levelsOf(item)
    const modeId = String(item?.default_mode ?? (String(item?.item_id) === '0' || String(item?.item_id) === '3' ? '1' : '3'))
    const agentMode = Number.isFinite(agentModes[String(item?.item_id)]) ? agentModes[String(item.item_id)] : modeId === '1' ? 2 : 1
    const extraParams = item?.model_extra_params && typeof item.model_extra_params === 'object' ? { ...item.model_extra_params } : undefined
    entries.push(Object.freeze({
      id,
      key: keyText,
      name: typeof item?.name === 'string' && item.name.trim() !== '' ? item.name.trim() : id,
      modeId,
      agentMode,
      convMode: modeId === '1' ? 1 : 3,
      effort: defaultLevelOf(item, levels),
      deepThink: DEEP_THINK_BY_KEY[keyText] ?? (modeId === '1' ? 0 : 4),
      levels,
      extraParams,
      contextWindow: windowsOf(extraParams),
      needLogin: item?.need_login === true,
      description: DESCRIPTIONS[id] ?? `${item?.name ?? id}, served through Doubao.`,
    }))
  }
  return entries.length > 0 ? entries : undefined
}

/** The effort list a model offers: Off plus every level the service listed. */
export function effortsFor(entry) {
  const off = { id: 'off', name: 'Off', description: 'Answer without extended thinking.' }
  const levels = Array.isArray(entry?.levels) && entry.levels.length > 0 ? entry.levels : [3, 4, 5]
  return [
    off,
    ...levels.map((level) => ({
      id: LEVEL_EFFORT_ID[level],
      name: LEVEL_NAME[level] ?? String(level),
      description: `Reasoning level ${level}, the tier Doubao labels ${LEVEL_NAME[level] ?? level}.`,
    })),
  ]
}
