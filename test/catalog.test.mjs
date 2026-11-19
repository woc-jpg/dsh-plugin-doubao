/**
 * The catalog is read from the client's own brief payload, so the parser is
 * tested against the exact shape that endpoint returns — a fixture cut down from
 * a live `/alice/slot/action_bar_v3/brief_list` response on 2026-11-19.
 *
 * The two things that used to be hard-coded and drifted are asserted here: the
 * model rows themselves (a model the account gains shows up, one it loses goes
 * away) and the per-model thinking tiers (GLM lists 3/5/7, Qwen 3/5/6, the
 * DeepSeek rows 3..7 — a single shared ladder cannot be right for all of them).
 */
import test from 'node:test'
import assert from 'node:assert/strict'

import {
  FALLBACK_MODELS,
  catalogFromBrief,
  effortsFor,
  idForKey,
  EFFORT_ID_LEVEL,
  LEVEL_EFFORT_ID,
} from '../lib/catalog.js'
import { buildBody, MODELS } from '../lib/doubao.js'

/** One `model_list.item_list` row, as the brief shapes it. */
function row(key, name, { mode = '3', itemId = 10001, levels = [3, 4, 5], extra, tags = [] } = {}) {
  return {
    item_id: itemId,
    model_item_key: key,
    name,
    default_mode: mode,
    conversation_mode_list: mode === '1' ? ['chat', 'creation'] : ['office', 'creation'],
    model_extra_params: extra,
    tag_list: tags.map((text) => ({ text })),
    reasoning_effort_config: {
      default_level: levels[0],
      option_list: levels.map((level) => ({ level, name: String(level) })),
    },
  }
}

/** A payload with the nesting the real endpoint uses (`menu_conf_v2` + `menu_conf`). */
function brief({ models, modes = [] }) {
  return {
    data: {
      entry_list: [{
        action_bar_key: 'coco_deep_thinking',
        active_switch_conf: {
          menu_conf_v2: { model_list: { item_list: models }, mode_list: { item_list: [] } },
          menu_conf: { item_list: modes },
        },
      }],
    },
  }
}

test('catalogFromBrief reads every row the account can reach', () => {
  const payload = brief({
    models: [
      row('0', '快速', { mode: '1', itemId: 0, levels: [3, 4, 5] }),
      row('person-deepseek-v4-1-flash-261017', 'DeepSeek V4.1 Flash', {
        levels: [3, 4, 5, 6, 7],
        extra: { memory_profile: '300k_230', total_window_size: '300000' },
        tags: ['限时优惠 0.01x'],
      }),
      row('person-glm-5-3-261111', 'GLM 5.3', { levels: [3, 5, 7], extra: { total_window_size: '300000' } }),
      row('person-qwen4-max', 'Qwen 4 Max', { levels: [3, 5, 6], extra: { total_window_size: '300000' } }),
    ],
    modes: [{ item_id: 0, agent_mode: 2 }, { item_id: 10001, agent_mode: 1 }],
  })
  const entries = catalogFromBrief(payload)
  assert.deepEqual(entries.map((e) => e.key), [
    '0',
    'person-deepseek-v4-1-flash-261017',
    'person-glm-5-3-261111',
    'person-qwen4-max',
  ])
  const glm = entries.find((e) => e.key === 'person-glm-5-3-261111')
  assert.deepEqual(glm.levels, [3, 5, 7], 'GLM offers a non-contiguous ladder')
  assert.equal(glm.name, 'GLM 5.3')
  assert.equal(glm.modeId, '3')
  assert.equal(glm.agentMode, 1, 'agent_mode comes from the mode rows, keyed by item_id')
  assert.equal(glm.contextWindow, 300_000)

  const chat = entries.find((e) => e.key === '0')
  assert.equal(chat.modeId, '1')
  assert.equal(chat.agentMode, 2)
})

test('catalogFromBrief keeps model_extra_params instead of dropping them', () => {
  const payload = brief({
    models: [row('person-deepseek-v4-1-flash-261017', 'DeepSeek V4.1 Flash', {
      extra: { memory_profile: '300k_230', total_window_size: '300000' },
    })],
  })
  const [entry] = catalogFromBrief(payload)
  assert.deepEqual(entry.extraParams, { memory_profile: '300k_230', total_window_size: '300000' })
  assert.equal(entry.contextWindow, 300_000)
})

test('catalogFromBrief deduplicates a key the payload lists twice', () => {
  const payload = brief({ models: [row('5', '豆包 2.1 Pro'), row('5', '豆包 2.1 Pro')] })
  assert.equal(catalogFromBrief(payload).length, 1)
})

test('catalogFromBrief reports "no rows" as undefined so the last table survives', () => {
  assert.equal(catalogFromBrief({ data: {} }), undefined)
  assert.equal(catalogFromBrief({ data: { entry_list: [] } }), undefined)
  assert.equal(catalogFromBrief(undefined), undefined)
  // A row without a key cannot be requested, so it is not a model.
  assert.equal(catalogFromBrief(brief({ models: [{ name: 'nameless' }] })), undefined)
})

test('a row without an effort config still gets the historical ladder', () => {
  const payload = brief({ models: [{ model_item_key: 'x', name: 'X', default_mode: '3' }] })
  const [entry] = catalogFromBrief(payload)
  assert.deepEqual(entry.levels, [3, 4, 5])
  assert.equal(entry.effort, 3)
})

test('idForKey keeps the ids a saved session already contains', () => {
  // These twelve are in shipped configs and saved sessions; changing them would
  // silently move someone onto a different model.
  assert.equal(idForKey('0'), 'doubao')
  assert.equal(idForKey('3'), 'doubao-expert')
  assert.equal(idForKey('9'), 'doubao-auto')
  assert.equal(idForKey('seed-lite-7b'), 'doubao-2.1-lite')
  assert.equal(idForKey('5'), 'doubao-2.1-pro')
  assert.equal(idForKey('person-deepseek-v4-1-flash-261017'), 'deepseek-v4.1-flash')
  assert.equal(idForKey('person-glm-5-3-261111'), 'glm-5.3')
  // A model added after this build derives a readable slug.
  assert.equal(idForKey('person-some-new-model-270101'), 'some-new-model')
})

test('every shipped model advertises exactly the tiers it lists', () => {
  for (const model of MODELS) {
    const ids = effortsFor(model).map((e) => e.id)
    assert.equal(ids[0], 'off', `${model.id} must lead with Off`)
    assert.deepEqual(ids.slice(1), model.levels.map((level) => LEVEL_EFFORT_ID[level]))
    assert.equal(new Set(ids).size, ids.length, `${model.id} must not repeat a tier`)
  }
})

test('the level and effort tables are inverses', () => {
  for (const [level, id] of Object.entries(LEVEL_EFFORT_ID)) {
    assert.equal(EFFORT_ID_LEVEL[id], Number(level))
  }
})

test('buildBody sends the requested level and the model memory parameters', () => {
  const entry = FALLBACK_MODELS.find((m) => m.key === 'person-deepseek-v4-1-flash-261017')
  const body = buildBody('hello', { entry, effort: 6 })
  // The service reads the level as a number here and as a string in the two
  // other copies of the same field.
  assert.equal(body.option.model_config.reasoning_effort, 6)
  assert.equal(body.option.conversation_init_ext.reasoning_effort, '6')
  assert.equal(body.option.aggregate_params.reasoning_effort, '6')
  assert.deepEqual(body.option.model_config.model_extra_params, {
    memory_profile: '300k_230',
    total_window_size: '300000',
  })
})

test('buildBody falls back to the model default when no tier is requested', () => {
  const entry = FALLBACK_MODELS.find((m) => m.key === 'person-glm-5-3-flash-261111')
  const body = buildBody('hello', { entry })
  assert.equal(body.option.model_config.reasoning_effort, entry.effort)
  assert.equal(body.option.model_config.model_extra_params.total_window_size, '300000')
})
