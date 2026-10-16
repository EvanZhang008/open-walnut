/**
 * The `routines` copy kind (docs/plan/walnut-replica-servers-impl.md, section 4
 * and WP5): the Mac's routines (cron-jobs.json, definitions in store order) with
 * a projection of each one's status (cron-state.json: last run, last status,
 * next run), on each host replica in the same two files. Read only there:
 * routines never run on a host replica (boot policy `cron`), the Routines page
 * reads this copy (core/routines/routines-core.ts), and every routine write
 * waits for the Mac.
 *
 * The projection leaves out what moves without the user seeing it (a running
 * mark, a trigger's last check and audit, notice clocks, the definition's
 * `updatedAtMs`, which the engine bumps on every run and every quiet check, and
 * a trigger's next check, which the daemon re-arms on every check), so a check
 * every few minutes is not a put every few minutes (a real applyTriggerChecked
 * pins it: tests/core/replication/kinds/routines.test.ts). On the host a copied
 * job's `updatedAtMs` reads as its `createdAtMs`. A jobs file the Mac fails to read or
 * parse throws, so the round skips the kind; a state file it fails to read
 * counts as no status (the engine recomputes it the same way).
 *
 * Ordered (store order), floor 20, no digest. The host side is routines-follower.ts.
 */

import path from 'node:path'
import { CRON_FILE } from '../../../constants.js'
import { readJsonFile } from '../../../utils/fs.js'
import type { CronJob, CronJobState, CronStateFile, CronStoreFile } from '../../cron/types.js'
import { sha12 } from '../kind.js'
import { onStoreWrite } from '../store-writes.js'
import { findSecrets, type SecretFinding } from '../config-allowlist.js'
import { log } from '../../../logging/index.js'
import type { CopyKind } from './copy-kind.js'

export const ROUTINES_SCHEMA_VERSION = 1
export const ROUTINES_REMOVAL_FLOOR = 20

/** What the Routines page shows of a routine's run state. */
const STATUS_FIELDS = ['nextRunAtMs', 'lastRunAtMs', 'lastStatus', 'lastError', 'lastDurationMs', 'consecutiveErrors', 'pausedAtMs'] as const

/** A copied definition: `updatedAtMs` left out (an older Mac's row may still carry it). */
export type CopiedJob = Omit<CronJob, 'state' | 'updatedAtMs'> & { updatedAtMs?: number }

export interface RoutineRow { id: string; job: CopiedJob; status: Partial<CronJobState> }

/** `trigger`: a check routine, whose next run is the daemon's re-arm of its next check (left out). */
export function projectStatus(state: Partial<CronJobState> | undefined, opts: { trigger?: boolean } = {}): Partial<CronJobState> {
  const out: Record<string, unknown> = {}
  for (const f of STATUS_FIELDS) {
    if (opts.trigger && f === 'nextRunAtMs') continue
    // No error count and a zero one read the same; a quiet check writes the zero.
    if (f === 'consecutiveErrors' && !state?.[f]) continue
    if (state?.[f] !== undefined) out[f] = state[f]
  }
  return out as Partial<CronJobState>
}

const stateFile = () => path.join(path.dirname(CRON_FILE), 'cron-state.json')

/**
 * Where a routine row holds something secret-shaped (a token in a check's shell
 * line, an executor setting named like a key, an error that quoted a header):
 * paths and reasons, never a value. Such a row is left out on the Mac and refused
 * on the host, as a config row is (config-allowlist.ts).
 */
export function routineRowSecrets(row: RoutineRow): SecretFinding[] {
  return findSecrets({ job: row.job, status: row.status }, 'routine')
}

let lastWarned = ''

/** The Mac's routine rows from its two files (tests point it at a Mac dir of their own). */
export async function readRoutineRows(jobsPath = CRON_FILE, statePath = stateFile()): Promise<RoutineRow[]> {
  const store = await readJsonFile<CronStoreFile>(jobsPath, { version: 2, jobs: [] }, { readErrors: 'throw' })
  if (!store || !Array.isArray(store.jobs)) throw new Error('cron-jobs.json has no jobs list')
  let states: Record<string, CronJobState> = {}
  try {
    const f = await readJsonFile<CronStateFile>(statePath, { version: 1, states: {} })
    if (f && typeof f.states === 'object' && f.states) states = f.states
  } catch { /* status is recomputable: none */ }
  const rows: RoutineRow[] = []
  const withheld: Array<{ id: string; paths: string[]; reasons: string[] }> = []
  for (const j of store.jobs) {
    if (!j || typeof j !== 'object' || typeof j.id !== 'string' || !j.id) continue
    const { state: embedded, updatedAtMs: _engineClock, ...job } = j as CronJob
    const row: RoutineRow = { id: j.id, job, status: projectStatus(states[j.id] ?? embedded, { trigger: !!job.check }) }
    const found = routineRowSecrets(row)
    if (found.length > 0) { withheld.push({ id: j.id, paths: found.map((f) => f.path), reasons: [...new Set(found.map((f) => f.reason))] }); continue }
    rows.push(row)
  }
  const note = JSON.stringify(withheld)
  if (withheld.length > 0 && note !== lastWarned) {
    log.session.warn('routines copy: left routines out, something in them looks like a secret', { routines: withheld })
  }
  lastWarned = note
  return rows
}

/** Tests only. */
export function _resetRoutinesLeaderForTesting(): void {
  lastWarned = ''
}

const hashes = new WeakMap<object, string>()
function hashOf(row: RoutineRow): string {
  let h = hashes.get(row)
  if (h === undefined) {
    h = sha12(JSON.stringify(row))
    hashes.set(row, h)
  }
  return h
}


export const ROUTINES_KIND: CopyKind<RoutineRow> = {
  kind: 'routines',
  schemaVersion: ROUTINES_SCHEMA_VERSION,
  key: (r) => r.id,
  hash: hashOf,
  ordered: true,
  digest: false,
  choice: 'routines',
  rows: () => readRoutineRows(),
  // The store's one write point, not the bus: its writers tell the browser sockets only (store-writes.ts).
  watch: (soon) => onStoreWrite('routines', soon),
}
