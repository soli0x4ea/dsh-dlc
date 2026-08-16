/**
 * DLC 记忆层 — 对照 dlc/memory/chatlog.py · timeline.py · search.py。
 * 双核线性记忆：ChatlogStore（按日 JSONL，MD5 去重）+ TimelineStore（小时级覆盖）+ MemorySearch。
 */
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, openSync, readFileSync, readdirSync, renameSync, unlinkSync, writeFileSync, closeSync } from 'node:fs'
import { join, resolve } from 'node:path'

export interface ChatlogEntry {
  ts: number
  hash: string
  role: string
  content: string
  [key: string]: unknown
}

export interface TimelineEntry {
  date_hour: string
  ts: number
  summary: string
  [key: string]: unknown
}

/** 文件锁：O_EXCL 创建，5 秒超时。 */
function withLock<T>(lockFile: string, fn: () => T, timeoutMs = 5000): T {
  const deadline = Date.now() + timeoutMs
  let fd: number | null = null
  for (;;) {
    try {
      fd = openSync(lockFile, 'wx', 0o600)
      break
    } catch {
      if (Date.now() >= deadline) throw new Error(`lock timeout: ${lockFile}`)
      sleepMs(50)
    }
  }
  try {
    return fn()
  } finally {
    if (fd !== null) closeSync(fd)
    try { unlinkSync(lockFile) } catch { /* 已释放 */ }
  }
}

function sleepMs(ms: number): void {
  const end = Date.now() + ms
  while (Date.now() < end) { /* 锁等待：短暂忙等 */ }
}

export class ChatlogStore {
  readonly rootDir: string

  constructor(rootDir: string) {
    this.rootDir = resolve(rootDir)
    mkdirSync(this.rootDir, { recursive: true })
  }

  append(role: string, content: string, meta: Record<string, unknown> = {}, ts = Date.now() / 1000, dateStr?: string): boolean {
    const day = dateStr ?? new Date().toISOString().slice(0, 10)
    const hash = md5(`${role}|${content}`)
    const lockFile = this.path(`${day}.jsonl.lock`)
    return withLock(lockFile, () => {
      const hashes = this.loadHashes(day)
      if (hashes.has(hash)) return false
      const entry: ChatlogEntry = { ts, hash, role, content, ...meta }
      const tmp = this.path(`${day}.jsonl.tmp`)
      const target = this.path(`${day}.jsonl`)
      const existing = existsSync(target) ? readFileSync(target, 'utf8') : ''
      writeFileSync(tmp, `${existing}${JSON.stringify(entry)}\n`, 'utf8')
      renameSync(tmp, target)
      return true
    })
  }

  loadDay(dateStr: string): ChatlogEntry[] {
    const path = this.path(`${dateStr}.jsonl`)
    if (!existsSync(path)) return []
    return readLines(path).map((line) => JSON.parse(line) as ChatlogEntry)
  }

  loadRange(start: string, end: string): ChatlogEntry[] {
    const result: ChatlogEntry[] = []
    for (const fname of readdirSync(this.rootDir).sort()) {
      if (!/^\d{4}-\d{2}-\d{2}\.jsonl$/.test(fname)) continue
      const day = fname.slice(0, 10)
      if (day >= start && day <= end) result.push(...this.loadDay(day))
    }
    return result
  }

  recent(n = 10): ChatlogEntry[] {
    const files = readdirSync(this.rootDir).filter((f) => /^\d{4}-\d{2}-\d{2}\.jsonl$/.test(f)).sort().reverse().slice(0, n)
    const entries: ChatlogEntry[] = []
    for (const f of files) {
      for (const line of readLines(this.path(f)).reverse()) {
        entries.push(JSON.parse(line) as ChatlogEntry)
        if (entries.length >= n) return entries
      }
    }
    return entries
  }

  stats(): Record<string, number> {
    let total = 0
    const byRole: Record<string, number> = {}
    for (const fname of readdirSync(this.rootDir)) {
      if (!/^\d{4}-\d{2}-\d{2}\.jsonl$/.test(fname)) continue
      for (const line of readLines(this.path(fname))) {
        try {
          const entry = JSON.parse(line) as ChatlogEntry
          total += 1
          byRole[entry.role] = (byRole[entry.role] ?? 0) + 1
        } catch { /* 跳过坏行 */ }
      }
    }
    return { total, ...byRole }
  }

  private loadHashes(dateStr: string): Set<string> {
    const hashes = new Set<string>()
    const path = this.path(`${dateStr}.jsonl`)
    if (!existsSync(path)) return hashes
    for (const line of readLines(path)) {
      try {
        const entry = JSON.parse(line) as ChatlogEntry
        if (entry.hash !== undefined) hashes.add(entry.hash)
      } catch { /* 跳过 */ }
    }
    return hashes
  }

  private path(name: string): string {
    return join(this.rootDir, name)
  }
}

export class TimelineStore {
  readonly rootDir: string

  constructor(rootDir: string) {
    this.rootDir = resolve(rootDir)
    mkdirSync(this.rootDir, { recursive: true })
  }

  /** 写入小时槽（同小时覆盖）。 */
  write(dateHour: string, summary: string, meta: Record<string, unknown> = {}, ts = Date.now() / 1000): void {
    const file = join(this.rootDir, 'timeline.jsonl')
    const lockFile = join(this.rootDir, 'timeline.jsonl.lock')
    const entry: TimelineEntry = { date_hour: dateHour, ts, summary, ...meta }
    withLock(lockFile, () => {
      const lines = existsSync(file) ? readLines(file) : []
      const out = lines.filter((line) => {
        try { return (JSON.parse(line) as TimelineEntry).date_hour !== dateHour } catch { return true }
      })
      out.push(JSON.stringify(entry))
      writeFileSync(file, `${out.join('\n')}\n`, 'utf8')
    })
  }

  range(startHour: string, endHour: string): TimelineEntry[] {
    const file = join(this.rootDir, 'timeline.jsonl')
    if (!existsSync(file)) return []
    return readLines(file)
      .map((line) => JSON.parse(line) as TimelineEntry)
      .filter((e) => e.date_hour >= startHour && e.date_hour <= endHour)
  }

  recent(n = 24): TimelineEntry[] {
    const file = join(this.rootDir, 'timeline.jsonl')
    if (!existsSync(file)) return []
    return readLines(file).map((line) => JSON.parse(line) as TimelineEntry).slice(-n).reverse()
  }
}

export class MemorySearch {
  constructor(readonly chatlog: ChatlogStore, readonly timeline: TimelineStore) {}

  byDate(dateStr: string): Record<string, unknown> {
    return {
      chatlog: this.chatlog.loadDay(dateStr),
      timeline: this.timeline.range(`${dateStr}-00`, `${dateStr}-23`),
    }
  }

  byRange(start: string, end: string): Record<string, unknown> {
    return {
      chatlog: this.chatlog.loadRange(start, end),
      timeline: this.timeline.range(`${start}-00`, `${end}-23`),
    }
  }

  recent(nChatlog = 10, nTimeline = 24): Record<string, unknown> {
    return { chatlog: this.chatlog.recent(nChatlog), timeline: this.timeline.recent(nTimeline) }
  }

  search(keyword: string, maxResults = 30): Record<string, unknown> {
    const kw = keyword.toLowerCase()
    const hit = (content: string): boolean => content.toLowerCase().includes(kw)
    const chatlogHits = this.chatlog.loadRange('0000-01-01', '9999-12-31').filter((e) => hit(e.content)).slice(0, maxResults)
    const timelineHits = this.timeline.range('0000-00-00', '9999-99-99').filter((e) => hit(e.summary)).slice(0, maxResults)
    return { chatlog: chatlogHits, timeline: timelineHits }
  }

  stats(): Record<string, unknown> {
    return { chatlog: this.chatlog.stats(), timeline: this.timeline.recent(1000).length }
  }

  injectContext(chatlogDays = 3, maxChatlog = 15, maxTimeline = 24): string {
    const end = new Date()
    const start = new Date(end.getTime() - chatlogDays * 86400000)
    const byRange = this.byRange(isoDay(start), isoDay(end))
    const chatlog = (byRange.chatlog as ChatlogEntry[]).slice(-maxChatlog)
    const timeline = (byRange.timeline as TimelineEntry[]).slice(-maxTimeline)
    return JSON.stringify({ chatlog, timeline }, null, 2)
  }
}

/** 记录一条对话（快捷入口，对照 record_chat）。 */
export function recordChat(chatlog: ChatlogStore, role: string, content: string, meta: Record<string, unknown> = {}): boolean {
  return chatlog.append(role, content, meta)
}

function md5(text: string): string {
  return createHash('md5').update(text, 'utf8').digest('hex')
}

function readLines(path: string): string[] {
  const text = readFileSync(path, 'utf8')
  return text.split('\n').map((l) => l.trim()).filter((l) => l !== '')
}

function isoDay(d: Date): string {
  return d.toISOString().slice(0, 10)
}
