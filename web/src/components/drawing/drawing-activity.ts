/**
 * What the person does on the canvas, as steps (`DrawingViewProps.onActivity`, plugin-api web.ts):
 * shapes drawn, changed or removed, the selection, and the element under the pointer. The Drawing
 * plugin records them beside the person's voice for a walkthrough (core/drawings/narration.ts).
 *
 * The editor reports whole scenes, so this diffs each one against the last by element version.
 * A scene loaded from outside (the first one, the AI's edit, another window's save) is taken as
 * the new baseline without a step: only the person's own changes are steps. A label inside a shape
 * counts as the shape (people talk about the box, not its text element). Pure: no editor import.
 */

export type ActivityKind = 'add' | 'edit' | 'delete' | 'select' | 'point'

export interface Activity {
  kind: ActivityKind
  ids: string[]
  labels: string[]
  at: number
}

/** The fields this reads of an editor element. */
export interface ActivityElement {
  id: string
  type: string
  version: number
  isDeleted?: boolean
  x: number
  y: number
  width: number
  height: number
  text?: string
  originalText?: string
  name?: string | null
  containerId?: string | null
  boundElements?: ReadonlyArray<{ id: string; type: string }> | null
}

/** Elements the pointer never "rests on": lines and arrows span too much space to mean one thing. */
const NOT_POINTABLE = new Set(['arrow', 'line', 'freedraw', 'selection'])
/** Only report an element as pointed at after the pointer stayed this long (a pass across is not pointing). */
export const POINT_DWELL_MS = 300

function firstLine(s: unknown): string {
  return typeof s === 'string' ? (s.split('\n').map((l) => l.trim()).find(Boolean) ?? '').slice(0, 80) : ''
}

export class ActivityTracker {
  private versions = new Map<string, number>()
  private byId = new Map<string, ActivityElement>()
  private selection = ''
  private pointed: string | null = null
  private pending: { id: string | null; since: number } | null = null
  private timer: ReturnType<typeof setTimeout> | null = null

  constructor(private readonly emit: (a: Activity) => void, private readonly now: () => number = Date.now) {}

  /** The element a step is about: a bound label is its shape. */
  private owner(el: ActivityElement): string {
    return el.type === 'text' && el.containerId && this.byId.has(el.containerId) ? el.containerId : el.id
  }

  labelOf(id: string): string {
    const el = this.byId.get(id)
    if (!el) return ''
    if (el.type === 'text') return firstLine(el.originalText ?? el.text)
    if (el.type === 'frame' || el.type === 'magicframe') return firstLine(el.name)
    const bound = el.boundElements?.find((b) => b.type === 'text')
    return bound ? this.labelOf(bound.id) : ''
  }

  private step(kind: ActivityKind, ids: Iterable<string>): void {
    const list = [...new Set(ids)]
    this.emit({ kind, ids: list, labels: list.map((id) => this.labelOf(id)), at: this.now() })
  }

  private remember(elements: readonly ActivityElement[]): void {
    this.versions = new Map()
    this.byId = new Map()
    for (const el of elements) {
      if (el.isDeleted) continue
      this.versions.set(el.id, el.version)
      this.byId.set(el.id, el)
    }
  }

  /** A scene from outside: the new baseline, no step. */
  baseline(elements: readonly ActivityElement[], selectedIds: Readonly<Record<string, boolean>> = {}): void {
    this.remember(elements)
    this.selection = this.selectionKey(selectedIds)
  }

  private selectionKey(selectedIds: Readonly<Record<string, boolean>>): string {
    return Object.keys(selectedIds).filter((id) => selectedIds[id]).sort().join('\n')
  }

  /** The person's scene changed: steps for what was drawn, changed, removed and selected. */
  change(elements: readonly ActivityElement[], selectedIds: Readonly<Record<string, boolean>>): void {
    const before = this.versions
    const beforeById = this.byId
    this.remember(elements)
    const added = new Set<string>()
    const edited = new Set<string>()
    for (const el of elements) {
      if (el.isDeleted) continue
      const was = before.get(el.id)
      if (was === undefined) added.add(this.owner(el))
      else if (was !== el.version) edited.add(this.owner(el))
    }
    const removed = new Set<string>()
    for (const id of before.keys()) {
      if (this.versions.has(id)) continue
      const el = beforeById.get(id)
      // A removed label of a shape still there is a change to that shape.
      if (el?.type === 'text' && el.containerId && this.byId.has(el.containerId)) edited.add(el.containerId)
      else removed.add(id)
    }
    for (const id of added) edited.delete(id)
    if (added.size) this.step('add', added)
    if (edited.size) this.step('edit', edited)
    if (removed.size) {
      // Labels of what is gone come from the scene before.
      const list = [...removed]
      const keep = this.byId
      this.byId = beforeById
      this.emit({ kind: 'delete', ids: list, labels: list.map((id) => this.labelOf(id)), at: this.now() })
      this.byId = keep
    }
    const sel = this.selectionKey(selectedIds)
    if (sel !== this.selection) {
      this.selection = sel
      const ids = sel ? sel.split('\n') : []
      this.step('select', ids.map((id) => { const el = this.byId.get(id); return el ? this.owner(el) : id }))
    }
  }

  /** The element under a scene point: the smallest pointable shape whose box holds it. */
  hit(x: number, y: number): string | null {
    let best: { id: string; area: number } | null = null
    for (const el of this.byId.values()) {
      if (NOT_POINTABLE.has(el.type)) continue
      const x0 = Math.min(el.x, el.x + el.width)
      const y0 = Math.min(el.y, el.y + el.height)
      const w = Math.abs(el.width)
      const h = Math.abs(el.height)
      if (x < x0 || x > x0 + w || y < y0 || y > y0 + h) continue
      const id = this.owner(el)
      const owner = this.byId.get(id) ?? el
      const area = Math.max(1, Math.abs(owner.width * owner.height))
      // A frame holds everything inside it: it is the last choice.
      const weight = el.type === 'frame' || el.type === 'magicframe' ? area * 1e6 : area
      if (!best || weight < best.area) best = { id, area: weight }
    }
    return best?.id ?? null
  }

  /** The pointer moved (scene coordinates): a `point` step once it rests on another element. */
  pointer(x: number, y: number): void {
    const id = this.hit(x, y)
    if (id === this.pointed) {
      this.pending = null
      this.clearTimer()
      return
    }
    if (this.pending?.id === id) return
    this.pending = { id, since: this.now() }
    this.clearTimer()
    this.timer = setTimeout(() => this.settle(), POINT_DWELL_MS)
  }

  private settle(): void {
    this.timer = null
    const p = this.pending
    if (!p) return
    this.pending = null
    this.pointed = p.id
    this.emit({ kind: 'point', ids: p.id ? [p.id] : [], labels: p.id ? [this.labelOf(p.id)] : [], at: p.since })
  }

  private clearTimer(): void {
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
  }

  dispose(): void {
    this.clearTimer()
  }
}
