/**
 * The billing rate the Doubao client prints next to each model.
 *
 * The rate is not a documented API field: the client gets it as a display tag
 * on the model rows of the action-bar brief, `/alice/slot/action_bar_v3/brief_list`.
 * Each item carries `tag_list`, and the rate rides in there as text — `0.65x`
 * for a paid model, `限时优惠 0.01x` during a promotion, `小额免费` for the free
 * tier. That is the number the official client shows the user, so it is the
 * only honest source; guessing a table from prices published elsewhere would
 * drift the moment a promotion starts.
 *
 * The fetch needs the same identity pair as chatting (device_id + fp) and the
 * session cookie, so it can only run after sign-in. When it fails, the fallback
 * below keeps the picker informative instead of bare — it is the reading taken
 * on 2026-11-14 and is only ever used until a live fetch succeeds.
 */
import { BOT_ID, DEFAULT_UA, buildQuery } from './doubao.js'

const BRIEF_URL = 'https://www.doubao.com/alice/slot/action_bar_v3/brief_list'

/** Reading of 2026-11-14, keyed by `model_item_key`. */
export const FALLBACK_RATES = Object.freeze({
  '9': '小额免费',
  'seed-lite-7b': 'x0.01 限时优惠',
  '5': 'x0.65',
  'person-deepseek-v4-1-flash-261017': 'x0.01 限时优惠',
  'person-kimi-k3-1-pro-261111': 'x0.95',
  'person-kimi-k3-1-pro-highspeed-261111': 'x1.44',
  'person-kimi-k3-261111': 'x1.48',
  'person-glm-5-3-261111': 'x0.80',
  'person-glm-5-3-flash-261111': 'x0.08',
  'person-deepseek-v4-pro-ga-260813': 'x0.46',
})

/**
 * Turn one row's tags into the suffix shown after the model name.
 *
 * The client writes the multiplier and the promotion in one string
 * (`限时优惠 0.01x`), so it is split: the number becomes `x0.01`, the words that
 * remain stay after it. A tag with no number (`小额免费`) is passed through
 * verbatim — there is nothing to reformat and inventing `x0.00` would claim a
 * precision the upstream does not publish.
 */
export function rateFromTags(tags) {
  const parts = []
  for (const tag of tags ?? []) {
    const text = typeof tag === 'string' ? tag : tag?.text
    if (typeof text !== 'string' || text.trim() === '') continue
    const trimmed = text.trim()
    const match = /(\d+(?:\.\d+)?)\s*x\b/i.exec(trimmed)
    if (!match) {
      parts.push(trimmed)
      continue
    }
    const words = trimmed.replace(match[0], '').replace(/\s+/g, ' ').trim()
    parts.push(`x${match[1]}${words ? ` ${words}` : ''}`)
  }
  return parts.length === 0 ? undefined : parts.join(' · ')
}

/** Walk an arbitrary brief payload and collect `model_item_key` -> rate. */
export function ratesFromBrief(payload) {
  const rates = {}
  const visit = (node) => {
    if (Array.isArray(node)) {
      for (const child of node) visit(child)
      return
    }
    if (!node || typeof node !== 'object') return
    if (typeof node.model_item_key === 'string' || typeof node.model_item_key === 'number') {
      const rate = rateFromTags(node.tag_list)
      if (rate !== undefined) rates[String(node.model_item_key)] = rate
    }
    for (const value of Object.values(node)) visit(value)
  }
  visit(payload)
  return rates
}

/**
 * Fetch the live rates. Never throws: a failure resolves to an empty table so
 * the caller keeps whatever it last showed instead of downgrading a live rate
 * back to the fallback snapshot. `FALLBACK_RATES` is the caller's starting
 * seed, not this function's error result.
 */
export async function fetchModelRates({ identity, cookies, signal, timeoutMs = 5_000, logger } = {}) {
  if (!identity?.deviceId || !cookies) return {}
  const query = new URLSearchParams(buildQuery(identity))
  try {
    const response = await fetch(`${BRIEF_URL}?${query}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json, text/plain, */*',
        'Agw-Js-Conv': 'str',
        'User-Agent': DEFAULT_UA,
        Origin: 'https://www.doubao.com',
        Referer: 'https://www.doubao.com/chat/',
        Cookie: cookies,
      },
      body: JSON.stringify({ bot_id: BOT_ID, language_code: 'zh' }),
      signal: signal ?? AbortSignal.timeout(timeoutMs),
    })
    if (!response.ok) {
      logger?.warn?.(`doubao: model rate lookup returned HTTP ${response.status}; keeping the last known table`)
      return {}
    }
    const rates = ratesFromBrief(await response.json())
    if (Object.keys(rates).length === 0) {
      logger?.warn?.('doubao: model rate lookup carried no tags; keeping the last known table')
    }
    return rates
  } catch (error) {
    logger?.warn?.(`doubao: model rate lookup failed (${error?.message ?? error}); keeping the last known table`)
    return {}
  }
}
