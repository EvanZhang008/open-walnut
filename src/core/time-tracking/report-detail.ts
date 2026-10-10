/**
 * The time report's Mac-local detail, PURE: the files open while the user worked
 * in a session, a plugin view's items, and the messages the user sent
 * (detail-store.ts). Lease lines are cut like every lease (report-adjust.ts):
 * seconds another app was frontmost do not count.
 */

import { uncovered } from './calls.js'
import type { DetailLine, SentMarker } from './detail-store.js'
import { workMsOf, type WorkHours } from './work-hours.js'

export interface Split { ms: number; workMs: number }

const MIN = 60_000
const minutes = (ms: number): number => Math.round(ms / MIN)

/** Whole-day and work-hours milliseconds of a list of pieces. */
export function splitOf(pieces: ReadonlyArray<readonly [number, number]>, wh: WorkHours): Split {
  let ms = 0
  let workMs = 0
  for (const [a, b] of pieces) { ms += b - a; workMs += workMsOf(a, b, wh) }
  return { ms, workMs }
}

export interface FileAcc extends Split { taskMs: Map<string, number>; days: Set<string> }
export interface ItemAcc extends Split { app: string; item: string; label: string; replyMs: number; days: Set<string> }
export interface DetailFold { files: Map<string, FileAcc>; items: Map<string, ItemAcc> }

export function foldDetail(
  detail: ReadonlyMap<string, readonly DetailLine[]> | undefined,
  opts: {
    counted: ReadonlySet<string>
    workHours: WorkHours
    other: ReadonlyArray<readonly [number, number]>
    /** A sent marker for `date`; answers false when the date is outside the range. */
    onSent: (date: string, marker: SentMarker) => boolean
    inRange: (date: string) => boolean
  },
): DetailFold {
  const files = new Map<string, FileAcc>()
  const items = new Map<string, ItemAcc>()
  // A message marked twice (written before a restart, queued again after) counts once.
  const sentIds = new Set<string>()
  for (const [date, lines] of detail ?? []) {
    if (!opts.inRange(date)) continue
    for (const l of lines) {
      if (l.t === 'sent') {
        if (l.messageId && sentIds.has(l.messageId)) continue
        if (l.messageId) sentIds.add(l.messageId)
        opts.onSent(date, l)
        continue
      }
      if (!opts.counted.has(l.kind)) continue
      const a = Date.parse(l.ts)
      if (!Number.isFinite(a) || !(l.durationMs > 0)) continue
      const s = splitOf(uncovered(a, a + l.durationMs, opts.other), opts.workHours)
      if (s.ms <= 0) continue
      if (l.file) {
        const f = files.get(l.file) ?? { ms: 0, workMs: 0, taskMs: new Map(), days: new Set<string>() }
        f.ms += s.ms
        f.workMs += s.workMs
        f.days.add(date)
        if (l.taskId) f.taskMs.set(l.taskId, (f.taskMs.get(l.taskId) ?? 0) + s.ms)
        files.set(l.file, f)
      }
      if (l.item || l.label) {
        const key = `${l.app ?? ''}\u0000${l.item ?? l.label}`
        const it = items.get(key) ?? { ms: 0, workMs: 0, app: l.app ?? '', item: l.item ?? '', label: l.label ?? '', replyMs: 0, days: new Set<string>() }
        it.ms += s.ms
        it.workMs += s.workMs
        if (l.mode === 'reply') it.replyMs += s.ms
        if (l.label) it.label = l.label
        it.days.add(date)
        items.set(key, it)
      }
    }
  }
  return { files, items }
}

type SplitRow = (s: Split) => Record<string, number>

function top<T extends Split>(rows: T[], n: number): { kept: T[]; otherMin: number; more: number } {
  const sorted = rows.sort((a, b) => b.ms - a.ms)
  const rest = sorted.slice(n)
  return { kept: sorted.slice(0, n), otherMin: minutes(rest.reduce((s, r) => s + r.ms, 0)), more: rest.length }
}

export function fileGroup(fold: DetailFold, n: number, splitRow: SplitRow, title: (taskId: string) => string | null, available: boolean): Record<string, unknown> {
  const t = top([...fold.files.entries()].map(([file, f]) => ({ ...f, file })), n)
  return {
    rows: t.kept.map((f) => {
      const taskId = [...f.taskMs.entries()].sort((a, b) => b[1] - a[1])[0]?.[0]
      return { file: f.file, ...splitRow(f), days: f.days.size, ...(taskId ? { taskId, title: title(taskId) } : {}) }
    }),
    otherMin: t.otherMin, more: t.more,
    ...(available ? {} : { unavailable: 'file detail is kept on the Mac only' }),
  }
}

export function itemGroup(fold: DetailFold, n: number, splitRow: SplitRow): Record<string, unknown> {
  const t = top([...fold.items.values()], n)
  return {
    rows: t.kept.map((it) => ({
      app: it.app, ...(it.item ? { item: it.item } : {}), ...(it.label ? { label: it.label } : {}),
      ...splitRow(it), ...(it.replyMs > 0 ? { replyMin: minutes(it.replyMs) } : {}), days: it.days.size,
    })),
    otherMin: t.otherMin, more: t.more,
  }
}
