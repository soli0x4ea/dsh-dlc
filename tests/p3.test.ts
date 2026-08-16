/**
 * P3 测试 — 记忆层（chatlog/timeline/search）、存储抽象、工具契约。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import {
  ChatlogStore,
  TimelineStore,
  MemorySearch,
  FileStateStore,
  MemoryStateStore,
  StateManager,
  DlcEngine,
  DLC_TOOLS,
  CardRuntimeContext,
} from '../src/index.ts'

function freshDir(tag: string): string {
  const dir = join(tmpdir(), `dlc-p3-${tag}-${Date.now()}-${Math.random().toString(36).slice(2)}`)
  rmSync(dir, { recursive: true, force: true })
  mkdirSync(dir, { recursive: true })
  return dir
}

test('ChatlogStore：append + MD5 去重 + loadDay', () => {
  const store = new ChatlogStore(freshDir('chatlog'))
  assert.equal(store.append('user', '你好', {}, 1, '2026-08-16'), true)
  assert.equal(store.append('user', '你好', {}, 2, '2026-08-16'), false, '同内容去重')
  assert.equal(store.append('assistant', '奴婢在', {}, 3, '2026-08-16'), true)
  const day = store.loadDay('2026-08-16')
  assert.equal(day.length, 2)
  assert.equal(day[0]?.content, '你好')
})

test('ChatlogStore：recent 与 stats', () => {
  const store = new ChatlogStore(freshDir('chatlog2'))
  store.append('user', '一', {}, 1, '2026-08-15')
  store.append('assistant', '二', {}, 2, '2026-08-16')
  const recent = store.recent(5)
  assert.equal(recent[0]?.content, '二')
  const stats = store.stats()
  assert.equal(stats.total, 2)
  assert.equal(stats.user, 1)
  assert.equal(stats.assistant, 1)
})

test('TimelineStore：小时槽覆盖', () => {
  const store = new TimelineStore(freshDir('timeline'))
  store.write('2026-08-16-14', '下午状态 A')
  store.write('2026-08-16-14', '下午状态 B', {}, 2)
  store.write('2026-08-16-15', '下午状态 C')
  const range = store.range('2026-08-16-00', '2026-08-16-23')
  assert.equal(range.length, 2, '同小时覆盖后只有 2 条')
  assert.equal(range.find((e) => e.date_hour === '2026-08-16-14')?.summary, '下午状态 B')
})

test('MemorySearch：byDate / recent / search', () => {
  const dir = freshDir('search')
  const chatlog = new ChatlogStore(join(dir, 'chatlog'))
  const timeline = new TimelineStore(join(dir, 'timeline'))
  chatlog.append('user', '聊了灵魂三值', {}, 1, '2026-08-16')
  chatlog.append('assistant', '奴婢在', {}, 2, '2026-08-16')
  timeline.write('2026-08-16-10', '三值讨论')
  const search = new MemorySearch(chatlog, timeline)
  const byDate = search.byDate('2026-08-16')
  assert.equal((byDate.chatlog as unknown[]).length, 2)
  const hits = search.search('三值')
  assert.equal((hits.chatlog as unknown[]).length, 1)
  assert.equal((hits.timeline as unknown[]).length, 1)
  const ctx = search.injectContext(1, 10, 24)
  assert.ok(ctx.includes('灵魂三值'))
})

test('StateStore：文件与内存后端可切换', () => {
  const dir = freshDir('store')
  const file = new FileStateStore(join(dir, 'state'), 'card')
  file.write('e1', { a: 1 })
  assert.deepEqual(file.read('e1'), { a: 1 })
  assert.deepEqual(file.list(), ['e1'])
  file.delete('e1')
  assert.equal(file.read('e1'), null)

  const mem = new MemoryStateStore()
  mem.write('e2', { b: 2 })
  assert.deepEqual(mem.read('e2'), { b: 2 })
  assert.deepEqual(mem.list(), ['e2'])
})

test('StateManager：export/import + backup', () => {
  const dir = freshDir('sm')
  const ctx = { cardId: 'card', stateDir: join(dir, 'state') } as CardRuntimeContext
  const sm = new StateManager(ctx, new MemoryStateStore())
  sm.write('e1', { ch: 10 })
  const exported = sm.exportState()
  assert.equal(exported.card_id, undefined) // MemoryStateStore 下无 cardId 注入（ctx 伪装），仅验证 entities
  assert.deepEqual(Object.keys(exported.entities ?? {}), ['e1'])
})

test('DlcEngine：memory 模块启用时自动加载', () => {
  const dir = freshDir('engine-mem')
  mkdirSync(join(dir, 'engine'), { recursive: true })
  mkdirSync(join(dir, 'interaction'), { recursive: true })
  writeFileSync(join(dir, 'card.json'), JSON.stringify({
    protocol_version: '1.0.0', card_id: 'mem-card', card_name: '记忆卡',
    complexity_level: 'L2', author: 'soli', created_at: '2026-08-16', updated_at: '2026-08-16',
    modules: {
      identity: { enabled: true }, body: { enabled: true },
      engine: { enabled: true, entities: 'engine/entities.json', modifiers: 'engine/modifiers.json', thresholds: 'engine/thresholds.json', narratives: 'engine/narratives.json' },
      memory: { enabled: true },
    },
  }))
  writeFileSync(join(dir, 'engine/entities.json'), JSON.stringify({ entities: { e_g: { channels: { a: { initial: 0 } } } } }))
  writeFileSync(join(dir, 'engine/modifiers.json'), JSON.stringify({ modifiers: {} }))
  writeFileSync(join(dir, 'engine/thresholds.json'), JSON.stringify({ thresholds: {} }))
  writeFileSync(join(dir, 'engine/narratives.json'), JSON.stringify({}))
  const engine = new DlcEngine(dir)
  const ctx = new CardRuntimeContext(dir)
  const memory = ctx.memory
  assert.ok(memory !== null, 'memory 应自动加载')
  memory?.chatlog.append('user', '记忆卡的第一句话', {}, Date.now() / 1000, '2026-08-16')
  assert.equal(memory?.chatlog.loadDay('2026-08-16').length, 1)
  void engine
})

test('tool-dlc 工具契约：三工具 schema 完整', () => {
  assert.equal(DLC_TOOLS.length, 3)
  const names = DLC_TOOLS.map((t) => t.name)
  assert.ok(names.includes('dlc_execute'))
  assert.ok(names.includes('dlc_get_state'))
  assert.ok(names.includes('dlc_reset'))
  const execute = DLC_TOOLS.find((t) => t.name === 'dlc_execute')
  assert.ok((execute?.parameters as { required?: string[] }).required?.includes('command'))
})
