/**
 * The standby copy of the leader's home (docs/reference/standby-copy.md): whole-folder
 * batches to a target directory, kept complete, checked for direct edits.
 *
 * The target is a directory on this machine (localTransport) or on another host
 * (remote-transport.ts); both implement StandbyTransport (types.ts).
 */
import fs from 'node:fs/promises'
import path from 'node:path'
import { takeBatch, type BatchOptions, type BatchOutcome } from './batch.js'
import { StandbyTarget } from './target.js'
import { checkTargetPlace } from './target-files.js'
import type { StandbyTransport } from './types.js'

export { takeBatch, type BatchOutcome, type BatchStats } from './batch.js'
export { verifyStandby, reportPendingDrift, type DriftReport, type VerifyResult } from './verify.js'
export { StandbyTarget } from './target.js'
export type { BatchFile, BatchManifest, StandbyState, StandbyTransport } from './types.js'

/** A target directory on this machine, as a transport. */
export async function localTransport(dir: string): Promise<StandbyTarget & StandbyTransport> {
  const target = new StandbyTarget(dir)
  await target.init()
  return target
}

export { checkTargetPlace } from './target-files.js'

/** One batch from `home` to the local target `dir`. */
export async function snapshotTo(home: string, dir: string, opts: Partial<Omit<BatchOptions, 'home' | 'transport'>> = {}): Promise<BatchOutcome> {
  await checkTargetPlace(home, dir)
  const transport = await localTransport(dir)
  // The home's own scratch (tmp/ is rebuildable): staging never reaches the copy.
  const stagingDir = opts.stagingDir ?? path.join(home, 'tmp', 'standby-staging')
  return takeBatch({ ...opts, home, transport, stagingDir })
}

export interface StandbyStatus {
  dir: string
  batch: number | null
  takenAt: string | null
  /** Seconds since the batch's moment. */
  ageSeconds: number | null
  /** When the target made that batch current (a long batch lands well after its moment); null in an older state. */
  committedAt: string | null
  fileCount: number
  bytes: number
  lastVerify: { at: string; drift: number; deep: boolean } | null
  /** Drift reports not yet handed to Walnut Health. */
  unreportedDrift: number
}

export async function standbyStatus(dir: string, now = Date.now()): Promise<StandbyStatus> {
  const target = new StandbyTarget(dir)
  if (!await fs.access(target.t.state).then(() => true, () => false)) throw new Error(`${path.resolve(dir)} holds no standby copy`)
  const s = await target.state()
  let unreported = 0
  for (const name of await fs.readdir(target.t.drift).catch(() => [] as string[])) {
    const r = JSON.parse(await fs.readFile(path.join(target.t.drift, name, 'report.json'), 'utf8').catch(() => '{}')) as { reported?: string; items?: unknown[] }
    if (r.items && !r.reported) unreported++
  }
  return {
    dir: target.t.root,
    batch: s.current?.batch ?? null,
    takenAt: s.current?.takenAt ?? null,
    ageSeconds: s.current ? Math.max(0, Math.round((now - Date.parse(s.current.takenAt)) / 1000)) : null,
    committedAt: s.current?.committedAt ?? null,
    fileCount: s.current?.fileCount ?? 0,
    bytes: s.current?.bytes ?? 0,
    lastVerify: s.lastVerify ?? null,
    unreportedDrift: unreported,
  }
}
