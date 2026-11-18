/**
 * The `jobs` block of a plugin manifest: the plugin's compute that Walnut keeps
 * running, each job a function of the plugin's server module (`export const jobs`).
 *
 *   "jobs": {
 *     "poll-queue": { "every": "5m" },
 *     "worker":     { "kind": "long-running", "serves": true }
 *   }
 *
 * `serves`: the job answers the plugin's HTTP routes the server half does not
 * (walnut.http.route inside the job; the leader forwards them to it). Only a
 * long-running job, and one per plugin.
 *
 * Parsed leniently, like the storage block: a bad entry costs that job (with a
 * reason the loader logs), never the plugin's load.
 *
 * One rule set for both ends: the host's loader drops the jobs it names, and
 * `walnut-plugin validate` (packages/plugin-cli/src/manifest.ts imports this file,
 * and its build carries it) reports the same reasons. So it imports nothing.
 */

export type PluginJobDeclaration =
  | { kind: 'every'; everyMs: number; every: string }
  | { kind: 'long-running'; serves?: true }

export const JOB_NAME_RE = /^[a-z0-9][a-z0-9-]{0,39}$/
export const MIN_JOB_EVERY_MS = 60_000
export const MAX_JOB_EVERY_MS = 7 * 24 * 60 * 60_000
const MAX_JOBS = 16

const UNIT_MS: Record<string, number> = { s: 1_000, m: 60_000, h: 3_600_000, d: 86_400_000 }

/** "90s", "5m", "1h", "1d" (one number and one unit) to milliseconds, or null. */
export function parseEvery(raw: unknown): number | null {
  if (typeof raw !== 'string') return null
  const m = /^\s*(\d{1,6})\s*([smhd])\s*$/.exec(raw)
  if (!m) return null
  return Number(m[1]) * UNIT_MS[m[2]!]!
}

export function parseManifestJobs(raw: unknown): { jobs?: Record<string, PluginJobDeclaration>; dropped: string[] } {
  const dropped: string[] = []
  if (raw === undefined) return { dropped }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { dropped: ['"jobs" must be an object of job names'] }
  const jobs: Record<string, PluginJobDeclaration> = {}
  let servingJob = ''
  for (const [name, value] of Object.entries(raw as Record<string, unknown>)) {
    if (Object.keys(jobs).length >= MAX_JOBS) { dropped.push(`${name}: at most ${MAX_JOBS} jobs`); continue }
    if (!JOB_NAME_RE.test(name)) { dropped.push(`${name}: a job name is 1 to 40 lowercase letters, digits or dashes`); continue }
    const v = value as { every?: unknown; kind?: unknown; serves?: unknown } | null
    if (!v || typeof v !== 'object' || Array.isArray(v)) { dropped.push(`${name}: must be an object`); continue }
    if (v.serves !== undefined && typeof v.serves !== 'boolean') { dropped.push(`${name}: "serves" is true or false`); continue }
    if (v.kind === 'long-running') {
      if (v.every !== undefined) { dropped.push(`${name}: a long-running job has no "every"`); continue }
      if (v.serves === true) {
        if (servingJob) { dropped.push(`${name}: only one job serves routes, and "${servingJob}" already does`); continue }
        servingJob = name
        jobs[name] = { kind: 'long-running', serves: true }
        continue
      }
      jobs[name] = { kind: 'long-running' }
      continue
    }
    if (v.serves === true) { dropped.push(`${name}: only a long-running job serves routes`); continue }
    if (v.kind !== undefined && v.kind !== 'every') { dropped.push(`${name}: "kind" is "long-running", or leave it out and give "every"`); continue }
    const everyMs = parseEvery(v.every)
    if (everyMs === null) { dropped.push(`${name}: "every" must be like "30s", "5m", "1h" or "1d"`); continue }
    if (everyMs < MIN_JOB_EVERY_MS || everyMs > MAX_JOB_EVERY_MS) { dropped.push(`${name}: "every" must be between 1m and 7d`); continue }
    jobs[name] = { kind: 'every', everyMs, every: String(v.every).trim() }
  }
  return Object.keys(jobs).length > 0 ? { jobs, dropped } : { dropped }
}

/** The job that serves the plugin's routes, if one does. */
export function servingJobOf(jobs: Record<string, PluginJobDeclaration> | undefined): string | undefined {
  for (const [name, d] of Object.entries(jobs ?? {})) if (d.kind === 'long-running' && d.serves) return name
  return undefined
}

/** Whether a loaded server module exports any job function (a jobs-only plugin needs no activate). */
export function moduleHasJobs(mod: Record<string, unknown>): boolean {
  const jobsOf = (v: unknown) => (v && typeof v === 'object' ? Object.values(v as Record<string, unknown>).some((f) => typeof f === 'function') : false)
  return jobsOf(mod.jobs) || jobsOf((mod.default as Record<string, unknown> | undefined)?.jobs)
}
