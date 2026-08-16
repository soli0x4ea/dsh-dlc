/**
 * P2 测试 — interaction 命令语义、narrative 组装、dlc/change 事件。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, rmSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import {
  DlcEngine,
  DlcEventBus,
  NarrativeAssembly,
  createEntity,
  executeCommand,
  loadCommands,
  matchCommand,
  parseInput,
} from '../src/index.ts'

function freshCard(): string {
  const dir = join(tmpdir(), `dlc-p2-${Date.now()}-${Math.random().toString(36).slice(2)}`)
  rmSync(dir, { recursive: true, force: true })
  mkdirSync(join(dir, 'engine'), { recursive: true })
  mkdirSync(join(dir, 'interaction'), { recursive: true })
  const copy = (name: string, data: unknown): void => writeFileSync(join(dir, name), JSON.stringify(data, null, 2), 'utf8')
  copy('card.json', {
    protocol_version: '1.0.0', card_id: 'p2-card', card_name: 'P2 测试卡',
    complexity_level: 'L3', author: 'soli', created_at: '2026-08-16', updated_at: '2026-08-16',
    modules: {
      identity: { enabled: true }, body: { enabled: true },
      engine: { enabled: true, entities: 'engine/entities.json', modifiers: 'engine/modifiers.json', thresholds: 'engine/thresholds.json', narratives: 'engine/narratives.json' },
      interaction: { enabled: true, commands: 'interaction/commands.json' },
    },
  })
  copy('engine/entities.json', {
    entities: { e_g: { channels: { ch_a: { initial: 0, min: 0, max: 100 } }, flags: { f_on: 0 } } },
  })
  copy('engine/modifiers.json', {
    modifiers: {
      m_add5: { label: 'm_add5', effects: { ch_a: { type: 'add', base: 5 } } },
      m_flag: { label: 'm_flag', type: 'flag_toggle', flag: 'f_on' },
    },
  })
  copy('engine/thresholds.json', { thresholds: {} })
  copy('engine/narratives.json', {
    command_assembly: {
      cmd_act: [{ op: 'range', brackets: [[1, 1], [2, 3], [4, 5]], texts: ['轻', '中', '重'] }],
    },
    events: { high: { texts: { intense: '非常高了！' } } },
  })
  copy('interaction/commands.json', {
    commands: [
      { id: 'cmd_status', name: '状态', effects: [] },
      { id: 'cmd_act', name: '行动', triggers: ['行动', 'act'], effects: [{ type: 'modifier', modifier_id: 'm_add5' }] },
      { id: 'cmd_flag', name: '开关', triggers: ['开关'], effects: [{ type: 'modifier', modifier_id: 'm_flag' }] },
      { id: 'cmd_setflag', name: '置位', triggers: ['置位'], effects: [{ type: 'state', action: 'flag_set', flag: 'f_on' }] },
      { id: 'cmd_cd', name: '冷却', effects: [{ type: 'modifier', modifier_id: 'm_add5' }], cooldown_seconds: 3600 },
    ],
  })
  return dir
}

// ── interaction ────────────────────────────────────────────────

test('loadCommands：id/triggers/modifier 简写/meta', () => {
  const dir = freshCard()
  const cmds = loadCommands(join(dir, 'interaction'))
  assert.equal(cmds.length, 5)
  const act = cmds.find((c) => c.id === 'cmd_act')
  assert.deepEqual(act?.triggers, ['行动', 'act'])
  const cd = cmds.find((c) => c.id === 'cmd_cd')
  assert.equal(cd?.cooldown_seconds, 3600)
})

test('matchCommand：最长触发词优先', () => {
  const dir = freshCard()
  const cmds = loadCommands(join(dir, 'interaction'))
  assert.equal(matchCommand('执行行动', cmds)?.id, 'cmd_act')
  assert.equal(matchCommand('act', cmds)?.id, 'cmd_act')
  assert.equal(matchCommand('无关输入', cmds), null)
})

test('parseInput：/命令 显式 + 自然语言', () => {
  const dir = freshCard()
  const cmds = loadCommands(join(dir, 'interaction'))
  const [c1, a1] = parseInput('/act 快点', cmds)
  assert.equal(c1?.id, 'cmd_act')
  assert.equal(a1, '快点')
  const [c2] = parseInput('请行动', cmds)
  assert.equal(c2?.id, 'cmd_act')
})

test('executeCommand：modifier 与 state', () => {
  const dir = freshCard()
  const state = createEntity('e_g', { channels: { ch_a: { initial: 0 } }, flags: { f_on: 0 } })
  const modifiers = JSON.parse(readFileSync(join(dir, 'engine/modifiers.json'), 'utf8')).modifiers
  const r1 = executeCommand({ type: 'modifier', modifier_id: 'm_add5' }, state, modifiers)
  assert.equal(r1.success, true)
  assert.equal(state.channels.ch_a, 5)
  const r2 = executeCommand({ type: 'state', action: 'flag_set', flag: 'f_on' }, state, modifiers)
  assert.equal(r2.success, true)
  assert.equal(state.flags.f_on, 1)
  const r3 = executeCommand({ type: 'state', action: 'flag_unset', flag: 'f_on' }, state, modifiers)
  assert.equal(state.flags.f_on, 0)
})

// ── narrative ──────────────────────────────────────────────────

test('NarrativeAssembly：legacy pipeline（range 分级）', () => {
  const dir = freshCard()
  const na = new NarrativeAssembly(dir)
  assert.equal(na.assemble(['action.act.1']), '轻')
  assert.equal(na.assemble(['action.act.3']), '中')
  assert.equal(na.assemble(['action.act.5']), '重')
})

test('NarrativeAssembly：事件查表与系统事件', () => {
  const dir = freshCard()
  const na = new NarrativeAssembly(dir)
  assert.equal(na.assemble(['threshold.high']), '非常高了！')
  assert.equal(na.assemble(['system.status']), '(状态快照已返回)')
  assert.equal(na.assemble(['action.nope']), '')
})

// ── 事件 ───────────────────────────────────────────────────────

test('DlcEngine：dlc/change 事件在 execute 后触发', () => {
  const bus = new DlcEventBus()
  const events: unknown[] = []
  bus.onStateChange((ev) => events.push(ev))
  const engine = new DlcEngine(freshCard(), { events: bus })
  engine.execute('行动') // m_add5: ch_a 0→5
  assert.equal(events.length, 1)
  const ev = events[0] as { command: string; diff: Record<string, unknown>; narrative_ids: string[] }
  assert.equal(ev.command, 'cmd_act')
  assert.equal(ev.narrative_ids[0], 'action.act')
  assert.deepEqual(ev.diff.ch_a, { before: 0, after: 5, delta: 5 })
})

test('DlcEngine：state 效果 + 触发词入口', () => {
  const engine = new DlcEngine(freshCard())
  const r = engine.execute('置位') // cmd_setflag 的 name? 不——触发词匹配用 triggers
  assert.equal(r.error, null)
  assert.equal(engine.getState().entities['e_g']?.flags['f_on'], 1)
})

test('DlcEngine：冷却拒绝', () => {
  const engine = new DlcEngine(freshCard())
  const first = engine.execute('cmd_cd')
  assert.equal(first.error, null)
  const second = engine.execute('cmd_cd')
  assert.match(second.error ?? '', /cooldown/i)
})

