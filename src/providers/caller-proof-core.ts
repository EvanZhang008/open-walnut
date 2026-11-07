/**
 * Pure process-tree helpers for telling whether a process runs inside a session (2026-11-07):
 * shared by the server's check of a loopback caller (src/core/approvals/caller-proof.ts) and a
 * host daemon's check of the process on its gateway socket (daemon-standalone.ts).
 */

export const MAX_DEPTH = 40

/** `ps -Ao pid= -o ppid= -o comm=` as pid -> {ppid, comm}. Pure. */
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

/** One process in a snapshot that also names when each process started. */
export interface ProcRow { ppid: number; comm: string; start: string }

const LSTART_ROW = /^\s*(\d+)\s+(\d+)\s+([A-Z][a-z]{2}\s+[A-Z][a-z]{2}\s+\d{1,2}\s+\d{1,2}:\d{2}:\d{2}\s+\d{4})\s*(.*)$/

/** Arguments for one `ps` snapshot of every process with its parent, start time and name (run with LC_ALL=C). */
export const PS_TREE_ARGS = ['-Ao', 'pid=', '-o', 'ppid=', '-o', 'lstart=', '-o', 'comm=']

/** `ps -Ao pid= -o ppid= -o lstart= -o comm=` (LC_ALL=C) as pid -> {ppid, comm, start}. Pure. */
export function parseProcessTree(out: string): Map<number, ProcRow> {
  const table = new Map<number, ProcRow>()
  for (const line of out.split('\n')) {
    const m = LSTART_ROW.exec(line)
    if (m) table.set(Number(m[1]), { ppid: Number(m[2]), start: normStart(m[3]!), comm: m[4]!.trim() })
  }
  return table
}

/** A start time with its spacing made one form ("Sat Nov  7 ..." and "Sat Nov 7 ..." are one). Pure. */
export function normStart(s: string): string {
  return s.trim().replace(/\s+/g, ' ')
}

/** When a process started, in ms, from its `ps` lstart (whole seconds, floored), or null. Pure. */
export function lstartMs(start: string | undefined): number | null {
  if (!start) return null
  const ms = Date.parse(normStart(start))
  return Number.isFinite(ms) ? ms : null
}

/**
 * Whether the process under a pid now is the one whose start time was recorded, and alive in the
 * snapshot: `readTicks` reads it again the way it was recorded (a Linux daemon's /proc ticks, a
 * `ps` lstart in the recorder's locale); with no such read, an lstart is compared with the
 * snapshot's. Unread is not the same. Pure apart from `readTicks`.
 */
export function sameStart(recorded: string | null | undefined, snapshotStart: string | undefined, readTicks: () => string | null | undefined): boolean {
  if (!recorded || !snapshotStart) return false
  // Read again the way it was recorded (same reader, same locale), where the caller can.
  const now = readTicks()
  if (typeof now === 'string' && now.trim()) return normStart(now) === normStart(recorded)
  if (/^\d+$/.test(recorded.trim())) return false
  return normStart(recorded) === snapshotStart
}

/**
 * Whether a process that started at `start` can be the one seen at `atMs`: the process holding a
 * connection, or the one that wrote a pid file, started before then. A process given the same pid
 * later started after it. lstart floors to the second and Linux's may drift by one, so only a pid
 * given out again within about two seconds passes, and both kernels hand pids out in turn. Pure.
 */
export function startedBy(start: string | undefined, atMs: number): boolean {
  const ms = lstartMs(start)
  return ms !== null && ms <= atMs + START_SLACK_MS
}

/** Linux builds lstart from a boot time that can move by a second with the clock (NTP). */
export const START_SLACK_MS = 1_000

/** Whether an lstart read in UTC (a terminal's pid record) is the same second as a local one. Pure. */
export function sameInstant(utc: string, local: string | undefined): boolean {
  const a = Date.parse(`${normStart(utc)} UTC`)
  const b = lstartMs(local)
  return Number.isFinite(a) && b !== null && a === b
}

/**
 * The processes of a session that are still the ones recorded: a process with a recorded start time
 * the snapshot (or /proc) still shows (`startUtc`: one read in UTC), or one started by `before`. Pure
 * apart from `readTicks`.
 */
export function stillTheirs(table: Map<number, ProcRow>, procs: ReadonlyArray<{ pid: number; start?: string | null; startUtc?: string; before?: number }>,
  readTicks: (pid: number) => string | null | undefined): number[] {
  const out: number[] = []
  for (const p of procs) {
    if (!(p.pid > 1)) continue
    const row = table.get(p.pid)
    if (!row) continue
    if (p.start ? sameStart(p.start, row.start, () => readTicks(p.pid))
      : p.startUtc ? sameInstant(p.startUtc, row.start)
        : p.before !== undefined && startedBy(row.start, p.before)) out.push(p.pid)
  }
  return out
}

/**
 * Whether the process `peer` runs inside a session whose own processes are `procs`, read from one
 * snapshot: it started by `at` (when its connection opened, or when Walnut looked), and it descends
 * from one of them that is still the process recorded. `unchecked` when it could not tell (the peer
 * is not in the snapshot or started later, or the session has no recorded process alive). Pure
 * apart from `readTicks`.
 */
export function proofFor(table: Map<number, ProcRow>, peer: number, at: number,
  procs: ReadonlyArray<{ pid: number; start?: string | null }>, readTicks: (pid: number) => string | null | undefined): { verified: boolean; unchecked?: true } {
  if (!startedBy(table.get(peer)?.start, at)) return { verified: false, unchecked: true }
  const own = stillTheirs(table, procs, readTicks)
  if (!own.length) return { verified: false, unchecked: true }
  return { verified: descendsFrom(table, peer, own) }
}
