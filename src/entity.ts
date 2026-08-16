/**
 * DLC 实体层 — 对照 dlc/engine/entity.py。
 * 领域无关的实体状态：channels（float 通道）+ flags（int 标志）+ meta。
 */
import type { ChannelConfig, EntityConfig, EntityState } from './types'

/** 从实体配置构造初始实体（channels 取 initial ?? default ?? 0，flags 取配置值）。 */
export function createEntity(entityId: string, config?: EntityConfig): EntityState {
  const entity: EntityState = { entity_id: entityId, channels: {}, flags: {}, meta: {} }
  for (const [key, cfg] of Object.entries(config?.channels ?? {})) {
    entity.channels[key] = Number(cfg.initial ?? cfg.default ?? 0)
  }
  for (const [key, value] of Object.entries(config?.flags ?? {})) {
    entity.flags[key] = Number(value)
  }
  return entity
}

export function entityToDict(state: EntityState): Record<string, unknown> {
  return { entity_id: state.entity_id, channels: state.channels, flags: state.flags, meta: state.meta }
}

export function entityFromDict(data: Record<string, unknown>): EntityState {
  return {
    entity_id: String(data.entity_id ?? ''),
    channels: asNumberRecord(data.channels),
    flags: asNumberRecord(data.flags),
    meta: (data.meta as Record<string, unknown> | undefined) ?? {},
  }
}

function asNumberRecord(value: unknown): Record<string, number> {
  const out: Record<string, number> = {}
  if (typeof value === 'object' && value !== null) {
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) out[k] = Number(v)
  }
  return out
}

/**
 * 自然衰减（P1-19）：对配置了 decay_per_tick 的通道每 tick 衰减，最低到 0。
 */
export function applyDecay(state: EntityState, entityConfig?: EntityConfig): void {
  for (const [chId, chCfg] of Object.entries(entityConfig?.channels ?? {})) {
    const decay = chCfg.decay_per_tick
    if (decay !== undefined && decay > 0) {
      const current = state.channels[chId] ?? 0
      state.channels[chId] = Math.max(0, current - Number(decay))
    }
  }
}
