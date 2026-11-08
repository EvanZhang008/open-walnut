/**
 * How much disk each task directory takes on this host, and which of its
 * top-level folders take it (`taskdir.sizes`, capability task-dir-sizes-v1).
 * Read only: the server uses it to tell a task whose own folder grew past a
 * limit while the disk is low (src/core/task-dir-size-notice.ts), because run
 * folders and evidence are the task's to judge, never build output to prune.
 *
 * Bytes are allocated blocks (du's measure), symlinks are not followed, and
 * the walk stops at a file and a time budget, marking the answer `partial`.
 * Async on purpose: the daemon's event loop keeps serving while it walks.
 */
import fsp from 'node:fs/promises'
import path from 'node:path'
import { isTaskDirId, taskDirPath } from '../lib/task-dir.js'

export interface TaskDirSize { taskId: string; bytes: number; partial: boolean; top: Array<{ name: string; bytes: number }> }

const TOP_ENTRIES = 6
const DEFAULT_FILES = 3_000_000
const DEFAULT_DEADLINE_MS = 120_000

type Budget = { files: number; until: number; partial: boolean }

async function sizeOf(p: string, budget: Budget): Promise<number> {
  if (budget.files <= 0 || Date.now() > budget.until) { budget.partial = true; return 0 }
  budget.files--
  let st: import('node:fs').Stats
  try { st = await fsp.lstat(p) } catch { return 0 }
  const own = st.blocks !== undefined ? st.blocks * 512 : st.size
  if (!st.isDirectory()) return own
  let names: string[]
  try { names = await fsp.readdir(p) } catch { return own }
  let sum = own
  for (const n of names) sum += await sizeOf(path.join(p, n), budget)
  return sum
}

/** Sizes of the named task directories (unknown or missing ones are left out). */
export async function taskDirSizes(root: string, ids: unknown[], opts: { files?: number; deadlineMs?: number } = {}): Promise<TaskDirSize[]> {
  const out: TaskDirSize[] = []
  const budget: Budget = { files: opts.files ?? DEFAULT_FILES, until: Date.now() + (opts.deadlineMs ?? DEFAULT_DEADLINE_MS), partial: false }
  for (const id of ids) {
    if (!isTaskDirId(id)) continue
    const dir = taskDirPath(root, id)!
    let names: string[]
    try { names = await fsp.readdir(dir) } catch { continue }
    budget.partial = false
    const top: Array<{ name: string; bytes: number }> = []
    let bytes = 0
    for (const n of names) {
      const b = await sizeOf(path.join(dir, n), budget)
      bytes += b
      top.push({ name: n, bytes: b })
    }
    top.sort((a, b) => b.bytes - a.bytes)
    // Partial bytes are a lower bound, still enough to tell a directory is over a limit.
    out.push({ taskId: id, bytes, partial: budget.partial, top: top.slice(0, TOP_ENTRIES) })
  }
  return out
}
