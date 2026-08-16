/**
 * DLC 卡片加载层 — 对照 dlc/loader.py · dlc/validate.py · dlc/resolver.py · dlc/context.py。
 * 卡片解析、版本兼容、模块索引、配置惰性加载、运行时上下文。
 */
import { existsSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import type {
  CardJson,
  CommandConfig,
  EntityConfig,
  ModifierConfig,
  NarrativesConfig,
  ThresholdConfig,
} from './types'
import {
  DLC_PROTOCOL_VERSION,
  MODULE_DEPENDENCIES,
  MODULE_LEVELS,
  MODULE_SUBKEYS,
} from './types'

export class CardLoadError extends Error {}

const REQUIRED_FIELDS = [
  'protocol_version', 'card_id', 'card_name',
  'complexity_level', 'author', 'created_at', 'updated_at',
] as const

/** 解析 card.json；支持目录路径或直接文件路径；兼容 .dlc.json 单文件格式。 */
export function loadCardJson(input: string | Record<string, unknown>): CardJson {
  let raw: Record<string, unknown>
  if (typeof input === 'string') {
    const path = existsSync(input) && !input.endsWith('.json') ? join(input, 'card.json') : input
    if (!existsSync(path)) throw new CardLoadError(`card.json not found: ${path}`)
    try {
      raw = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>
    } catch (error) {
      throw new CardLoadError(`Invalid JSON in ${path}: ${String(error)}`)
    }
  } else {
    raw = input
  }

  // .dlc.json 单文件格式：{ "card": {...}, "configs": {...} }
  if (typeof raw.card === 'object' && raw.card !== null && 'configs' in raw) {
    raw = raw.card as Record<string, unknown>
  }

  const missing = REQUIRED_FIELDS.filter((k) => !(k in raw))
  if (missing.length > 0) {
    throw new CardLoadError(`Missing required fields: ${missing.join(', ')}`)
  }
  const versionError = checkVersion(DLC_PROTOCOL_VERSION, String(raw.protocol_version))
  if (versionError !== null) {
    throw new CardLoadError(`Protocol version mismatch: ${versionError}`)
  }
  return raw as CardJson
}

/**
 * 协议版本兼容（SemVer 规则）：同 major 兼容；卡片 major > 引擎 major 不兼容；引擎 major 更大则前向兼容。
 * 返回 null 表示兼容，否则返回错误信息。
 */
export function checkVersion(engineVersion: string, cardVersion: string): string | null {
  const parse = (v: string): number[] => v.trim().split('.').map((p) => Number.parseInt(p, 10))
  let eng: number[]
  let card: number[]
  try {
    eng = parse(engineVersion)
    card = parse(cardVersion)
  } catch {
    return `Invalid version format: engine=${engineVersion}, card=${cardVersion}`
  }
  if (card[0] > eng[0]) {
    return `Incompatible major version: card requires protocol ${cardVersion} (major ${card[0]}), engine supports ${engineVersion} (major ${eng[0]})`
  }
  return null
}

// ═══════════════════════════════════════════════════════════════
// 模块索引（对照 loader.py resolve_modules / detect_complexity / check_dependencies）
// ═══════════════════════════════════════════════════════════════

export interface ModuleIndex {
  [module: string]: Record<string, string | null>
}

/** 提取 enabled 模块及其子键路径。 */
export function resolveModules(card: CardJson): ModuleIndex {
  const result: ModuleIndex = {}
  for (const [modName, subkeys] of Object.entries(MODULE_SUBKEYS)) {
    const modCfg = (card.modules?.[modName] ?? {}) as Record<string, unknown>
    if (modCfg.enabled === true) {
      const entry: Record<string, string | null> = {}
      for (const sk of subkeys) entry[sk] = (modCfg[sk] as string | undefined) ?? null
      result[modName] = entry
    }
  }
  return result
}

/** 从启用模块自动探测复杂度等级（L0-L3），不匹配则回落声明等级。 */
export function detectComplexity(enabled: ModuleIndex, declared: string): string {
  const active = new Set(Object.keys(enabled))
  let detected = 'L0'
  for (const [level, required] of MODULE_LEVELS) {
    if (isSubset(required, active)) detected = level
  }
  return detected === 'L0' && declared !== '' ? declared : detected
}

function isSubset(required: ReadonlySet<string>, active: Set<string>): boolean {
  for (const r of required) if (!active.has(r)) return false
  return true
}

/** 依赖完整性检查：返回错误列表（空 = 无问题）。 */
export function checkDependencies(enabled: ModuleIndex): string[] {
  const errors: string[] = []
  const active = new Set(Object.keys(enabled))
  for (const [mod, deps] of Object.entries(MODULE_DEPENDENCIES)) {
    if (!active.has(mod)) continue
    for (const dep of deps) {
      if (!active.has(dep)) errors.push(`Module '${mod}' requires '${dep}' to be enabled`)
    }
  }
  return errors
}

// ═══════════════════════════════════════════════════════════════
// ConfigResolver（对照 resolver.py）
// ═══════════════════════════════════════════════════════════════

export class ResolverError extends Error {}

export class ConfigResolver {
  private readonly cache = new Map<string, Record<string, unknown>>()
  private readonly card: CardJson
  private readonly paths: ModuleIndex
  private readonly cardDir: string

  constructor(cardDir: string) {
    this.cardDir = resolve(cardDir)
    const raw = readCardJsonFile(this.cardDir)
    for (const key of ['card_id', 'protocol_version', 'modules']) {
      if (!(key in raw)) throw new ResolverError(`card.json missing required field: ${key}`)
    }
    this.card = raw as CardJson
    this.paths = resolveModules(this.card)
  }

  get cardId(): string {
    return this.card.card_id
  }

  get enabledModules(): string[] {
    return Object.keys(this.paths).sort()
  }

  get stateDir(): string {
    return join(this.cardDir, 'state')
  }

  loadConfig(module: string, subKey: string): Record<string, unknown> {
    const cacheKey = `${module}/${subKey}`
    const cached = this.cache.get(cacheKey)
    if (cached !== undefined) return cached
    const subPath = this.paths[module]?.[subKey]
    if (subPath === null || subPath === undefined) {
      throw new ResolverError(`config not configured: ${module}/${subKey}`)
    }
    const path = join(this.cardDir, subPath)
    if (!existsSync(path)) throw new ResolverError(`config file not found: ${path}`)
    const data = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>
    this.cache.set(cacheKey, data)
    return data
  }
}

function readCardJsonFile(cardDir: string): Record<string, unknown> {
  const path = join(cardDir, 'card.json')
  if (!existsSync(path)) throw new ResolverError(`card.json not found: ${path}`)
  return JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>
}

// ═══════════════════════════════════════════════════════════════
// CardRuntimeContext（对照 context.py）
// ═══════════════════════════════════════════════════════════════

/** 配置取外层键（如 "entities"），无则直接用原对象。 */
export function unwrapConfig(raw: Record<string, unknown> | undefined, key: string): Record<string, unknown> {
  if (raw !== undefined && typeof raw[key] === 'object' && raw[key] !== null) {
    return raw[key] as Record<string, unknown>
  }
  return raw ?? {}
}

export class CardRuntimeContext {
  readonly resolver: ConfigResolver
  readonly cardDir: string

  constructor(cardDir: string) {
    this.cardDir = resolve(cardDir)
    this.resolver = new ConfigResolver(this.cardDir)
  }

  get cardId(): string {
    return this.resolver.cardId
  }

  get entities(): Record<string, EntityConfig> {
    return unwrapConfig(this.safeLoad('engine', 'entities'), 'entities') as Record<string, EntityConfig>
  }

  get modifiers(): Record<string, ModifierConfig> {
    return unwrapConfig(this.safeLoad('engine', 'modifiers'), 'modifiers') as Record<string, ModifierConfig>
  }

  get thresholds(): Record<string, ThresholdConfig> {
    return unwrapConfig(this.safeLoad('engine', 'thresholds'), 'thresholds') as Record<string, ThresholdConfig>
  }

  get narratives(): NarrativesConfig {
    return this.safeLoad('engine', 'narratives')
  }

  get commands(): CommandConfig[] {
    const raw = this.safeLoad('interaction', 'commands')
    const unwrapped = unwrapConfig(raw, 'commands') as unknown
    if (Array.isArray(unwrapped)) return unwrapped as CommandConfig[]
    if (Array.isArray(raw)) return raw as CommandConfig[]
    return []
  }

  get stateDir(): string {
    return this.resolver.stateDir
  }

  private safeLoad(module: string, subKey: string): Record<string, unknown> {
    try {
      return this.resolver.loadConfig(module, subKey)
    } catch {
      return {}
    }
  }
}
