/**
 * DLC 修改器层 — 对照 dlc/engine/modifier.py。
 * 纯函数：add / set / multiply / state_set / batch_restore / flag_toggle / 钳制 / 定时恢复 / 冷却 / 概率自动触发。
 */
import type { EffectConfig, EntityConfig, EntityState, ModifierConfig } from './types'

export interface ModifierResult {
  modifier_id: string
  applied: boolean
  deltas: Record<string, number>
  note: string
}

/** delta = (base + random(0, random)) * intensity */
export function calcDelta(effect: EffectConfig, intensity = 1.0): number {
  const base = Number(effect.base ?? 0)
  const rand = Number(effect.random ?? 0)
  const delta = base + (rand > 0 ? Math.random() * rand : 0)
  return delta * intensity
}

/** 通道值钳制（G1）：按实体配置的 min/max 裁剪。 */
export function clampChannel(state: EntityState, channel: string, entityConfig?: EntityConfig): void {
  const chCfg = entityConfig?.channels?.[channel]
  const minVal = chCfg?.min
  const maxVal = chCfg?.max
  if (minVal === undefined && maxVal === undefined) return
  const current = state.channels[channel] ?? 0
  if (minVal !== undefined && current < minVal) state.channels[channel] = Number(minVal)
  else if (maxVal !== undefined && current > maxVal) state.channels[channel] = Number(maxVal)
}

export function applyEffect(state: EntityState, channel: string, effect: EffectConfig, intensity = 1.0, entityConfig?: EntityConfig): number {
  switch (effect.type) {
    case 'add': {
      const delta = calcDelta(effect, intensity)
      state.channels[channel] = (state.channels[channel] ?? 0) + delta
      if (entityConfig !== undefined) clampChannel(state, channel, entityConfig)
      return delta
    }
    case 'set': {
      const delta = calcDelta(effect, intensity)
      state.channels[channel] = delta
      if (entityConfig !== undefined) clampChannel(state, channel, entityConfig)
      return delta
    }
    case 'multiply': {
      const multiplier = calcDelta(effect, intensity)
      const old = state.channels[channel] ?? 0
      state.channels[channel] = old * multiplier
      if (entityConfig !== undefined) clampChannel(state, channel, entityConfig)
      return state.channels[channel] - old
    }
    case 'state_set': {
      return applyStateSet(state, channel, effect, intensity)
    }
    case 'batch_restore': {
      return applyBatchRestore(state, effect)
    }
    default:
      return 0
  }
}

/** state_set（P2-01）：定时置值，到期自动恢复原值。 */
function applyStateSet(state: EntityState, channel: string, effect: EffectConfig, intensity: number): number {
  const delta = calcDelta(effect, intensity)
  const duration = Math.trunc(Number(effect.duration_ticks ?? 1))
  const meta = state.meta as Record<string, Record<string, { original: number; remaining: number }>>
  if (meta._state_set === undefined) meta._state_set = {}
  const existing = meta._state_set[channel]
  const original = existing !== undefined ? existing.original : (state.channels[channel] ?? 0)
  meta._state_set[channel] = { original, remaining: duration }
  state.channels[channel] = delta
  return delta
}

/** batch_restore（P2-02）：按 FIFO 恢复 count 个 state_set 通道。 */
function applyBatchRestore(state: EntityState, effect: EffectConfig): number {
  const meta = state.meta as Record<string, Record<string, { original: number; remaining: number }>>
  const effects = meta._state_set
  if (effects === undefined) return 0
  const count = Math.trunc(Number(effect.count ?? 1))
  let restored = 0
  for (const key of Object.keys(effects)) {
    if (restored >= count) break
    state.channels[key] = effects[key].original
    delete effects[key]
    restored += 1
  }
  if (Object.keys(effects).length === 0) delete meta._state_set
  return restored
}

/** 定时效果 tick（P2-03）：递减剩余 tick，到期恢复原值并钳制。 */
export function tickTimedEffects(state: EntityState, entityConfig?: EntityConfig): void {
  const meta = state.meta as Record<string, Record<string, { original: number; remaining: number }>>
  const effects = meta._state_set
  if (effects === undefined) return
  const expired: string[] = []
  for (const [channel, data] of Object.entries(effects)) {
    data.remaining -= 1
    if (data.remaining <= 0) {
      state.channels[channel] = data.original
      if (entityConfig !== undefined) clampChannel(state, channel, entityConfig)
      expired.push(channel)
    }
  }
  for (const ch of expired) delete effects[ch]
  if (Object.keys(effects).length === 0) delete meta._state_set
}

/** flag 切换（P1-15）：0 ↔ 1。 */
export function applyFlagToggle(state: EntityState, flag: string): void {
  state.flags[flag] = state.flags[flag] === 0 ? 1 : 0
}

function cooldownKey(modifier: ModifierConfig): string {
  return modifier.label ?? JSON.stringify(modifier)
}

function isOnCooldown(state: EntityState, modifier: ModifierConfig, tick: number): boolean {
  const cooldownTicks = Number(modifier.cooldown_ticks ?? 0)
  if (cooldownTicks <= 0) return false
  const meta = state.meta as Record<string, Record<string, number>>
  const lastUsed = meta._cooldowns?.[cooldownKey(modifier)] ?? -999
  return tick - lastUsed < cooldownTicks
}

function markCooldown(state: EntityState, modifier: ModifierConfig, tick: number): void {
  const cooldownTicks = Number(modifier.cooldown_ticks ?? 0)
  if (cooldownTicks <= 0) return
  const meta = state.meta as Record<string, Record<string, number>>
  if (meta._cooldowns === undefined) meta._cooldowns = {}
  meta._cooldowns[cooldownKey(modifier)] = tick
}

/**
 * 完整修改器管线（对照 apply_modifier）：冷却检查 → flag_toggle 或通道效果 → 记录 deltas。
 */
export function applyModifier(
  state: EntityState,
  modifier: ModifierConfig,
  intensity = 1.0,
  tick = 0,
  entityConfig?: EntityConfig,
): ModifierResult {
  const result: ModifierResult = { modifier_id: modifier.label ?? '', applied: false, deltas: {}, note: '' }

  if (isOnCooldown(state, modifier, tick)) {
    result.note = 'cooldown'
    return result
  }

  if (modifier.type === 'flag_toggle' && modifier.flag !== undefined) {
    applyFlagToggle(state, modifier.flag)
    result.applied = true
    result.note = `flag_toggle: ${modifier.flag}`
    markCooldown(state, modifier, tick)
    return result
  }

  let appliedAny = false
  for (const [channel, effectCfg] of Object.entries(modifier.effects ?? {})) {
    const delta = applyEffect(state, channel, effectCfg, intensity, entityConfig)
    if (delta !== 0 || (effectCfg.type !== undefined && effectCfg.type !== 'unknown')) {
      result.deltas[channel] = delta
      appliedAny = true
    }
  }

  result.applied = appliedAny
  if (appliedAny) {
    markCooldown(state, modifier, tick)
    result.note = `${Object.keys(result.deltas).length} channel(s) updated`
  }
  return result
}

/**
 * 概率自动触发（P2-03）：trigger_probability 命中时应用目标修改器。
 */
export function maybeAutoTrigger(
  state: EntityState,
  modifierId: string,
  triggerConfig: { trigger_probability?: number },
  modifiers: Record<string, ModifierConfig>,
  tick = 0,
): ModifierResult {
  const result: ModifierResult = { modifier_id: modifierId, applied: false, deltas: {}, note: '' }
  const probability = Number(triggerConfig.trigger_probability ?? 0)
  if (Math.random() >= probability) {
    result.note = 'probability_check_failed'
    return result
  }
  const mod = modifiers[modifierId]
  if (mod === undefined) {
    result.note = `modifier ${modifierId} not found`
    return result
  }
  return applyModifier(state, mod, 1.0, tick)
}
