/**
 * DLC 交互层 — 对照 dlc/interaction/commands.py · items.py。
 * 命令加载/触发词匹配/效果执行/冷却/帮助；道具加载/稀有度/库存。
 */
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import type { EntityState, ModifierConfig } from './types'
import { applyModifier } from './modifiers'

// ═══════════════════════════════════════════════════════════════
// 命令
// ═══════════════════════════════════════════════════════════════

export interface CommandEffect {
  type: string
  modifier_id?: string
  modifier?: string
  intensity?: number
  command_id?: string
  vars?: Record<string, unknown>
  event_id?: string
  action?: string
  flag?: string
  [key: string]: unknown
}

export interface CommandConfig {
  id: string
  triggers: string[]
  description: string
  effects: CommandEffect[]
  cooldown_seconds: number
  meta: Record<string, unknown>
}

export interface CommandResult {
  command_id: string
  success: boolean
  output: string | null
  error: string
}

/** 命令加载（对照 CommandLoader）：id/name 别名、triggers/aliases、effects/modifier 简写、meta 保留扩展字段。 */
export function loadCommands(interactionDir: string): CommandConfig[] {
  const path = join(interactionDir, 'commands.json')
  if (!existsSync(path)) return []
  const raw = JSON.parse(readFileSync(path, 'utf8')) as { commands?: Record<string, unknown>[] }
  const commands: CommandConfig[] = []
  for (const c of raw.commands ?? []) {
    const id = String(c.id ?? c.name ?? '')
    const triggers = (c.triggers as string[] | undefined) ?? (c.aliases as string[] | undefined) ?? []
    let effects = c.effects as CommandEffect[] | undefined
    if (effects === undefined) {
      const modId = c.modifier ?? c.modifier_id
      effects = modId !== undefined && modId !== '' ? [{ type: 'modifier', modifier_id: String(modId) }] : []
    }
    const standardKeys = new Set(['id', 'name', 'triggers', 'aliases', 'effects', 'modifier', 'modifier_id', 'description', 'cooldown_seconds'])
    const meta: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(c)) if (!standardKeys.has(k)) meta[k] = v
    commands.push({
      id,
      triggers: triggers.map(String),
      description: String(c.description ?? ''),
      effects,
      cooldown_seconds: Number(c.cooldown_seconds ?? 0),
      meta,
    })
  }
  return commands
}

/** 触发词匹配（对照 match_command）：最长触发词优先，防子串误匹配。 */
export function matchCommand(input: string, commands: CommandConfig[]): CommandConfig | null {
  const text = input.toLowerCase()
  let best: CommandConfig | null = null
  let bestLen = 0
  for (const cmd of commands) {
    for (const trigger of cmd.triggers) {
      const t = trigger.toLowerCase()
      if (t !== '' && text.includes(t) && t.length > bestLen) {
        bestLen = t.length
        best = cmd
      }
    }
  }
  return best
}

/** 输入解析（对照 parse_input）：/命令 显式格式 + 自然语言触发词。返回 (命令, 剩余参数)。 */
export function parseInput(input: string, commands: CommandConfig[]): [CommandConfig | null, string] {
  const text = input.trim()
  if (text.startsWith('/')) {
    const [name, ...rest] = text.slice(1).split(/\s+/)
    const args = rest.join(' ')
    const cmd = commands.find((c) => c.id === name || c.triggers.includes(name))
    return cmd === undefined ? [null, ''] : [cmd, args]
  }
  return [matchCommand(text, commands), text]
}

/**
 * 单效果执行（对照 execute_command）：modifier / command_narrative / narrative / state（flag_set/flag_unset）。
 * v3.0 中 narrative 类由外部组装（返回空），此处保持语义。
 */
export function executeCommand(
  effect: CommandEffect,
  state: EntityState,
  modifiersCfg: Record<string, ModifierConfig>,
  entityCfg?: Parameters<typeof applyModifier>[4],
): CommandResult {
  const result: CommandResult = { command_id: '', success: false, output: null, error: '' }
  try {
    const etype = effect.type
    if (etype === 'modifier') {
      const modId = String(effect.modifier_id ?? effect.modifier ?? '')
      const mod = modifiersCfg[modId]
      if (mod === undefined) {
        result.error = `modifier ${modId} not found`
        return result
      }
      const intensity = Number(effect.intensity ?? 1.0)
      const r = applyModifier(state, mod, intensity, 0, entityCfg)
      result.success = r.applied
      result.output = r.note
    } else if (etype === 'state') {
      const action = String(effect.action ?? '')
      const flag = String(effect.flag ?? '')
      if (action === 'flag_set' && flag !== '') {
        state.flags[flag] = 1
        result.success = true
        result.output = `flag_set: ${flag}=1`
      } else if (action === 'flag_unset' && flag !== '') {
        state.flags[flag] = 0
        result.success = true
        result.output = `flag_unset: ${flag}=0`
      } else {
        result.error = `unknown state action: ${action}`
      }
    } else if (etype === 'narrative' || etype === 'command_narrative') {
      // v3.0 语义：叙事文本由 NarrativeAssembly 外部组装（render 桩返回空）
      result.success = false
      result.output = null
    } else {
      result.error = `unknown effect type: ${etype}`
    }
  } catch (error) {
    result.success = false
    result.error = String(error)
  }
  return result
}

/** 帮助文本（对照 generate_help）。 */
export function generateHelp(commands: CommandConfig[]): string {
  const lines = ['[可用命令]']
  for (const cmd of commands) {
    const triggers = cmd.triggers.slice(0, 3).join(', ')
    const cd = cmd.cooldown_seconds > 0 ? ` (冷却${cmd.cooldown_seconds}s)` : ''
    lines.push(`- /${cmd.id} | ${triggers} | ${cmd.description}${cd}`)
  }
  return lines.join('\n')
}

// ═══════════════════════════════════════════════════════════════
// 道具
// ═══════════════════════════════════════════════════════════════

export const RARITY_LEVELS = ['common', 'uncommon', 'rare', 'epic', 'legendary'] as const
export const RARITY_DISPLAY: Record<string, string> = {
  common: '普通', uncommon: '罕见', rare: '稀有', epic: '史诗', legendary: '传说',
}
const RARITY_ORDER: Record<string, number> = { common: 0, uncommon: 1, rare: 2, epic: 3, legendary: 4 }

export function validateRarity(rarity: string): string {
  return rarity in RARITY_ORDER ? rarity : 'common'
}

export interface ItemConfig {
  id: string
  name: string
  description: string
  type: string
  effects: CommandEffect[]
  max_quantity: number
  use_cooldown_seconds: number
  rarity: string
}

/** 道具加载（对照 ItemLoader）：effects/effect 别名、type 推断（stackable）。 */
export function loadItems(interactionDir: string): ItemConfig[] {
  const path = join(interactionDir, 'items.json')
  if (!existsSync(path)) return []
  const raw = JSON.parse(readFileSync(path, 'utf8')) as { items?: Record<string, unknown>[] }
  const items: ItemConfig[] = []
  for (const i of raw.items ?? []) {
    let effects = i.effects as CommandEffect[] | undefined
    if (effects === undefined && i.effect !== undefined) {
      const eff = i.effect
      effects = Array.isArray(eff) ? (eff as CommandEffect[]) : [eff as CommandEffect]
    }
    let type = String(i.type ?? '')
    if (type === '' && 'stackable' in i) {
      type = i.stackable === true ? 'consumable' : 'permanent'
    }
    items.push({
      id: String(i.id ?? ''),
      name: String(i.name ?? ''),
      description: String(i.description ?? ''),
      type,
      effects: effects ?? [],
      max_quantity: Number(i.max_quantity ?? 1),
      use_cooldown_seconds: Number(i.use_cooldown_seconds ?? 0),
      rarity: validateRarity(String(i.rarity ?? 'common')),
    })
  }
  return items
}

/** 库存（对照 Inventory）：state 目录下 inventory.json 持久化。 */
export class Inventory {
  private readonly items = new Map<string, ItemConfig>()
  private quantities = new Map<string, number>()
  private equipped = new Set<string>()
  private lastUsed = new Map<string, number>()
  private readonly statePath: string

  constructor(stateDir: string) {
    this.statePath = join(stateDir, 'inventory.json')
    this.load()
  }

  register(item: ItemConfig): void {
    this.items.set(item.id, item)
  }

  add(item: ItemConfig, qty = 1): number {
    const current = this.quantities.get(item.id) ?? 0
    const next = Math.min(current + qty, item.max_quantity)
    this.quantities.set(item.id, next)
    this.save()
    return next
  }

  remove(itemId: string, qty = 1): boolean {
    const current = this.quantities.get(itemId) ?? 0
    if (current < qty) return false
    const next = current - qty
    if (next <= 0) this.quantities.delete(itemId)
    else this.quantities.set(itemId, next)
    this.save()
    return true
  }

  count(itemId: string): number {
    return this.quantities.get(itemId) ?? 0
  }

  /** 使用道具（对照 Inventory.use）：检查数量与冷却，应用 effects，消耗/装备。 */
  use(itemId: string, now = Date.now()): boolean {
    const item = this.items.get(itemId)
    if (item === undefined) return false
    const count = this.quantities.get(itemId) ?? 0
    if (count <= 0 && item.type !== 'equippable') return false
    if (item.use_cooldown_seconds > 0) {
      const last = this.lastUsed.get(itemId)
      if (last !== undefined && now - last < item.use_cooldown_seconds * 1000) return false
    }
    this.lastUsed.set(itemId, now)
    if (item.type === 'consumable') this.remove(itemId, 1)
    if (item.type === 'equippable') this.equipped.add(itemId)
    this.save()
    return true
  }

  isEquipped(itemId: string): boolean {
    return this.equipped.has(itemId)
  }

  unequip(itemId: string): void {
    this.equipped.delete(itemId)
    this.save()
  }

  private save(): void {
    mkdirSync(this.stateDir(), { recursive: true })
    writeFileSync(this.statePath, JSON.stringify({
      quantities: Object.fromEntries(this.quantities),
      equipped: [...this.equipped],
      last_used: Object.fromEntries(this.lastUsed),
    }, null, 2), 'utf8')
  }

  private load(): void {
    if (!existsSync(this.statePath)) return
    const data = JSON.parse(readFileSync(this.statePath, 'utf8')) as {
      quantities?: Record<string, number>
      equipped?: string[]
      last_used?: Record<string, number>
    }
    this.quantities = new Map(Object.entries(data.quantities ?? {}))
    this.equipped = new Set(data.equipped ?? [])
    this.lastUsed = new Map(Object.entries(data.last_used ?? {}).map(([k, v]) => [k, Number(v)]))
  }

  private stateDir(): string {
    return this.statePath.slice(0, this.statePath.lastIndexOf('/'))
  }
}
