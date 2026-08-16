/**
 * dsh-dlc Cordis 插件 — DLC 数字生命卡片长进 DSH。
 *
 * 注册：
 *   - ctx.dlc 服务：getEngine(cardId?) / listCards()
 *   - 三个模型工具：dlc_execute / dlc_get_state / dlc_reset
 *   - systemPrompt 提示段
 */
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type {} from '@deepseek-ai/dsh-system-prompt'
import { existsSync, readdirSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { DlcEngine } from './engine'
import { executeTool, getStateTool, resetTool } from './tools'

/** Cordis 插件名。 */
export const name = 'dlc'

/** 依赖的能力服务。 */
export const inject = ['tools', 'systemPrompt']

/** 插件配置。 */
export interface Config {
  /** 卡片目录；缺省为包内 cards/。 */
  cardsDir?: string
  /** 默认卡片 id；缺省取目录内第一张。 */
  defaultCard?: string
}

/** Schemastery 配置。 */
export const Config: z<Config> = z.object({
  cardsDir: z.string().default(''),
  defaultCard: z.string().default(''),
})

/** ctx.dlc 服务接口。 */
export interface DlcService {
  getEngine(cardId?: string): DlcEngine | undefined
  listCards(): string[]
}

const TEXT_OUTPUT = {
  schema: { type: 'string' as const },
  render: (_args: unknown, value: unknown) => [{ type: 'text' as const, text: String(value) }],
}

/** 插件入口。 */
export function apply(ctx: Context, config: Config): void {
  const cardsDir = config.cardsDir !== undefined && config.cardsDir !== '' ? resolve(config.cardsDir) : defaultCardsDir()
  const engines = new Map<string, DlcEngine>()

  const listCards = (): string[] => {
    if (!existsSync(cardsDir)) return []
    return readdirSync(cardsDir)
      .filter((d) => existsSync(join(cardsDir, d, 'card.json')))
      .sort()
  }

  const getEngine = (cardId?: string): DlcEngine | undefined => {
    const id = cardId ?? config.defaultCard ?? listCards()[0]
    if (id === undefined) return undefined
    let engine = engines.get(id)
    if (engine === undefined) {
      const cardDir = join(cardsDir, id)
      if (!existsSync(join(cardDir, 'card.json'))) return undefined
      engine = new DlcEngine(cardDir)
      engines.set(id, engine)
    }
    return engine
  }

  ctx.provide('dlc', { getEngine, listCards } satisfies DlcService)

  ctx.systemPrompt.section({
    name: 'dlc',
    order: 112,
    text: '数字生命卡片：用 dlc_execute 执行卡片命令（状态机转移），dlc_get_state 读取状态快照，dlc_reset 重置。卡片状态与记忆在本地持久化。',
  })

  ctx.tools.register(defineTool({
    name: executeTool.name,
    description: executeTool.description,
    parameters: {
      card_id: { type: 'string', description: '目标卡片 ID（默认当前卡片）' },
      command: { type: 'string', required: true, description: '命令 id、/命令 或自然语言触发词' },
      params: { type: 'json', description: '可选参数（intensity / count 等）' },
    },
    output: TEXT_OUTPUT,
    execute: async (args) => {
      const { command, params, card_id: cardId } = args as {
        command: string
        params?: Record<string, unknown>
        card_id?: string
      }
      const engine = getEngine(cardId)
      if (engine === undefined) {
        return JSON.stringify({ error: `unknown card: ${cardId ?? 'default'}` })
      }
      return JSON.stringify(engine.execute(command, params ?? {}))
    },
  }))

  ctx.tools.register(defineTool({
    name: getStateTool.name,
    description: getStateTool.description,
    parameters: {
      card_id: { type: 'string', description: '目标卡片 ID（默认当前卡片）' },
    },
    output: TEXT_OUTPUT,
    execute: async (args) => {
      const { card_id: cardId } = args as { card_id?: string }
      const engine = getEngine(cardId)
      if (engine === undefined) return JSON.stringify({ error: `unknown card: ${cardId ?? 'default'}` })
      return JSON.stringify(engine.getState())
    },
  }))

  ctx.tools.register(defineTool({
    name: resetTool.name,
    description: resetTool.description,
    parameters: {
      card_id: { type: 'string', description: '目标卡片 ID（默认当前卡片）' },
    },
    output: TEXT_OUTPUT,
    execute: async (args) => {
      const { card_id: cardId } = args as { card_id?: string }
      const engine = getEngine(cardId)
      if (engine === undefined) return JSON.stringify({ error: `unknown card: ${cardId ?? 'default'}` })
      return JSON.stringify(engine.reset())
    },
  }))
}

function defaultCardsDir(): string {
  const url = new URL('../cards/', import.meta.url)
  return url.pathname
}
