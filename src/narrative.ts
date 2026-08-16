/**
 * DLC 叙事组装 — 对照 dlc/narrative/assembly.py。
 * 编号 → 查表 → stdout 组装。纯知识库操作，零状态逻辑。
 */
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'

interface TemplateTable {
  [key: string]: unknown
}

interface PipelineStep {
  op?: string
  brackets?: Array<[number, number]>
  texts?: string[]
  key?: string
  cases?: Record<string, string>
  if?: unknown[]
  condition?: { channel?: string; min?: number; max?: number }
  text?: string
  variants?: Array<{ weight?: number; text?: string }>
  template?: string
}

export class NarrativeAssembly {
  private readonly templates: TemplateTable = {}
  private readonly cardPath: string

  constructor(cardPath: string) {
    this.cardPath = resolve(cardPath)
    this.loadTemplates()
  }

  /** 给定叙事编号数组，组装完整 stdout 文本。 */
  assemble(narrativeIds: string[]): string {
    const parts: string[] = []
    for (const nid of narrativeIds) {
      const text = this.lookup(nid)
      if (text !== '') parts.push(text)
    }
    return parts.join('\n')
  }

  // ═══════════════════════════════════════════════════════════
  // Internal
  // ═══════════════════════════════════════════════════════════

  private loadTemplates(): void {
    let templateDir = join(this.cardPath, 'narratives', 'templates')
    if (!existsSync(templateDir)) {
      templateDir = join(this.cardPath, 'narratives')
      if (!existsSync(templateDir)) {
        const legacy = join(this.cardPath, 'engine', 'narratives.json')
        if (existsSync(legacy)) {
          try {
            this.templates['_legacy'] = JSON.parse(readFileSync(legacy, 'utf8')) as TemplateTable
          } catch { /* 忽略坏模板 */ }
        }
        return
      }
    }
    for (const fname of readdirSync(templateDir)) {
      if (!fname.endsWith('.json')) continue
      const key = fname.slice(0, -5)
      try {
        this.templates[key] = JSON.parse(readFileSync(join(templateDir, fname), 'utf8')) as TemplateTable
      } catch { /* 忽略坏模板 */ }
    }
  }

  private lookup(narrativeId: string): string {
    const parts = narrativeId.split('.')
    const domain = parts[0] ?? ''

    if (domain === 'system') return parts.length > 1 ? this.lookupSystem(parts[1] ?? '') : ''
    if (domain === 'action') return this.lookupAction(parts.slice(1))
    if (domain === 'threshold' || domain === 'boundary') return this.lookupEvent(parts.slice(1))
    if (domain === 'command') return this.lookupAction(parts.slice(1))
    if (domain === 'event') return this.lookupEvent(parts.slice(1))
    if (domain === 'emergence') return this.lookupEmergence(parts.slice(1))

    // 直接键查表
    const tmpl = this.templates[narrativeId]
    if (typeof tmpl === 'string') return tmpl
    if (typeof tmpl === 'object' && tmpl !== null) {
      const obj = tmpl as Record<string, unknown>
      return String(obj.text ?? obj.narrative ?? String(tmpl))
    }
    return ''
  }

  private lookupSystem(subtype: string): string {
    const texts: Record<string, string> = { status: '(状态快照已返回)', reset: '(状态已重置)' }
    return texts[subtype] ?? ''
  }

  private lookupAction(parts: string[]): string {
    if (parts.length === 0) return ''
    const cmdId = parts[0] ?? ''

    let variant: string | null = null
    let level: string | null = null
    if (parts.length === 2) {
      level = parts[1] ?? null
    } else if (parts.length >= 3) {
      variant = parts[1] ?? null
      level = parts[2] ?? null
    }

    // Path 1: templates/<cmd>.json → STIMULATE[level] / NARRATIVES[variant][level]
    const cmdTmpl = this.templates[cmdId]
    if (typeof cmdTmpl === 'object' && cmdTmpl !== null && level !== null && /^\d+$/.test(level)) {
      const idx = Number.parseInt(level, 10)
      const table = cmdTmpl as Record<string, unknown>
      const stimulate = (table.STIMULATE ?? {}) as Record<string, unknown>
      if (idx in stimulate) return String(stimulate[idx])
      if (variant !== null) {
        const narratives = (table.NARRATIVES ?? {}) as Record<string, unknown>
        const varNarr = narratives[variant]
        if (typeof varNarr === 'object' && varNarr !== null && idx in (varNarr as Record<string, unknown>)) {
          return String((varNarr as Record<string, unknown>)[idx])
        }
        if (typeof varNarr === 'string') return varNarr
      }
    }

    // Path 2: legacy command_assembly（管道格式）
    const legacy = this.templates['_legacy'] as Record<string, unknown> | undefined
    const cmdAssembly = (legacy?.command_assembly ?? {}) as Record<string, unknown>
    const cmdData = cmdAssembly[cmdId] ?? cmdAssembly[`cmd_${cmdId}`]
    if (cmdData !== undefined) {
      return level !== null ? resolvePipeline(cmdData, level) : resolvePipelineNoLevel(cmdData)
    }
    return ''
  }

  private lookupEvent(parts: string[]): string {
    if (parts.length === 0) return ''
    let eventId = parts[0] ?? ''
    let variant: string | null = parts.length > 1 ? (parts[1] ?? null) : null

    // variant 后缀检测（boundary.overflow_a → event_id=overflow, variant=a）
    for (const suffix of ['_v', '_a', '_u']) {
      if (variant === null && eventId.endsWith(suffix)) {
        eventId = eventId.slice(0, -suffix.length)
        variant = suffix.slice(1)
        break
      }
    }

    // Path 1: templates/events.json
    const eventsTmpl = this.templates['events'] as Record<string, unknown> | undefined
    if (eventsTmpl !== undefined) {
      const ev = eventsTmpl[eventId]
      if (ev !== undefined) return extractTextFromEvent(ev)
    }

    // Path 2: legacy events 精确
    const legacy = this.templates['_legacy'] as Record<string, unknown> | undefined
    const legEvents = (legacy?.events ?? {}) as Record<string, unknown>
    const exact = legEvents[eventId]
    if (exact !== undefined) return extractTextFromEvent(exact)

    // Path 3: legacy prefixed variants
    const legacyId = mapLegacyEventId(eventId, legEvents)
    if (legacyId !== null) {
      const ev = legEvents[legacyId]
      if (ev !== undefined) return extractTextFromEvent(ev)
    }

    // Path 4: legacy composite boundary
    if (variant !== null) return assembleLegacyBoundary(eventId, variant, legEvents)

    return ''
  }

  private lookupEmergence(parts: string[]): string {
    if (parts.length === 0) return ''
    const emergence = this.templates['emergence'] as Record<string, unknown> | undefined
    const value = emergence?.[parts[0] ?? '']
    return value === undefined ? '' : String(value)
  }
}

// ═══════════════════════════════════════════════════════════════
// 管道解析（对照 _resolve_pipeline / _resolve_pipeline_no_level）
// ═══════════════════════════════════════════════════════════════

function resolvePipeline(cmdData: unknown, level: string): string {
  if (typeof cmdData === 'string') return cmdData
  if (Array.isArray(cmdData)) {
    const levelInt = /^\d+$/.test(level) ? Number.parseInt(level, 10) : null
    const texts: string[] = []
    for (const step of cmdData) {
      if (typeof step !== 'object' || step === null) continue
      const s = step as PipelineStep
      const op = s.op ?? ''
      if (op === 'range' && levelInt !== null) {
        const brackets = s.brackets ?? []
        const stepTexts = s.texts ?? []
        for (let bi = 0; bi < brackets.length; bi += 1) {
          const [lo, hi] = brackets[bi] ?? [0, 0]
          if (levelInt >= lo && levelInt <= hi && bi < stepTexts.length) texts.push(stepTexts[bi] ?? '')
        }
      } else if (op === 'switch') {
        const matched = levelInt !== null ? (s.cases ?? {})[String(levelInt)] : undefined
        if (matched !== undefined) texts.push(matched)
      } else if (op === 'cond') {
        const allTexts = s.texts ?? []
        const idx = levelInt !== null && levelInt < allTexts.length ? levelInt : 0
        if (allTexts.length > 0) texts.push(allTexts[idx] ?? '')
      } else if (op === 'conditional') {
        const cond = s.condition ?? {}
        const lo = cond.min ?? -999
        const hi = cond.max ?? 999
        if (levelInt !== null && levelInt >= lo && levelInt <= hi) texts.push(s.text ?? '')
      } else if (op === 'rand') {
        const variants = s.variants ?? []
        if (variants.length > 0) {
          const weights = variants.map((v) => v.weight ?? 1)
          const total = weights.reduce((a, b) => a + b, 0)
          let pick = Math.random() * total
          let chosen = variants[0]?.text ?? ''
          for (let i = 0; i < variants.length; i += 1) {
            pick -= weights[i] ?? 1
            if (pick <= 0) { chosen = variants[i]?.text ?? ''; break }
          }
          texts.push(chosen)
        }
      } else if (op === 'interp') {
        texts.push(s.template ?? '')
      }
    }
    return texts.join('\n')
  }
  if (typeof cmdData === 'object' && cmdData !== null) {
    const obj = cmdData as Record<string, unknown>
    const text = obj.text ?? obj.narrative ?? ''
    if (typeof text === 'string' && text !== '') return text
    if (Array.isArray(text)) return (text as string[]).slice(0, 3).join('\n')
    return ''
  }
  return ''
}

function resolvePipelineNoLevel(cmdData: unknown): string {
  if (typeof cmdData === 'string') return cmdData
  if (Array.isArray(cmdData)) {
    for (const step of cmdData) {
      if (typeof step !== 'object' || step === null) continue
      const s = step as PipelineStep
      const op = s.op ?? ''
      if (op === 'interp') return s.template ?? ''
      if (op === 'rand') {
        const variants = s.variants ?? []
        if (variants.length > 0) {
          const weights = variants.map((v) => v.weight ?? 1)
          const total = weights.reduce((a, b) => a + b, 0)
          let pick = Math.random() * total
          for (let i = 0; i < variants.length; i += 1) {
            pick -= weights[i] ?? 1
            if (pick <= 0) return variants[i]?.text ?? ''
          }
          return variants[0]?.text ?? ''
        }
      }
      if (op === 'range' || op === 'cond') {
        const texts = s.texts ?? []
        if (texts.length > 0) return texts[0] ?? ''
      }
      if (op === 'switch') {
        const cases = s.cases ?? {}
        const first = Object.values(cases)[0]
        if (first !== undefined) return first
      }
      if (op === 'conditional') return s.text ?? ''
    }
    return ''
  }
  if (typeof cmdData === 'object' && cmdData !== null) {
    const obj = cmdData as Record<string, unknown>
    const text = obj.text ?? obj.narrative ?? ''
    if (typeof text === 'string' && text !== '') return text
    if (Array.isArray(text)) return (text as string[]).slice(0, 3).join('\n')
    return ''
  }
  return ''
}

function extractTextFromEvent(ev: unknown): string {
  if (typeof ev === 'string') return ev
  if (typeof ev === 'object' && ev !== null) {
    const obj = ev as Record<string, unknown>
    const texts = (obj.texts ?? {}) as Record<string, unknown>
    return String(texts.intense ?? texts.peak ?? texts.medium ?? texts.mild ?? obj.text ?? '')
  }
  return ''
}

function mapLegacyEventId(eventId: string, legEvents: Record<string, unknown>): string | null {
  for (const c of [`narr_status_warn_${eventId}`, `narr_critical_${eventId}`, `narr_${eventId}`]) {
    if (c in legEvents) return c
  }
  return null
}

function assembleLegacyBoundary(eventId: string, variant: string, legEvents: Record<string, unknown>): string {
  const prefix = `narr_${eventId}_${variant}_`
  const parts: string[] = []
  for (const key of Object.keys(legEvents).sort()) {
    if (key.startsWith(prefix)) parts.push(extractTextFromEvent(legEvents[key]))
  }
  return parts.join('')
}
