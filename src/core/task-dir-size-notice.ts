/**
 * While this machine's disk is low, tell each open task whose own task
 * directory takes more than the limit (WALNUT_TASK_DIR_NOTICE_GB, default 5,
 * 0 = off) to clear what it no longer needs. 2026-11-08: the Mac refilled from
 * 30 to 8 GB in hours, and the sweep's build pruning freed little, because the
 * growth was each running task's own test run folders (a data copy per run,
 * 0.3 to 1.3 GB each, a dozen per task). Those may be evidence, so Walnut
 * never deletes them; the task that made them judges, and it is told with
 * its largest folders named. Once a day per task, or again when it grew by
 * 2 GB since it was told. Called by the sweep (task-dir-sweep.ts) for the
 * local host only, because only this machine's disk is measured.
 */
import fsp from 'node:fs/promises'
import path from 'node:path'
import { log } from '../logging/index.js'
import type { TaskDirSize } from '../providers/task-dir-sizes.js'

export const SIZE_NOTICE_REPEAT_MS = 24 * 3_600_000
export const SIZE_NOTICE_GROWTH_BYTES = 2 * 1024 ** 3
const TOLD_KEEP_MS = 7 * 24 * 3_600_000

export interface SizeNoticeTask { id: string; phase: string; session_id?: string }
export type ToldSizes = Record<string, { at: number; bytes: number }>

export function taskDirNoticeBytes(env: NodeJS.ProcessEnv): number {
  const raw = env.WALNUT_TASK_DIR_NOTICE_GB
  const n = raw === undefined || raw === '' ? 5 : Number(raw)
  return Number.isFinite(n) && n >= 0 ? n * 1024 ** 3 : 5 * 1024 ** 3
}

/** The directories to tell their task about now. */
export function pickSizeNotices(sizes: TaskDirSize[], tasks: Map<string, SizeNoticeTask>, told: ToldSizes, opts: { now: number; floor: number }): TaskDirSize[] {
  if (!(opts.floor > 0)) return []
  return sizes.filter((s) => {
    const t = tasks.get(s.taskId)
    if (!t || t.phase === 'COMPLETE' || !t.session_id) return false
    if (!(s.bytes >= opts.floor)) return false
    const prev = told[s.taskId]
    return !prev || opts.now - prev.at >= SIZE_NOTICE_REPEAT_MS || s.bytes - prev.bytes >= SIZE_NOTICE_GROWTH_BYTES
  })
}

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

async function readTold(file: string, now: number): Promise<ToldSizes> {
  try {
    const raw = JSON.parse(await fsp.readFile(file, 'utf8')) as ToldSizes
    return Object.fromEntries(Object.entries(raw).filter(([, v]) => v && now - v.at < TOLD_KEEP_MS))
  } catch { return {} }
}

async function writeTold(file: string, told: ToldSizes): Promise<void> {
  await fsp.mkdir(path.dirname(file), { recursive: true })
  const tmp = `${file}.${process.pid}.tmp`
  await fsp.writeFile(tmp, JSON.stringify(told) + '\n')
  await fsp.rename(tmp, file)
}

type Conn = { host: string; hasCapability?: (c: string) => boolean; send: (cmd: string, p?: Record<string, unknown>, t?: number) => Promise<unknown> }

/** Measure the open tasks' directories on this host and tell the ones over the limit. Returns the task ids told. */
export async function tellOversizeTasks(conn: Conn, dirs: Array<{ taskId: string; path: string }>, tasks: Map<string, SizeNoticeTask>, deps: {
  now: number
  file: string
  freeBytes: number | null
  deliver?: (task: SizeNoticeTask, text: string, messageId: string) => Promise<void>
}): Promise<string[]> {
  const floor = taskDirNoticeBytes(process.env)
  if (!(floor > 0) || !conn.hasCapability?.('task-dir-sizes-v1')) return []
  const open = dirs.filter((d) => { const t = tasks.get(d.taskId); return t && t.phase !== 'COMPLETE' && t.session_id })
  if (open.length === 0) return []
  const res = await conn.send('taskdir.sizes', { taskIds: open.map((d) => d.taskId) }, 180_000) as { ok?: boolean; error?: string; sizes?: TaskDirSize[] }
  if (res?.ok === false) throw new Error(res.error || 'taskdir.sizes refused')
  const told = await readTold(deps.file, deps.now)
  const due = pickSizeNotices(Array.isArray(res?.sizes) ? res.sizes : [], tasks, told, { now: deps.now, floor })
  const deliver = deps.deliver ?? deliverNotice
  const out: string[] = []
  for (const s of due) {
    const task = tasks.get(s.taskId)!
    const dir = dirs.find((d) => d.taskId === s.taskId)!.path
    try {
      await deliver(task, sizeNoticeText(s, dir, deps.freeBytes, conn.host), `tds-${s.taskId}-${Math.floor(deps.now / SIZE_NOTICE_REPEAT_MS)}`)
      told[s.taskId] = { at: deps.now, bytes: s.bytes }
      out.push(s.taskId)
    } catch (err) {
      log.session.warn('task dir size notice not delivered', { taskId: s.taskId, error: (err as Error).message })
    }
  }
  if (out.length > 0) await writeTold(deps.file, told)
  log.session.info('task dir sizes checked', { host: conn.host, measured: res?.sizes?.length ?? 0, told: out, floorBytes: floor })
  return out
}

async function deliverNotice(task: SizeNoticeTask, text: string, messageId: string): Promise<void> {
  const { getSessionByClaudeId } = await import('./session-tracker.js')
  const record = await getSessionByClaudeId(task.session_id!)
  if (!record) throw new Error('no session record')
  const { deliverToSession } = await import('./sessions/session-send-core.js')
  await deliverToSession(record, { busText: text, enqueueText: text, source: 'walnut-notify', taskId: task.id, messageId })
}
