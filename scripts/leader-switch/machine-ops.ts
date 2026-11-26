/**
 * Everything the cross-machine rehearsal does ON one machine, as named operations with JSON arguments and a
 * JSON answer: its files, the product's readers of its records, its processes (the switch command, a server
 * started by hand, LocalSide's start and stop, its daemon and its host service). machine-io.ts runs them in the
 * rehearsal's own process for a machine on this computer, and over machine-agent.ts (a process ON the other
 * machine, its stdin and stdout one ssh channel) for a machine elsewhere: one code path for rehearsal (a), every
 * machine on one box, and rehearsal (b), machine B on another computer.
 *
 * Paths are that machine's paths. Nothing here reaches another machine: an operation sees only the computer it
 * runs on, with the environment of the process that runs it (on machine B: the agent's, every place inside B's
 * rehearsal root).
 */
import fs from 'node:fs'
import path from 'node:path'
import { randomBytes, randomFill } from 'node:crypto'
import { execFile, spawn } from 'node:child_process'
import type { MachinePlace } from '../../src/core/leader/switch/settings.js'

/** This repo's root on the machine the operation runs on (its own checkout, or B's staged code). */
const REPO = path.resolve(import.meta.dirname, '../..')

/** A process an operation started and keeps a handle to (a daemon, a host service). */
interface Kept { pid: number; stop: () => Promise<void>; log?: () => string }
const kept = new Map<string, Kept>()
const setupWitnesses = new Map<string, { walnutId: string | null; close(): Promise<void> }>()
let nextHandle = 1

/** A process's start in clock ticks since boot (/proc/<pid>/stat field 22), or null (gone, or no /proc). */
export function startTick(pid: number): number | null {
  try {
    const s = fs.readFileSync(`/proc/${pid}/stat`, 'utf8')
    const t = Number(s.slice(s.lastIndexOf(')') + 2).split(' ')[19])
    return Number.isFinite(t) ? t : null
  } catch { return null }
}

/** Each process started here and its start tick: a pid is signalled only while it is still that process. */
const startedHere = new Map<number, number | null>()

/** Each process started here, as the cleanup reads it: one JSON line per start in $WALNUT_REHEARSAL_PIDS, when set. */
function recordStart(what: string, pid: number | undefined, argv: string[]): void {
  if (!pid) return
  const tick = startTick(pid)
  startedHere.set(pid, tick)
  const file = process.env.WALNUT_REHEARSAL_PIDS
  if (!file) return
  fs.appendFileSync(file, `${JSON.stringify({ pid, tick, what, argv, at: new Date().toISOString() })}\n`, { mode: 0o600 })
}

const alive = (pid: number): boolean => { if (!Number.isInteger(pid) || pid <= 1) return false; try { process.kill(pid, 0); return true } catch { return false } }

/** The agent's root (rehearsal (b)), resolved: a pid it signals runs there. Null in rehearsal (a). */
const agentRoot = (() => { const r = process.env.WALNUT_REHEARSAL_ROOT; if (!r) return null; try { return fs.realpathSync(r) } catch { return path.resolve(r) } })()
const underAgentRoot = (pid: number): boolean => {
  if (!agentRoot) return true
  for (const f of ['cwd', 'exe']) { try { const t = fs.readlinkSync(`/proc/${pid}/${f}`); if (t === agentRoot || t.startsWith(agentRoot + '/')) return true } catch { /* gone or not ours */ } }
  return false
}
/** Still the process that was started here (the same start tick), and on the agent's machine under its root. */
function stillOurs(pid: number): boolean {
  if (!alive(pid)) return false
  const known = startedHere.get(pid)
  if (known !== undefined && known !== null && startTick(pid) !== known) return false
  return underAgentRoot(pid)
}

/**
 * SIGTERM, then SIGKILL after `graceMs`: one pid, never a group, never pid 1 or below or this process, and each
 * signal only while that pid is still the process started here (its start tick; a pid gone and reused is left
 * alone) and, on the other machine, runs under the agent's root.
 */
async function stopOne(pid: number, graceMs: number): Promise<boolean> {
  if (!Number.isInteger(pid) || pid <= 1 || pid === process.pid) throw new Error(`refused to signal pid ${pid}`)
  if (!stillOurs(pid)) return false
  try { process.kill(pid, 'SIGTERM') } catch { return false }
  for (let waited = 0; waited < graceMs && alive(pid); waited += 100) await new Promise((r) => setTimeout(r, 100))
  if (stillOurs(pid)) try { process.kill(pid, 'SIGKILL') } catch { /* gone */ }
  return true
}

/**
 * A log line's time is when it was written, a little after its batch ended: a batch's start is taken this much
 * earlier still, so one that began just before `since` is never counted as begun after it (review round 1).
 */
const LOG_SLACK_MS = 1_000
type CommittedBatch = { start: number; end: number; batch: number; ms: number; sentBytes: number }
/** What has been read of each log file: its bytes so far (a whole line each) and the batches in them. */
const batchLogRead = new Map<string, { bytes: number; batches: CommittedBatch[] }>()

/** A machine's server log files, oldest first (its daemon dir's open-walnut-<day>.log). */
function serverLogFiles(dir: string): string[] {
  return fs.existsSync(dir) ? fs.readdirSync(dir).filter((n) => /^open-walnut-.*\.log$/.test(n)).sort().map((n) => path.join(dir, n)) : []
}

/** The pid of session `sid`'s CLI in a daemon dir's registry (sessions.json), or null. */
function cliPidOf(daemonDir: string, sid: string): number | null {
  let doc: unknown
  try { doc = JSON.parse(fs.readFileSync(path.join(daemonDir, 'sessions.json'), 'utf8')) } catch { return null }
  let found: number | null = null
  const walk = (x: unknown, key?: string): void => {
    if (found !== null || !x || typeof x !== 'object') return
    const o = x as Record<string, unknown>
    if ((o.sid === sid || o.sessionId === sid || o.id === sid || key === sid) && typeof o.pid === 'number') { found = o.pid; return }
    for (const [k, v] of Object.entries(o)) walk(v, Array.isArray(x) ? undefined : k)
  }
  walk(doc)
  return found
}

/** A process's env as the kernel holds it (Linux), or null where there is no /proc. */
function envOfPid(pid: number | null | undefined): Record<string, string> | null {
  if (!pid) return null
  try {
    const env: Record<string, string> = {}
    for (const kv of fs.readFileSync(`/proc/${pid}/environ`, 'utf8').split('\0')) {
      const i = kv.indexOf('=')
      if (i > 0) env[kv.slice(0, i)] = kv.slice(i + 1)
    }
    return env
  } catch { return null }
}

export interface SideCall { method: 'runningServer' | 'standbyServer' | 'stopServer' | 'startServer' | 'startStandby'; args?: unknown[] }

/**
 * The operations. Each takes JSON arguments and returns a JSON value (a Map comes back as its entries); an error
 * comes back as an error with its message.
 */
export const OPS = {
  // ---- files ----
  text: (p: string): string | null => { try { return fs.readFileSync(p, 'utf8') } catch { return null } },
  exists: (p: string): boolean => fs.existsSync(p),
  ls: (p: string): string[] | null => { try { return fs.readdirSync(p) } catch { return null } },
  /** The permission bits, or null when there is nothing there. */
  mode: (p: string): number | null => { try { return fs.statSync(p).mode & 0o7777 } catch { return null } },
  write: (p: string, content: string): void => { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, content) },
  mkdir: (p: string): void => { fs.mkdirSync(p, { recursive: true }) },
  rename: (from: string, to: string): void => fs.renameSync(from, to),
  rm: (p: string): void => fs.rmSync(p, { recursive: true, force: true }),
  chmod: (p: string, mode: number): void => fs.chmodSync(p, mode),
  /** `bytes` random bytes written over `p` at `offset` (a database broken on purpose). */
  corrupt: (p: string, offset: number, bytes: number): void => {
    const fd = fs.openSync(p, 'r+')
    try { fs.writeSync(fd, randomBytes(bytes), 0, bytes, offset) } finally { fs.closeSync(fd) }
  },
  /** `count` files of `bytesEach` random bytes under `dir` (`<prefix>-<i>.bin`), made on this machine. */
  /**
   * Files of random bytes, written 4 MiB at a time without holding the event loop: in rehearsal (a) and on A in
   * (b) this runs in the driver, whose proxies carry the doors and links (a synchronous 1.2 GB write stalled them
   * long enough for the leader to lose its permission: no witness door answered in time).
   */
  randomFiles: async (dir: string, count: number, bytesEach: number, prefix: string): Promise<void> => {
    await fs.promises.mkdir(dir, { recursive: true })
    const chunk = Buffer.alloc(4 * 1_048_576)
    for (let i = 0; i < count; i++) {
      const f = await fs.promises.open(path.join(dir, `${prefix}-${i}.bin`), 'w')
      try {
        for (let left = bytesEach; left > 0; left -= chunk.length) {
          const part = left >= chunk.length ? chunk : chunk.subarray(0, left)
          await new Promise<void>((resolve, reject) => randomFill(part, (err) => (err ? reject(err) : resolve())))
          await f.write(part)
        }
      } finally {
        await f.close()
      }
    }
  },
  /** `git <args>` in `cwd`; its stdout, or an error with its stderr. */
  git: (cwd: string, args: string[]): Promise<string> => new Promise((resolve, reject) => execFile('git', ['-C', cwd, ...args], { encoding: 'utf8', maxBuffer: 64 << 20 },
    (err, stdout, stderr) => (err ? reject(new Error(`git ${args.join(' ')}: ${stderr || err.message}`)) : resolve(stdout)))),

  // ---- the product's readers of a machine's records ----
  readMayAct: async (home: string) => (await import('../../src/core/leader/switch/records.js')).readMayAct(home),
  readMarker: async (home: string) => (await import('../../src/core/leader/switch/records.js')).readMarker(home),
  readSwitchState: async (home: string) => (await import('../../src/core/leader/switch/flow.js')).readSwitchState(home),
  readSwitchOutcome: async (home: string) => (await import('../../src/core/leader/switch/flow.js')).readSwitchOutcome(home),
  readTargetState: async (dir: string, id: string) => (await import('../../src/core/leader/switch/flow.js')).readTargetState(dir, id),
  targetJobRunning: async (dir: string, id: string) => (await import('../../src/core/leader/switch/target-job.js')).targetJobRunning(dir, id),
  /** A home's snapshot by the manifest's classes (home-kept.ts), as its entries. */
  snapshotHome: async (home: string) => [...(await (await import('../../src/core/home-manifest/home-kept.js')).snapshotHome(home))],
  standbyStatus: async (dir: string) => (await import('../../src/core/standby/index.js')).standbyStatus(dir),
  batchUnderWay: async (dir: string, landedAt: string | null) => (await import('../../src/core/standby/index.js')).batchUnderWay(dir, landedAt),
  /**
   * The batches a leader's standby runner made current ("standby: batch committed" in its server's log, in its
   * daemon dir `logDir`): start, end, time. Each file is read on from where the last read in this process ended
   * (a wait polls this for up to an hour on a large home).
   */
  committedBatches: (logDir: string): CommittedBatch[] => {
    const out: CommittedBatch[] = []
    for (const f of serverLogFiles(logDir)) {
      const seen = batchLogRead.get(f) ?? { bytes: 0, batches: [] }
      let size = 0
      try { size = fs.statSync(f).size } catch { continue }
      if (size < seen.bytes) { seen.bytes = 0; seen.batches = [] }
      if (size > seen.bytes) {
        const fd = fs.openSync(f, 'r')
        try {
          const buf = Buffer.alloc(size - seen.bytes)
          fs.readSync(fd, buf, 0, buf.length, seen.bytes)
          const text = buf.toString('utf8')
          // Up to the last whole line: a line still being written is read next time.
          const whole = text.lastIndexOf('\n') + 1
          seen.bytes += Buffer.byteLength(text.slice(0, whole))
          for (const line of text.slice(0, whole).split('\n')) {
            if (!line.includes('"standby: batch committed"')) continue
            try {
              const l = JSON.parse(line) as { time: string; batch?: number; totalMs?: number; sentBytes?: number }
              const end = Date.parse(l.time)
              const ms = Number(l.totalMs)
              if (Number.isFinite(end) && Number.isFinite(ms) && typeof l.batch === 'number') seen.batches.push({ start: end - ms - LOG_SLACK_MS, end, batch: l.batch, ms, sentBytes: Number(l.sentBytes) || 0 })
            } catch { /* not a log line */ }
          }
        } finally {
          fs.closeSync(fd)
        }
        batchLogRead.set(f, seen)
      }
      out.push(...seen.batches)
    }
    return out
  },
  /** A machine's server log (its daemon dir's files), parsed; `match`: only the lines whose text matches this regex. */
  serverLog: (logDir: string, match?: string): Array<Record<string, unknown>> => {
    const re = match ? new RegExp(match) : null
    return serverLogFiles(logDir).flatMap((f) => fs.readFileSync(f, 'utf8').split('\n').flatMap((l) => {
      if (re && !re.test(l)) return []
      try { return [JSON.parse(l) as Record<string, unknown>] } catch { return [] }
    }))
  },
  /** The new leader's home scanned for paths of the old machine (home-paths.ts), judged by the rule table: what is left that no rule keeps. */
  oldPathsLeft: async (o: { fromHome: string; toHome: string; fromAccount?: string; toAccount?: string }) => {
    const { describeHit, judgePathHits, pathRoots, scanHomePaths } = await import('../../src/core/leader/switch/home-paths.js')
    const { homePathRules } = await import('../../src/core/leader/switch/home-path-rules.js')
    const scan = scanHomePaths(o.toHome, pathRoots(o))
    const j = judgePathHits(scan.hits, homePathRules())
    return { files: scan.files, ms: scan.ms, keptRules: [...new Set(j.kept.map((k) => k.rule))], keptCount: j.kept.length, left: [...j.notRewritten.map((x) => x.hit), ...j.unknown].map(describeHit) }
  },
  cliPidOf,
  envOfPid,
  alive: (pid: number): boolean => alive(pid),
  /**
   * Which daemon shape the servers of one machine ran, from their own logs (every server and standby of a
   * machine logs into its daemon dir): how many times a server started the daemon in its own process, and how
   * many times one used a daemon program (its `local daemon ready` with a port).
   */
  daemonShapes: (daemonDir: string): { inProcess: number; program: number } => {
    let inProcess = 0
    let program = 0
    for (const f of serverLogFiles(daemonDir)) {
      for (const line of fs.readFileSync(f, 'utf8').split('\n')) {
        if (line.includes('"message":"in-process daemon started"')) inProcess++
        else if (line.includes('"message":"local daemon ready"') && /"port":\d+/.test(line)) program++
      }
    }
    return { inProcess, program }
  },
  /** The processes of this account whose cwd is one of `roots` or under it (src/lib/home-processes.ts): pid, name, cwd. */
  processesIn: async (roots: string[]) => (await import('../../src/lib/home-processes.js')).processesInFolders(roots),
  /** A file's size in bytes, or null. */
  size: (p: string): number | null => { try { return fs.statSync(p).size } catch { return null } },
  /** The door port a machine's daemon publishes now (daemon.port), or null. */
  daemonPort: (daemonDir: string): number | null => {
    try {
      const port = Number(fs.readFileSync(path.join(daemonDir, 'daemon.port'), 'utf8').trim())
      return Number.isInteger(port) && port > 0 ? port : null
    } catch { return null }
  },
  /** Does the CLI transcript of session `sid` under `accountHome`'s .claude/projects hold `text`? */
  transcriptHas: (accountHome: string, sid: string, text: string): boolean => {
    const projects = path.join(accountHome, '.claude', 'projects')
    let dirs: string[] = []
    try { dirs = fs.readdirSync(projects) } catch { return false }
    return dirs.some((d) => { try { return fs.readFileSync(path.join(projects, d, `${sid}.jsonl`), 'utf8').includes(text) } catch { return false } })
  },
  /** One request over this machine's leader relay socket (leader-relay.ts), as a command there makes it. */
  relay: async (sock: string, method: string, route: string, body: unknown, timeoutMs: number) => {
    const { relayRequest, relaySocketOpener } = await import('../../src/core/leader/switch/leader-relay.js')
    return relayRequest(relaySocketOpener(sock), method, route, body, timeoutMs).catch((err: Error) => ({ status: 0, json: { why: err.message } }))
  },
  /** Which machine answers over this machine's leader relay socket (its whoami), or null. */
  relayMachine: async (sock: string) => {
    const { relayMachine, relaySocketOpener } = await import('../../src/core/leader/switch/leader-relay.js')
    return relayMachine(relaySocketOpener(sock)).catch(() => null)
  },

  /**
   * Every TCP port a process under `root` listens on (its cwd or program there, /proc), with the address: what the
   * rehearsal's processes open on this machine's network. Linux only (elsewhere none).
   */
  listenersUnder: (root: string): Array<{ pid: number; addr: string; cmd: string }> => {
    if (process.platform !== 'linux') return []
    // The resolved root: /proc gives a process's cwd and program resolved.
    const r = (() => { try { return fs.realpathSync(root) } catch { return path.resolve(root) } })()
    const under = (p: string | null) => !!p && (p === r || p.startsWith(`${r}${path.sep}`))
    const byInode = new Map<string, string>()
    for (const [file, v6] of [['/proc/net/tcp', false], ['/proc/net/tcp6', true]] as const) {
      let lines: string[] = []
      try { lines = fs.readFileSync(file, 'utf8').split('\n').slice(1) } catch { continue }
      for (const l of lines) {
        const f = l.trim().split(/\s+/)
        if (f.length < 10 || f[3] !== '0A') continue
        const [ip, port] = f[1]!.split(':') as [string, string]
        const host = v6
          ? (/^0{32}$/.test(ip) ? '[::]' : ip === '00000000000000000000000001000000' ? '[::1]' : /^0{16}FFFF0000/.test(ip) ? `[::ffff:${[6, 4, 2, 0].map((i) => parseInt(ip.slice(24 + i, 26 + i), 16)).join('.')}]` : `[${ip}]`)
          : [6, 4, 2, 0].map((i) => parseInt(ip.slice(i, i + 2), 16)).join('.')
        byInode.set(f[9]!, `${host}:${parseInt(port, 16)}`)
      }
    }
    const out: Array<{ pid: number; addr: string; cmd: string }> = []
    for (const e of fs.readdirSync('/proc')) {
      const pid = Number(e)
      if (!Number.isInteger(pid)) continue
      const link = (n: string) => { try { return fs.readlinkSync(`/proc/${pid}/${n}`) } catch { return null } }
      if (!under(link('cwd')) && !under(link('exe'))) continue
      let fds: string[] = []
      try { fds = fs.readdirSync(`/proc/${pid}/fd`) } catch { continue }
      const cmd = (() => { try { return fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8').split('\0').join(' ').trim().slice(0, 160) } catch { return '' } })()
      for (const fd of fds) {
        const m = /^socket:\[(\d+)\]$/.exec(link(`fd/${fd}`) ?? '')
        const addr = m ? byInode.get(m[1]!) : undefined
        if (addr) out.push({ pid, addr, cmd })
      }
    }
    return out
  },
  /** This machine's clock (ms). */
  now: (): number => Date.now(),
  // ---- processes ----
  /** This machine's runtime and checkout: what its servers run. */
  runtime: (): { bun: string; repo: string } => ({ bun: process.execPath, repo: REPO }),
  /** `walnut <args>` with the home `home`, as its own process here; its exit and output. */
  cli: (home: string, args: string[], env: Record<string, string> = {}): Promise<{ code: number | null; signal: string | null; out: string }> => new Promise((resolve) => {
    const child = spawn(process.execPath, [path.join(REPO, 'src/cli.ts'), ...args], { env: { ...process.env, OPEN_WALNUT_HOME: home, ...env }, stdio: ['ignore', 'pipe', 'pipe'] })
    recordStart('cli', child.pid, ['walnut', ...args])
    let out = ''
    child.stdout.on('data', (d) => { out += String(d) })
    child.stderr.on('data', (d) => { out += String(d) })
    child.on('exit', (code, signal) => resolve({ code, signal, out }))
  }),
  /** The switch's own side of machine `m` on this computer (side.ts LocalSide), one method. */
  side: async (m: MachinePlace, call: SideCall) => {
    const { LocalSide } = await import('../../src/core/leader/switch/side.js')
    const s = new LocalSide(m)
    const args = call.args ?? []
    switch (call.method) {
      case 'runningServer': return s.runningServer()
      case 'standbyServer': { const x = s.standbyServer(); return x ? { pid: x.pid } : null }
      case 'stopServer': return s.stopServer(args[0] as number | undefined)
      case 'startServer': { const r = await s.startServer(args[0] as 'leader' | 'trial', args[1] as number | undefined); recordStart('server', r.pid, m.start ?? []); return r }
      case 'startStandby': { const r = await s.startStandby(args[0] as number | undefined); recordStart('standby', r.pid, m.start ?? []); return r }
    }
    throw new Error(`no side method ${String(call.method)}`)
  },
  /**
   * Machine `m`'s server started by hand, as a person (or a launcher) would: detached, its log in the machine's
   * folder (`<dir>/by-hand-<label>.log`), never in the home. Its pid; the caller waits for it to answer.
   */
  byHandStart: (m: MachinePlace & { dir: string }, label: string): { pid: number; log: string } => {
    const log = path.join(m.dir, `by-hand-${label}.log`)
    const fd = fs.openSync(log, 'a', 0o600)
    const cmd = m.start!
    const child = spawn(cmd[0]!, cmd.slice(1), { env: { ...process.env, ...m.env, OPEN_WALNUT_HOME: m.home }, detached: true, stdio: ['ignore', fd, fd] })
    fs.closeSync(fd)
    child.unref()
    recordStart('by-hand', child.pid, cmd)
    return { pid: child.pid!, log }
  },
  /** SIGTERM, then SIGKILL after `graceMs`: one pid (never a group, never 1 or below). Whether it was alive. */
  stopPid: (pid: number, graceMs = 30_000): Promise<boolean> => stopOne(pid, graceMs),
  /** The mock Claude CLI and a refusing ssh in `bin` (replica-cluster.ts writeStubBin), and `walnut-rehearsal`: this machine's walnut program. */
  writeBin: async (bin: string, o: { profileHome?: string } = {}): Promise<void> => {
    const { writeStubBin } = await import('../../tests/helpers/replica-cluster.js')
    writeStubBin(bin)
    fs.writeFileSync(path.join(bin, 'walnut-rehearsal'), `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(path.join(REPO, 'src', 'cli.ts'))} "$@"\n`, { mode: 0o755 })
    // A host's commands run through the login shell (host-exec-core.ts loginPath), whose system profile may set
    // PATH afresh (Debian's /etc/profile does): the machine HOME's own profiles put this bin first again, as a
    // user's profile puts ~/bin on PATH, so `walnut-rehearsal` (standby.walnut, the same word on both machines) is found.
    if (o.profileHome) {
      const line = `PATH=${JSON.stringify(bin)}:"$PATH"; export PATH\n`
      for (const f of ['.profile', '.bash_profile', '.zprofile']) fs.writeFileSync(path.join(o.profileHome, f), line)
    }
  },
  /** This machine's daemon (the built standalone twin, replica-cluster.ts startHostDaemon): kept here, its handle. */
  startDaemon: async (o: { dir: string; home: string; bin: string; env: Record<string, string> }): Promise<{ handle: string; port: number; pid: number }> => {
    const { startHostDaemon } = await import('../../tests/helpers/replica-cluster.js')
    const d = await startHostDaemon('standalone', o.dir, o.home, o.bin, true, { env: o.env })
    recordStart('daemon', d.pid, [`daemon-${process.platform}-${process.arch}`, '--start'])
    const handle = `daemon-${nextHandle++}`
    kept.set(handle, { pid: d.pid, stop: async () => { await stopOne(d.pid, 10_000).catch(() => {}) } })
    return { handle, port: d.port, pid: d.pid }
  },
  /** This machine's host replica serving its witness's direct door (witness-machines.ts startHostReplicaDoor): kept here, its handle. */
  startService: async (o: { base: string; machineDir: string; machineId: string; walnutId: string; witness: string; env?: Record<string, string> }): Promise<{ handle: string; port: number; pid: number }> => {
    const { startHostReplicaDoor } = await import('../../tests/helpers/witness-machines.js')
    // On the other machine (rehearsal (b)) nothing signals a group: the replica alone, its children left to the cleanup.
    const r = await startHostReplicaDoor({ ...o, ...(agentRoot ? { pidOnly: true } : {}) })
    recordStart('service', r.proc.pid, ['walnut', 'web', '--replica', '--dev'])
    const handle = `service-${nextHandle++}`
    const pid = r.proc.pid!
    kept.set(handle, { pid, stop: agentRoot ? async () => { await stopOne(pid, 10_000).catch(() => {}) } : r.stop, log: r.log })
    return { handle, port: r.port, pid: r.proc.pid! }
  },
  /**
   * Rehearsal (b)'s setup-only link to this machine's witness (w-b): the leader door of a host's service over its
   * witness root (witness-machines.ts startWitnessMachine), in this process, on a loopback port. A host replica's
   * witness is set up only over a link to its service (no setup route on its door), so the leader's one-time
   * `witnesses init` reaches it here; the world closes it right after, and every permit round after that reaches
   * the witness through its door. Kept here, its handle.
   */
  startSetupWitness: async (o: { host: string; root: string }): Promise<{ handle: string; port: number }> => {
    const { startWitnessMachine } = await import('../../tests/helpers/witness-machines.js')
    const m = await startWitnessMachine({ host: o.host, root: o.root, walnutId: null })
    const handle = `setup-witness-${nextHandle++}`
    setupWitnesses.set(handle, m)
    kept.set(handle, { pid: process.pid, stop: async () => { setupWitnesses.delete(handle); await m.close() } })
    return { handle, port: m.port }
  },
  /** The Walnut the setup-only link answers (known after A's first boot). */
  setSetupWitnessWalnut: (handle: string, walnutId: string): void => { const m = setupWitnesses.get(handle); if (m) m.walnutId = walnutId },
  /** The output a kept process wrote so far. */
  keptLog: (handle: string): string => kept.get(handle)?.log?.() ?? '',
  /** Stop a kept process. */
  stopKept: async (handle: string): Promise<void> => { const k = kept.get(handle); kept.delete(handle); await k?.stop() },
  /** Stop every kept process (the agent's end). */
  stopAllKept: async (): Promise<void> => { for (const h of [...kept.keys()]) { const k = kept.get(h); kept.delete(h); await k?.stop().catch(() => {}) } },
} as const

export type Ops = typeof OPS
export type OpName = keyof Ops
/** An operation's answer, as it comes back (awaited). */
export type OpResult<K extends OpName> = Awaited<ReturnType<Ops[K]>>

/** Run one operation here. */
export async function runOp<K extends OpName>(name: K, args: Parameters<Ops[K]>): Promise<OpResult<K>> {
  const f = OPS[name] as (...a: unknown[]) => unknown
  if (typeof f !== 'function') throw new Error(`no operation ${String(name)}`)
  return (await f(...args)) as OpResult<K>
}

