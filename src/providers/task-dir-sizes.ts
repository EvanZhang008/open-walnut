/**
 * How much disk each task directory takes on this host, and which of its
 * top-level folders take it (`taskdir.sizes`, capability task-dir-sizes-v1).
 * Read only: the server uses it to tell a task whose own folder grew past a
 * limit while the disk is low (src/core/task-dir-size-notice.ts), because run
 * folders and evidence are the task's to judge, never build output to prune.
 *
 * Bytes are allocated blocks (du's measure), symlinks are not followed. Each
 * directory has its own file and time budget (`partial` when cut short, its
 * bytes then a lower bound), so one huge tree never starves the rest; the
 * whole call has a deadline too, and a directory it did not reach is left out
 * of the answer, never reported as empty (the server asks for those first next
 * time). Directories are read entry by entry (opendir), the walk stops the
 * moment a budget runs out, and it yields to the event loop every few hundred
 * entries, so the daemon keeps serving while it walks.
 */
import fsp from 'node:fs/promises'
import path from 'node:path'
import type { Dir, Stats } from 'node:fs'
import { isTaskDirId, taskDirPath } from '../lib/task-dir.js'

export interface TaskDirSize { taskId: string; bytes: number; partial: boolean; top: Array<{ name: string; bytes: number }> }

const TOP_ENTRIES = 6
const PER_DIR_FILES = 1_000_000
const PER_DIR_MS = 20_000
const TOTAL_MS = 150_000
const YIELD_EVERY = 500

type Budget = { files: number; until: number; partial: boolean; sinceYield: number }

const spent = (b: Budget): boolean => {
  if (b.files <= 0 || Date.now() > b.until) b.partial = true
  return b.partial
}

/** Close a Dir that a for-await may already have closed. */
async function closeDir(d: Dir): Promise<void> {
  try { await d.close() } catch { /* already closed */ }
}

async function sizeOf(p: string, budget: Budget): Promise<number> {
  if (spent(budget)) return 0
  budget.files--
  if (++budget.sinceYield >= YIELD_EVERY) { budget.sinceYield = 0; await new Promise((r) => setImmediate(r)) }
  let st: Stats
  try { st = await fsp.lstat(p) } catch { return 0 }
  const own = st.blocks !== undefined ? st.blocks * 512 : st.size
  if (!st.isDirectory()) return own
  let sum = own
  let dir: Dir
  try { dir = await fsp.opendir(p) } catch { return own }
  try {
    for await (const ent of dir) {
      sum += await sizeOf(path.join(p, ent.name), budget)
      if (spent(budget)) break
    }
  } catch { /* a folder that vanished mid-walk counts what was read */ }
  finally { await closeDir(dir) }
  return sum
}

function keepTop(top: Array<{ name: string; bytes: number }>, e: { name: string; bytes: number }): void {
  if (top.length >= TOP_ENTRIES && e.bytes <= top[top.length - 1].bytes) return
  top.push(e)
  top.sort((a, b) => b.bytes - a.bytes)
  if (top.length > TOP_ENTRIES) top.pop()
}

/** Sizes of the named task directories, in the order asked (unknown, missing and unreached ones are left out). */
export async function taskDirSizes(root: string, ids: unknown[], opts: { files?: number; perDirMs?: number; totalMs?: number } = {}): Promise<TaskDirSize[]> {
  const out: TaskDirSize[] = []
  const end = Date.now() + (opts.totalMs ?? TOTAL_MS)
  for (const id of ids) {
    if (Date.now() > end) break
    if (!isTaskDirId(id)) continue
    const dir = taskDirPath(root, id)!
    let handle: Dir
    try { handle = await fsp.opendir(dir) } catch { continue }
    const budget: Budget = { files: opts.files ?? PER_DIR_FILES, until: Math.min(end, Date.now() + (opts.perDirMs ?? PER_DIR_MS)), partial: false, sinceYield: 0 }
    const top: Array<{ name: string; bytes: number }> = []
    let bytes = 0
    try {
      for await (const ent of handle) {
        const b = await sizeOf(path.join(dir, ent.name), budget)
        bytes += b
        keepTop(top, { name: ent.name, bytes: b })
        if (spent(budget)) break
      }
    } catch { /* counted what was read */ }
    finally { await closeDir(handle) }
    out.push({ taskId: id, bytes, partial: budget.partial, top })
  }
  return out
}
