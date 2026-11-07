/**
 * Waits on the server's WebSocket broadcasts, filtered to the session or task the
 * test started.
 *
 * Every per-session event (`session:result`, `session:started`, `session:error`,
 * `session:status-changed`, the stream deltas ...) is broadcast to every client, for
 * every session. An e2e file runs its tests against one server, so a wait on
 * "the next session:result" also takes a late frame from the previous test's
 * session (GitHub CI, 2026-11-07: the plan-mode test in session-lifecycle got
 * `sess-task-001`'s result and failed on its taskId). A wait therefore names what
 * it waits for: `{ taskId }`, `{ sessionId }` once the test knows it, or a
 * predicate on the event's data. tests/e2e/ws-event-filter-guard.test.ts fails on
 * a wait on a per-session event that names nothing.
 */
import type { WebSocket } from 'ws'

export interface WsEventFrame {
  type: string
  name?: string
  data?: Record<string, unknown>
  [key: string]: unknown
}

/**
 * The session or task a wait is for, or a predicate on the event's data.
 * `resultIncludes` also asks for text in the event's `result`, for a test that
 * starts a task an earlier test of the file already ran (the mock CLI echoes the
 * prompt into its result).
 */
export type WsEventMatch =
  | { taskId: string; sessionId?: string; resultIncludes?: string }
  | { sessionId: string; taskId?: string; resultIncludes?: string }
  | ((data: Record<string, unknown>) => boolean)

/** True when an event's data belongs to what `match` names. */
export function wsEventMatches(data: Record<string, unknown> | undefined, match: WsEventMatch): boolean {
  const d = data ?? {}
  if (typeof match === 'function') return match(d)
  if (match.taskId !== undefined && d.taskId !== match.taskId) return false
  if (match.sessionId !== undefined && d.sessionId !== match.sessionId) return false
  if (match.resultIncludes !== undefined && !String(d.result ?? '').includes(match.resultIncludes)) return false
  return true
}

function describeMatch(match: WsEventMatch): string {
  if (typeof match === 'function') return 'a predicate'
  return Object.entries(match).filter(([, v]) => v !== undefined).map(([k, v]) => `${k}=${String(v)}`).join(' ')
}

function parseFrame(raw: WebSocket.RawData): WsEventFrame | null {
  try {
    return JSON.parse(raw.toString()) as WsEventFrame
  } catch {
    return null
  }
}

/**
 * Collect frames of `eventName` matching `match` until `count` arrived. The
 * timeout names the frames of that event it skipped, so a wrong filter reads as
 * one at once.
 */
export function waitForWsEvents(
  ws: WebSocket,
  eventName: string,
  match: WsEventMatch,
  count: number,
  timeoutMs = 30000,
): Promise<WsEventFrame[]> {
  return new Promise((resolve, reject) => {
    const events: WsEventFrame[] = []
    const skipped: string[] = []
    const timer = setTimeout(() => {
      ws.off('message', handler)
      reject(new Error(
        `Timed out waiting for ${count === 1 ? '' : `${count}x `}${eventName} (${describeMatch(match)}): got ${events.length}`
        + (skipped.length ? `; skipped ${skipped.length} for others: ${skipped.slice(-5).join(', ')}` : ''),
      ))
    }, timeoutMs)
    const handler = (raw: WebSocket.RawData) => {
      const frame = parseFrame(raw)
      if (!frame || frame.type !== 'event' || frame.name !== eventName) return
      if (!wsEventMatches(frame.data, match)) {
        skipped.push(`taskId=${String(frame.data?.taskId)} sessionId=${String(frame.data?.sessionId)}`)
        return
      }
      events.push(frame)
      if (events.length >= count) {
        clearTimeout(timer)
        ws.off('message', handler)
        resolve(events)
      }
    }
    ws.on('message', handler)
  })
}

/** The next frame of `eventName` that belongs to what `match` names. */
export function waitForWsEvent(
  ws: WebSocket,
  eventName: string,
  match: WsEventMatch,
  timeoutMs = 15000,
): Promise<WsEventFrame> {
  return waitForWsEvents(ws, eventName, match, 1, timeoutMs).then((events) => events[0])
}

/**
 * For a file whose tests start sessions with no task (every one reads `taskId: ''`):
 * a predicate that takes only a session this file has not had an event from yet,
 * and remembers it. A late frame of an earlier test's session is then skipped.
 * One wait per new session: a second wait on the same session names its sessionId.
 *
 *   const newSession = newSessionMatcher()
 *   const result = waitForWsEvent(ws, 'session:result', newSession({ taskId: '' }))
 */
export function newSessionMatcher(): (base?: { taskId?: string }) => (data: Record<string, unknown>) => boolean {
  const seen = new Set<string>()
  return (base = {}) => (data) => {
    const sid = typeof data.sessionId === 'string' ? data.sessionId : ''
    if (!sid || seen.has(sid)) return false
    if (base.taskId !== undefined && data.taskId !== base.taskId) return false
    seen.add(sid)
    return true
  }
}
