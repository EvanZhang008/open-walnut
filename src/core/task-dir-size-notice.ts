/**
 * While this machine's disk is low, tell each open task whose own task
 * directory takes more than the limit (WALNUT_TASK_DIR_NOTICE_GB, default 5,
 * 0 = off) to clear what it no longer needs. 2026-11-08: the Mac refilled from
 * 30 to 8 GB in hours, and the sweep's build pruning freed little, because the
 * growth was each running task's own test run folders (a data copy per run,
 * 0.3 to 1.3 GB each, a dozen per task). Those may be evidence, so Walnut
 * never deletes them; the task that made them judges, and it is told with
 * its largest folders named. Once a day per task, every 6 hours while free
 * space is under the floor (taskDirLowDiskFloorBytes; 2026-11-09: a task told
 * at 5.45 GiB kept writing for 18 hours while the Mac sat at 13 to 15 GiB),
 * or again when it grew by 2 GB since it was told. Called by the sweep
 * (task-dir-sweep.ts) for the local host only, because only this machine's
 * disk is measured.
 */
import fsp from 'node:fs/promises'
import path from 'node:path'
import { log } from '../logging/index.js'
import type { TaskDirSize } from '../providers/task-dir-sizes.js'
import { taskDirLowDiskFloorBytes } from '../lib/task-dir.js'

export const SIZE_NOTICE_REPEAT_MS = 24 * 3_600_000
/** The repeat while free space is under the floor. */
export const SIZE_NOTICE_REPEAT_UNDER_FLOOR_MS = 6 * 3_600_000
export const SIZE_NOTICE_GROWTH_BYTES = 2 * 1024 ** 3
const TOLD_KEEP_MS = 7 * 24 * 3_600_000

export interface SizeNoticeTask { id: string; phase: string; session_id?: string; org_role?: string }
export type ToldSizes = Record<string, { at: number; bytes: number }>
/** What the sweep remembers across rounds and restarts: who was told, and when each directory was last measured. */
interface NoticeRecord { told: ToldSizes; measured: Record<string, number> }

export function taskDirNoticeBytes(env: NodeJS.ProcessEnv): number {
  const raw = env.WALNUT_TASK_DIR_NOTICE_GB
  const n = raw === undefined || raw === '' ? 5 : Number(raw)
  return Number.isFinite(n) && n >= 0 ? n * 1024 ** 3 : 5 * 1024 ** 3
}

/** The directories to tell their task about now. */
export function pickSizeNotices(sizes: TaskDirSize[], tasks: Map<string, SizeNoticeTask>, told: ToldSizes, opts: { now: number; floor: number; orgOn: boolean; repeatMs?: number }): TaskDirSize[] {
  if (!(opts.floor > 0)) return []
  return sizes.filter((s) => {
    const t = tasks.get(s.taskId)
    if (!t || !mayTell(t, opts.orgOn)) return false
    if (!(s.bytes >= opts.floor)) return false
    const prev = told[s.taskId]
    return !prev || opts.now - prev.at >= (opts.repeatMs ?? SIZE_NOTICE_REPEAT_MS) || s.bytes - prev.bytes >= SIZE_NOTICE_GROWTH_BYTES
  })
}

/** An open task with a session; Main or a VP only while the org is on (org-enabled.ts: no Walnut message reaches one while it is off). */
const mayTell = (t: SizeNoticeTask, orgOn: boolean): boolean =>
  t.phase !== 'COMPLETE' && !!t.session_id && (orgOn || !t.org_role)

const gb = (b: number): string => `${(b / 1024 ** 3).toFixed(1)} GB`

export function sizeNoticeText(size: TaskDirSize, dir: string, freeBytes: number | null, host = '__local__'): string {
  const top = size.top.filter((e) => e.bytes >= 100 * 1024 ** 2).map((e) => `- ${e.name}: ${gb(e.bytes)}`).join('\n')
  return [
    `<walnut-message kind="notification" from="Walnut" outcome="task-dir-size">`,
    `The disk of host ${host === '__local__' ? '__local__ (the machine Walnut runs on)' : host} is low${freeBytes !== null ? ` (${gb(freeBytes)} free)` : ''}, and your task directory there, ${dir}, takes ${size.partial ? 'at least ' : ''}${gb(size.bytes)}.`,
    ...(top ? ['Its largest folders:', top] : []),
    `Delete what you no longer need there now: old test or run folders, data copies, archives, build output. Keep only the latest run you still read, and move evidence you must keep into one small folder. From now on clear a run's folder once its result is recorded. Walnut deletes none of it for you.`,
    `</walnut-message>`,
  ].join('\n')
}

async function readRecord(file: string, now: number): Promise<NoticeRecord> {
  try {
    const raw = JSON.parse(await fsp.readFile(file, 'utf8')) as Partial<NoticeRecord>
    const fresh = <T>(o: Record<string, T> | undefined, at: (v: T) => number) =>
      Object.fromEntries(Object.entries(o && typeof o === 'object' ? o : {}).filter(([, v]) => v != null && now - at(v) < TOLD_KEEP_MS))
    return { told: fresh(raw.told, (v) => v.at), measured: fresh(raw.measured, (v) => v) }
  } catch { return { told: {}, measured: {} } }
}

async function writeRecord(file: string, rec: NoticeRecord): Promise<void> {
  await fsp.mkdir(path.dirname(file), { recursive: true })
  const tmp = `${file}.${process.pid}.tmp`
  await fsp.writeFile(tmp, JSON.stringify(rec) + '\n')
  await fsp.rename(tmp, file)
}

type Conn = { host: string; hasCapability?: (c: string) => boolean; send: (cmd: string, p?: Record<string, unknown>, t?: number) => Promise<unknown> }

/** Measure the open tasks' directories on this host and tell the ones over the limit. Returns the task ids told. */
export async function tellOversizeTasks(conn: Conn, dirs: Array<{ taskId: string; path: string }>, tasks: Map<string, SizeNoticeTask>, deps: {
  now: number
  file: string
  freeBytes: number | null
  deliver?: (task: SizeNoticeTask, text: string, messageId: string) => Promise<void>
  orgOn?: boolean
}): Promise<string[]> {
  const floor = taskDirNoticeBytes(process.env)
  if (!(floor > 0) || !conn.hasCapability?.('task-dir-sizes-v1')) return []
  const orgOn = deps.orgOn ?? await import('./org/org-enabled.js').then((m) => m.isOrgEnabled()).catch(() => true)
  const rec = await readRecord(deps.file, deps.now)
  // The ones measured longest ago go first: the host stops at its deadline, and the rest come next round.
  const open = dirs.filter((d) => { const t = tasks.get(d.taskId); return t && mayTell(t, orgOn) })
    .sort((a, b) => (rec.measured[a.taskId] ?? 0) - (rec.measured[b.taskId] ?? 0))
  if (open.length === 0) return []
  const res = await conn.send('taskdir.sizes', { taskIds: open.map((d) => d.taskId) }, 180_000) as { ok?: boolean; error?: string; sizes?: TaskDirSize[] }
  if (res?.ok === false) throw new Error(res.error || 'taskdir.sizes refused')
  const sizes = Array.isArray(res?.sizes) ? res.sizes : []
  for (const s of sizes) rec.measured[s.taskId] = deps.now
  const told = rec.told
  const underFloor = deps.freeBytes !== null && deps.freeBytes < taskDirLowDiskFloorBytes(process.env)
  const repeatMs = underFloor ? SIZE_NOTICE_REPEAT_UNDER_FLOOR_MS : SIZE_NOTICE_REPEAT_MS
  const due = pickSizeNotices(sizes, tasks, told, { now: deps.now, floor, orgOn, repeatMs })
  const deliver = deps.deliver ?? deliverNotice
  const out: string[] = []
  for (const s of due) {
    const task = tasks.get(s.taskId)!
    const dir = dirs.find((d) => d.taskId === s.taskId)!.path
    try {
      // One id per notice: a later notice is new news, never a retry of the last one.
      await deliver(task, sizeNoticeText(s, dir, deps.freeBytes, conn.host), `tds-${s.taskId}-${deps.now}`)
      told[s.taskId] = { at: deps.now, bytes: s.bytes }
      out.push(s.taskId)
    } catch (err) {
      log.session.warn('task dir size notice not delivered', { taskId: s.taskId, error: (err as Error).message })
    }
  }
  await writeRecord(deps.file, rec)
  log.session.info('task dir sizes checked', { host: conn.host, asked: open.length, measured: sizes.length, told: out, floorBytes: floor, repeatHours: repeatMs / 3_600_000 })
  return out
}

async function deliverNotice(task: SizeNoticeTask, text: string, messageId: string): Promise<void> {
  const { getSessionByClaudeId } = await import('./session-tracker.js')
  const record = await getSessionByClaudeId(task.session_id!)
  if (!record) throw new Error('no session record')
  const { deliverToSession } = await import('./sessions/session-send-core.js')
  await deliverToSession(record, { busText: text, enqueueText: text, source: 'walnut-notify', taskId: task.id, messageId })
}
