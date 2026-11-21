/**
 * A planned restart, written by whatever is about to stop this Walnut so the stopping
 * server can say why it stopped (the feature-node connection journal's `server_stopping`):
 *
 *   WALNUT_HOME/local/planned-restart.json   { at, reason, build? }   (local/: never git-synced)
 *
 * Writers, each after every guard of its own passed and right before the stop:
 * scripts/dev-prod.sh (`deploy`), the companion's self-update into a trial
 * (companion-build/box.ts, `companion-update`), and a Mac app update (`app-update`:
 * desktop/apply-update.sh before it ends the old app's session hosts, which carry a deploy's
 * server, and AppUpdateBridge.swift before the app stops the server it started). The stopping
 * server takes it once (reads, then removes it); one older than PLANNED_RESTART_TTL_MS says
 * nothing, and a starting server removes one the previous server never took (an older build,
 * or a SIGKILL).
 *
 * The stopping server also leaves what it took in `local/last-planned-stop.json`
 * ({ reason, pid, takenAt }), so the next boot knows why the one before it stopped
 * (health-monitor/engine.ts: a Mac app update restarts the server on the build it ran, and
 * is no restart "on its own"; 2026-11-20, two app installs rang the server.restarts alarm).
 */

import crypto from 'node:crypto'
import fsp from 'node:fs/promises'
import path from 'node:path'

export const PLANNED_RESTART_TTL_MS = 5 * 60_000
export const plannedRestartReasons = ['deploy', 'companion-update', 'app-update'] as const
export type PlannedRestartReason = typeof plannedRestartReasons[number]
export interface PlannedRestart { at: number; reason: PlannedRestartReason; build?: string }

/**
 * The planned restarts meant to come back on the build that ran: a Mac app update ends the
 * server only so it starts again under the new app. A deploy that comes back on the old
 * build did not take, so it is not one of them.
 */
export const sameBuildRestartReasons: readonly PlannedRestartReason[] = ['app-update']

/**
 * What the last stopping server took: its marker's reason, its own pid, and when. Pid 0: a
 * marker no server took, found by the next boot (the server had stopped before the marker was
 * left: a Mac app quit for an update installed by hand, desktop/apply-update.sh with pid 0).
 */
export interface LastPlannedStop { reason: PlannedRestartReason; pid: number; takenAt: number }

export function lastPlannedStopFile(home: string): string {
  return path.join(home, 'local', 'last-planned-stop.json')
}

/** The last planned stop a server recorded, or null (none, unreadable, or not one). Never throws. */
export async function readLastPlannedStop(home: string): Promise<LastPlannedStop | null> {
  try {
    const v = JSON.parse((await fsp.readFile(lastPlannedStopFile(home), 'utf8')).slice(0, 1024)) as Partial<LastPlannedStop>
    if (!plannedRestartReasons.includes(v.reason as PlannedRestartReason)) return null
    if (!Number.isInteger(v.pid) || (v.pid as number) < 0 || !Number.isFinite(v.takenAt)) return null
    return { reason: v.reason as PlannedRestartReason, pid: v.pid as number, takenAt: v.takenAt as number }
  } catch { return null }
}

export function plannedRestartFile(home: string): string {
  return path.join(home, 'local', 'planned-restart.json')
}

export async function writePlannedRestart(
  home: string, plan: { reason: PlannedRestartReason; build?: string }, now = Date.now(),
): Promise<void> {
  const file = plannedRestartFile(home)
  await fsp.mkdir(path.dirname(file), { recursive: true, mode: 0o700 })
  const tmp = `${file}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`
  const build = typeof plan.build === 'string' && /^[A-Za-z0-9._-]{1,96}$/.test(plan.build) ? plan.build : undefined
  await fsp.writeFile(tmp, `${JSON.stringify({ at: new Date(now).toISOString(), reason: plan.reason, ...(build ? { build } : {}) })}\n`, { mode: 0o600 })
  await fsp.rename(tmp, file)
}

/** Parse a marker; null for anything that is not one, or one too old (or too far ahead) to be this stop's. */
export function parsePlannedRestart(raw: string, now = Date.now()): PlannedRestart | null {
  try {
    const value = JSON.parse(raw) as { at?: unknown; reason?: unknown; build?: unknown }
    const at = typeof value.at === 'number' ? value.at : typeof value.at === 'string' ? Date.parse(value.at) : NaN
    if (!Number.isFinite(at) || now - at > PLANNED_RESTART_TTL_MS || at - now > 60_000) return null
    if (!plannedRestartReasons.includes(value.reason as PlannedRestartReason)) return null
    const build = typeof value.build === 'string' && /^[A-Za-z0-9._-]{1,96}$/.test(value.build) ? value.build : undefined
    return { at, reason: value.reason as PlannedRestartReason, ...(build ? { build } : {}) }
  } catch { return null }
}

/** Read the marker without taking it (the stopping server's work it cuts short says why). Never throws. */
export async function peekPlannedRestart(home: string, now = Date.now()): Promise<PlannedRestart | null> {
  try { return parsePlannedRestart((await fsp.readFile(plannedRestartFile(home), 'utf8')).slice(0, 1024), now) } catch { return null }
}

/**
 * Read and remove the marker. Never throws; null when there is none (or none that counts).
 * `stopping`: the stopping server's own take, recorded as the last planned stop with its pid.
 * `atBoot`: a starting server's sweep of a marker the server before it never took, recorded
 * with pid 0 (it still says why that server is gone, when it is fresh).
 */
export async function takePlannedRestart(
  home: string, now = Date.now(), opts: { stopping?: boolean; atBoot?: boolean } = {},
): Promise<PlannedRestart | null> {
  const file = plannedRestartFile(home)
  let raw: string
  let handle: fsp.FileHandle | undefined
  try {
    handle = await fsp.open(file, 'r')
    const buffer = Buffer.alloc(1024)
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0)
    raw = buffer.subarray(0, bytesRead).toString('utf8')
  } catch {
    return null
  } finally {
    await handle?.close().catch(() => {})
  }
  await fsp.rm(file, { force: true }).catch(() => {})
  const plan = parsePlannedRestart(raw, now)
  if (plan && opts.stopping) await recordLastPlannedStop(home, { reason: plan.reason, pid: process.pid, takenAt: now }).catch(() => {})
  else if (plan && opts.atBoot) await recordLastPlannedStop(home, { reason: plan.reason, pid: 0, takenAt: plan.at }).catch(() => {})
  return plan
}

async function recordLastPlannedStop(home: string, stop: LastPlannedStop): Promise<void> {
  const file = lastPlannedStopFile(home)
  const tmp = `${file}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`
  await fsp.writeFile(tmp, `${JSON.stringify(stop)}\n`, { mode: 0o600 })
  await fsp.rename(tmp, file)
}

let bootRead: Promise<{ stale: PlannedRestart | null; last: LastPlannedStop | null }> | null = null

/**
 * This boot's one read of why the server before it stopped: a marker it never took is swept
 * (recorded with pid 0), then the record is read. Every reader at boot (the feature-node start,
 * the health monitor) awaits the same read, so none sees the marker gone and the record not yet
 * written. A server started again in this process (tests) calls resetPlannedStopAtBoot first.
 */
export function plannedStopAtBoot(home: string): Promise<{ stale: PlannedRestart | null; last: LastPlannedStop | null }> {
  return bootRead ??= (async () => {
    const stale = await takePlannedRestart(home, Date.now(), { atBoot: true })
    return { stale, last: await readLastPlannedStop(home) }
  })()
}

export function resetPlannedStopAtBoot(): void { bootRead = null }
