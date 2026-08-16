/**
 * P1 行为对照测试 — 对照参考实现（Python）语义。
 * 用 node:test + tsx 运行：pnpm test
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { DlcEngine, createEntity, applyModifier, applyEffect, tickTimedEffects, checkThresholds } from '../src/index.ts'

/** 每测试独立卡片目录副本（state 目录隔离）。 */
function freshCard(): string {
  const dir = join(tmpdir(), `dlc-test-${Date.now()}-${Math.random().toString(36).slice(2)}`)
  rmSync(dir, { recursive: true, force: true })
  mkdirSync(join(dir, 'engine'), { recursive: true })
  mkdirSync(join(dir, 'interaction'), { recursive: true })
  const copy = (name: string, data: unknown): void => {
    writeFileSync(join(dir, name), JSON.stringify(data, null, 2), 'utf8')
  }
  copy('card.json', {
    protocol_version: '1.0.0', card_id: 'my-card', card_name: '测试卡',
    complexity_level: 'L3', author: 'soli', created_at: '2026-08-16', updated_at: '2026-08-16',
    modules: {
      identity: { enabled: true }, body: { enabled: true },
      engine: { enabled: true, entities: 'engine/entities.json', modifiers: 'engine/modifiers.json', thresholds: 'engine/thresholds.json', narratives: 'engine/narratives.json' },
      interaction: { enabled: true, commands: 'interaction/commands.json' },
    },
  })
  copy('engine/entities.json', {
    entities: { e_g: { channels: { ch_g_a: { initial: 10, min: 0, max: 100 }, ch_g_s: { initial: 20 } }, flags: { f_on: 1 } } },
  })
  copy('engine/modifiers.json', {
    modifiers: {
      m_add: { label: 'm_add', effects: { ch_g_a: { type: 'add', base: 5 } } },
      m_set: { label: 'm_set', effects: { ch_g_s: { type: 'set', base: 99 } } },
      m_flag: { label: 'm_flag', type: 'flag_toggle', flag: 'f_on' },
      m_state_set: { label: 'm_state_set', effects: { ch_g_s: { type: 'state_set', base: 50, duration_ticks: 2 } } },
      m_clamp: { label: 'm_clamp', effects: { ch_g_a: { type: 'add', base: 500 } } },
    },
  })
  copy('engine/thresholds.json', {
    thresholds: {
      t_high: { entity: 'e_g', channel: 'ch_g_a', operator: '>=', value: 20, event_id: 'narr_status_warn_high', event_type: 'warning' },
    },
  })
  copy('engine/narratives.json', { 'action.act': 'act', 'threshold.high': 'high', 'system.status': 'status', 'system.reset': 'reset' })
  copy('interaction/commands.json', {
    commands: [
      { id: 'cmd_status', name: '状态', effects: [] },
      { id: 'cmd_reset', name: '重置', effects: [] },
      { id: 'cmd_act', name: '行动', aliases: ['act'], effects: [{ type: 'modifier', modifier: 'm_add' }] },
      { id: 'cmd_clamp', name: '钳制', effects: [{ type: 'modifier', modifier: 'm_clamp' }] },
    ],
  })
  return dir
}

test('createEntity：初始值与 flag', () => {
  const e = createEntity('e_g', { channels: { a: { initial: 10 }, b: { default: 5 } }, flags: { f: 1 } })
  assert.equal(e.channels.a, 10)
  assert.equal(e.channels.b, 5)
  assert.equal(e.flags.f, 1)
})

test('applyEffect：add 与 clamp（G1）', () => {
  const e = createEntity('e_g', { channels: { a: { initial: 10, min: 0, max: 100 } } })
  applyEffect(e, 'a', { type: 'add', base: 5 }, 1, { channels: { a: { initial: 10, min: 0, max: 100 } } })
  assert.equal(e.channels.a, 15)
  applyEffect(e, 'a', { type: 'add', base: 500 }, 1, { channels: { a: { initial: 10, min: 0, max: 100 } } })
  assert.equal(e.channels.a, 100, '超上限应钳制到 max')
})

test('applyModifier：flag_toggle', () => {
  const e = createEntity('e_g', { flags: { f_on: 1 } })
  const r = applyModifier(e, { type: 'flag_toggle', flag: 'f_on' })
  assert.equal(r.applied, true)
  assert.equal(e.flags.f_on, 0)
})

test('tickTimedEffects：state_set 到期恢复原值', () => {
  const e = createEntity('e_g', { channels: { s: { initial: 20 } } })
  applyModifier(e, { effects: { s: { type: 'state_set', base: 50, duration_ticks: 2 } } })
  assert.equal(e.channels.s, 50)
  tickTimedEffects(e)
  assert.equal(e.channels.s, 50, '未到期')
  tickTimedEffects(e)
  assert.equal(e.channels.s, 20, '到期恢复原值')
})

test('checkThresholds：>= 触发 + 冷却', () => {
  const e = createEntity('e_g', { channels: { a: { initial: 25 } } })
  const config = { entity: 'e_g', channel: 'a', operator: '>=' as const, value: 20, event_id: 'narr_status_warn_x', cooldown_ticks: 3 }
  const events = checkThresholds(e, { t: config }, 0)
  assert.equal(events.length, 1)
  assert.equal(events[0]?.event_id, 'narr_status_warn_x')
  const again = checkThresholds(e, { t: config }, 1)
  assert.equal(again.length, 0, '冷却期内不重复触发')
})

test('DlcEngine：加载与初始状态', () => {
  const engine = new DlcEngine(freshCard())
  const state = engine.getState()
  assert.equal(state.card_id, 'my-card')
  assert.equal(state.entities['e_g']?.channels['ch_g_a'], 10)
})

test('DlcEngine：execute 命令 + 叙事编号 + diff + 阈值', () => {
  const engine = new DlcEngine(freshCard())
  const r = engine.execute('cmd_act') // m_add: ch_g_a +5 → 15
  assert.equal(r.error, null)
  assert.deepEqual(r.narrative_ids, ['action.act']) // 10+5=15 < 20 无阈值
  assert.deepEqual(r.state_diff['ch_g_a'], { before: 10, after: 15, delta: 5 })

  const r2 = engine.execute('act') // 别名
  assert.equal(r2.error, null)
  assert.equal(r2.state_diff['ch_g_a']?.after, 20)
  // 现在 ch_g_a=20 触发 t_high（narr_status_warn_high → threshold.high）
  assert.ok(r2.narrative_ids.includes('threshold.high'), `含阈值叙事: ${r2.narrative_ids.join(',')}`)
})

test('DlcEngine：meta 命令 cmd_status / cmd_reset', () => {
  const engine = new DlcEngine(freshCard())
  const s = engine.execute('cmd_status')
  assert.deepEqual(s.narrative_ids, ['system.status'])
  const r = engine.execute('cmd_act')
  assert.equal(r.state_diff['ch_g_a']?.after, 15)
  const reset = engine.execute('cmd_reset')
  assert.deepEqual(reset.narrative_ids, ['system.reset'])
  assert.equal(engine.getState().entities['e_g']?.channels['ch_g_a'], 10)
})

test('DlcEngine：未知命令与冷却', () => {
  const engine = new DlcEngine(freshCard())
  const bad = engine.execute('cmd_nope')
  assert.match(bad.error ?? '', /Unknown command/)
})
