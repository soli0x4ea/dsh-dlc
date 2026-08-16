/**
 * DLC Protocol v3.0 — TypeScript 类型层。
 *
 * 语义对照参考实现（Python）：dlc/loader.py · dlc/engine/entity.py ·
 * dlc/engine/modifier.py · dlc/engine/threshold.py · dlc/constants.py。
 *
 * 全部为类型与 schema，无运行时逻辑（除 zod schema 定义）。
 */
import { z } from 'zod'

// ═══════════════════════════════════════════════════════════════
// card.json
// ═══════════════════════════════════════════════════════════════

export const cardJsonSchema = z.object({
  protocol_version: z.string(),
  card_id: z.string(),
  card_name: z.string(),
  complexity_level: z.string(),
  author: z.string(),
  created_at: z.string(),
  updated_at: z.string(),
  description: z.string().optional(),
  tags: z.array(z.string()).optional(),
  modules: z.record(z.unknown()).optional(),
  engine_requirements: z.record(z.unknown()).optional(),
})

export type CardJson = z.infer<typeof cardJsonSchema>

/** 单文件 .dlc.json 格式：{ "card": {...}, "configs": {...} } */
export interface DlcSingleFile {
  card: Record<string, unknown>
  configs?: Record<string, unknown>
}

// ═══════════════════════════════════════════════════════════════
// 模块常量（对照 dlc/constants.py）
// ═══════════════════════════════════════════════════════════════

export const MODULE_SUBKEYS: Record<string, readonly string[]> = {
  identity: ['profile', 'personality', 'speech'],
  body: ['anatomy', 'zones'],
  engine: ['entities', 'modifiers', 'thresholds', 'narratives'],
  memory: [],
  behavior: ['lws_rules'],
  interaction: ['commands', 'items'],
} as const

export const MODULE_DEPENDENCIES: Record<string, readonly string[]> = {
  engine: ['body'],
  memory: ['engine'],
  behavior: ['engine'],
  interaction: ['engine'],
}

export const MODULE_LEVELS: ReadonlyArray<readonly [string, ReadonlySet<string>]> = [
  ['L0', new Set(['identity'])],
  ['L1', new Set(['identity', 'body', 'engine'])],
  ['L2', new Set(['identity', 'body', 'engine', 'memory', 'behavior'])],
  ['L3', new Set(['identity', 'body', 'engine', 'memory', 'behavior', 'interaction'])],
]

export const DLC_PROTOCOL_VERSION = '1.0.0'

// ═══════════════════════════════════════════════════════════════
// 实体（对照 EntityState）
// ═══════════════════════════════════════════════════════════════

export interface EntityState {
  entity_id: string
  channels: Record<string, number>
  flags: Record<string, number>
  meta: Record<string, unknown>
}

export interface ChannelConfig {
  initial?: number
  default?: number
  min?: number
  max?: number
  decay_per_tick?: number
}

export interface EntityConfig {
  channels: Record<string, ChannelConfig>
  flags: Record<string, number>
}

/**
 * entities 配置文件。Python 侧 `_unwrap_config(raw, "entities")` 支持两种形态：
 *   { "entities": { ... } }   带外层键（文件原始形态）
 *   { "e_g": { ... } }        直接实体表
 */
export type EntitiesConfig = Record<string, unknown>

// ═══════════════════════════════════════════════════════════════
// 修改器（对照 dlc/engine/modifier.py）
// ═══════════════════════════════════════════════════════════════

export type EffectType = 'add' | 'set' | 'multiply' | 'state_set' | 'batch_restore'

export interface EffectConfig {
  /** 效果类型；已知类型 add/set/multiply/state_set/batch_restore，未知类型运行时忽略（对照 Python 语义）。 */
  type: string
  base?: number
  random?: number
  duration_ticks?: number
  count?: number
}

export interface ModifierConfig {
  label?: string
  type?: 'flag_toggle' | 'channel'
  flag?: string
  effects?: Record<string, EffectConfig>
  cooldown_ticks?: number
}

/** modifiers 配置文件，同 entities 的双形态约定（外层键 "modifiers"）。 */
export type ModifiersConfig = Record<string, unknown>

// ═══════════════════════════════════════════════════════════════
// 阈值（对照 dlc/engine/threshold.py）
// ═══════════════════════════════════════════════════════════════

export type ThresholdOperator = '>=' | '>' | '<=' | '<' | '=='

export interface ThresholdConfig {
  entity: string
  channel: string
  operator: ThresholdOperator
  value: number
  event_id: string
  event_type?: 'warning' | 'critical' | 'peak' | 'clearing'
  cooldown_ticks?: number
}

export interface ThresholdEvent {
  threshold_id: string
  entity_id: string
  channel: string
  current_value: number
  threshold_value: number
  operator: string
  event_id: string
  event_type: string
}

/** thresholds 配置文件（外层键 "thresholds"）。 */
export type ThresholdsConfig = Record<string, unknown>

// ═══════════════════════════════════════════════════════════════
// 命令与道具（P2 使用；对照 dlc/interaction/*）
// ═══════════════════════════════════════════════════════════════

/** narratives 配置文件：叙事编号 → 叙事条目。 */
export type NarrativesConfig = Record<string, unknown>

// ═══════════════════════════════════════════════════════════════
// 引擎结果类型（对照 StateMachineEngine 输出）
// ═══════════════════════════════════════════════════════════════

export interface ChannelDiff {
  before: number
  after: number
  delta: number
}

export interface ExecuteResult {
  narrative_ids: string[]
  state_diff: Record<string, ChannelDiff>
  flags: Record<string, number>
  error: string | null
}

export interface StateSnapshot {
  card_id: string
  entities: Record<string, { channels: Record<string, number>; flags: Record<string, number> }>
}
