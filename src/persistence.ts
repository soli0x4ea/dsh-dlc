/**
 * DLC 持久化层 — 对照 dlc/persistence.py。
 * StateManager：卡片作用域状态读写删（原子写）、导出/导入、备份/恢复。
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import type { CardRuntimeContext } from './card-loader'
import type { EntityState } from './types'

export class StateManager {
  private readonly stateDir: string
  private readonly cardId: string

  constructor(ctx: CardRuntimeContext) {
    this.stateDir = ctx.stateDir
    this.cardId = ctx.cardId
    mkdirSync(this.stateDir, { recursive: true })
  }

  read(entityId: string): Record<string, unknown> | null {
    const path = this.path(entityId)
    if (!existsSync(path)) return null
    return JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>
  }

  /** 原子写：临时文件 + rename（防止崩溃损坏）。 */
  write(entityId: string, data: unknown): string {
    const path = this.path(entityId)
    const tmp = join(tmpdir(), `dlc-${this.cardId}-${entityId}-${process.pid}-${Date.now()}.json`)
    writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8')
    renameSync(tmp, path)
    return path
  }

  delete(entityId: string): void {
    const path = this.path(entityId)
    if (existsSync(path)) rmSync(path)
  }

  listStates(): string[] {
    if (!existsSync(this.stateDir)) return []
    return readdirSync(this.stateDir)
      .filter((f) => f.endsWith('.json'))
      .map((f) => f.slice(0, -5))
      .sort()
  }

  /** 导出全部实体状态（.dlc-state 格式）。 */
  exportState(): Record<string, unknown> {
    const entities: Record<string, unknown> = {}
    for (const eid of this.listStates()) {
      const data = this.read(eid)
      if (data !== null) entities[eid] = data
    }
    return {
      protocol_version: '1.0.0',
      card_id: this.cardId,
      exported_at: new Date().toISOString(),
      entities,
    }
  }

  importState(data: Record<string, unknown>): void {
    const entities = (data.entities ?? {}) as Record<string, unknown>
    for (const [eid, state] of Object.entries(entities)) {
      this.write(eid, state)
    }
  }

  backup(label?: string): string {
    const backupDir = join(this.stateDir, '.backups')
    mkdirSync(backupDir, { recursive: true })
    const ts = timestampCompact()
    const suffix = label !== undefined ? `_${label}` : ''
    const path = join(backupDir, `backup_${ts}${suffix}.dlc-state`)
    writeFileSync(path, JSON.stringify(this.exportState(), null, 2), 'utf8')
    return path
  }

  restore(backupPath: string): void {
    const data = JSON.parse(readFileSync(backupPath, 'utf8')) as Record<string, unknown>
    this.importState(data)
  }

  listBackups(): string[] {
    const backupDir = join(this.stateDir, '.backups')
    if (!existsSync(backupDir)) return []
    return readdirSync(backupDir)
      .filter((f) => f.endsWith('.dlc-state'))
      .sort()
      .reverse()
      .map((f) => join(backupDir, f))
  }

  private path(entityId: string): string {
    return join(this.stateDir, `${entityId}.json`)
  }
}

function timestampCompact(): string {
  const d = new Date()
  const pad = (n: number): string => String(n).padStart(2, '0')
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}_${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`
}

export type { EntityState }
