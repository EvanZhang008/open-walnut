/**
 * Time detail that stays on this Mac: WALNUT_HOME/time-tracking/outside/detail/<date>.jsonl.
 * Under outside/ because the data sync ignores that directory: the synced day
 * files carry only the small `view` enum, while the names (the file open in a
 * session, a plugin item's label) and the sent-message markers live here.
 *
 * Two line shapes:
 *   {"t":"lease","ts","durationMs","kind","sessionId?","taskId?","view?","file?","app?","item?","label?","mode?"}
 *     a banked lease window that had a file or a plugin item under it;
 *   {"t":"sent","ts","sessionId?","taskId?","chat?","messageId","chars","device"}
 *     a message the user sent: when, where, how long. Never its text (the
 *     session's history has it).
 *
 * Appends are fire-and-forget and run in one chain; reads are bounded per day.
 */

import fsp from 'node:fs/promises'
import path from 'node:path'
import { WALNUT_HOME } from '../../constants.js'
import { bus, EventNames } from '../event-bus.js'
import { log } from '../../logging/index.js'
import { localDateKey } from './rollup.js'
import type { TimeRecord } from './types.js'

const MAX_DAY_BYTES = 16 * 1024 * 1024
const SUBSCRIBER = 'time-sent-markers'
/** A person's send, by the queue's provenance tag (phase.ts REOPENING_SEND_SOURCES, minus agents and peers). */
const HUMAN_SENDS: Readonly<Record<string, { device: 'web' | 'ios'; chat: boolean }>> = {
  ui: { device: 'web', chat: false },
  mobile: { device: 'ios', chat: false },
  chat: { device: 'web', chat: true },
  'api-v1': { device: 'ios', chat: true },
}

export interface LeaseDetail {
  t: 'lease'
  ts: string
  durationMs: number
  kind: string
  sessionId?: string
  taskId?: string
  view?: string
  file?: string
  app?: string
  item?: string
  label?: string
  mode?: string
}

export interface SentMarker {
  t: 'sent'
  ts: string
  sessionId?: string
  taskId?: string
  chat?: true
  messageId: string
  chars: number
  device: 'web' | 'ios'
}

export type DetailLine = LeaseDetail | SentMarker

function dir(): string {
  return path.join(WALNUT_HOME, 'time-tracking', 'outside', 'detail')
}

let tail: Promise<void> = Promise.resolve()

/** Append lines under the local date of each `ts`. Never throws. */
export function appendDetail(lines: readonly DetailLine[]): Promise<void> {
  if (lines.length === 0) return Promise.resolve()
  const work = async (): Promise<void> => {
    const byDate = new Map<string, string[]>()
    for (const l of lines) {
      const ms = Date.parse(l.ts)
      if (!Number.isFinite(ms)) continue
      const date = localDateKey(new Date(ms))
      const list = byDate.get(date) ?? []
      list.push(JSON.stringify(l))
      byDate.set(date, list)
    }
    try {
      await fsp.mkdir(dir(), { recursive: true })
      for (const [date, list] of byDate) await fsp.appendFile(path.join(dir(), `${date}.jsonl`), `${list.join('\n')}\n`, 'utf8')
    } catch (err) {
      log.web.warn('time detail: append failed', { error: err instanceof Error ? err.message : String(err) })
    }
  }
  const run = tail.then(work, work)
  tail = run.then(() => undefined, () => undefined)
  return run
}

/** One day's detail lines (junk skipped). */
export async function readDetailDay(date: string): Promise<DetailLine[]> {
  await tail
  const file = path.join(dir(), `${date}.jsonl`)
  let text = ''
  try {
    const st = await fsp.stat(file)
    if (st.size > MAX_DAY_BYTES) return []
    text = await fsp.readFile(file, 'utf8')
  } catch {
    return []
  }
  const out: DetailLine[] = []
  for (const line of text.split('\n')) {
    if (!line) continue
    try {
      const rec = JSON.parse(line) as DetailLine
      if ((rec.t === 'lease' && typeof rec.durationMs === 'number') || (rec.t === 'sent' && typeof rec.messageId === 'string')) {
        if (typeof rec.ts === 'string') out.push(rec)
      }
    } catch { /* a torn line */ }
  }
  return out
}

/** The detail a banked record carries, as a lease line, or null when it has none. */
export function leaseDetailOf(rec: TimeRecord, extra: { file?: string; item?: string; label?: string }): LeaseDetail | null {
  if (!extra.file && !extra.item && !extra.label) return null
  return {
    t: 'lease', ts: rec.ts, durationMs: rec.durationMs, kind: rec.kind,
    ...(rec.sessionId ? { sessionId: rec.sessionId } : {}),
    ...(rec.taskId ? { taskId: rec.taskId } : {}),
    ...(rec.view ? { view: rec.view } : {}),
    ...(rec.app ? { app: rec.app } : {}),
    ...(rec.mode ? { mode: rec.mode } : {}),
    ...(extra.file ? { file: extra.file } : {}),
    ...(extra.item ? { item: extra.item } : {}),
    ...(extra.label ? { label: extra.label } : {}),
  }
}

/** The marker for a queued message, or null when a person did not send it. */
export function sentMarkerOf(data: { sessionId?: unknown; messageId?: unknown; message?: unknown; source?: unknown; enqueuedAt?: unknown }, now: Date): SentMarker | null {
  const how = typeof data.source === 'string' ? HUMAN_SENDS[data.source] : undefined
  if (!how || typeof data.messageId !== 'string' || !data.messageId) return null
  const at = typeof data.enqueuedAt === 'string' && Number.isFinite(Date.parse(data.enqueuedAt)) ? new Date(data.enqueuedAt) : now
  return {
    t: 'sent', ts: at.toISOString(),
    ...(typeof data.sessionId === 'string' && data.sessionId ? { sessionId: data.sessionId } : {}),
    ...(how.chat ? { chat: true as const } : {}),
    messageId: data.messageId.slice(0, 128),
    chars: typeof data.message === 'string' ? data.message.length : 0,
    device: how.device,
  }
}

/** `file` relative to `cwd` when it lies inside it; unchanged otherwise. */
export function relativeFile(file: string, cwd: string | undefined): string {
  if (!cwd || !file.startsWith('/')) return file
  const root = cwd.endsWith('/') ? cwd : `${cwd}/`
  return file.startsWith(root) ? file.slice(root.length) : file
}

const MAX_CWD_LOOKUPS = 10

/**
 * Write the local detail of a banked browser batch: one lease line per record that
 * had a file or a plugin item under it. A file path is made relative to its
 * session's working directory, so the same file reads the same in every report.
 * Never throws; best effort like the rest of telemetry.
 */
export async function recordLeaseDetails(pairs: ReadonlyArray<{ rec: TimeRecord; detail: { file?: string; item?: string; label?: string } }>): Promise<void> {
  const lines: Array<{ line: LeaseDetail; sessionId?: string }> = []
  for (const { rec, detail } of pairs) {
    const line = leaseDetailOf(rec, detail)
    if (line) lines.push({ line, ...(rec.sessionId && line.file ? { sessionId: rec.sessionId } : {}) })
  }
  if (lines.length === 0) return
  const cwds = new Map<string, string | undefined>()
  try {
    const { getSessionByClaudeId } = await import('../session-tracker.js')
    for (const sid of [...new Set(lines.map((l) => l.sessionId).filter((s): s is string => !!s))].slice(0, MAX_CWD_LOOKUPS)) {
      cwds.set(sid, (await getSessionByClaudeId(sid).catch(() => null))?.cwd)
    }
  } catch { /* absolute paths still group */ }
  await appendDetail(lines.map(({ line, sessionId }) => (
    sessionId && line.file ? { ...line, file: relativeFile(line.file, cwds.get(sessionId)) } : line
  )))
}

async function withTask(marker: SentMarker): Promise<SentMarker> {
  if (!marker.sessionId) return marker
  try {
    const { getSessionByClaudeId } = await import('../session-tracker.js')
    const rec = await getSessionByClaudeId(marker.sessionId)
    return rec?.taskId ? { ...marker, taskId: rec.taskId } : marker
  } catch {
    return marker
  }
}

/** Message ids already marked: a retry, a phone resend or a bridge replay queues the same id again. */
const markedIds = new Set<string>()
const MAX_MARKED_IDS = 2000

/** Record every message a person sends, once per message id. Idempotent (same subscriber name replaces). */
export function startSentMarkers(): void {
  bus.subscribe(SUBSCRIBER, (event) => {
    const marker = sentMarkerOf((event.data ?? {}) as Record<string, unknown>, new Date())
    if (!marker) return
    if (marker.messageId) {
      if (markedIds.has(marker.messageId)) return
      markedIds.add(marker.messageId)
      if (markedIds.size > MAX_MARKED_IDS) markedIds.delete(markedIds.values().next().value!)
    }
    void withTask(marker).then((m) => appendDetail([m]))
  }, { global: true, interest: [EventNames.SESSION_MESSAGE_QUEUED] })
}

export function stopSentMarkers(): void {
  bus.unsubscribe(SUBSCRIBER)
}

/** Tests: forget the write chain. */
export function resetDetailStore(): void {
  tail = Promise.resolve()
  markedIds.clear()
}
