/**
 * DLC 存储抽象 — 可插拔状态持久化。
 * StateStore 接口 + 文件实现（默认）；P3 收尾时 DSH 侧提供 storages 适配。
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import type { CardRuntimeContext } from './card-loader.ts'
import type { EntityState } from './types.ts'

/** 状态存储接口：P3 起引擎通过它读写实体状态，可替换为 DSH storages 后端。 */
export interface StateStore {
  read(entityId: string): Record<string, unknown> | null
  write(entityId: string, data: unknown): string
  delete(entityId: string): void
  list(): string[]
}

/** 文件后端：state 目录下 <entity>.json，原子写（tmp + rename）。 */
export class FileStateStore implements StateStore {
  constructor(private readonly stateDir: string, private readonly cardId: string) {
    mkdirSync(stateDir, { recursive: true })
  }

  read(entityId: string): Record<string, unknown> | null {
    const path = this.path(entityId)
    if (!existsSync(path)) return null
    return JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>
  }

  write(entityId: string, data: unknown): string {
    const path = this.path(entityId)
    const tmp = join(tmpdir(), `dlc-${this.cardId}-${entityId}-${process.pid}-${Date.now()}.json`)
    writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8')
    renameSync(tmp, path)
    return path
  }

  delete(entityId: string): void {
    if (existsSync(this.path(entityId))) rmSync(this.path(entityId))
  }

  list(): string[] {
    if (!existsSync(this.stateDir)) return []
    return readdirSync(this.stateDir)
      .filter((f) => f.endsWith('.json'))
      .map((f) => f.slice(0, -5))
      .sort()
  }

  private path(entityId: string): string {
    return join(this.stateDir, `${entityId}.json`)
  }
}

/** 内存后端（测试/临时用）。 */
export class MemoryStateStore implements StateStore {
  private readonly map = new Map<string, Record<string, unknown>>()

  read(entityId: string): Record<string, unknown> | null {
    return this.map.get(entityId) ?? null
  }

  write(entityId: string, data: unknown): string {
    this.map.set(entityId, data as Record<string, unknown>)
    return entityId
  }

  delete(entityId: string): void {
    this.map.delete(entityId)
  }

  list(): string[] {
    return [...this.map.keys()].sort()
  }
}

/** 状态管理器（对照 StateManager），基于可插拔 StateStore。 */
export class StateManager {
  constructor(
    ctx: CardRuntimeContext,
    private readonly store: StateStore = new FileStateStore(ctx.stateDir, ctx.cardId),
  ) {}

  read(entityId: string): Record<string, unknown> | null {
    return this.store.read(entityId)
  }

  write(entityId: string, data: unknown): string {
    return this.store.write(entityId, data)
  }

  delete(entityId: string): void {
    this.store.delete(entityId)
  }

  listStates(): string[] {
    return this.store.list()
  }

  exportState(): Record<string, unknown> {
    const entities: Record<string, unknown> = {}
    for (const eid of this.store.list()) {
      const data = this.store.read(eid)
      if (data !== null) entities[eid] = data
    }
    return { protocol_version: '1.0.0', exported_at: new Date().toISOString(), entities }
  }

  backup(label?: string): string {
    const backupDir = join((this.store as FileStateStore)['stateDir'] ?? tmpdir(), '.backups')
    mkdirSync(backupDir, { recursive: true })
    const d = new Date()
    const pad = (n: number): string => String(n).padStart(2, '0')
    const ts = `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}_${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`
    const suffix = label !== undefined ? `_${label}` : ''
    const path = join(backupDir, `backup_${ts}${suffix}.dlc-state`)
    writeFileSync(path, JSON.stringify(this.exportState(), null, 2), 'utf8')
    return path
  }

  importState(data: Record<string, unknown>): void {
    const entities = (data.entities ?? {}) as Record<string, unknown>
    for (const [eid, state] of Object.entries(entities)) this.store.write(eid, state)
  }
}

export type { EntityState }
