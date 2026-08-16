/**
 * DLC 阈值层 — 对照 dlc/engine/threshold.py。
 * 纯函数：按实体过滤 → 冷却检查 → 操作符比较 → ThresholdEvent 列表。
 */
import type { EntityState, ThresholdConfig, ThresholdEvent } from './types'

const OPERATORS: Record<string, (cur: number, thr: number) => boolean> = {
  '>=': (cur, thr) => cur >= thr,
  '>': (cur, thr) => cur > thr,
  '<=': (cur, thr) => cur <= thr,
  '<': (cur, thr) => cur < thr,
  '==': (cur, thr) => cur === thr,
}

function isThresholdOnCooldown(state: EntityState, tid: string, config: ThresholdConfig, tick: number): boolean {
  const cooldownTicks = Number(config.cooldown_ticks ?? 0)
  if (cooldownTicks <= 0) return false
  const meta = state.meta as Record<string, Record<string, number>>
  const lastFired = meta._threshold_cd?.[tid] ?? -999
  return tick - lastFired < cooldownTicks
}

function markThresholdCooldown(state: EntityState, tid: string, config: ThresholdConfig, tick: number): void {
  const cooldownTicks = Number(config.cooldown_ticks ?? 0)
  if (cooldownTicks <= 0) return
  const meta = state.meta as Record<string, Record<string, number>>
  if (meta._threshold_cd === undefined) meta._threshold_cd = {}
  meta._threshold_cd[tid] = tick
}

/**
 * 检查全部阈值（对照 check_thresholds）。按 threshold_id 顺序返回触发事件。
 */
export function checkThresholds(state: EntityState, thresholds: Record<string, ThresholdConfig>, tick = 0): ThresholdEvent[] {
  const events: ThresholdEvent[] = []
  for (const [tid, config] of Object.entries(thresholds)) {
    if (config.entity !== state.entity_id) continue
    const current = state.channels[config.channel]
    if (current === undefined) continue
    if (isThresholdOnCooldown(state, tid, config, tick)) continue

    const operator = config.operator ?? '>='
    const thresholdValue = Number(config.value ?? 0)
    const checker = OPERATORS[operator] ?? OPERATORS['>=']
    if (checker(current, thresholdValue)) {
      events.push({
        threshold_id: tid,
        entity_id: config.entity,
        channel: config.channel,
        current_value: current,
        threshold_value: thresholdValue,
        operator,
        event_id: config.event_id,
        event_type: config.event_type ?? 'warning',
      })
      markThresholdCooldown(state, tid, config, tick)
    }
  }
  return events
}
