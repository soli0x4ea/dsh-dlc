/**
 * DLC v3.0 状态机引擎（TypeScript 重写）— 对照 dlc/sm/engine.py。
 *
 * 纯计算状态机：输入命令，输出叙事编号 + 状态 diff，零自然语言。
 * 叙事编号格式: <domain>.<type>[.<variant>][.<level>]
 *   action.ping / action.act.3 / action.act.a.3 / threshold.hp_low / system.status
 */
import { appendFileSync, mkdirSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { CardRuntimeContext, unwrapConfig } from './card-loader'
import { createEntity, entityFromDict, entityToDict } from './entity'
import type { CommandConfig, EntityConfig, ExecuteResult, StateSnapshot } from './types'
import { applyEffect, applyModifier } from './modifiers'
import { checkThresholds } from './thresholds'
import { StateManager } from './persistence'

type EntityState = ReturnType<typeof createEntity>

export class DlcEngine {
  readonly cardPath: string
  readonly cardId: string
  protected readonly ctx: CardRuntimeContext
  protected readonly stateMgr: StateManager
  protected readonly entities = new Map<string, EntityState>()
  private readonly cooldowns = new Map<string, number>()
  private readonly commands: CommandConfig[]

  constructor(cardPath: string) {
    this.cardPath = resolve(cardPath)
    this.ctx = new CardRuntimeContext(this.cardPath)
    this.cardId = this.ctx.cardId
    this.stateMgr = new StateManager(this.ctx)
    this.commands = this.ctx.commands
    this.restoreEntities()
  }

  // ═══════════════════════════════════════════════════════════
  // Public API（对照 MCP 三工具）
  // ═══════════════════════════════════════════════════════════

  execute(command: string, params: Record<string, unknown> = {}): ExecuteResult {
    const result: ExecuteResult = { narrative_ids: [], state_diff: {}, flags: {}, error: null }

    // 1. 匹配命令：先按 id 精确匹配，再试别名
    const cmd = this.matchCommand(command)
    if (cmd === undefined) {
      result.error = `Unknown command: ${command}`
      return result
    }

    // 2. Meta 命令
    if (cmd.id === 'cmd_status' || cmd.id === 'cmd_reset' || cmd.id === 'cmd_end') {
      return this.handleMeta(cmd.id, result)
    }

    // 3. 冷却
    if (this.isCooling(cmd)) {
      result.error = `Command ${cmd.id} on cooldown`
      return result
    }

    // 4. 强度（intensity ?? count ?? 1）
    const intensity = Number(params.intensity ?? params.count ?? 1)

    // 5. 应用效果
    const entity = this.getOrCreateEntity(this.primaryEntityId())
    const before = { ...entity.channels }
    const beforeFlags = { ...entity.flags }

    const effectIds: string[] = []
    for (const effect of cmd.effects) {
      if (this.executeEffect(effect, entity, intensity)) {
        effectIds.push(this.actionId(cmd, intensity))
      }
    }

    // 6. Post-effects hook（卡片特有，可覆写）
    effectIds.push(...this.postEffectsHook(entity, before, cmd.id, command))

    // 7. 阈值
    const seen = new Set<string>()
    for (const tev of checkThresholds(entity, this.ctx.thresholds, 0)) {
      if (seen.has(tev.event_id)) continue
      seen.add(tev.event_id)
      effectIds.push(this.thresholdId(tev.event_id))
    }

    // 8. 保存
    this.saveEntity(entity)

    // 9. Diff
    const after = { ...entity.channels }
    const afterFlags = { ...entity.flags }
    const diff: ExecuteResult['state_diff'] = {}
    for (const [ch, val] of Object.entries(after)) {
      const old = before[ch] ?? 0
      if (Math.abs(val - old) > 0.001) {
        diff[ch] = { before: round1(old), after: round1(val), delta: round1(val - old) }
      }
    }
    const flagDiff: Record<string, number> = {}
    for (const [fk, fv] of Object.entries(afterFlags)) {
      if (fv !== (beforeFlags[fk] ?? 0)) flagDiff[fk] = fv
    }

    result.narrative_ids = effectIds
    result.state_diff = diff
    result.flags = flagDiff

    // 10. 冷却 + 审计
    this.markUsed(cmd)
    this.writeStateChange(command, diff, flagDiff)

    return result
  }

  getState(): StateSnapshot {
    const entities: StateSnapshot['entities'] = {}
    for (const [eid, entity] of this.entities) {
      entities[eid] = {
        channels: Object.fromEntries(
          Object.entries(entity.channels).filter(([, v]) => Math.abs(v) > 0.001).map(([k, v]) => [k, round1(v)]),
        ),
        flags: Object.fromEntries(Object.entries(entity.flags).filter(([, v]) => v !== 0)),
      }
    }
    return { card_id: this.cardId, entities }
  }

  reset(): Record<string, unknown> {
    const entity = this.getOrCreateEntity(this.primaryEntityId())
    const config = this.ctx.entities[entity.entity_id] ?? {}
    for (const [chKey, chCfg] of Object.entries(config.channels ?? {})) {
      entity.channels[chKey] = Number(chCfg.initial ?? chCfg.default ?? 0)
    }
    for (const [fKey, fVal] of Object.entries(config.flags ?? {})) {
      entity.flags[fKey] = fVal
    }
    this.saveEntity(entity)
    return { status: 'reset', card_id: this.cardId }
  }

  // ═══════════════════════════════════════════════════════════
  // 可覆写 hook（对照 _post_effects_hook）
  // ═══════════════════════════════════════════════════════════

  protected postEffectsHook(
    _entity: EntityState,
    _before: Record<string, number>,
    _cmdId: string,
    _rawInput: string,
  ): string[] {
    return []
  }

  // ═══════════════════════════════════════════════════════════
  // Internal
  // ═══════════════════════════════════════════════════════════

  private matchCommand(input: string): CommandConfig | undefined {
    const trimmed = input.trim()
    return this.commands.find((c) => c.id === trimmed)
      ?? this.commands.find((c) => (c.aliases ?? []).includes(trimmed))
  }

  private handleMeta(cmdId: string, result: ExecuteResult): ExecuteResult {
    if (cmdId === 'cmd_status') {
      result.narrative_ids = ['system.status']
      result.state_diff = this.getState() as unknown as ExecuteResult['state_diff']
      return result
    }
    result.narrative_ids = ['system.reset']
    result.flags = this.reset() as Record<string, number>
    return result
  }

  /** 执行单条效果；对照 execute_command（modifier 效果按 modifiers 配置，channel 效果直接 add/set）。 */
  private executeEffect(eff: Record<string, unknown>, entity: EntityState, intensity: number): boolean {
    const type = String(eff.type ?? '')

    if (type === 'modifier') {
      const modId = String(eff.modifier ?? eff.label ?? '')
      const mod = this.ctx.modifiers[modId]
      if (mod === undefined) return false
      const entityConfig = this.ctx.entities[entity.entity_id]
      const modResult = applyModifier(entity, mod, intensity, 0, entityConfig)
      return modResult.applied
    }

    // 直接通道效果：对照 _EFFECT_EXECUTORS 的 add/set 等
    const channel = String(eff.channel ?? '')
    if (channel === '') return false
    const entityConfig = this.ctx.entities[entity.entity_id]
    const delta = applyEffect(entity, channel, eff as never, intensity, entityConfig)
    return delta !== 0 || type !== 'unknown'
  }

  private primaryEntityId(): string {
    const keys = Object.keys(this.ctx.entities)
    return keys.length > 0 ? keys[0] : 'main'
  }

  private getOrCreateEntity(entityId: string): EntityState {
    let entity = this.entities.get(entityId)
    if (entity === undefined) {
      entity = createEntity(entityId, this.ctx.entities[entityId])
      this.entities.set(entityId, entity)
    }
    return entity
  }

  private saveEntity(entity: EntityState): void {
    this.stateMgr.write(entity.entity_id, entityToDict(entity))
  }

  private restoreEntities(): void {
    const ids = this.stateMgr.listStates()
    if (ids.length === 0) {
      for (const [eid, config] of Object.entries(this.ctx.entities)) {
        this.entities.set(eid, createEntity(eid, config))
      }
      return
    }
    for (const eid of ids) {
      const data = this.stateMgr.read(eid)
      if (data !== null) this.entities.set(eid, entityFromDict(data))
    }
    for (const eid of Object.keys(this.ctx.entities)) {
      if (!this.entities.has(eid)) this.getOrCreateEntity(eid)
    }
  }

  private isCooling(cmd: CommandConfig): boolean {
    const seconds = Number(cmd.cooldown_seconds ?? 0)
    if (seconds <= 0) return false
    const last = this.cooldowns.get(cmd.id)
    return last !== undefined && Date.now() - last < seconds * 1000
  }

  private markUsed(cmd: CommandConfig): void {
    this.cooldowns.set(cmd.id, Date.now())
  }

  private actionId(cmd: CommandConfig, intensity: number): string {
    const name = cmd.id.replace(/^cmd_/, '')
    const level = Math.trunc(intensity)
    return level > 1 ? `action.${name}.${level}` : `action.${name}`
  }

  private thresholdId(eventId: string): string {
    if (eventId.startsWith('narr_status_warn_')) return `threshold.${eventId.slice('narr_status_warn_'.length)}`
    if (eventId.startsWith('narr_')) return `threshold.${eventId.slice('narr_'.length)}`
    return `threshold.${eventId}`
  }

  private writeStateChange(command: string, diff: ExecuteResult['state_diff'], flags: Record<string, number>): void {
    const logDir = join(this.cardPath, 'MEMORY', 'state_log')
    mkdirSync(logDir, { recursive: true })
    const now = new Date()
    const today = now.toISOString().slice(0, 10)
    const ts = now.toISOString().slice(11, 19)
    appendFileSync(join(logDir, `${today}.jsonl`), `${JSON.stringify({ ts, command, diff, flags })}\n`, 'utf8')
  }
}

function round1(v: number): number {
  return Math.round(v * 10) / 10
}

export type { EntityConfig }
