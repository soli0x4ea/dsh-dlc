/**
 * DLC 事件层 — dlc/change 状态变更事件。
 * 纯类型与分发接口；P3 插件化时映射到 Cordis ctx.emit('dlc/change')。
 */
import type { ChannelDiff } from './types'

export interface DlcStateChangeEvent {
  card_id: string
  entity_id: string
  command: string
  narrative_ids: string[]
  channels_before: Record<string, number>
  channels_after: Record<string, number>
  flags_before: Record<string, number>
  flags_after: Record<string, number>
  diff: Record<string, ChannelDiff>
  timestamp: number
}

export type DlcStateChangeListener = (event: DlcStateChangeEvent) => void

/** 事件发射接口：引擎在每次成功 execute 后触发。 */
export interface DlcEventSink {
  emitStateChange(event: DlcStateChangeEvent): void
}

/** 极简同步事件总线（内存实现；P3 由插件替换为 Cordis 事件）。 */
export class DlcEventBus implements DlcEventSink {
  private readonly listeners = new Set<DlcStateChangeListener>()

  onStateChange(listener: DlcStateChangeListener): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  emitStateChange(event: DlcStateChangeEvent): void {
    for (const listener of this.listeners) {
      try {
        listener(event)
      } catch {
        // 监听器异常不阻断引擎流程
      }
    }
  }
}
