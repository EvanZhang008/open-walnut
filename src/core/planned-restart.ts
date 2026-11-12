/**
 * A planned restart, written by whatever is about to stop this Walnut so the stopping
 * server can say why it stopped (the feature-node connection journal's `server_stopping`):
 *
 *   WALNUT_HOME/local/planned-restart.json   { at, reason, build? }   (local/: never git-synced)
 *
 * Writers, each after every guard of its own passed and right before the stop:
 * scripts/dev-prod.sh (`deploy`) and the companion's self-update into a trial
 * (companion-build/box.ts, `companion-update`). The stopping server takes it once (reads,
 * then removes it); one older than PLANNED_RESTART_TTL_MS says nothing, and a starting
 * server removes one the previous server never took (an older build, or a SIGKILL).
 */

import crypto from 'node:crypto'
import fsp from 'node:fs/promises'
import path from 'node:path'

export const PLANNED_RESTART_TTL_MS = 5 * 60_000
export const plannedRestartReasons = ['deploy', 'companion-update'] as const
export type PlannedRestartReason = typeof plannedRestartReasons[number]
export interface PlannedRestart { at: number; reason: PlannedRestartReason; build?: string }

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

/** Read and remove the marker. Never throws; null when there is none (or none that counts). */
export async function takePlannedRestart(home: string, now = Date.now()): Promise<PlannedRestart | null> {
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
  return parsePlannedRestart(raw, now)
}
