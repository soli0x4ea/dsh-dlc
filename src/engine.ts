/**
 * DLC v3.0 状态机引擎（TypeScript 重写）— 对照 dlc/sm/engine.py。
 *
 * 纯计算状态机：输入命令，输出叙事编号 + 状态 diff，零自然语言。
 * P2 升级：完整命令语义（触发词/别名/四类效果）+ 事件回调。
 */
import { appendFileSync, mkdirSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { CardRuntimeContext } from './card-loader'
import { createEntity, entityFromDict, entityToDict } from './entity'
import type { EntityConfig, ExecuteResult, StateSnapshot } from './types'
import { checkThresholds } from './thresholds'
import { StateManager } from './persistence'
import { executeCommand, loadCommands, parseInput } from './interaction'
import type { CommandConfig, CommandEffect } from './interaction'
import { DlcEventBus, type DlcStateChangeEvent } from './events'

type EntityState = ReturnType<typeof createEntity>

export interface DlcEngineOptions {
  /** 事件总线；缺省自动创建内存总线。 */
  events?: DlcEventBus
}

export class DlcEngine {
  readonly cardPath: string
  readonly cardId: string
  protected readonly ctx: CardRuntimeContext
  protected readonly stateMgr: StateManager
  readonly events: DlcEventBus
  protected readonly entities = new Map<string, EntityState>()
  private readonly cooldowns = new Map<string, number>()
  private readonly commands: CommandConfig[]

  constructor(cardPath: string, options: DlcEngineOptions = {}) {
    this.cardPath = resolve(cardPath)
    this.ctx = new CardRuntimeContext(this.cardPath)
    this.cardId = this.ctx.cardId
    this.stateMgr = new StateManager(this.ctx)
    this.commands = loadCommands(join(this.cardPath, 'interaction'))
    this.events = options.events ?? new DlcEventBus()
    this.restoreEntities()
  }

  execute(command: string, params: Record<string, unknown> = {}): ExecuteResult {
    const result: ExecuteResult = { narrative_ids: [], state_diff: {}, flags: {}, error: null }

    const [parsed] = parseInput(command, this.commands)
    const cmd = parsed ?? this.commands.find((c) => c.id === command)
    if (cmd === undefined) {
      result.error = `Unknown command: ${command}`
      return result
    }

    if (cmd.id === 'cmd_status' || cmd.id === 'cmd_reset' || cmd.id === 'cmd_end') {
      return this.handleMeta(cmd.id, result)
    }

    if (this.isCooling(cmd)) {
      result.error = `Command ${cmd.id} on cooldown`
      return result
    }

    const intensity = Number(params.intensity ?? params.count ?? 1)

    const entity = this.getOrCreateEntity(this.primaryEntityId())
    const before = { ...entity.channels }
    const beforeFlags = { ...entity.flags }

    const effectIds: string[] = []
    for (const effect of cmd.effects) {
      const eff: CommandEffect = { ...effect }
      if (intensity !== 1.0 && eff.type === 'modifier') {
        eff.intensity = intensity
      }
      const execResult = executeCommand(eff, entity, this.ctx.modifiers, this.ctx.entities[entity.entity_id])
      if (execResult.success) {
        effectIds.push(this.actionId(cmd, intensity))
      }
    }

    effectIds.push(...this.postEffectsHook(entity, before, cmd.id, command))

    const seen = new Set<string>()
    for (const tev of checkThresholds(entity, this.ctx.thresholds, 0)) {
      if (seen.has(tev.event_id)) continue
      seen.add(tev.event_id)
      effectIds.push(this.thresholdId(tev.event_id))
    }

    this.saveEntity(entity)

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

    this.markUsed(cmd)
    this.writeStateChange(command, diff, flagDiff)
    this.emitChange({
      card_id: this.cardId,
      entity_id: entity.entity_id,
      command: cmd.id,
      narrative_ids: [...effectIds],
      channels_before: { ...before },
      channels_after: after,
      flags_before: { ...beforeFlags },
      flags_after: afterFlags,
      diff,
      timestamp: Date.now(),
    })

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

  protected postEffectsHook(
    _entity: EntityState,
    _before: Record<string, number>,
    _cmdId: string,
    _rawInput: string,
  ): string[] {
    return []
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

  private emitChange(event: DlcStateChangeEvent): void {
    this.events.emitStateChange(event)
  }
}

function round1(v: number): number {
  return Math.round(v * 10) / 10
}

export type { EntityConfig, CommandEffect }
