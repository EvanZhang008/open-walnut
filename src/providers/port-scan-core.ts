/**
 * Host-local discovery of the servers a session started, and a safe Stop for one.
 *
 * A session's agent starts dev servers (vite, `python -m http.server`, an ephemeral
 * Walnut) and forgets them: ports collide, orphans pile up, and nobody knows which
 * session a listening port belongs to. This module answers "what is listening on this
 * host, and whose is it" in one pass, and stops one server without touching the agent
 * or the terminal that started it.
 *
 *   listeners   `ss -ltnpH` (Linux), `lsof -iTCP -sTCP:LISTEN` (macOS, or Linux without
 *               ss), else /proc/net/tcp{,6} plus a bounded /proc/<pid>/fd walk.
 *   attribution every process a Walnut session's agent spawns inherits WALNUT_SESSION_ID,
 *               and every job in its terminal WALNUT_TERMINAL_SESSION_ID, so a listener's
 *               own environment names its session (also after the agent died and the
 *               server was re-parented to init). A process whose environment was
 *               cleared is attributed by ancestry instead: the nearest ancestor that is
 *               a session's agent.
 *   guard       the daemon, every session's agent CLI, each of their ancestors, the
 *               daemon's direct children, a terminal's dtach master and its shell, and
 *               any pid the caller names (the Walnut server) are never listed and never
 *               signalled, and neither is a process group holding one of them.
 *   stop        re-scan, confirm the (pid, port) is still this session's, then SIGTERM
 *               the listener's process group (a shell job, so `npm run dev` goes with its
 *               node child), SIGKILL after a grace period if it is still there. When the
 *               group is shared with something else, only the listener itself is
 *               signalled.
 *
 * Runs in the daemon of the host that owns the processes (bundled into the binary and
 * shipped as the `port-scan-core.cjs` sidecar for source-deployed daemons), so it uses
 * node builtins only and every external effect goes through `PortScanIo`.
 */

import fsp from 'node:fs/promises'
import net from 'node:net'
import tls from 'node:tls'
import { execFile } from 'node:child_process'

/** The environment variable every process a session's agent starts carries. */
export const SESSION_ENV = 'WALNUT_SESSION_ID'
/** The environment variable a session's terminal shell (and so each job in it) carries. */
export const TERMINAL_ENV = 'WALNUT_TERMINAL_SESSION_ID'

/** Most servers one scan reports for a host (a runaway test spawning hundreds stays bounded). */
export const MAX_SERVERS = 200
/** Most /proc/<pid>/fd entries the fallback reads in one scan. */
const PROC_FD_BUDGET = 20_000
const CMD_TIMEOUT_MS = 5_000
const PROBE_TIMEOUT_MS = 1_200
const PROBE_CACHE_MS = 5 * 60_000
const PROBE_RETRY_MS = 15_000
const STOP_GRACE_MS = 3_000
const STOP_POLL_MS = 150
/** A command longer than this is cut (with an ellipsis): a pasted cut one would not run anyway. */
const COMMAND_MAX = 4000

export interface Listener {
  port: number
  /** Bound address as the kernel reports it: `127.0.0.1`, `::1`, `0.0.0.0`, `::`, `*`, or a specific IP. */
  address: string
  pid: number
}

export interface ProcRow {
  pid: number
  ppid: number
  pgid: number
  /** Seconds since the process started, when ps reported it. */
  ageSec: number | null
  /** Short executable name. */
  comm: string
}

export type Via = 'env' | 'terminal' | 'tree'
export type ServerKind = 'http' | 'https' | 'other' | 'unknown'
export interface ProbeResult { kind: ServerKind; title?: string }

export interface DiscoveredServer {
  /** The session it belongs to, after the caller's alias resolution. */
  sid: string
  port: number
  /** Every address it listens on (an IPv4 and an IPv6 socket are one server). */
  addresses: string[]
  /** True when every address is loopback (reachable only on its host). */
  loopbackOnly: boolean
  pid: number
  pgid: number
  /** Short process name (`node`, `python3`). */
  name: string
  /** Command line, truncated. */
  command: string
  ageSec: number | null
  /** `env`: its environment names the session's agent. `terminal`: it runs in the session's
   *  terminal. `tree`: an ancestor is the session's agent. */
  via: Via
  /** What answered a probe on the port. */
  kind: ServerKind
  /** The `<title>` of the page `/` serves, when it is a web page that has one. */
  title?: string
  /** `group`: Stop signals its process group. `process`: only the listener (the group holds other things).
   *  `none`: it shares a process group with the agent, so Walnut will not signal it. */
  stopScope: 'group' | 'process' | 'none'
}

export interface ScanContext {
  /** Map a WALNUT_SESSION_ID value to the session id the caller tracks (aliases, runtime ids), or null for none. */
  resolveSid: (envSid: string) => string | null
  /** Agent CLI pid of each live session on this host, keyed by pid. */
  agentPids: Map<number, string>
  /** Pids that must never be listed or signalled (with their ancestors): the Walnut server, the daemon. */
  guardPids: number[]
  /** The daemon's own pid: it, its ancestors and its direct children (the agent CLIs and workers it spawned) are guarded. */
  daemonPid: number
}

export interface ScanResult {
  servers: DiscoveredServer[]
  /** Which listener source answered. */
  source: 'ss' | 'lsof' | 'proc' | 'none'
  truncated: boolean
  ms: number
}

export interface PortScanIo {
  platform: string
  /** Bounded execFile: stdout, or null when the command is missing, failed or timed out. */
  run: (cmd: string, args: string[], timeoutMs: number) => Promise<string | null>
  readFile: (path: string) => Promise<string | null>
  readdir: (path: string) => Promise<string[] | null>
  readlink: (path: string) => Promise<string | null>
  /** What answers on the port; a web page's answer may carry its `<title>`. */
  probe: (address: string, port: number, timeoutMs: number) => Promise<ServerKind | ProbeResult>
  kill: (pid: number, signal: NodeJS.Signals) => void
  now: () => number
  sleep: (ms: number) => Promise<void>
}

// ── Parsers (pure) ─────────────────────────────────────────────────────────

/** Split `host:port` the way ss and lsof print it (`[::1]:80`, `*:80`, `127.0.0.1%lo:53`). */
export function splitHostPort(raw: string): { address: string; port: number } | null {
  const s = raw.trim()
  const colon = s.lastIndexOf(':')
  if (colon <= 0) return null
  let address = s.slice(0, colon)
  const port = Number(s.slice(colon + 1))
  if (!Number.isInteger(port) || port <= 0 || port > 65535) return null
  if (address.startsWith('[') && address.endsWith(']')) address = address.slice(1, -1)
  const pct = address.indexOf('%')
  if (pct > 0) address = address.slice(0, pct)
  if (address.startsWith('::ffff:') && address.includes('.')) address = address.slice(7)
  return { address, port }
}

/** `ss -ltnpH`: one line per listening socket, its owners in `users:(("name",pid=1,fd=3),...)`. */
export function parseSsListeners(out: string): Listener[] {
  const res: Listener[] = []
  for (const line of out.split('\n')) {
    const cols = line.trim().split(/\s+/)
    if (cols.length < 5 || cols[0] !== 'LISTEN') continue
    const hp = splitHostPort(cols[3]!)
    if (!hp) continue
    const rest = cols.slice(5).join(' ')
    // Each owner is `("name",pid=N,fd=M)`; a name is quoted, so a `pid=` inside one is not an owner.
    for (const m of rest.matchAll(/\("(?:[^"\\]|\\.)*",pid=(\d+),/g)) {
      const pid = Number(m[1])
      if (pid > 1) res.push({ ...hp, pid })
    }
  }
  return res
}

/** `lsof -nP -iTCP -sTCP:LISTEN -F pn`: `p<pid>` starts a process, `n<addr:port>` is one of its sockets. */
export function parseLsofListeners(out: string): Listener[] {
  const res: Listener[] = []
  let pid = 0
  for (const line of out.split('\n')) {
    if (line.startsWith('p')) pid = Number(line.slice(1)) || 0
    else if (line.startsWith('n') && pid > 1) {
      const hp = splitHostPort(line.slice(1).split('->')[0]!)
      if (hp) res.push({ ...hp, pid })
    }
  }
  return res
}

function procAddress(hex: string): string {
  if (hex.length === 8) {
    const b = Buffer.from(hex, 'hex')
    return `${b[3]}.${b[2]}.${b[1]}.${b[0]}`
  }
  if (hex.length !== 32) return hex
  // Four little-endian 32-bit words.
  const bytes: number[] = []
  for (let w = 0; w < 4; w++) {
    const word = hex.slice(w * 8, w * 8 + 8)
    for (let i = 3; i >= 0; i--) bytes.push(parseInt(word.slice(i * 2, i * 2 + 2), 16))
  }
  if (bytes.slice(0, 10).every((b) => b === 0) && bytes[10] === 0xff && bytes[11] === 0xff) {
    return bytes.slice(12).join('.')
  }
  if (bytes.every((b) => b === 0)) return '::'
  if (bytes.slice(0, 15).every((b) => b === 0) && bytes[15] === 1) return '::1'
  const groups: string[] = []
  for (let i = 0; i < 16; i += 2) groups.push(((bytes[i]! << 8) | bytes[i + 1]!).toString(16))
  return groups.join(':')
}

/** /proc/net/tcp{,6}: listening sockets (state 0A) with their inode. */
export function parseProcNetTcp(out: string): Array<{ address: string; port: number; inode: string }> {
  const res: Array<{ address: string; port: number; inode: string }> = []
  for (const line of out.split('\n').slice(1)) {
    const f = line.trim().split(/\s+/)
    if (f.length < 10 || f[3] !== '0A') continue
    const [addrHex, portHex] = (f[1] ?? '').split(':')
    if (!addrHex || !portHex) continue
    const port = parseInt(portHex, 16)
    if (!(port > 0 && port <= 65535) || !f[9] || f[9] === '0') continue
    res.push({ address: procAddress(addrHex), port, inode: f[9] })
  }
  return res
}

/** `[[dd-]hh:]mm:ss` (ps etime) to seconds. */
export function parseEtime(s: string): number | null {
  const m = /^(?:(\d+)-)?(?:(\d+):)?(\d+):(\d+)$/.exec(s.trim())
  if (!m) return null
  return Number(m[1] ?? 0) * 86400 + Number(m[2] ?? 0) * 3600 + Number(m[3]) * 60 + Number(m[4])
}

/** `ps -A -o pid= -o ppid= -o pgid= -o etime= -o comm=`. */
export function parseProcTable(out: string): Map<number, ProcRow> {
  const rows = new Map<number, ProcRow>()
  for (const line of out.split('\n')) {
    const m = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s+(.*)$/.exec(line)
    if (!m) continue
    const pid = Number(m[1])
    const comm = m[5]!.trim()
    rows.set(pid, {
      pid, ppid: Number(m[2]), pgid: Number(m[3]), ageSec: parseEtime(m[4]!),
      // macOS prints the full executable path for comm.
      comm: comm.slice(comm.lastIndexOf('/') + 1),
    })
  }
  return rows
}

/** Which session a process's environment names: the agent's variable first, then the terminal's. */
export interface EnvSession { sid: string; terminal: boolean }

/** The session a NUL-separated /proc/<pid>/environ names. */
export function sessionFromEnviron(raw: string): EnvSession | null {
  let agent: string | null = null
  let terminal: string | null = null
  for (const entry of raw.split('\0')) {
    if (entry.startsWith(`${SESSION_ENV}=`)) agent = entry.slice(SESSION_ENV.length + 1).trim() || null
    else if (entry.startsWith(`${TERMINAL_ENV}=`)) terminal = entry.slice(TERMINAL_ENV.length + 1).trim() || null
  }
  return agent ? { sid: agent, terminal: false } : terminal ? { sid: terminal, terminal: true } : null
}

/**
 * macOS `ps -E -ww -o pid= -o command=`: the launch environment follows the argv, space
 * separated. The LAST assignment wins, as it would in the environment a later `export`
 * built; an argument that spells the assignment out is a risk ps -E cannot rule out.
 */
export function parsePsEnvSessions(out: string): Map<number, EnvSession> {
  const res = new Map<number, EnvSession>()
  const last = (text: string, name: string): string | null => {
    let hit: string | null = null
    for (const m of text.matchAll(new RegExp(`(?:^|\\s)${name}=(\\S+)`, 'g'))) hit = m[1]!
    return hit
  }
  for (const line of out.split('\n')) {
    const m = /^\s*(\d+)\s(.*)$/.exec(line)
    if (!m) continue
    const agent = last(m[2]!, SESSION_ENV)
    const terminal = agent ? null : last(m[2]!, TERMINAL_ENV)
    if (agent) res.set(Number(m[1]), { sid: agent, terminal: false })
    else if (terminal) res.set(Number(m[1]), { sid: terminal, terminal: true })
  }
  return res
}

export function isLoopbackAddress(a: string): boolean {
  return a === '::1' || a.startsWith('127.') || a === 'localhost'
}

export function isWildcardAddress(a: string): boolean {
  return a === '*' || a === '0.0.0.0' || a === '::'
}

// ── Guard ──────────────────────────────────────────────────────────────────

/** `pids` and every ancestor of each (stopping at init). */
export function withAncestors(table: Map<number, ProcRow>, pids: Iterable<number>): Set<number> {
  const out = new Set<number>()
  for (const start of pids) {
    let pid: number | undefined = start
    for (let hops = 0; pid !== undefined && pid > 1 && !out.has(pid) && hops < 256; hops++) {
      out.add(pid)
      pid = table.get(pid)?.ppid
    }
  }
  return out
}

/**
 * What Stop may signal for `pid`: its whole process group when every member belongs to
 * `sid` and none is guarded; the listener alone when the group also holds other
 * sessions' or unattributed processes; nothing (null) when the listener is guarded or
 * shares a process group with a guarded process (an agent that runs its tools without
 * a group of their own: signalling there could reach the agent).
 */
export function stopTarget(
  table: Map<number, ProcRow>,
  pid: number,
  guarded: Set<number>,
  sidOf: (pid: number) => string | null,
  sid: string,
  shielded: ReadonlySet<number> = new Set(),
): { scope: 'group'; pgid: number } | { scope: 'process'; pid: number } | null {
  if (pid <= 1 || guarded.has(pid) || shielded.has(pid)) return null
  const row = table.get(pid)
  if (!row) return null
  const pgid = row.pgid
  if (pgid <= 1 || guarded.has(pgid)) return null
  const members = [...table.values()].filter((r) => r.pgid === pgid)
  if (members.some((r) => guarded.has(r.pid))) return null
  // A group that holds an agent's own child (an adapter's inner CLI, its tool shell or MCP
  // server, all with the session's variable) is the agent's: only the listener is signalled.
  if (members.some((r) => shielded.has(r.pid))) return { scope: 'process', pid }
  return members.every((r) => sidOf(r.pid) === sid) ? { scope: 'group', pgid } : { scope: 'process', pid }
}

/** A shell by its name (a login shell's comm starts with "-"; macOS ps prints a path). */
const SHELL_COMM = /^-?(?:sh|bash|zsh|dash|ksh|mksh|tcsh|csh|fish|pwsh|nu)$/

/**
 * An agent's direct children that are not a shell: an ACP adapter's inner CLI, a CLI's MCP
 * servers. They are the agent at work, never a server: not listed, never signalled, and a
 * process group holding one is stopped by its listener's pid only (stopTarget). A tool's
 * shell is not one of them: the job it runs (`npm run dev` and its children) is the server's
 * group, stopped whole.
 */
export function agentChildren(table: Map<number, ProcRow>, ctx: Pick<ScanContext, 'agentPids'>): Set<number> {
  const out = new Set<number>()
  for (const r of table.values()) {
    if (ctx.agentPids.has(r.ppid) && !SHELL_COMM.test(r.comm.split('/').pop() ?? '')) out.add(r.pid)
  }
  return out
}

/** A terminal's dtach: the bundled `walnut-dtach` or a system `dtach`, by name or path (macOS ps prints the path). */
export function isDtach(comm: string): boolean {
  return /^(?:walnut-)?dtach$/.test(comm.split('/').pop() ?? '')
}

/** The pids never listed or signalled: the guard pids, the agents, each one's ancestors, and the daemon's direct children (session spawns). */
export function guardedPids(table: Map<number, ProcRow>, ctx: ScanContext): Set<number> {
  const guarded = withAncestors(table, [...ctx.guardPids, ...ctx.agentPids.keys(), ...(ctx.daemonPid > 1 ? [ctx.daemonPid] : [])])
  // The daemon's direct children are the session spawns; a terminal's dtach master and
  // its direct child are the terminal and its shell. Jobs below them stay stoppable.
  const parents = new Set<number>()
  if (ctx.daemonPid > 1) { guarded.add(ctx.daemonPid); parents.add(ctx.daemonPid) }
  for (const r of table.values()) if (isDtach(r.comm)) { guarded.add(r.pid); parents.add(r.pid) }
  for (const r of table.values()) if (parents.has(r.ppid)) guarded.add(r.pid)
  return guarded
}

// ── Scan ───────────────────────────────────────────────────────────────────

async function readListeners(io: PortScanIo): Promise<{ listeners: Listener[]; source: ScanResult['source'] }> {
  if (io.platform === 'linux') {
    const ss = await io.run('ss', ['-ltnpH'], CMD_TIMEOUT_MS)
    if (ss !== null) return { listeners: parseSsListeners(ss), source: 'ss' }
  }
  const lsof = await io.run('lsof', ['-nP', '-iTCP', '-sTCP:LISTEN', '-F', 'pn'], CMD_TIMEOUT_MS)
  // lsof exits 1 when nothing listens, which the runner reports as "".
  if (lsof !== null) return { listeners: parseLsofListeners(lsof), source: 'lsof' }
  if (io.platform === 'linux') return { listeners: await readProcListeners(io), source: 'proc' }
  return { listeners: [], source: 'none' }
}

/** /proc fallback: listening inodes, then which of our processes hold them. */
async function readProcListeners(io: PortScanIo): Promise<Listener[]> {
  const socks = [
    ...parseProcNetTcp((await io.readFile('/proc/net/tcp')) ?? ''),
    ...parseProcNetTcp((await io.readFile('/proc/net/tcp6')) ?? ''),
  ]
  if (socks.length === 0) return []
  const byInode = new Map(socks.map((s) => [s.inode, s]))
  const res: Listener[] = []
  let budget = PROC_FD_BUDGET
  for (const name of (await io.readdir('/proc')) ?? []) {
    if (!/^\d+$/.test(name) || budget <= 0) continue
    const fds = await io.readdir(`/proc/${name}/fd`)
    if (!fds) continue
    for (const fd of fds.slice(0, budget)) {
      budget--
      const link = await io.readlink(`/proc/${name}/fd/${fd}`)
      const inode = link && /^socket:\[(\d+)\]$/.exec(link)?.[1]
      const sock = inode ? byInode.get(inode) : undefined
      if (sock) res.push({ address: sock.address, port: sock.port, pid: Number(name) })
    }
  }
  return res
}

/**
 * One `-o` per column: procps (Linux) reads everything after a column's first `=` as
 * that column's header, so two columns joined by a comma in one `-o` print as one.
 */
const PS_TABLE_COLUMNS = ['-o', 'pid=', '-o', 'ppid=', '-o', 'pgid=', '-o', 'etime=', '-o', 'comm=']

async function readProcTable(io: PortScanIo): Promise<Map<number, ProcRow>> {
  const out = await io.run('ps', ['-A', ...PS_TABLE_COLUMNS], CMD_TIMEOUT_MS)
  return out ? parseProcTable(out) : new Map()
}

/** The session each pid's environment names (raw, before alias resolution). */
async function readSessionEnv(io: PortScanIo, pids: number[]): Promise<Map<number, EnvSession>> {
  const res = new Map<number, EnvSession>()
  if (pids.length === 0) return res
  if (io.platform === 'linux') {
    await Promise.all(pids.map(async (pid) => {
      const raw = await io.readFile(`/proc/${pid}/environ`)
      const sid = raw ? sessionFromEnviron(raw) : null
      if (sid) res.set(pid, sid)
    }))
    return res
  }
  const out = await io.run('ps', ['-E', '-ww', '-o', 'pid=', '-o', 'command=', '-p', pids.join(',')], CMD_TIMEOUT_MS)
  return out ? parsePsEnvSessions(out) : res
}

/** One argument as a POSIX shell reads it: bare when it is plain, else in single quotes. */
export function shellQuote(arg: string): string {
  if (arg !== '' && /^[A-Za-z0-9_\/.,:=@%+-]+$/.test(arg)) return arg
  return `'${arg.replace(/'/g, `'\\''`)}'`
}

/** `/proc/<pid>/cmdline` (NUL-separated argv) as a command a shell runs as it ran. */
export function commandFromCmdline(raw: string): string {
  const argv = raw.split('\0')
  if (argv.length > 1 && argv[argv.length - 1] === '') argv.pop()
  return argv.map(shellQuote).join(' ')
}

async function readCommands(io: PortScanIo, pids: number[]): Promise<Map<number, string>> {
  const res = new Map<number, string>()
  if (pids.length === 0) return res
  if (io.platform === 'linux') {
    await Promise.all(pids.map(async (pid) => {
      const raw = await io.readFile(`/proc/${pid}/cmdline`)
      if (raw) res.set(pid, commandFromCmdline(raw))
    }))
    return res
  }
  const out = await io.run('ps', ['-ww', '-o', 'pid=', '-o', 'command=', '-p', pids.join(',')], CMD_TIMEOUT_MS)
  for (const line of (out ?? '').split('\n')) {
    const m = /^\s*(\d+)\s(.*)$/.exec(line)
    if (m) res.set(Number(m[1]), m[2]!.trim())
  }
  return res
}

/** Session of each pid: its own environment first, else the nearest ancestor that is a session's agent. */
function attribute(
  table: Map<number, ProcRow>,
  env: Map<number, EnvSession>,
  ctx: ScanContext,
): (pid: number) => { sid: string; via: Via } | null {
  return (pid) => {
    const named = env.get(pid)
    if (named) {
      const sid = ctx.resolveSid(named.sid)
      if (sid) return { sid, via: named.terminal ? 'terminal' : 'env' }
    }
    let cur = table.get(pid)?.ppid
    for (let hops = 0; cur !== undefined && cur > 1 && hops < 64; hops++) {
      const sid = ctx.agentPids.get(cur)
      if (sid) return { sid, via: 'tree' }
      cur = table.get(cur)?.ppid
    }
    return null
  }
}

export interface PortScanner {
  scan: (ctx: ScanContext, opts?: { sids?: string[] }) => Promise<ScanResult>
  stop: (ctx: ScanContext, req: { sids: string[]; pid: number; port: number }) => Promise<StopResult>
}

export type StopResult =
  /** `confirmed: false`: the process table could not be read after the signal, so its exit was not seen. */
  | { stopped: true; scope: 'group' | 'process'; signal: 'SIGTERM' | 'SIGKILL' | 'none'; confirmed: boolean }
  | { stopped: false; code: 'not_found' | 'not_stoppable' | 'signal_failed'; reason: string }

/** Where an orphan lands: init, or a subreaper (a user systemd, a container init). Never an agent. */
const REAPERS = new Set(['systemd', 'launchd', 'init', 'tini', 'docker-init', 'dumb-init', 's6-svscan', 'runsvdir'])
const isReaper = (row: ProcRow | undefined): boolean => !row || row.pid <= 1 || REAPERS.has(row.comm)

const sameSession = (a: EnvSession | undefined, b: EnvSession | undefined): boolean =>
  !!a && !!b && a.sid === b.sid && a.terminal === b.terminal

/**
 * Where a session's variable was injected: a process whose environment names a session
 * while its live parent's (not init, not a subreaper) does not name the same one. That is
 * an agent CLI or a worker some daemon spawned (this one's or another Walnut's on the same
 * host), or a terminal's shell: never a server. Everything below it inherits the same
 * value from it, and an orphan's parent is init.
 */
export function injectionRoots(table: Map<number, ProcRow>, env: Map<number, EnvSession>, pids: Iterable<number>): number[] {
  const roots: number[] = []
  for (const pid of pids) {
    const own = env.get(pid)
    if (!own) continue
    const parent = table.get(table.get(pid)?.ppid ?? 0)
    if (isReaper(parent)) continue
    if (!sameSession(own, env.get(parent!.pid))) roots.push(pid)
  }
  return roots
}

/** Ports the OS hands out on bind(0) (Linux from 32768, macOS from 49152). */
const EPHEMERAL_MIN = 32_768
/** A listener on such a port is not probed while younger than this. */
const ONE_SHOT_SEC = 120

/** A command that is a sign-in (`gcloud auth login`, `az login`, an `oauth` helper). */
const LOGIN_COMMAND = /(?:^|[\s/-])(?:auth|login|oauth2?|sso)(?:$|[\s:-])/i

/**
 * A young listener on an OS-assigned port, or one a sign-in command holds on a fixed port
 * (`gcloud auth login` on 8085), may be a login's loopback callback that serves one request
 * (an OAuth `run_local_server`): the probe's GET would use it up. Dev servers mostly pick
 * their own port, and a young one is asked once it is older.
 */
export function mayBeOneShot(port: number, ageSec: number | null, command = ''): boolean {
  const young = ageSec === null || ageSec < ONE_SHOT_SEC
  return young && (port >= EPHEMERAL_MIN || LOGIN_COMMAND.test(command))
}

export function createPortScanner(io: PortScanIo = defaultPortScanIo()): PortScanner {
  // A probe's answer per (pid, port), so a poll every few seconds does not reconnect to every server.
  const probes = new Map<string, ProbeResult & { at: number }>()

  async function kindOf(addresses: string[], port: number, pid: number): Promise<ProbeResult> {
    const key = `${pid}:${port}`
    const hit = probes.get(key)
    // A port that did not answer is asked again sooner: it may have been still starting.
    if (hit && io.now() - hit.at < (hit.kind === 'unknown' ? PROBE_RETRY_MS : PROBE_CACHE_MS)) return hit
    const target = addresses.some((a) => isWildcardAddress(a) || a.startsWith('127.')) ? '127.0.0.1'
      : addresses.includes('::1') ? '::1' : addresses[0]!
    const raw = await io.probe(target, port, PROBE_TIMEOUT_MS)
    const res: ProbeResult = typeof raw === 'string' ? { kind: raw } : raw
    probes.set(key, { ...res, at: io.now() })
    return res
  }

  async function snapshot(ctx: ScanContext) {
    const [{ listeners, source }, table] = await Promise.all([readListeners(io), readProcTable(io)])
    const guarded = guardedPids(table, ctx)
    const shielded = agentChildren(table, ctx)
    const env = new Map<number, EnvSession>()
    const read = new Set<number>()
    /** Read the environments of `pids` and their parents, and guard the injection roots among them. */
    const learn = async (pids: number[]) => {
      const parents = pids.map((p) => table.get(p)?.ppid ?? 0).filter((pp) => pp > 1 && !isReaper(table.get(pp)))
      const unread = [...new Set([...pids, ...parents])].filter((p) => !read.has(p))
      for (const p of unread) read.add(p)
      for (const [p, e] of await readSessionEnv(io, unread)) env.set(p, e)
      for (const root of injectionRoots(table, env, pids)) guarded.add(root)
    }
    await learn([...new Set(listeners.map((l) => l.pid))].filter((p) => !guarded.has(p) && !shielded.has(p)))
    /** Learn every member of the process groups of `pids` (Stop's scope depends on all of them). */
    const learnGroups = (pids: number[]) => {
      const groups = new Set(pids.map((p) => table.get(p)?.pgid ?? 0).filter((g) => g > 1))
      return learn([...table.values()].filter((r) => groups.has(r.pgid)).map((r) => r.pid))
    }
    return { listeners, source, table, guarded, shielded, env, learnGroups, owner: attribute(table, env, ctx) }
  }

  async function scan(ctx: ScanContext, opts: { sids?: string[] } = {}): Promise<ScanResult> {
    const t0 = io.now()
    const snap = await snapshot(ctx)
    // One server per port: its IPv4 and IPv6 sockets, and every worker a pre-fork server
    // (gunicorn, node cluster, uvicorn --reload) shares the socket with, merge into it.
    const byPort = new Map<number, { pids: Set<number>; port: number; addresses: string[]; sid: string; via: Via }>()
    for (const l of snap.listeners) {
      if (snap.guarded.has(l.pid) || snap.shielded.has(l.pid)) continue
      const who = snap.owner(l.pid)
      if (!who || (opts.sids && !opts.sids.includes(who.sid))) continue
      const cur = byPort.get(l.port)
      if (cur) { cur.pids.add(l.pid); if (!cur.addresses.includes(l.address)) cur.addresses.push(l.address) }
      else byPort.set(l.port, { pids: new Set([l.pid]), port: l.port, addresses: [l.address], ...who })
    }
    // The server is the topmost of the pids holding it: the one no other holder is an ancestor of.
    const found = [...byPort.values()].map((s) => {
      const holders = [...s.pids].sort((a, b) => a - b)
      const top = holders.find((p) => {
        for (let cur = snap.table.get(p)?.ppid, hops = 0; cur !== undefined && cur > 1 && hops < 64; cur = snap.table.get(cur)?.ppid, hops++) {
          if (s.pids.has(cur)) return false
        }
        return true
      }) ?? holders[0]!
      return { pid: top, port: s.port, addresses: s.addresses, sid: s.sid, via: s.via }
    }).sort((a, b) => a.port - b.port)
    const truncated = found.length > MAX_SERVERS
    const picked = found.slice(0, MAX_SERVERS)
    const pids = [...new Set(picked.map((s) => s.pid))]
    const [commands] = await Promise.all([readCommands(io, pids), snap.learnGroups(pids)])
    const sidOf = (p: number) => snap.owner(p)?.sid ?? null
    const servers = await mapBounded(picked, 8, async (s): Promise<DiscoveredServer> => {
      const row = snap.table.get(s.pid)
      const target = stopTarget(snap.table, s.pid, snap.guarded, sidOf, s.sid, snap.shielded)
      // As the shell would run it (a copy pastes and runs): an inline script (`python3 -c
      // '...'`) keeps its newlines inside its quotes; the page draws it on one line.
      const full = (commands.get(s.pid) ?? row?.comm ?? '').trim()
      const command = full.length > COMMAND_MAX ? `${full.slice(0, COMMAND_MAX)}…` : full
      // A listener inside an agent's own group is not probed: it may be one that takes a
      // single connection (a login's loopback callback), and the probe would use it up.
      const probed = target && !mayBeOneShot(s.port, row?.ageSec ?? null, full) ? await kindOf(s.addresses, s.port, s.pid) : null
      return {
        sid: s.sid,
        port: s.port,
        addresses: s.addresses,
        loopbackOnly: s.addresses.every(isLoopbackAddress),
        pid: s.pid,
        pgid: row?.pgid ?? 0,
        name: row?.comm ?? (command.split(/\s+/)[0] ?? '').split('/').pop() ?? '',
        command,
        ageSec: row?.ageSec ?? null,
        via: s.via,
        ...(probed ? { kind: probed.kind, ...(probed.title ? { title: probed.title } : {}) } : { kind: 'unknown' as const }),
        stopScope: target?.scope ?? 'none',
      }
    })
    // Every listener on the host, not only the asked sessions': two panels polling two
    // sessions must not evict each other's answers.
    const live = new Set(snap.listeners.map((l) => `${l.pid}:${l.port}`))
    for (const key of probes.keys()) if (!live.has(key)) probes.delete(key)
    return { servers, source: snap.source, truncated, ms: io.now() - t0 }
  }

  async function stop(ctx: ScanContext, req: { sids: string[]; pid: number; port: number }): Promise<StopResult> {
    if (!Number.isSafeInteger(req.pid) || req.pid <= 1 || !Number.isInteger(req.port)) {
      return { stopped: false, code: 'not_found', reason: 'no such server' }
    }
    // The pid comes from a client: signal only what a scan made NOW attributes to this session.
    const snap = await snapshot(ctx)
    const listed = snap.listeners.some((l) => l.pid === req.pid && l.port === req.port)
    const who = listed && !snap.guarded.has(req.pid) && !snap.shielded.has(req.pid) ? snap.owner(req.pid) : null
    if (!who || !req.sids.includes(who.sid)) {
      return { stopped: false, code: 'not_found', reason: `nothing of this session listens on port ${req.port} any more` }
    }
    await snap.learnGroups([req.pid])
    const target = stopTarget(snap.table, req.pid, snap.guarded, (p) => snap.owner(p)?.sid ?? null, who.sid, snap.shielded)
    if (!target) return { stopped: false, code: 'not_stoppable', reason: 'it shares a process group with the agent, so stopping it could stop the session' }

    const signal = (sig: NodeJS.Signals): boolean => {
      try {
        if (target.scope === 'group') signalGroup(io, target.pgid, sig)
        else io.kill(target.pid, sig)
        return true
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'ESRCH') return false
        throw err
      }
    }
    try {
      if (!signal('SIGTERM')) return { stopped: true, scope: target.scope, signal: 'none', confirmed: true }
    } catch (err) {
      return { stopped: false, code: 'signal_failed', reason: (err as Error).message }
    }
    // An original process is the same one while it is in the same group and not younger
    // than it was (a recycled pid starts its clock again). While one is, the group was not
    // reused, so a SIGKILL after the grace period reaches only the job that ignored SIGTERM.
    const originals = (target.scope === 'group'
      ? [...snap.table.values()].filter((r) => r.pgid === target.pgid)
      : [snap.table.get(target.pid)!])
    const stillThere = (now: Map<number, ProcRow>) => originals.some((o) => {
      const row = now.get(o.pid)
      return !!row && row.pgid === o.pgid && (row.ageSec === null || o.ageSec === null || row.ageSec + 2 >= o.ageSec)
    })
    const deadline = io.now() + STOP_GRACE_MS
    let seen: Map<number, ProcRow> | null = null
    while (io.now() < deadline) {
      await io.sleep(STOP_POLL_MS)
      const now = await readProcTable(io)
      // An empty table is ps failing, not every process gone: keep waiting.
      if (now.size === 0) continue
      seen = now
      if (!stillThere(now)) return { stopped: true, scope: target.scope, signal: 'SIGTERM', confirmed: true }
    }
    // Without a process table there is no proof the group is still the job's: no SIGKILL.
    if (!seen) return { stopped: true, scope: target.scope, signal: 'SIGTERM', confirmed: false }
    try { signal('SIGKILL') } catch (err) {
      return { stopped: false, code: 'signal_failed', reason: (err as Error).message }
    }
    return { stopped: true, scope: target.scope, signal: 'SIGKILL', confirmed: true }
  }

  return { scan, stop }
}

/** Signals the process group `pgid`. Refuses 0 and 1: group 0 is the caller's own, and -1 reaches every process the user owns. */
export function signalGroup(io: { kill: (pid: number, sig: NodeJS.Signals) => void }, pgid: number, sig: NodeJS.Signals): void {
  if (!Number.isSafeInteger(pgid) || pgid <= 1) throw Object.assign(new Error(`refusing to signal process group ${pgid}`), { code: 'EINVAL' })
  io.kill(-pgid, sig)
}

async function mapBounded<T, R>(items: T[], limit: number, fn: (t: T) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length)
  let next = 0
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next++
      out[i] = await fn(items[i]!)
    }
  }))
  return out
}

/** Connect, send a minimal HTTP request, and read what comes back first. */
/** The bytes of a page a probe reads at most, looking for its `<title>`. */
const PROBE_READ_MAX = 32 * 1024
const TITLE_MAX = 80

/** A page's `<title>`, decoded and on one line; undefined when it has none. */
export function pageTitle(html: string): string | undefined {
  const m = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)
  if (!m) return undefined
  const text = m[1]!
    .replace(/&(amp|lt|gt|quot|#39|apos|nbsp);/g, (_, e: string) => ({ amp: '&', lt: '<', gt: '>', quot: '"', '#39': "'", apos: "'", nbsp: ' ' })[e]!)
    .replace(/&#(\d+);/g, (_, n: string) => { const c = Number(n); return c > 0 && c < 0x110000 ? String.fromCodePoint(c) : '' })
    .replace(/\s+/g, ' ')
    .trim()
  return text ? text.slice(0, TITLE_MAX) : undefined
}

/** One plaintext GET of `/`: what answered, the page's title, and whether the server closed without a word. */
function probeOnce(connect: () => net.Socket, port: number, timeoutMs: number, secure: boolean): Promise<ProbeResult & { silent?: boolean }> {
  return new Promise((resolve) => {
    let done = false
    let kind: ServerKind | null = null
    let body = ''
    const finish = (k: ServerKind, silent = false) => {
      if (done) return
      done = true
      clearTimeout(deadline)
      sock.destroy()
      const title = k === 'http' || k === 'https' ? pageTitle(body) : undefined
      resolve({ kind: k, ...(title ? { title } : {}), ...(silent ? { silent } : {}) })
    }
    const web: ServerKind = secure ? 'https' : 'http'
    // A hard deadline: a page that streams forever (an event stream) cannot hold the scan.
    const deadline = setTimeout(() => finish(kind ?? 'unknown'), timeoutMs)
    const sock = connect()
    sock.once(secure ? 'secureConnect' : 'connect', () => sock.write(`GET / HTTP/1.0\r\nHost: localhost:${port}\r\nUser-Agent: walnut-port-scan\r\nAccept: text/html\r\n\r\n`))
    sock.on('data', (buf: Buffer) => {
      if (kind === null) {
        const head = buf.subarray(0, 5).toString('latin1')
        if (head === 'HTTP/') {
          // A TLS server that answers plaintext with a 400 page ("HTTP request to an HTTPS server").
          if (!secure && /^HTTP\/1\.[01] 400[^\r\n]*\r?\n[\s\S]*https/i.test(buf.toString('latin1'))) return finish('https')
          kind = web
        } else if (!secure && buf[0] === 0x15 && buf[1] === 0x03) return finish('https')
        else return finish('other')
      }
      body += buf.toString('utf8')
      if (/<\/title>/i.test(body) || body.length >= PROBE_READ_MAX) finish(web)
    })
    sock.once('error', () => finish(kind ?? 'other', kind === null))
    sock.once('end', () => finish(kind ?? 'other', kind === null))
  })
}

/**
 * What answers on a port: an HTTP response (`http`, with the page's `<title>` when the
 * first 32KB of `/` hold one), a TLS server (`https`: a TLS alert or a 400 to plaintext,
 * or a TLS handshake once plaintext was dropped without a word), anything else
 * (`other`), or nothing within the timeout (`unknown`). Each attempt has a hard deadline.
 */
export async function probePort(address: string, port: number, timeoutMs: number): Promise<ProbeResult> {
  const plain = await probeOnce(() => net.connect({ host: address, port }), port, timeoutMs, false)
  if (!plain.silent) return { kind: plain.kind, ...(plain.title ? { title: plain.title } : {}) }
  // Closed on a plaintext request without answering: many TLS servers do that.
  const secure = await probeOnce(
    () => tls.connect({ host: address, port, rejectUnauthorized: false, servername: net.isIP(address) ? undefined : address, ALPNProtocols: ['http/1.1'] }),
    port, timeoutMs, true)
  if (secure.kind === 'https') return { kind: 'https', ...(secure.title ? { title: secure.title } : {}) }
  return { kind: 'other' }
}

export function defaultPortScanIo(): PortScanIo {
  return {
    platform: process.platform,
    run: (cmd, args, timeoutMs) => new Promise((resolve) => {
      execFile(cmd, args, { timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024, encoding: 'utf8' }, (err, stdout) => {
        if (!err) return resolve(stdout)
        // lsof and ps exit 1 when there is nothing to report: the output still holds.
        const code = (err as { code?: unknown }).code
        resolve(code === 1 && typeof stdout === 'string' ? stdout : null)
      })
    }),
    readFile: (p) => fsp.readFile(p, 'utf8').catch(() => null),
    readdir: (p) => fsp.readdir(p).catch(() => null),
    readlink: (p) => fsp.readlink(p).catch(() => null),
    probe: probePort,
    kill: (pid, sig) => process.kill(pid, sig),
    now: () => Date.now(),
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
  }
}

// ── Daemon glue (both daemon twins) ────────────────────────────────────────

export interface DaemonPortsDeps {
  /** Agent CLI / worker pid of each live session, keyed by pid. */
  agentPids: () => Map<number, string>
  /** A WALNUT_SESSION_ID value to the id the daemon tracks now (renames); the value itself when unknown. */
  resolveSid: (envSid: string) => string
  daemonPid: number
  io?: PortScanIo
}

/** A poll inside this long after a scan finished gets that scan's answer. */
const LIST_CACHE_MS = 1_500

function pidList(v: unknown): number[] {
  return Array.isArray(v) ? v.filter((p): p is number => Number.isSafeInteger(p) && (p as number) > 1).slice(0, 16) : []
}

function sidList(v: unknown): string[] | undefined {
  return Array.isArray(v) ? v.filter((s): s is string => typeof s === 'string' && s.length > 0).slice(0, 8) : undefined
}

/**
 * `ports.list {sids?, guardPids?}` and `ports.stop {sids, pid, port, guardPids?}` ('ports-v1').
 * `sids`: the session whose servers to list (all of the host's when absent). `guardPids`:
 * pids on this host the caller must never see listed or stopped (the Walnut server
 * asking, when it runs here).
 */
export function createDaemonPorts(deps: DaemonPortsDeps) {
  const scanner = createPortScanner(deps.io)
  // One scan per question at a time: a poll that arrives while it runs, or shortly after,
  // shares it (several panels on one host poll every few seconds).
  const scans = new Map<string, { done: number | null; result: Promise<ScanResult> }>()
  const ctxOf = (guardPids: number[]): ScanContext => ({
    resolveSid: deps.resolveSid,
    agentPids: deps.agentPids(),
    guardPids,
    daemonPid: deps.daemonPid,
  })
  return {
    list(cmd: Record<string, unknown>): Promise<ScanResult> {
      const guardPids = pidList(cmd.guardPids)
      const sids = sidList(cmd.sids)
      const key = `${guardPids.join(',')}|${sids?.join(',') ?? '*'}`
      const hit = scans.get(key)
      if (hit && (hit.done === null || Date.now() - hit.done < LIST_CACHE_MS)) return hit.result
      for (const [k, v] of scans) if (v.done !== null && Date.now() - v.done >= LIST_CACHE_MS) scans.delete(k)
      const entry: { done: number | null; result: Promise<ScanResult> } = { done: null, result: scanner.scan(ctxOf(guardPids), sids ? { sids } : {}) }
      scans.set(key, entry)
      entry.result.then(() => { entry.done = Date.now() }, () => { if (scans.get(key) === entry) scans.delete(key) })
      return entry.result
    },
    async stop(cmd: Record<string, unknown>): Promise<StopResult> {
      const sids = sidList(cmd.sids) ?? []
      if (sids.length === 0) return { stopped: false, code: 'not_found', reason: 'no session named' }
      const res = await scanner.stop(ctxOf(pidList(cmd.guardPids)), { sids, pid: Number(cmd.pid), port: Number(cmd.port) })
      scans.clear()
      return res
    },
  }
}
