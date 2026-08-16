/**
 * P4 冒烟测试 — Cordis 插件挂载、三工具注册、ctx.dlc 服务、端到端执行。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Context } from '@deepseek-ai/cordis'
import { cpSync, mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { dlcPlugin } from '../lib/index.js'

interface RegisteredTool {
  name: string
  description: string
  execute(args: Record<string, unknown>): Promise<unknown>
}

async function mountPlugin(): Promise<{ ctx: Context; tools: RegisteredTool[]; sections: unknown[] }> {
  const ctx = new Context()
  const tools: RegisteredTool[] = []
  const sections: unknown[] = []
  ctx.provide('tools', {
    register: (t: RegisteredTool) => tools.push(t),
  } as never)
  ctx.provide('systemPrompt', {
    section: (s: unknown) => sections.push(s),
  } as never)
  const tmpRoot = join(tmpdir(), `dlc-plugin-${Date.now()}-${Math.random().toString(36).slice(2)}`)
  mkdirSync(tmpRoot, { recursive: true })
  cpSync('/Users/soli/Documents/DSH/WORKS/dsh-dlc/cards/my-card', join(tmpRoot, 'my-card'), { recursive: true })
  rmSync(join(tmpRoot, 'my-card', 'state'), { recursive: true, force: true })
  await ctx.plugin(dlcPlugin, { cardsDir: tmpRoot })
  return { ctx, tools, sections }
}

test('dlc 插件：注册三个工具 + 提示段', async () => {
  const { ctx, tools, sections } = await mountPlugin()
  assert.equal(tools.length, 3)
  assert.deepEqual(tools.map((t) => t.name).sort(), ['dlc_execute', 'dlc_get_state', 'dlc_reset'])
  assert.equal(sections.length, 1)
})

test('ctx.dlc 服务：listCards / getEngine', async () => {
  const { ctx } = await mountPlugin()
  const svc = (ctx as unknown as { dlc: { listCards(): string[]; getEngine(id?: string): unknown } }).dlc
  assert.deepEqual(svc.listCards(), ['my-card'])
  assert.ok(svc.getEngine('my-card') !== undefined)
  assert.equal(svc.getEngine('nope'), undefined)
})

test('dlc_execute 端到端：命令执行返回叙事编号', async () => {
  const { ctx, tools } = await mountPlugin()
  const execute = tools.find((t) => t.name === 'dlc_execute')
  assert.ok(execute)
  const out = await execute.execute({ command: 'cmd_act' })
  const parsed = JSON.parse(String(out)) as { narrative_ids: string[]; state_diff: Record<string, unknown> }
  assert.deepEqual(parsed.narrative_ids, ['action.act'])
  assert.ok('ch_g_a' in parsed.state_diff)
})

test('dlc_get_state 端到端：状态快照', async () => {
  const { ctx, tools } = await mountPlugin()
  const getState = tools.find((t) => t.name === 'dlc_get_state')
  assert.ok(getState)
  const out = await getState.execute({})
  const parsed = JSON.parse(String(out)) as { card_id: string; entities: Record<string, unknown> }
  assert.equal(parsed.card_id, 'my-card')
  assert.ok(parsed.entities['e_g'] !== undefined)
})
