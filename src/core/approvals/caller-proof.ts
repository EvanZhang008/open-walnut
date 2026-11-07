/**
 * Whether an approval really comes from the session it names (2026-11-07, the user: "it just
 * starts from a script, so how does it know which session it is?"). A command a session runs
 * inherits WALNUT_SESSION_ID, so a Python or shell script it starts carries it; but a session id
 * is a name, and any process of this account could send one. So Walnut checks the process on the
 * other end of the request itself: the one holding the connection must descend from that session's
 * own process (its Claude Code CLI, its ACP worker, the shell of a terminal Walnut opened for it).
 *
 * - verified: the connection's process descends from the session's process;
 * - unverified: it does not, or Walnut could not see it in time (the screen says so, and a
 *   single-use approval is refused);
 * - none: no session was named (a terminal, cron): the screen says "Session: unknown".
 *
 * The process table is read with one `ps` and the connection's owner with one `lsof` (macOS) or
 * `ss` (Linux), each a child process with a deadline, never on the event loop. The owner is the
 * process whose socket is exactly this connection's client end (both addresses and both ports).
 */
import { execFile } from 'node:child_process'

export type CallerIdentity = 'verified' | 'unverified' | 'none'

const RUN_MS = 2_000
const MAX_DEPTH = 40

function run(cmd: string, args: string[]): Promise<string | null> {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout: RUN_MS, maxBuffer: 8 * 1024 * 1024, env: { ...process.env, LC_ALL: 'C' } }, (err, stdout) => {
      resolve(err && !stdout ? null : String(stdout ?? ''))
    })
  })
}

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

/** One TCP connection as the server sees it: the client's end, then the server's. */
export interface Conn { remoteAddress: string; remotePort: number; localAddress: string; localPort: number }

/** `::ffff:127.0.0.1` and `[::1]` read as `127.0.0.1` and `::1`. Pure. */
export function normAddr(a: string): string {
  const bare = a.replace(/^\[|\]$/g, '').toLowerCase()
  return bare.startsWith('::ffff:') ? bare.slice(7) : bare
}

/** `host:port` or `[v6]:port` into its parts. Pure. */
function splitEnd(end: string): { addr: string; port: number } | null {
  const m = /^(.*):(\d+)$/.exec(end)
  return m ? { addr: normAddr(m[1]!), port: Number(m[2]) } : null
}

/** Whether one socket name (`client->server`) is exactly this connection's client end. Pure. */
function isClientEnd(from: string, to: string, c: Conn): boolean {
  const a = splitEnd(from)
  const b = splitEnd(to)
  return !!a && !!b && a.port === c.remotePort && a.addr === normAddr(c.remoteAddress)
    && b.port === c.localPort && b.addr === normAddr(c.localAddress)
}

/**
 * lsof -Fpn output: the pids holding the client end of exactly this connection (all four parts
 * match, so a process that bound the same port number on another loopback address is not it). Pure.
 */
export function clientPidsFromLsof(out: string, c: Conn): number[] {
  const pids = new Set<number>()
  let pid = 0
  for (const line of out.split('\n')) {
    if (/^p\d+$/.test(line)) pid = Number(line.slice(1))
    else if (line.startsWith('n') && pid) {
      const [from, to] = line.slice(1).split('->')
      if (from && to && isClientEnd(from, to, c)) pids.add(pid)
    }
  }
  return [...pids]
}

/** `ss -Htnp` lines: the pids holding the client end of exactly this connection. Pure. */
export function clientPidsFromSs(out: string, c: Conn): number[] {
  const pids = new Set<number>()
  for (const line of out.split('\n')) {
    // With a state filter ss prints no State column: the ends are the first two host:port columns.
    const ends = line.trim().split(/\s+/).filter((col) => /^\S+:\d+$/.test(col) && !col.startsWith('users:'))
    if (ends.length < 2 || !isClientEnd(ends[0]!, ends[1]!, c)) continue
    for (const m of line.matchAll(/pid=(\d+)/g)) pids.add(Number(m[1]))
  }
  return [...pids]
}

// At most a few lookups at once: a burst of asks queues here rather than piling up processes.
const PROBE_MAX = 3
let probes = 0
const waiting: Array<() => void> = []
async function limited<T>(fn: () => Promise<T>): Promise<T> {
  if (probes >= PROBE_MAX) await new Promise<void>((resolve) => waiting.push(resolve))
  probes++
  try { return await fn() } finally { probes--; waiting.shift()?.() }
}

/** The pids holding the client end of a loopback connection to this server; null = could not look. */
export async function clientPidsOf(c: Conn): Promise<number[] | null> {
  if (!Number.isInteger(c.remotePort) || c.remotePort <= 0) return null
  return limited(async () => {
    if (process.platform === 'darwin') {
      const out = await run('lsof', ['-nP', '-b', '-w', `-iTCP:${c.remotePort}`, '-sTCP:ESTABLISHED', '-Fpn'])
      return out === null ? null : clientPidsFromLsof(out, c)
    }
    const out = await run('ss', ['-Htnp', 'state', 'established', `( sport = :${c.remotePort} and dport = :${c.localPort} )`])
    return out === null ? null : clientPidsFromSs(out, c)
  })
}

/**
 * Whether this server itself holds the client end: a host's daemon relays its sessions' asks
 * through the server's own self-call, so a request claiming a host origin that any other process
 * sends is not a relay.
 */
export async function isSelfCall(c: Conn): Promise<boolean> {
  const pids = await clientPidsOf(c)
  return !!pids && pids.length === 1 && pids[0] === process.pid
}

export async function processTable(): Promise<Map<number, { ppid: number; comm: string }> | null> {
  return limited(async () => {
    const out = await run('ps', ['-axo', 'pid=,ppid=,comm='])
    return out ? parseProcessTable(out) : null
  })
}

/** This server and every process above it: never a session's own process. Pure. */
export function selfAndAbove(table: Map<number, { ppid: number }>, self: number): Set<number> {
  const out = new Set<number>()
  let cur = self
  for (let i = 0; i < MAX_DEPTH && cur > 1 && !out.has(cur); i++) { out.add(cur); cur = table.get(cur)?.ppid ?? 0 }
  return out
}

/**
 * A command line with its program named by its file name: `/opt/.../Python release.py wait` reads
 * `Python release.py wait`. A program path with a space in it is left whole. Pure.
 */
export function shortProgram(line: string): string {
  const m = /^(\/\S+\/)([^/\s]+)(\s|$)/.exec(line)
  return m ? line.slice(m[1]!.length) : line
}

/** The command line of the process that started `pid` (a script's `walnut approve`), cut short. */
async function parentCommand(table: Map<number, { ppid: number }>, pid: number): Promise<string | undefined> {
  const parent = table.get(pid)?.ppid
  if (!parent || parent <= 1) return undefined
  const out = await limited(() => run('ps', ['-o', 'args=', '-p', String(parent)]))
  const raw = out?.trim().split('\n')[0]?.trim()
  if (!raw) return undefined
  // A command line can carry a token as an argument: it is masked before anyone sees it.
  const { redactSensitiveText } = await import('../../logging/redact.js')
  const line = shortProgram(redactSensitiveText(raw))
  return line.length > 300 ? `${line.slice(0, 299)}…` : line
}

/**
 * The identity of a local caller. `sessionPids` are the named session's own live processes (its
 * CLI, its ACP worker, its terminal's dtach process); `notSession` are processes that never count
 * as one (the local daemon). Never throws.
 *
 * - verified: exactly one process holds the connection and it descends from one of them;
 * - outside: Walnut looked and the asking process is not inside that session (a single-use ask
 *   is refused);
 * - unchecked: Walnut could not look (no lsof or ss, a timeout, no live process recorded).
 */
export async function localCallerIdentity(input: { conn?: Conn; sessionId?: string; sessionPids: readonly number[]; notSession?: readonly number[] }):
Promise<{ identity: CallerIdentity; check?: 'outside' | 'unchecked'; process?: string; ranBy?: string; user?: string }> {
  try {
    const pids = input.conn ? await clientPidsOf(input.conn) : null
    const pid = pids && pids.length === 1 && pids[0] !== process.pid ? pids[0] : undefined
    const table = pid ? await processTable() : null
    const proc = pid && table ? parentName(table, pid) : undefined
    // What really ran it, read from the process table, never from what the caller says.
    const ran = pid && table ? await parentCommand(table, pid) : undefined
    const user = process.env.USER || process.env.LOGNAME || undefined
    const seen = { ...(proc ? { process: proc } : {}), ...(ran ? { ranBy: ran } : {}) }
    if (!input.sessionId) return { identity: 'none', ...seen, ...(user ? { user } : {}) }
    if (pids && pids.length > 1) return { identity: 'unverified', check: 'outside' }
    if (!pid || !table) return { identity: 'unverified', check: 'unchecked' }
    const never = new Set([...selfAndAbove(table, process.pid), ...(input.notSession ?? [])])
    const own = input.sessionPids.filter((p) => !never.has(p) && table.has(p))
    if (!own.length) return { identity: 'unverified', check: 'unchecked', ...seen }
    return descendsFrom(table, pid, own)
      ? { identity: 'verified', ...seen }
      : { identity: 'unverified', check: 'outside', ...seen }
  } catch {
    return input.sessionId ? { identity: 'unverified', check: 'unchecked' } : { identity: 'none' }
  }
}
