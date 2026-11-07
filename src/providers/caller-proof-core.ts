/**
 * Pure process-tree helpers for telling whether a process runs inside a session (2026-11-07):
 * shared by the server's check of a loopback caller (src/core/approvals/caller-proof.ts) and a
 * host daemon's check of the process on its gateway socket (daemon-standalone.ts).
 */

export const MAX_DEPTH = 40

/** `ps -axo pid=,ppid=,comm=` as pid -> {ppid, comm}. Pure. */
export function parseProcessTable(out: string): Map<number, { ppid: number; comm: string }> {
  const table = new Map<number, { ppid: number; comm: string }>()
  for (const line of out.split('\n')) {
    const m = /^\s*(\d+)\s+(\d+)\s*(.*)$/.exec(line)
    if (m) table.set(Number(m[1]), { ppid: Number(m[2]), comm: m[3]!.trim() })
  }
  return table
}

/** Whether `pid` is `ancestor` or one of its descendants. Pure. */
export function descendsFrom(table: Map<number, { ppid: number }>, pid: number, ancestors: readonly number[]): boolean {
  const want = new Set(ancestors.filter((p) => p > 1))
  if (!want.size) return false
  let cur = pid
  for (let i = 0; i < MAX_DEPTH && cur > 1; i++) {
    if (want.has(cur)) return true
    const row = table.get(cur)
    if (!row) return false
    cur = row.ppid
  }
  return false
}

/** The name of the process that started `pid`, e.g. "python3" for a script's `walnut approve`. Pure. */
export function parentName(table: Map<number, { ppid: number; comm: string }>, pid: number): string | undefined {
  const parent = table.get(pid)?.ppid
  const comm = parent ? table.get(parent)?.comm : undefined
  return comm ? comm.split('/').pop() : undefined
}

/**
 * A command line with its program named by its file name: `/opt/.../Python release.py wait` reads
 * `Python release.py wait`. A program path with a space in it is left whole. Pure.
 */
export function shortProgram(line: string): string {
  const m = /^(\/\S+\/)([^/\s]+)(\s|$)/.exec(line)
  return m ? line.slice(m[1]!.length) : line
}
