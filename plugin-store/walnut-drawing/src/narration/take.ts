/**
 * One walkthrough take as it is recorded: the sentences (times first, words when speech to text
 * answers) and the canvas steps, on the take's clock (milliseconds since Record was pressed).
 * What it holds is what Walnut stores (core/drawings/narration.ts). Pure: the clock is passed in.
 */

import type { DrawingActivity } from '@open-walnut/plugin-api/web'

export interface TakeSentence { t0: number; t1: number; text: string; recordingId?: string; failed?: boolean }
export interface TakeEvent { t: number; kind: DrawingActivity['kind']; ids: string[]; labels: string[]; untilT?: number }
export interface TakeData { id: string; startedAt: string; durationMs: number; speech: TakeSentence[]; events: TakeEvent[] }

/** The same edit of the same shapes within this long is one step (a drag is many versions). */
const EDIT_FOLD_MS = 1_500
export const MAX_EVENTS = 20_000
export const MAX_SENTENCES = 3_000

export class Take {
  readonly id: string
  readonly startedAt: number
  private speech: TakeSentence[] = []
  private events: TakeEvent[] = []
  private openPoint: TakeEvent | null = null
  private endedAt: number | null = null
  /** Bumped on every change, so a saver can tell there is something new. */
  version = 0

  constructor(startedAt: number, id = `take-${new Date(startedAt).toISOString().replace(/[:.]/g, '-')}`) {
    this.startedAt = startedAt
    this.id = id
  }

  private rel(at: number): number {
    return Math.max(0, Math.round(at - this.startedAt))
  }

  /** A step from the canvas (`at` is Date.now() when it happened). */
  activity(a: DrawingActivity): void {
    if (this.endedAt !== null || this.events.length >= MAX_EVENTS) return
    const t = this.rel(a.at)
    if (a.kind === 'point') {
      if (this.openPoint) this.openPoint.untilT = Math.max(this.openPoint.t, t)
      this.openPoint = null
      if (a.ids.length === 0) { this.version++; return }
      const e: TakeEvent = { t, kind: 'point', ids: a.ids.slice(0, 1), labels: a.labels.slice(0, 1) }
      this.events.push(e)
      this.openPoint = e
      this.version++
      return
    }
    if (a.kind === 'edit') {
      const key = a.ids.join('\n')
      for (let i = this.events.length - 1; i >= 0; i--) {
        const e = this.events[i]
        if (t - e.t > EDIT_FOLD_MS) break
        if (e.kind === 'edit' && e.ids.join('\n') === key) {
          e.labels = a.labels.slice()
          this.version++
          return
        }
      }
    }
    this.events.push({ t, kind: a.kind, ids: a.ids.slice(), labels: a.labels.slice() })
    this.version++
  }

  /** A sentence's times, its words to come: answers its index for `heard`. */
  sentence(t0: number, t1: number): number {
    if (this.speech.length >= MAX_SENTENCES) return -1
    this.speech.push({ t0: Math.round(t0), t1: Math.round(t1), text: '' })
    this.version++
    return this.speech.length - 1
  }

  /** Speech to text answered (or failed) for sentence `i`. */
  heard(i: number, result: { text: string; recordingId?: string } | { failed: true }): void {
    const s = this.speech[i]
    if (!s) return
    if ('failed' in result) s.failed = true
    else {
      s.text = result.text.trim()
      if (result.recordingId) s.recordingId = result.recordingId
      delete s.failed
    }
    this.version++
  }

  /** Recording stopped at `at`: the pointer's element is left then. */
  end(at: number): void {
    if (this.endedAt !== null) return
    this.endedAt = at
    if (this.openPoint) this.openPoint.untilT = Math.max(this.openPoint.t, this.rel(at))
    this.openPoint = null
    this.version++
  }

  get ended(): boolean { return this.endedAt !== null }

  /** Something worth keeping: a sentence or a step. */
  get empty(): boolean { return this.speech.length === 0 && this.events.length === 0 }

  /** The take as Walnut stores it, at `now` (or its end). */
  data(now: number): TakeData {
    return {
      id: this.id,
      startedAt: new Date(this.startedAt).toISOString(),
      durationMs: this.rel(this.endedAt ?? now),
      speech: this.speech.map((s) => ({ ...s })),
      events: this.events.map((e) => ({ ...e, ids: e.ids.slice(), labels: e.labels.slice() })),
    }
  }

  /** The words of the newest sentence heard so far, for the caption. */
  lastWords(): string {
    for (let i = this.speech.length - 1; i >= 0; i--) if (this.speech[i].text) return this.speech[i].text
    return ''
  }
}
