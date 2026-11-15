/**
 * The credits the Doubao account has left.
 *
 * Like the model rates, this is not a documented API: the number the client
 * prints in its own account panel comes from
 * `/alice/commerce/sale/subscription/quota/summary/`, which the web client calls
 * when that panel opens. It answers with the account's quota groups — the
 * activity-granted allowance (`活动赠送额度`) and the monthly plan allowance
 * (`monthly_quota`) — each carrying `total_amount` and `used_amount` as
 * thousand-separated *strings* (`"9,000"`). Remaining credit is therefore a
 * subtraction, not a field; publishing a number the upstream does not send
 * would drift the moment the plan changes.
 *
 * `POST` only. A `GET` on the same path is a 404 with an empty body, which is
 * how this endpoint announced itself while it was being found.
 *
 * Failures resolve to `undefined`, never to zero: "we could not read it" and
 * "you have none left" are different answers, and the readout says `—` for the
 * first while only the second should look like an empty balance.
 */
import { DEFAULT_UA, buildQuery } from './doubao.js'

const QUOTA_URL = 'https://www.doubao.com/alice/commerce/sale/subscription/quota/summary/'

/** Group keys whose upstream label is blank, mapped to what the user calls them. */
const GROUP_LABELS = Object.freeze({
  monthly_quota: '月度额度',
  doubao_activity_reward_quota: '活动赠送额度',
})

/**
 * Read one `total_amount` / `used_amount` string as a number.
 *
 * The upstream format is `"1,200"`; anything unparsable is treated as absent
 * rather than as zero, so a shape change degrades the readout instead of
 * silently reporting an empty balance.
 */
export function amountOf(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value !== 'string') return undefined
  const digits = value.replace(/[,\s_]/g, '')
  if (!/^-?\d+(?:\.\d+)?$/.test(digits)) return undefined
  const parsed = Number(digits)
  return Number.isFinite(parsed) ? parsed : undefined
}

/** Turn one upstream window into the row the readout shows. */
function windowOf(group, limit) {
  const total = amountOf(limit?.total_amount)
  const used = amountOf(limit?.used_amount)
  if (total === undefined && used === undefined) return undefined
  const limitAmount = total ?? 0
  const usedAmount = used ?? 0
  return {
    key: String(group?.feature_group ?? ''),
    label: String(group?.feature_group_name ?? '').trim() || GROUP_LABELS[group?.feature_group] || String(group?.feature_group ?? '额度'),
    limit: limitAmount,
    used: usedAmount,
    // A negative remainder would mean the upstream counted more usage than
    // allowance; clamp it so the readout cannot print a negative balance.
    remaining: Math.max(0, limitAmount - usedAmount),
    percent: typeof limit?.used_percent === 'number' ? limit.used_percent : undefined,
    endTime: typeof limit?.end_time === 'number' ? limit.end_time : undefined,
  }
}

/**
 * Flatten a `quota/summary` answer into the one shape the UI renders.
 *
 * Both sections are walked the same way — the activity allowance and the plan
 * allowance are the same kind of fact, so they are summed rather than
 * special-cased, and a future third section needs no code change.
 */
export function creditsFromSummary(payload) {
  const data = payload?.data
  if (!data || typeof data !== 'object') return undefined
  const groups = []
  for (const section of [data.incentive_quota_section, data.window_limit_section]) {
    for (const group of section?.window_limit_groups ?? []) {
      for (const limit of group?.window_limits ?? []) {
        const row = windowOf(group, limit)
        if (row !== undefined) groups.push(row)
      }
    }
  }
  const sum = (pick) => groups.reduce((total, row) => total + pick(row), 0)
  // No parsable window means the answer did not carry a balance, which is not
  // the same fact as "nothing left" — the readout must not print 0 for it.
  if (groups.length === 0) return undefined
  const subscription = data.current_subscription ?? {}
  return {
    groups,
    limit: sum((row) => row.limit),
    used: sum((row) => row.used),
    remaining: sum((row) => row.remaining),
    plan: String(subscription.display?.short_name ?? '').trim() || undefined,
    planEndTime: typeof subscription.end_time === 'number' ? subscription.end_time : undefined,
  }
}

/** `9,793` — the same thousand-separated spelling the client uses. */
export function formatAmount(value) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return '—'
  return Math.round(value).toLocaleString('en-US')
}

/**
 * Fetch the live balance. Never throws: `undefined` means "could not read it",
 * which the caller renders as an em dash rather than as an empty balance.
 */
export async function fetchCredits({ identity, cookies, signal, timeoutMs = 5_000, logger } = {}) {
  if (!identity?.deviceId || !cookies) return undefined
  const query = new URLSearchParams(buildQuery(identity))
  try {
    const response = await fetch(`${QUOTA_URL}?${query}`, {
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
      body: '{}',
      signal: signal ?? AbortSignal.timeout(timeoutMs),
    })
    if (!response.ok) {
      logger?.warn?.(`doubao: credit lookup returned HTTP ${response.status}`)
      return undefined
    }
    const credits = creditsFromSummary(await response.json())
    if (credits === undefined) {
      logger?.warn?.('doubao: credit lookup carried no quota groups')
      return undefined
    }
    return { ...credits, fetchedAt: Date.now() }
  } catch (error) {
    logger?.warn?.(`doubao: credit lookup failed (${error?.message ?? error})`)
    return undefined
  }
}
