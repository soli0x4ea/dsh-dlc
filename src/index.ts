/**
 * dsh-dlc — DLC 数字生命卡片协议（TypeScript 重写）公共导出。
 */
export {
  cardJsonSchema,
  MODULE_SUBKEYS,
  MODULE_DEPENDENCIES,
  MODULE_LEVELS,
  DLC_PROTOCOL_VERSION,
} from './types'
export type {
  CardJson,
  DlcSingleFile,
  EntityState,
  ChannelConfig,
  EntityConfig,
  EntitiesConfig,
  EffectConfig,
  ModifierConfig,
  ModifiersConfig,
  ThresholdConfig,
  ThresholdEvent,
  ThresholdsConfig,
  CommandConfig,
  NarrativesConfig,
  ChannelDiff,
  ExecuteResult,
  StateSnapshot,
} from './types'

export { createEntity, entityToDict, entityFromDict, applyDecay } from './entity'
export {
  calcDelta,
  clampChannel,
  applyEffect,
  applyFlagToggle,
  applyModifier,
  tickTimedEffects,
  maybeAutoTrigger,
} from './modifiers'
export type { ModifierResult } from './modifiers'
export { checkThresholds } from './thresholds'
export {
  loadCardJson,
  checkVersion,
  resolveModules,
  detectComplexity,
  checkDependencies,
  ConfigResolver,
  CardRuntimeContext,
  unwrapConfig,
  CardLoadError,
  ResolverError,
} from './card-loader'
export type { ModuleIndex } from './card-loader'
export { StateManager } from './persistence'
export { DlcEngine } from './engine'
