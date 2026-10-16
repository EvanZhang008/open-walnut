/**
 * The host side of the `routines` copy kind (routines.ts): the Mac's routines in
 * the same two files a Mac keeps (cron-jobs.json, definitions in the Mac's
 * order; cron-state.json, each routine's status), read only. Nothing on a host
 * replica runs or writes them but this follower (boot policy `cron` is off, and
 * routines-core.ts reads the copy through readRoutinesCopy instead of the engine,
 * whose list recomputes and persists).
 */

import fsp from 'node:fs/promises'
import path from 'node:path'
import { CRON_FILE } from '../../../constants.js'
import { log } from '../../../logging/index.js'
import type { CronJob, CronJobState } from '../../cron/types.js'
import { createRowSetFollower, serialChain, writeCopyFile, type RowSetFollower } from '../kind-follower.js'
import { copyRefusal, markCopyOff } from './gate.js'
import { copyStateIo } from './state-io.js'
import { ROUTINES_REMOVAL_FLOOR, ROUTINES_SCHEMA_VERSION, projectStatus, routineRowSecrets, type CopiedJob, type RoutineRow } from './routines.js'

const jobsFile = () => CRON_FILE
const statesFile = () => path.join(path.dirname(CRON_FILE), 'cron-state.json')

async function readJobs(): Promise<CopiedJob[]> {
  try {
    const raw = JSON.parse(await fsp.readFile(jobsFile(), 'utf8')) as { jobs?: unknown }
    return Array.isArray(raw?.jobs) ? raw.jobs.filter((j): j is CopiedJob => !!j && typeof j === 'object' && typeof (j as { id?: unknown }).id === 'string') : []
  } catch { return [] }
}

async function readStates(): Promise<Record<string, Partial<CronJobState>>> {
  try {
    const raw = JSON.parse(await fsp.readFile(statesFile(), 'utf8')) as { states?: unknown }
    return raw?.states && typeof raw.states === 'object' ? raw.states as Record<string, Partial<CronJobState>> : {}
  } catch { return {} }
}

function isRow(v: unknown): v is RoutineRow {
  const r = v as Partial<RoutineRow> | null
  return !!r && typeof r === 'object' && typeof r.id === 'string' && !!r.id && !!r.job && typeof r.job === 'object'
    && (r.job as { id?: unknown }).id === r.id && !!r.status && typeof r.status === 'object'
}

let io = copyStateIo('routines')
let serial = serialChain()
let follower: RowSetFollower | null = null

export function routinesFollower(): RowSetFollower {
  follower ??= createRowSetFollower<RoutineRow>({
    kind: 'routines',
    schemaVersion: ROUTINES_SCHEMA_VERSION,
    label: 'routines copy',
    log: log.cron,
    removalFloor: ROUTINES_REMOVAL_FLOOR,
    ordered: true,
    serial: (fn) => serial(fn),
    refuse: copyRefusal,
    load: () => io.load(),
    save: () => io.save(),
    isRow,
    key: (r) => r.id,
    localKeys: async () => (await readJobs()).map((j) => j.id),
    apply: async ({ rows, removeIds, order }) => {
      const jobs = new Map((await readJobs()).map((j) => [j.id, j]))
      const states = await readStates()
      const ids = [...jobs.keys()]
      for (const id of removeIds ?? []) { jobs.delete(id); delete states[id] }
      const skipped: string[] = []
      for (const r of rows ?? []) {
        // Something secret-shaped in it (an older Mac sent it): never written here.
        // An older version of it here goes too.
        if (routineRowSecrets(r).length > 0) { skipped.push(r.id); jobs.delete(r.id); delete states[r.id]; continue }
        if (!jobs.has(r.id)) ids.push(r.id)
        jobs.set(r.id, r.job)
        states[r.id] = projectStatus(r.status)
      }
      const listed: CopiedJob[] = []
      const placed = new Set<string>()
      for (const id of [...(order ?? ids), ...jobs.keys()]) {
        const j = jobs.get(id)
        if (!j || placed.has(id)) continue
        placed.add(id)
        listed.push(j)
      }
      const kept: Record<string, Partial<CronJobState>> = {}
      for (const j of listed) kept[j.id] = states[j.id] ?? {}
      await writeCopyFile(jobsFile(), { version: 2, jobs: listed })
      await writeCopyFile(statesFile(), { version: 1, states: kept })
      return { skipped }
    },
    held: async () => (await import('../../../replica/journal-overlay.js')).journalHeld('routines'),
    changed: () => {},
    purge: async () => {
      const removed = (await readJobs()).length
      await fsp.rm(jobsFile(), { force: true })
      await fsp.rm(statesFile(), { force: true })
      await markCopyOff('routines')
      io.reset()
      return { removed }
    },
  })
  return follower
}

/**
 * The copied routines with their status, in the order the Routines page lists
 * them (cron/ops.ts list: by next run), or null when there is no copy.
 */
export async function readRoutinesCopy(opts: { includeDisabled?: boolean } = {}): Promise<CronJob[] | null> {
  const [jobs, states] = await Promise.all([readJobs(), readStates()])
  if (jobs.length === 0 && !(await fsp.stat(jobsFile()).then(() => true, () => false))) return null
  // The copy leaves out the engine's updatedAtMs clock (routines.ts): it reads as the definition's creation.
  const all = jobs.map((j) => ({ ...j, updatedAtMs: j.updatedAtMs ?? j.createdAtMs, state: { ...(states[j.id] ?? {}) } }) as CronJob)
  const shown = opts.includeDisabled ? all : all.filter((j) => j.enabled)
  return shown.sort((a, b) => (a.state.nextRunAtMs ?? 0) - (b.state.nextRunAtMs ?? 0))
}

/** Tests only. */
export function _resetRoutinesCopyForTesting(): void {
  io = copyStateIo('routines')
  serial = serialChain()
  follower = null
}
