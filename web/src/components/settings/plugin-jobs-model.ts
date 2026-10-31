/**
 * What a plugin's jobs rows say (PluginJobsControls): the answer of
 * GET /api/plugin-runtime/:id/jobs (src/core/plugin-jobs/manager.ts PluginJobsView),
 * read defensively, and the words of each row. Pure, so the copy is pinned without rendering.
 */

export type PluginJobKind = 'every' | 'long-running'
export type PluginJobRunState = 'idle' | 'starting' | 'running' | 'retrying' | 'refused'
export type PluginJobsPlacement = 'running' | 'pending' | 'host-offline' | 'host-unsupported' | 'host-unknown' | 'plugin-off' | 'code-error'

export interface PluginJobRow {
  job: string
  kind: PluginJobKind
  everyMs?: number
  version: string
  state: PluginJobRunState
  since?: number
  startedAt?: number
  restarts: number
  runs: number
  failures: number
  lastError?: string
  lastRunAt?: number
  lastRunMs?: number
  nextRunAt?: number
  metrics: Record<string, number>
  host: string
}

export interface PluginJobsHostOption { key: string; label: string; connected: boolean; supported: boolean }

export interface PluginJobsState {
  pluginId: string
  declared: Array<{ name: string; kind: PluginJobKind; every?: string }>
  runOn: string
  runOnLabel: string
  placement: { state: PluginJobsPlacement; message: string }
  jobs: PluginJobRow[]
  live: boolean
  checkedAt?: number
  elsewhere: Array<{ host: string; jobs: number }>
  hosts: PluginJobsHostOption[]
}

const RUN_STATES: PluginJobRunState[] = ['idle', 'starting', 'running', 'retrying', 'refused']
const PLACEMENTS: PluginJobsPlacement[] = ['running', 'pending', 'host-offline', 'host-unsupported', 'host-unknown', 'plugin-off', 'code-error']

const num = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : undefined)
const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined)
const obj = (v: unknown): Record<string, unknown> | null => (v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : null)
const kindOf = (v: unknown): PluginJobKind | null => (v === 'every' || v === 'long-running' ? v : null)

function readRow(raw: unknown): PluginJobRow | null {
  const r = obj(raw)
  const job = str(r?.job)
  const kind = kindOf(r?.kind)
  if (!r || !job || !kind) return null
  const metrics: Record<string, number> = {}
  for (const [k, v] of Object.entries(obj(r.metrics) ?? {})) { const n = num(v); if (n !== undefined) metrics[k] = n }
  const state = RUN_STATES.includes(r.state as PluginJobRunState) ? r.state as PluginJobRunState : 'idle'
  return {
    job, kind, everyMs: num(r.everyMs), version: str(r.version) ?? '', state,
    since: num(r.since), startedAt: num(r.startedAt),
    restarts: num(r.restarts) ?? 0, runs: num(r.runs) ?? 0, failures: num(r.failures) ?? 0,
    lastError: str(r.lastError), lastRunAt: num(r.lastRunAt), lastRunMs: num(r.lastRunMs), nextRunAt: num(r.nextRunAt),
    metrics, host: str(r.host) ?? '',
  }
}

/** The view, or null for an answer this page cannot read (an older server, a plugin without jobs). */
export function readPluginJobsState(raw: unknown): PluginJobsState | null {
  const r = obj(raw)
  const pluginId = str(r?.pluginId)
  const placement = obj(r?.placement)
  if (!r || !pluginId || !placement) return null
  const declared: PluginJobsState['declared'] = []
  for (const d of Array.isArray(r.declared) ? r.declared : []) {
    const o = obj(d)
    const name = str(o?.name)
    const kind = kindOf(o?.kind)
    if (name && kind) declared.push({ name, kind, ...(str(o?.every) ? { every: str(o?.every) } : {}) })
  }
  const hosts: PluginJobsHostOption[] = []
  for (const h of Array.isArray(r.hosts) ? r.hosts : []) {
    const o = obj(h)
    const key = str(o?.key)
    if (key) hosts.push({ key, label: str(o?.label) || key, connected: o?.connected === true, supported: o?.supported !== false })
  }
  const elsewhere: PluginJobsState['elsewhere'] = []
  for (const e of Array.isArray(r.elsewhere) ? r.elsewhere : []) {
    const o = obj(e)
    const host = str(o?.host)
    if (host) elsewhere.push({ host, jobs: num(o?.jobs) ?? 0 })
  }
  return {
    pluginId, declared,
    runOn: str(r.runOn) || '__local__',
    runOnLabel: str(r.runOnLabel) || 'This computer',
    placement: {
      state: PLACEMENTS.includes(placement.state as PluginJobsPlacement) ? placement.state as PluginJobsPlacement : 'pending',
      message: str(placement.message) ?? '',
    },
    jobs: (Array.isArray(r.jobs) ? r.jobs : []).map(readRow).filter((x): x is PluginJobRow => x !== null),
    live: r.live === true,
    checkedAt: num(r.checkedAt),
    elsewhere, hosts,
  }
}

/** A length of time in the largest unit that fits: "45 s", "5 min", "2 h", "3 days". */
export function spanWords(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000))
  if (s < 60) return `${s} s`
  const m = Math.round(s / 60)
  if (m < 60) return `${m} min`
  const h = Math.round(m / 60)
  if (h < 48) return `${h} h`
  return `${Math.round(h / 24)} days`
}

const ago = (at: number, now: number): string => (now - at < 60_000 ? 'just now' : `${spanWords(now - at)} ago`)

export function placementTone(state: PluginJobsPlacement): 'neutral' | 'warning' | 'success' | 'error' {
  if (state === 'running') return 'success'
  if (state === 'code-error' || state === 'host-unknown') return 'error'
  if (state === 'host-offline' || state === 'host-unsupported') return 'warning'
  return 'neutral'
}

/** The sentence under "Runs on": where the jobs are now, and any machine still reporting them. */
export function placementHelp(view: PluginJobsState, now = Date.now()): string {
  const first = view.placement.message ? view.placement.message.charAt(0).toUpperCase() + view.placement.message.slice(1) : ''
  const parts = [first.endsWith('.') ? first : `${first}.`]
  if (!view.live && view.checkedAt) parts.push(`Last report ${ago(view.checkedAt, now)}.`)
  for (const e of view.elsewhere) {
    const label = view.hosts.find((h) => h.key === e.host)?.label ?? e.host
    parts.push(`${label} still reports ${e.jobs === 1 ? '1 job' : `${e.jobs} jobs`}; they stop when it next connects.`)
  }
  return parts.join(' ')
}

export function hostOptionLabel(h: PluginJobsHostOption): string {
  if (!h.supported) return `${h.label} (needs a newer daemon)`
  if (!h.connected) return `${h.label} (not connected)`
  return h.label
}

/** The tag beside a job's name. */
export function jobTag(row: PluginJobRow | undefined, placement: PluginJobsPlacement): { label: string; tone: 'neutral' | 'warning' | 'success' | 'error' } {
  if (!row) return placement === 'plugin-off' ? { label: 'Off', tone: 'neutral' } : { label: 'Not running', tone: 'neutral' }
  if (row.state === 'refused') return { label: 'Refused', tone: 'error' }
  if (row.state === 'retrying') return { label: 'Restarting', tone: 'warning' }
  if (row.state === 'running' || row.state === 'starting') return { label: 'Running', tone: 'success' }
  if (row.lastError) return { label: 'Last run failed', tone: 'error' }
  return { label: 'Waiting', tone: 'neutral' }
}

/** The metrics a job wrote, as "processed 7, queue 3" (at most 6, in the order written). */
export function metricsLine(metrics: Record<string, number>): string {
  const entries = Object.entries(metrics)
  if (entries.length === 0) return ''
  const shown = entries.slice(0, 6).map(([k, v]) => `${k} ${Number.isInteger(v) ? v : v.toFixed(2)}`)
  return entries.length > 6 ? `${shown.join(', ')} and ${entries.length - 6} more` : shown.join(', ')
}

/** The sentence under a job: how it runs, what happened last, its numbers. */
export function jobHelp(decl: { kind: PluginJobKind; every?: string }, row: PluginJobRow | undefined, now = Date.now()): string {
  const parts: string[] = []
  if (decl.kind === 'every') {
    parts.push(`Every ${decl.every ?? (row?.everyMs ? spanWords(row.everyMs) : '?')}.`)
    if (row?.state === 'running' && row.startedAt) parts.push(`Running now, started ${ago(row.startedAt, now)}.`)
    else if (row?.lastRunAt) parts.push(`Last run ${ago(row.lastRunAt, now)}${row.lastRunMs !== undefined ? `, took ${row.lastRunMs < 1_000 ? 'under a second' : spanWords(row.lastRunMs)}` : ''}.`)
    if (row?.nextRunAt && row.state !== 'running' && row.state !== 'refused') parts.push(row.nextRunAt <= now ? 'Next run soon.' : `Next in ${spanWords(row.nextRunAt - now)}.`)
    if (row && row.runs > 0) parts.push(`${row.runs} ${row.runs === 1 ? 'run' : 'runs'}${row.failures > 0 ? `, ${row.failures} failed` : ''}.`)
  } else {
    parts.push('Runs all the time; restarted when it stops.')
    if ((row?.state === 'running' || row?.state === 'starting') && row.startedAt) parts.push(`Up since ${ago(row.startedAt, now)}.`)
    if (row?.state === 'retrying' && row.nextRunAt) parts.push(row.nextRunAt <= now ? 'Starting again now.' : `Starting again in ${spanWords(row.nextRunAt - now)}.`)
    if (row && row.restarts > 0) parts.push(`Restarted ${row.restarts === 1 ? 'once' : `${row.restarts} times`}${row.failures > 0 ? `, ${row.failures} after a failure` : ''}.`)
  }
  if (row?.lastError && (row.state === 'refused' || row.state === 'retrying' || decl.kind === 'every')) {
    const e = row.lastError.length > 160 ? `${row.lastError.slice(0, 157)}...` : row.lastError
    parts.push(row.state === 'refused' ? `Not started: ${e}.` : `Last error: ${e}.`)
  }
  const m = row ? metricsLine(row.metrics) : ''
  if (m) parts.push(`${m.charAt(0).toUpperCase()}${m.slice(1)}.`)
  return parts.join(' ')
}

const pad2 = (n: number): string => String(n).padStart(2, '0')

/**
 * One line of a job's log for a person: the harness writes JSON lines
 * (`{"t","level","msg","data"}`, plugin-job-harness.ts), shown as
 * "06:16:05 info  worker up {"queue":"q1"}" in this browser's time, with an error's
 * text on the lines after it. Anything else the job printed stays as it is.
 */
export function formatLogLine(line: string): string {
  if (!line.startsWith('{')) return line
  let j: { t?: unknown; level?: unknown; msg?: unknown; data?: unknown }
  try { j = JSON.parse(line) } catch { return line }
  if (!j || typeof j.msg !== 'string') return line
  const at = typeof j.t === 'string' ? new Date(j.t) : null
  const time = at && !Number.isNaN(at.getTime()) ? `${pad2(at.getHours())}:${pad2(at.getMinutes())}:${pad2(at.getSeconds())} ` : ''
  const level = typeof j.level === 'string' ? j.level : 'info'
  let data = ''
  let error = ''
  if (j.data && typeof j.data === 'object' && !Array.isArray(j.data)) {
    const { error: e, ...rest } = j.data as Record<string, unknown>
    if (typeof e === 'string') error = `\n  ${e.split('\n').join('\n  ')}`
    else if (e !== undefined) rest.error = e
    if (Object.keys(rest).length > 0) data = ` ${JSON.stringify(rest)}`
  } else if (j.data !== undefined) {
    data = ` ${JSON.stringify(j.data)}`
  }
  return `${time}${level.padEnd(5)} ${j.msg}${data}${error}`
}
