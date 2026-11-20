/**
 * A drawing's recorded walkthroughs ("narration"): what the person said while drawing, sentence by
 * sentence with times, beside what they drew, changed, selected and pointed at, on one clock.
 * The Drawing plugin records a take (plugin-store/walnut-drawing/src/narration/) and saves it
 * here; narration-align.ts lines each sentence up with the elements it was about.
 *
 * A take's times are milliseconds from the moment recording started. The file sits beside its
 * scene, `a/b/Name.excalidraw` -> `a/b/Name.narration.json` (narration-store.ts), so it moves and
 * goes with the drawing. This module only shapes and checks the data; it touches no file.
 */

import { DrawingInputError } from './scene.js'

export const NARRATION_SUFFIX = '.narration.json'
export const NARRATION_VERSION = 1

/** One sentence, cut where the person paused, and its text from Walnut's speech to text. */
export interface NarrationSpeech {
  t0: number
  t1: number
  text: string
  /** The stored recording of this sentence (Walnut's STT keeps every take it transcribes). */
  recordingId?: string
  /** Speech to text failed for it: the time is known, the words are not. */
  failed?: boolean
}

export type NarrationEventKind = 'add' | 'edit' | 'delete' | 'select' | 'point'

/**
 * Something the person did on the canvas. `select` carries the whole selection after the change
 * (empty: nothing selected); `point` names the element under the pointer (empty: none) and, when
 * the pointer left it, `untilT`. `labels` are the elements' words at that moment, parallel to `ids`.
 */
export interface NarrationEvent {
  t: number
  kind: NarrationEventKind
  ids: string[]
  labels: string[]
  untilT?: number
}

export interface NarrationTake {
  id: string
  startedAt: string
  durationMs: number
  speech: NarrationSpeech[]
  events: NarrationEvent[]
}

export interface NarrationFile {
  version: number
  /** The scene this file belongs to (vault-relative): a copy that names another scene is not ours. */
  scene: string
  takes: NarrationTake[]
}

export const NARRATION_LIMITS = {
  takes: 100,
  speech: 3_000,
  events: 20_000,
  text: 2_000,
  ids: 200,
  idLength: 64,
  label: 200,
  /** Six hours: a take longer than this is not a walkthrough. */
  durationMs: 6 * 60 * 60 * 1000,
  /** Compact JSON: about four of the longest takes, many ordinary ones. */
  fileBytes: 16 * 1024 * 1024,
} as const

const KINDS: ReadonlySet<string> = new Set<NarrationEventKind>(['add', 'edit', 'delete', 'select', 'point'])
const TAKE_ID = /^[A-Za-z0-9._:-]{1,80}$/

/** `a/b/Name.excalidraw` -> `a/b/Name.narration.json`. */
export function narrationPathFor(scenePath: string): string {
  return scenePath.replace(/\.excalidraw$/i, '') + NARRATION_SUFFIX
}

function bad(message: string): never {
  throw new DrawingInputError(`walkthrough: ${message}`)
}

function time(v: unknown, max: number, what: string): number {
  if (typeof v !== 'number' || !Number.isFinite(v) || v < 0) bad(`${what} must be a time in milliseconds`)
  return Math.min(Math.round(v), max)
}

function text(v: unknown, max: number): string {
  return typeof v === 'string' ? v.replace(/\u0000/g, '').slice(0, max) : ''
}

function idList(v: unknown, what: string): string[] {
  if (v === undefined) return []
  if (!Array.isArray(v)) bad(`${what} must be a list`)
  const out: string[] = []
  for (const id of v.slice(0, NARRATION_LIMITS.ids)) {
    if (typeof id !== 'string' || !id || id.length > NARRATION_LIMITS.idLength) bad(`${what} holds an invalid element id`)
    out.push(id)
  }
  return out
}

/** A take as sent by a client, checked and trimmed to the limits; throws DrawingInputError. */
export function cleanTake(raw: unknown): NarrationTake {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) bad('take must be an object')
  const r = raw as Record<string, unknown>
  if (typeof r.id !== 'string' || !TAKE_ID.test(r.id)) bad('take id must be 1 to 80 letters, digits or ._:-')
  if (typeof r.startedAt !== 'string' || Number.isNaN(Date.parse(r.startedAt))) bad('startedAt must be a date')
  const durationMs = time(r.durationMs, NARRATION_LIMITS.durationMs, 'durationMs')
  // Times may run a little past the end (a sentence finished transcribing after the stop).
  const end = durationMs + 60_000
  if (!Array.isArray(r.speech)) bad('speech must be a list')
  if (r.speech.length > NARRATION_LIMITS.speech) bad(`at most ${NARRATION_LIMITS.speech} sentences in one take`)
  const speech = r.speech.map((s): NarrationSpeech => {
    if (!s || typeof s !== 'object') bad('a sentence must be an object')
    const o = s as Record<string, unknown>
    const t0 = time(o.t0, end, 'a sentence start')
    const t1 = Math.max(t0, time(o.t1, end, 'a sentence end'))
    const out: NarrationSpeech = { t0, t1, text: text(o.text, NARRATION_LIMITS.text).trim() }
    if (typeof o.recordingId === 'string' && /^[A-Za-z0-9._:-]{1,100}$/.test(o.recordingId)) out.recordingId = o.recordingId
    if (o.failed === true) out.failed = true
    return out
  }).sort((a, b) => a.t0 - b.t0)
  const rawEvents = r.events === undefined ? [] : r.events
  if (!Array.isArray(rawEvents)) bad('events must be a list')
  if (rawEvents.length > NARRATION_LIMITS.events) bad(`at most ${NARRATION_LIMITS.events} events in one take`)
  const events = rawEvents.map((e): NarrationEvent => {
    if (!e || typeof e !== 'object') bad('an event must be an object')
    const o = e as Record<string, unknown>
    if (typeof o.kind !== 'string' || !KINDS.has(o.kind)) bad('an event kind must be add, edit, delete, select or point')
    const ids = idList(o.ids, 'event ids')
    const labels = Array.isArray(o.labels) ? o.labels.slice(0, ids.length).map((l) => text(l, NARRATION_LIMITS.label)) : []
    while (labels.length < ids.length) labels.push('')
    const out: NarrationEvent = { t: time(o.t, end, 'an event time'), kind: o.kind as NarrationEventKind, ids, labels }
    if (o.untilT !== undefined) out.untilT = Math.max(out.t, time(o.untilT, end, 'an event end'))
    return out
  }).sort((a, b) => a.t - b.t)
  return { id: r.id, startedAt: new Date(Date.parse(r.startedAt)).toISOString(), durationMs, speech, events }
}

/**
 * A file read from disk (its text, or its JSON already parsed off the event loop), or null when it
 * is not a narration file this version understands.
 */
export function parseNarrationFile(input: string | Record<string, unknown>): NarrationFile | null {
  let parsed: unknown = input
  if (typeof input === 'string') {
    try {
      parsed = JSON.parse(input)
    } catch {
      return null
    }
  }
  if (!parsed || typeof parsed !== 'object') return null
  const p = parsed as Record<string, unknown>
  if (typeof p.version !== 'number' || typeof p.scene !== 'string' || !Array.isArray(p.takes)) return null
  // Takes a newer version wrote are kept as they are; one this version cannot read is skipped
  // when reading, never dropped when writing (narration-store.ts writes the file it parsed).
  const takes: NarrationTake[] = []
  for (const t of p.takes) {
    try {
      takes.push(cleanTake(t))
    } catch { /* skipped */ }
  }
  return { version: p.version, scene: p.scene, takes }
}

/** The words an element shows: its own text, a frame's name, or the text bound inside a shape. */
export function sceneLabels(elements: ReadonlyArray<Record<string, unknown>>): Map<string, string> {
  const labels = new Map<string, string>()
  const firstLine = (s: unknown) => (typeof s === 'string' ? s.split('\n').map((l) => l.trim()).find(Boolean) ?? '' : '').slice(0, 80)
  for (const el of elements) {
    if (el.isDeleted === true || typeof el.id !== 'string') continue
    if (el.type === 'text') {
      const words = firstLine(el.originalText ?? el.text)
      if (!words) continue
      // A label inside a shape names the shape (the canvas reports the shape, not its text).
      const owner = typeof el.containerId === 'string' && el.containerId ? el.containerId : el.id
      if (!labels.has(owner)) labels.set(owner, words)
    } else if ((el.type === 'frame' || el.type === 'magicframe') && typeof el.name === 'string') {
      const words = firstLine(el.name)
      if (words) labels.set(el.id, words)
    }
  }
  return labels
}
