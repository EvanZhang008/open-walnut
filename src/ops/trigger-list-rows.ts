/**
 * trigger_list's rows, filters and limit (src/ops/triggers.ts).
 *
 * 2026-11-06, Main's daily reflection: an unfiltered trigger_list answered about
 * 268,000 characters (every trigger's script, its last check object and six
 * recent checks), more than a tool answer can be read in, so an agent could not
 * tell whether one VP's reflection trigger had fired. The default row is now one
 * compact line of facts per trigger, with the last check and the last fire as one
 * line each; `full` brings back the whole row the op returned before.
 */

import { triggerRunState, type TriggerRunState } from '../core/cron/trigger-run-state.js'
import {
  checkErrorText, isTimeLimitError, limitUse, limitUseLine, limitWarning, runLimitSeconds, timeLimitSeconds,
} from '../core/cron/trigger-time-limit.js'

export const DEFAULT_LIMIT = 25
/** A full row is about 100 times a compact one, so its page is shorter. */
export const DEFAULT_FULL_LIMIT = 5
export const MAX_LIMIT = 500
const DESCRIPTION_MAX = 160
const ERROR_MAX = 160

type AuditEntry = Record<string, unknown> & {
  atMs?: number; outcome?: string; reason?: string; items?: number; error?: string
  retryPending?: boolean; coalesced?: number; delivery?: { status?: string }; durationMs?: number; killedAtLimit?: boolean
  limitSeconds?: number
}

export type ListedJob = {
  id?: string; name?: string; description?: string; enabled?: boolean
  schedule?: { everyMs?: number }
  check?: { run?: string; host?: string; cwd?: string; timeoutSeconds?: number }
  executor?: { type?: string; config?: { target?: unknown } }
  state?: {
    lastCheck?: AuditEntry; nextRunAtMs?: number; lastRunAtMs?: number; fireCount?: number; pausedAtMs?: number
    consecutiveErrors?: number; checkLog?: AuditEntry[]; fireLog?: AuditEntry[]
  }
}

export type ListFilter = { name?: string; state?: TriggerRunState }

/** Human interval out of a stored `every` schedule. */
export function everyLabel(everyMs: unknown): string {
  const ms = typeof everyMs === 'number' && Number.isFinite(everyMs) ? everyMs : 0
  if (ms <= 0) return 'unknown'
  if (ms % 3_600_000 === 0) return `${ms / 3_600_000}h`
  if (ms % 60_000 === 0) return `${ms / 60_000}m`
  return `${Math.round(ms / 1000)}s`
}

function iso(ms: unknown): string | undefined {
  return typeof ms === 'number' && Number.isFinite(ms) ? new Date(ms).toISOString() : undefined
}

function clip(text: string, max: number): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat
}

function itemsWord(n: unknown): string {
  return typeof n === 'number' ? `${n} item${n === 1 ? '' : 's'}` : ''
}

/**
 * The time limit beside the last check's run time: `lastRun` "ran 34 s of its 120 s limit" (or
 * "was killed at its 120 s limit"), and `limitWarning` when it ran over half of it. A check that was
 * killed before this was recorded reads from its error's words (trigger-time-limit.ts).
 */
function timeFields(job: ListedJob): Record<string, unknown> {
  if (!job.check) return {}
  const limitS = timeLimitSeconds(job.check)
  const last = job.state?.lastCheck
  const killed = last?.outcome === 'error' && (last.killedAtLimit === true || isTimeLimitError(last.error))
  // The last run against the limit it ran under, which may not be today's.
  const use = last ? limitUse(last.durationMs, runLimitSeconds(last, job.check), killed) : null
  const warning = limitWarning(use, 'The last check')
  return {
    timeLimit: `${limitS}s`,
    ...(use ? { lastRun: limitUseLine(use) } : {}),
    ...(warning ? { limitWarning: warning } : {}),
  }
}

/** The last check as one line: "fired 2 items at <iso>", "quiet (all-seen) at <iso>", "error at <iso>: <text>". */
export function checkLine(check: AuditEntry | undefined, limitS?: number): string | undefined {
  if (!check || typeof check.outcome !== 'string') return undefined
  const at = iso(check.atMs)
  const when = at ? ` at ${at}` : ''
  if (check.outcome === 'fired') {
    const items = itemsWord(check.items)
    return `fired${items ? ` ${items}` : ''}${when}${check.retryPending ? ', delivery retrying' : ''}`
  }
  if (check.outcome === 'error') {
    const error = typeof check.error === 'string' && limitS ? checkErrorText(check.error, limitS) : check.error
    return `error${when}${error ? `: ${clip(String(error), ERROR_MAX)}` : ''}`
  }
  return `${check.outcome}${check.reason ? ` (${check.reason})` : ''}${when}`
}

function atOf(entry: AuditEntry | undefined): number {
  return typeof entry?.atMs === 'number' && Number.isFinite(entry.atMs) ? entry.atMs : -Infinity
}

/**
 * The newest fire by its own time. The fire log is in arrival order, and a late
 * fire (a backlog, a retry after a reconnect) is recorded at its head with an
 * older time (trigger-apply.ts mergeFireAttempt), so its head is not the newest.
 */
function newestFire(job: ListedJob): AuditEntry | undefined {
  const fires = [...(job.state?.fireLog ?? []), ...(job.state?.checkLog ?? []).filter((e) => e.outcome === 'fired')]
  let best: AuditEntry | undefined
  for (const f of fires) if (atOf(f) > atOf(best)) best = f
  return best
}

/** The newest fire as one line: "<iso>, 2 items, delivery ok". */
export function fireLine(job: ListedJob): string | undefined {
  const fire = newestFire(job)
  const at = iso(fire?.atMs)
  if (!fire || !at) return undefined
  const parts = [at]
  const items = itemsWord(fire.items)
  if (items) parts.push(items)
  if (typeof fire.coalesced === 'number' && fire.coalesced > 1) parts.push(`${fire.coalesced} fires merged`)
  if (fire.delivery?.status) parts.push(`delivery ${fire.delivery.status}`)
  return parts.join(', ')
}

export function targetOf(job: ListedJob): string | undefined {
  const t = job.executor?.type === 'session' ? job.executor.config?.target : undefined
  return typeof t === 'string' && t.trim() ? t.trim() : undefined
}

export function matchesFilter(job: ListedJob, filter: ListFilter): boolean {
  if (filter.state && triggerRunState(job) !== filter.state) return false
  const needle = filter.name?.trim().toLowerCase()
  if (needle) {
    const hay = [job.name, job.id, job.description].map((s) => (typeof s === 'string' ? s.toLowerCase() : ''))
    if (!hay.some((s) => s.includes(needle))) return false
  }
  return true
}

/**
 * When it last did anything: a trigger's newest check or fire, a plain timed
 * routine's last run (state.lastRunAtMs, the task view lists those too).
 */
function activityMs(job: ListedJob): number {
  const st = job.state
  return Math.max(
    atOf(st?.lastCheck), atOf(st?.checkLog?.[0]), atOf(newestFire(job)),
    typeof st?.lastRunAtMs === 'number' && Number.isFinite(st.lastRunAtMs) ? st.lastRunAtMs : -Infinity,
  )
}

/** Newest activity first; a stable sort keeps the stored order among equals. */
export function byActivity(jobs: ListedJob[]): ListedJob[] {
  return [...jobs].sort((a, b) => activityMs(b) - activityMs(a))
}

/** The fields every row carries, compact or full. */
function headOf(job: ListedJob, extra: Record<string, unknown>, description: string | undefined) {
  return {
    id: job.id,
    name: job.name,
    ...extra,
    ...(description ? { description } : {}),
    every: everyLabel(job.schedule?.everyMs),
    host: job.check?.host ?? '__local__',
    enabled: job.enabled === true,
    state: triggerRunState(job),
    ...(!job.enabled && typeof job.state?.pausedAtMs === 'number'
      ? { pausedAt: new Date(job.state.pausedAtMs).toISOString() } : {}),
  }
}

/** One short row: facts only, the last check and the last fire as one line each. */
export function compactRow(job: ListedJob, extra: Record<string, unknown> = {}): Record<string, unknown> {
  const target = targetOf(job)
  const last = checkLine(job.state?.lastCheck, job.check ? runLimitSeconds(job.state?.lastCheck, job.check) : undefined)
  const lastFire = fireLine(job)
  const next = iso(job.state?.nextRunAtMs)
  return {
    ...headOf(job, extra, job.description ? clip(job.description, DESCRIPTION_MAX) : undefined),
    ...(target && !('target' in extra) ? { task: target } : {}),
    fires: job.state?.fireCount ?? 0,
    ...(last ? { last } : {}),
    ...(lastFire ? { lastFire } : {}),
    // A plain timed routine (the task view lists those too) has runs, not checks.
    ...(!job.check && iso(job.state?.lastRunAtMs) ? { lastRunAt: iso(job.state?.lastRunAtMs) } : {}),
    ...(next ? { nextCheckAt: next } : {}),
    ...timeFields(job),
  }
}

/** The whole row trigger_list returned before the compact one: script, last check object, recent checks. */
export function fullRow(job: ListedJob, extra: Record<string, unknown> = {}): Record<string, unknown> {
  const target = targetOf(job)
  return {
    ...headOf(job, extra, job.description),
    ...(target && !('target' in extra) ? { task: target } : {}),
    run: job.check?.run,
    ...(job.check?.cwd ? { cwd: job.check.cwd } : {}),
    ...timeFields(job),
    fires: job.state?.fireCount ?? 0,
    ...(job.state?.lastCheck ? { lastCheck: job.state.lastCheck } : {}),
    ...(typeof job.state?.nextRunAtMs === 'number'
      ? { nextCheckAt: new Date(job.state.nextRunAtMs).toISOString() } : {}),
    // The audit trail, trimmed for a tool answer: the verdicts and where each
    // fire went, without the injected-text previews (those are for the UI —
    // a caller that wants the message reads the session).
    ...(Array.isArray(job.state?.checkLog) && job.state.checkLog.length > 0
      ? {
        recentChecks: job.state.checkLog.slice(0, 6).map((entry) => {
          const { injected: _injected, epoch: _epoch, ...rest } = entry as Record<string, unknown>
          const atMs = typeof rest.atMs === 'number' ? rest.atMs : undefined
          return { ...rest, ...(atMs ? { at: new Date(atMs).toISOString() } : {}), atMs: undefined }
        }),
      }
      : {}),
  }
}

/** The page's limit: the caller's, else the default for its row kind, never past MAX_LIMIT. */
export function pageLimit(limit: unknown, full: boolean): number {
  const n = typeof limit === 'number' && Number.isFinite(limit) ? Math.floor(limit) : 0
  if (n <= 0) return full ? DEFAULT_FULL_LIMIT : DEFAULT_LIMIT
  return Math.min(n, MAX_LIMIT)
}

/** The words of a filter, for a hint: name "x", state armed. */
export function filterWords(filter: ListFilter): string {
  return [
    filter.name?.trim() ? `name "${filter.name.trim()}"` : '',
    filter.state ? `state ${filter.state}` : '',
  ].filter(Boolean).join(', ')
}
