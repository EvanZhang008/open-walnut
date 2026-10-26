import { formatDuration } from './time-timeline'

/**
 * Where the two slots lead, and how the App reads it back:
 *
 *   <base>/task/<taskId>             every day of the task, each with its sessions
 *   <base>/task/<taskId>?session=<s> the same, narrowed to one session
 *   <base>/session/<sessionId>       a session with no task
 *
 * Pure (no React), so the round trip is unit-tested on its own.
 */

export interface TimePaths {
  task(taskId: string, sessionId?: string): string
  session(sessionId: string): string
}

export function timePaths(basePath: string): TimePaths {
  const base = basePath.replace(/\/+$/, '')
  return {
    task: (taskId, sessionId) =>
      `${base}/task/${encodeURIComponent(taskId)}${sessionId ? `?session=${encodeURIComponent(sessionId)}` : ''}`,
    session: (sessionId) => `${base}/session/${encodeURIComponent(sessionId)}`,
  }
}

export type TimePage =
  | { kind: 'task'; id: string; session: string | null }
  | { kind: 'session'; id: string }

/**
 * The subpath as the address bar spells it, still percent-encoded. The router hands
 * the App a DECODED subpath, and decoding an id twice turns `a%2541` into `aA`, so
 * the ids are read from the raw address and decoded exactly once, here.
 */
export function rawSubpath(props: { basePath: string; subpath: string }, pathname = globalThis.location?.pathname): string {
  const base = props.basePath.replace(/\/+$/, '')
  if (typeof pathname === 'string') {
    for (const prefix of [base, encodeURI(base)]) {
      if (pathname === prefix || pathname.startsWith(`${prefix}/`)) return pathname.slice(prefix.length)
    }
  }
  return props.subpath
}

/** The page a RAW (still encoded) subpath asks for, or null for the App's own tabs. */
export function timePageFromRoute(subpath: string, search: string): TimePage | null {
  const parts = subpath.replace(/^\/+/, '').split('/')
  const id = parts[1] ? safeDecode(parts[1]) : ''
  if (!id) return null
  if (parts[0] === 'task') {
    const session = new URLSearchParams(search).get('session')
    return { kind: 'task', id, session: session || null }
  }
  if (parts[0] === 'session') return { kind: 'session', id }
  return null
}

function safeDecode(part: string): string {
  try { return decodeURIComponent(part) } catch { return part }
}

/** "0m" rather than "0s": a lane with nothing in it reads as empty, not as a stopwatch. */
export const formatLane = (ms: number) => (ms <= 0 ? '0m' : formatDuration(ms))

/**
 * One whole unit for the header pill ("2h", not "2h 46m"): the largest unit of the
 * exact line's own minutes (formatLane rounds to the minute), the rest dropped, so the
 * pill never reads more than its hover does ("6m" never sits on "7m"). Minutes under
 * an hour, hours up to 99, then days. The hover and the aria-label carry the exact line.
 */
export function formatLaneCompact(ms: number): string {
  if (ms <= 0) return '0m'
  if (ms < 60_000) return '<1m'
  const minutes = Math.round(ms / 60_000)
  if (minutes < 60) return `${minutes}m`
  const hours = Math.floor(minutes / 60)
  if (hours < 100) return `${hours}h`
  return `${Math.floor(hours / 24)}d`
}
