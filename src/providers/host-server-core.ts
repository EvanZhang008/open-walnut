/**
 * Host server supervision: the daemon keeps a Walnut server running on its host
 * (docs/plan/walnut-servers-everywhere.md, "A server on a host").
 *
 * The leader (the Mac's server, over its trusted socket) says what to run with
 * `server.configure {spec}` and stops it with `{spec: null}`. One spec per Walnut
 * (keyed by the leader's data dir, `home`), so a test server never touches the
 * real one. The daemon:
 *   - starts the command in its own process group, output appended to the spec's
 *     log file, and keeps it running: an exit is restarted after 5 s, doubling to
 *     5 min; a run that lasted 10 min starts the count again;
 *   - gives it a token of its own (WALNUT_FOLLOWER_TOKEN): `follower.hello` for
 *     this Walnut takes no other, so only the process the daemon started speaks
 *     as its follower;
 *   - writes the spec with the token (0600) and the pid with its start time, so a
 *     new daemon (an upgrade) adopts a server that is still up instead of
 *     starting a second one; a pid whose start time differs is another process
 *     and is never signalled;
 *   - takes a change of the spec's `settings` (its tunnel, say) without a
 *     restart: the server reads them from `follower.status`;
 *   - keeps what the server last reported (`follower.report`) for the leader's
 *     `server.status`;
 *   - stops it with SIGTERM to the group, SIGKILL after 10 s.
 * It does not stop the server when the daemon itself exits: the server outlives
 * a daemon upgrade the way sessions do.
 *
 * A spec may carry a `fallback {args, env}` (docs/plan/walnut-replica-servers-impl.md,
 * WP2: the plain host server beside a host replica). After 3 exits within 10 min
 * the daemon runs the fallback by itself, for 1 h or until the next configure
 * from a fresh leader link (the Mac is back) or with another spec, and
 * `server.status` says so (`program`, `fallback`). A resend of the same spec on
 * the link that sent it before (the Mac sends one on every settings save) keeps
 * the fallback: it is no news that the primary works again. This works while
 * the Mac sleeps, which is when a replica's away code runs.
 *
 * A host's one Walnut service (src/binary/service-entry.ts) IS the follower of one home (`self`):
 * no child is started, adopted or stopped for it. Its spec and token are kept as for any other
 * (follower.hello still takes that token, status and report work the same), and a configure that
 * changes what runs (or removes it) saves the spec and asks the service to restart
 * (`self.changed`), so the launcher starts it again on the new spec. Its settings change live.
 * The service's home is one Walnut under every home a declared move made its alias here
 * (`canonical`, walnut-scope-core.ts): a configure that names another of them is still the
 * service's own, and its spec keeps the service's home, the one service-mode.json names, so the
 * next `--service` start finds it (review A3b S34-L3: a second follower, then a daemon start).
 *
 * How the daemon twins get it: daemon-standalone.ts imports
 * createHostServerSupervisor; daemon-source.ts inlines its `toString()` through
 * `__CREATE_HOST_SERVER__`. So the factory body references NOTHING at module
 * scope; every side effect arrives through deps.
 */

export interface HostServerSpec {
  v: 1
  /** The leader's data dir: which Walnut this server follows. */
  home: string
  walnutId: string
  /** Absolute path of the program (a Node). */
  command: string
  args: string[]
  /** Absolute. */
  cwd: string
  env: Record<string, string>
  /** Absolute; output is appended. */
  log: string
  /** The loopback port the server listens on. */
  port: number
  /** What the server reads while it runs (a change needs no restart). */
  settings: Record<string, unknown>
  /** What runs instead after a crash loop (same command and cwd; this env replaces the spec's). */
  fallback?: { args: string[]; env: Record<string, string> }
}

export type HostServerProgram = 'primary' | 'fallback'

export type HostServerState = 'off' | 'starting' | 'running' | 'retrying'

export interface HostServerStatus {
  state: HostServerState
  since: number
  pid?: number
  port?: number
  restarts: number
  lastExit?: { code: number | null; signal: string | null; at: number }
  lastError?: string
  nextRetryAt?: number
  /** What the server last said about itself, and when. */
  report?: Record<string, unknown>
  reportedAt?: number
  /** How long ago, by this host's clock (the leader's clock may differ). */
  reportAgeMs?: number
  /** Which program runs (only when the spec has a fallback). */
  program?: HostServerProgram
  /** While the fallback runs: since when, until when, and the primary's last error. */
  fallback?: { since: number; until: number; lastError?: string }
}

interface ChildLike {
  pid?: number
  once(event: 'exit', cb: (code: number | null, signal: string | null) => void): unknown
  once(event: 'error', cb: (err: Error) => void): unknown
  unref(): void
}

export interface HostServerDeps {
  fs: typeof import('node:fs')
  path: typeof import('node:path')
  spawn: (command: string, args: string[], opts: { cwd: string; env: Record<string, string>; detached: true; stdio: ['ignore', number, number] }) => ChildLike
  /** Where specs and pid files live (0700). */
  dir: string
  keyOf: (home: string) => string
  now: () => number
  setTimer: (fn: () => void, ms: number) => unknown
  clearTimer: (t: unknown) => void
  log: (level: 'info' | 'warn' | 'error', msg: string, data?: Record<string, unknown>) => void
  /** The process's start time (Linux /proc, ps elsewhere), or null when there is no such process. */
  startTimeOf: (pid: number) => string | null
  /** Signal a whole process group (`process.kill(-pid, sig)`). */
  killGroup: (pid: number, signal: 'SIGTERM' | 'SIGKILL') => void
  /** The pid file's reader: `heldServerAt` (the source twin inlines it; the factory references nothing at module scope). */
  heldAt: typeof heldServerAt
  /** What every server starts with before the spec's env (PATH, the daemon's dir). */
  baseEnv: () => Record<string, string>
  /** A fresh secret (hex). */
  randomToken: () => string
  /**
   * The stdout log's size cap (default 20 MB; WP14). Checked at every start and,
   * while the server runs, every few seconds: over it, the log is copied to
   * `<log>.1` and emptied in place (the server appends, so it writes on at 0).
   */
  maxLogBytes?: number
  /** The host's one Walnut service: the follower of `home` is this very process (pid). */
  self?: { home: string; pid: number; changed: (why: string) => void }
  /** The home a Walnut is keyed by here (walnut-scope-core.ts canonical); only the service's own home is matched by it. */
  canonical?: (home: string) => string
}

export function createHostServerSupervisor(deps: HostServerDeps) {
  const { fs, path } = deps
  const FIRST_DELAY_MS = 5_000
  const MAX_DELAY_MS = 5 * 60_000
  const STEADY_MS = 10 * 60_000
  const POLL_MS = 5_000
  const KILL_AFTER_MS = 10_000
  const MAX_LOG_BYTES = typeof deps.maxLogBytes === 'number' && deps.maxLogBytes > 0 ? deps.maxLogBytes : 20 * 1024 * 1024
  /** How often a running server's log size is looked at. */
  const LOG_CHECK_MS = 5_000
  const MAX_SETTINGS_CHARS = 64 * 1024
  const MAX_REPORT_CHARS = 16 * 1024
  const ENV_KEY = /^[A-Za-z_][A-Za-z0-9_]*$/
  /** This many exits of the primary program within CRASH_WINDOW_MS switch to the fallback. */
  const CRASH_EXITS = 3
  const CRASH_WINDOW_MS = 10 * 60_000
  const FALLBACK_MS = 60 * 60_000

  interface Entry {
    spec: HostServerSpec
    token: string
    report?: Record<string, unknown>
    reportedAt?: number
    state: HostServerState
    since: number
    pid?: number
    startTime?: string | null
    startedAt?: number
    restarts: number
    attempt: number
    lastExit?: HostServerStatus['lastExit']
    lastError?: string
    nextRetryAt?: number
    timer?: unknown
    poll?: unknown
    /** Bumped on every start and stop: an exit of an older run is ignored. */
    gen: number
    program: HostServerProgram
    /** When the primary program exited, inside the crash window. */
    exitTimes: number[]
    fallback?: { since: number; until: number; lastError?: string }
    backTimer?: unknown
    /** The running server's log size check (WP14). */
    logPoll?: unknown
  }
  const entries = new Map<string, Entry>()

  /** `home` names the service's own Walnut (the home it serves, or a home a declared move made the same). */
  function isSelf(home: string): boolean {
    const self = deps.self
    if (!self) return false
    if (self.home === home) return true
    return !!deps.canonical && !!home && deps.canonical(home) === deps.canonical(self.home)
  }

  /** The entry for `home`: the service's own under its own home, whichever of its homes is named. */
  function entryOf(home: string): Entry | undefined {
    return entries.get(home) ?? (isSelf(home) ? entries.get(deps.self!.home) : undefined)
  }

  function specFile(home: string): string { return path.join(deps.dir, `server-${deps.keyOf(home)}.json`) }
  function pidFile(home: string): string { return path.join(deps.dir, `server-${deps.keyOf(home)}.pid`) }

  function writeAtomic(file: string, body: string): void {
    fs.mkdirSync(deps.dir, { recursive: true, mode: 0o700 })
    const tmp = `${file}.${process.pid}.tmp`
    fs.writeFileSync(tmp, body, { mode: 0o600 })
    fs.renameSync(tmp, file)
  }

  function validate(raw: unknown): HostServerSpec {
    const s = raw as Partial<HostServerSpec> | null
    if (!s || typeof s !== 'object') throw new Error('server.configure: spec must be an object or null')
    const abs = (v: unknown, name: string): string => {
      if (typeof v !== 'string' || !v.startsWith('/') || v.length > 1024) throw new Error(`server.configure: ${name} must be an absolute path`)
      return v
    }
    if (typeof s.home !== 'string' || !s.home) throw new Error('server.configure: missing home')
    if (typeof s.walnutId !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(s.walnutId)) throw new Error('server.configure: bad walnutId')
    const args = Array.isArray(s.args) ? s.args : []
    if (args.length > 64 || args.some((a) => typeof a !== 'string' || a.length > 4096)) throw new Error('server.configure: args must be at most 64 strings')
    const envOf = (raw: unknown, name: string): Record<string, string> => {
      const out: Record<string, string> = {}
      for (const [k, v] of Object.entries(raw && typeof raw === 'object' ? raw : {})) {
        if (!ENV_KEY.test(k) || typeof v !== 'string' || v.length > 8192) throw new Error(`server.configure: ${name}.${k} must be a string`)
        out[k] = v
      }
      if ('WALNUT_FOLLOWER_TOKEN' in out) throw new Error('server.configure: the daemon sets WALNUT_FOLLOWER_TOKEN itself')
      return out
    }
    const env = envOf(s.env, 'env')
    let fallback: HostServerSpec['fallback']
    if (s.fallback !== undefined && s.fallback !== null) {
      const f = s.fallback as { args?: unknown; env?: unknown }
      if (typeof f !== 'object' || !Array.isArray(f.args) || f.args.length > 64 || f.args.some((a) => typeof a !== 'string' || a.length > 4096)) {
        throw new Error('server.configure: fallback.args must be at most 64 strings')
      }
      fallback = { args: f.args as string[], env: envOf(f.env, 'fallback.env') }
    }
    const port = Number(s.port)
    if (!Number.isInteger(port) || port <= 0 || port >= 65536) throw new Error('server.configure: port must be a TCP port')
    const settings = s.settings && typeof s.settings === 'object' && !Array.isArray(s.settings) ? s.settings : {}
    if (JSON.stringify(settings).length > MAX_SETTINGS_CHARS) throw new Error('server.configure: settings are too large')
    return {
      v: 1, home: s.home, walnutId: s.walnutId,
      command: abs(s.command, 'command'), args, cwd: abs(s.cwd, 'cwd'), env, log: abs(s.log, 'log'),
      port, settings, ...(fallback ? { fallback } : {}),
    }
  }

  function save(e: Entry): void {
    // The program in use rides along, so a new daemon adopting the fallback knows it.
    writeAtomic(specFile(e.spec.home), JSON.stringify({ spec: e.spec, token: e.token, ...(e.fallback ? { fallback: e.fallback } : {}) }))
  }

  /** Everything that needs a restart when it changes (the settings do not). */
  function runKey(s: HostServerSpec): string {
    return JSON.stringify([s.walnutId, s.command, s.args, s.cwd, s.env, s.log, s.port, s.fallback ?? null])
  }

  /** What the run uses: the primary program, or the fallback while it is on. */
  function runOf(e: Entry): { args: string[]; env: Record<string, string> } {
    return e.program === 'fallback' && e.spec.fallback ? e.spec.fallback : { args: e.spec.args, env: e.spec.env }
  }

  function toFallback(e: Entry): void {
    const now = deps.now()
    e.program = 'fallback'
    e.fallback = { since: now, until: now + FALLBACK_MS, ...(e.lastError ? { lastError: e.lastError } : {}) }
    e.exitTimes = []
    e.attempt = 0
    if (e.backTimer) deps.clearTimer(e.backTimer)
    e.backTimer = deps.setTimer(() => { e.backTimer = undefined; toPrimary(e, 'the fallback hour is over') }, FALLBACK_MS)
    try { save(e) } catch { /* adoption only */ }
    deps.log('warn', 'host server: crash loop, running the fallback program', {
      home: e.spec.home, exits: CRASH_EXITS, windowMs: CRASH_WINDOW_MS, forMs: FALLBACK_MS, error: e.lastError,
    })
  }

  /** Back to the primary program: stop the fallback run and start the primary. */
  function toPrimary(e: Entry, why: string): void {
    if (e.program !== 'fallback') return
    if (e.backTimer) { deps.clearTimer(e.backTimer); e.backTimer = undefined }
    e.program = 'primary'
    e.fallback = undefined
    e.exitTimes = []
    e.attempt = 0
    try { save(e) } catch { /* adoption only */ }
    deps.log('info', 'host server: back to the primary program', { home: e.spec.home, why })
    stopRun(e)
    // The fallback lets go of the port first.
    setState(e, 'retrying')
    e.nextRetryAt = deps.now() + FIRST_DELAY_MS
    e.timer = deps.setTimer(() => { e.timer = undefined; start(e) }, FIRST_DELAY_MS)
  }

  function setState(e: Entry, state: HostServerState): void {
    if (e.state !== state) { e.state = state; e.since = deps.now() }
  }

  function clearTimers(e: Entry): void {
    if (e.timer) { deps.clearTimer(e.timer); e.timer = undefined }
    if (e.poll) { deps.clearTimer(e.poll); e.poll = undefined }
    if (e.logPoll) { deps.clearTimer(e.logPoll); e.logPoll = undefined }
  }

  function openLog(file: string): number {
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 })
    try {
      if (fs.statSync(file).size > MAX_LOG_BYTES) fs.renameSync(file, `${file}.1`)
    } catch { /* no log yet */ }
    return fs.openSync(file, 'a', 0o600)
  }

  /**
   * The log of a server that runs, kept under its cap (WP14): the server holds
   * the file open for appending, so a rename would leave it writing to `.1`.
   * The bytes are copied to `<log>.1` and the file emptied in place instead;
   * lines written between the copy and the truncate are lost (a few at most).
   */
  function capLog(e: Entry): void {
    const file = e.spec.log
    let size = 0
    try {
      const st = fs.lstatSync(file)
      if (!st.isFile()) return
      size = st.size
    } catch { return }
    if (size <= MAX_LOG_BYTES) return
    try {
      fs.copyFileSync(file, `${file}.1`)
      fs.truncateSync(file, 0)
      deps.log('info', 'host server: log capped', { home: e.spec.home, bytes: size, maxBytes: MAX_LOG_BYTES, kept: `${file}.1` })
    } catch (err) {
      deps.log('warn', 'host server: log not capped', { home: e.spec.home, bytes: size, error: (err as Error).message })
    }
  }

  function watchLog(e: Entry, gen: number): void {
    if (e.logPoll) deps.clearTimer(e.logPoll)
    e.logPoll = deps.setTimer(() => {
      e.logPoll = undefined
      if (gen !== e.gen || e.state !== 'running') return
      capLog(e)
      watchLog(e, gen)
    }, LOG_CHECK_MS)
  }

  function ours(e: Entry): boolean {
    if (!e.pid || e.pid <= 1) return false
    const now = deps.startTimeOf(e.pid)
    return now !== null && (e.startTime == null || now === e.startTime)
  }

  function exited(e: Entry, gen: number, code: number | null, signal: string | null, error?: string): void {
    if (gen !== e.gen) return
    if (e.poll) { deps.clearTimer(e.poll); e.poll = undefined }
    if (e.logPoll) { deps.clearTimer(e.logPoll); e.logPoll = undefined }
    const ranMs = e.startedAt ? deps.now() - e.startedAt : 0
    e.lastExit = { code, signal, at: deps.now() }
    if (error) e.lastError = error
    else e.lastError = code !== null ? `exited with code ${code}` : `ended by ${signal ?? 'an unknown signal'}`
    e.pid = undefined
    e.startTime = undefined
    e.report = undefined
    e.reportedAt = undefined
    try { fs.unlinkSync(pidFile(e.spec.home)) } catch { /* none */ }
    if (ranMs >= STEADY_MS) e.attempt = 0
    if (e.program === 'primary' && e.spec.fallback) {
      const now = deps.now()
      e.exitTimes = [...e.exitTimes.filter((t) => now - t < CRASH_WINDOW_MS), now]
      if (e.exitTimes.length >= CRASH_EXITS) toFallback(e)
    }
    const delay = Math.min(MAX_DELAY_MS, FIRST_DELAY_MS * 2 ** e.attempt)
    e.attempt += 1
    e.restarts += 1
    e.nextRetryAt = deps.now() + delay
    setState(e, 'retrying')
    deps.log('warn', 'host server: exited, starting again', { home: e.spec.home, code, signal, ranMs, delayMs: delay, error: e.lastError })
    e.timer = deps.setTimer(() => { e.timer = undefined; start(e) }, delay)
  }

  function watch(e: Entry, gen: number): void {
    e.poll = deps.setTimer(() => {
      e.poll = undefined
      if (gen !== e.gen) return
      if (ours(e)) { watch(e, gen); return }
      exited(e, gen, null, null, 'is no longer running')
    }, POLL_MS)
  }

  function start(e: Entry): void {
    clearTimers(e)
    const gen = ++e.gen
    e.nextRetryAt = undefined
    setState(e, 'starting')
    let fd: number
    try {
      fd = openLog(e.spec.log)
    } catch (err) {
      exited(e, gen, null, null, `cannot open its log: ${(err as Error).message}`)
      return
    }
    let child: ChildLike
    try {
      // Its cwd is its data dir, which a server of another Walnut on this host never made for
      // it (core/host-server/install.ts walnutDirs): a spawn into a missing dir fails (ENOENT).
      fs.mkdirSync(e.spec.cwd, { recursive: true, mode: 0o700 })
      const run = runOf(e)
      child = deps.spawn(e.spec.command, run.args, {
        cwd: e.spec.cwd, env: { ...deps.baseEnv(), ...run.env, WALNUT_FOLLOWER_TOKEN: e.token }, detached: true, stdio: ['ignore', fd, fd],
      })
    } catch (err) {
      try { fs.closeSync(fd) } catch { /* closed */ }
      exited(e, gen, null, null, `could not start: ${(err as Error).message}`)
      return
    }
    try { fs.closeSync(fd) } catch { /* the child holds its own copy */ }
    let done = false
    child.once('error', (err) => {
      if (done) return
      done = true
      exited(e, gen, null, null, `could not start: ${err.message}`)
    })
    child.once('exit', (code, signal) => {
      if (done) return
      done = true
      exited(e, gen, code, signal)
    })
    child.unref()
    if (!child.pid) return // the error event follows
    e.pid = child.pid
    e.startTime = deps.startTimeOf(child.pid)
    e.startedAt = deps.now()
    e.lastError = undefined
    try { writeAtomic(pidFile(e.spec.home), JSON.stringify({ pid: e.pid, startTime: e.startTime })) } catch { /* adoption only */ }
    setState(e, 'running')
    watchLog(e, gen)
    deps.log('info', 'host server: started', { home: e.spec.home, pid: e.pid, port: e.spec.port, ...(e.spec.fallback ? { program: e.program } : {}) })
  }

  function stopRun(e: Entry): void {
    clearTimers(e)
    e.gen += 1
    const pid = e.pid
    if (pid && pid > 1 && ours(e)) {
      const startTime = e.startTime
      try { deps.killGroup(pid, 'SIGTERM') } catch { /* gone */ }
      deps.setTimer(() => {
        const now = deps.startTimeOf(pid)
        if (now !== null && (startTime == null || now === startTime)) {
          try { deps.killGroup(pid, 'SIGKILL') } catch { /* gone */ }
        }
      }, KILL_AFTER_MS)
    }
    e.pid = undefined
    e.startTime = undefined
    try { fs.unlinkSync(pidFile(e.spec.home)) } catch { /* none */ }
  }

  function statusOf(e: Entry | undefined): HostServerStatus {
    if (!e) return { state: 'off', since: 0, restarts: 0 }
    return {
      state: e.state, since: e.since, restarts: e.restarts,
      ...(e.pid ? { pid: e.pid } : {}),
      port: e.spec.port,
      ...(e.lastExit ? { lastExit: e.lastExit } : {}),
      ...(e.lastError ? { lastError: e.lastError } : {}),
      ...(e.nextRetryAt ? { nextRetryAt: e.nextRetryAt } : {}),
      ...(e.report ? { report: e.report, reportedAt: e.reportedAt, reportAgeMs: Math.max(0, deps.now() - (e.reportedAt ?? 0)) } : {}),
      ...(e.spec.fallback ? { program: e.program } : {}),
      ...(e.fallback ? { fallback: e.fallback } : {}),
    }
  }

  /**
   * The leader sets (or removes, with null) what runs for its Walnut.
   * `from.freshLink`: the first configure on this leader connection (the twins say).
   */
  /** The service's own home: its spec is kept, nothing is started or stopped for it. */
  function selfEntry(spec: HostServerSpec, token: string): Entry {
    return { spec, token, state: 'running', since: deps.now(), pid: deps.self!.pid, restarts: 0, attempt: 0, gen: 0, program: 'primary', exitTimes: [] }
  }

  function configureSelf(named: string, raw: unknown): HostServerStatus {
    const home = deps.self!.home
    const prev = entries.get(home)
    if (raw === null || raw === undefined) {
      entries.delete(home)
      try { fs.unlinkSync(specFile(home)) } catch { /* none */ }
      deps.log('info', 'host server: removed (the service\'s own)', { home })
      deps.self!.changed('the leader removed the follower')
      return statusOf(undefined)
    }
    const asked = validate(raw)
    if (asked.home !== named) throw new Error('server.configure: the spec belongs to another Walnut')
    // Kept under the service's home, the one its mode file and its next start match.
    const spec: HostServerSpec = { ...asked, home }
    if (prev && runKey(prev.spec) === runKey(spec)) {
      if (JSON.stringify(prev.spec.settings) !== JSON.stringify(spec.settings)) { prev.spec = spec; save(prev) }
      return statusOf(prev)
    }
    const e = selfEntry(spec, deps.randomToken())
    e.state = 'starting'
    save(e)
    entries.set(home, e)
    deps.self!.changed('the leader changed what runs')
    return statusOf(e)
  }

  function configure(home: string, raw: unknown, from?: { freshLink?: boolean }): HostServerStatus {
    if (typeof home !== 'string' || !home) throw new Error('server.configure: missing home')
    if (isSelf(home)) return configureSelf(home, raw)
    const prev = entries.get(home)
    if (raw === null || raw === undefined) {
      if (prev) {
        if (prev.backTimer) { deps.clearTimer(prev.backTimer); prev.backTimer = undefined }
        stopRun(prev)
        entries.delete(home)
        deps.log('info', 'host server: removed', { home })
      }
      try { fs.unlinkSync(specFile(home)) } catch { /* none */ }
      return statusOf(undefined)
    }
    const spec = validate(raw)
    if (spec.home !== home) throw new Error('server.configure: the spec belongs to another Walnut')
    if (prev && runKey(prev.spec) === runKey(spec)) {
      if (JSON.stringify(prev.spec.settings) !== JSON.stringify(spec.settings)) {
        prev.spec = spec
        save(prev)
      }
      // The leader is back (a fresh link) and says what to run: the primary program again.
      if (prev.program === 'fallback') {
        if (from?.freshLink !== true) return statusOf(prev)
        toPrimary(prev, 'configure')
        return statusOf(prev)
      }
      // A spec the leader sends again after a long wait need not wait out the backoff.
      if (prev.state === 'retrying') { prev.attempt = 0; start(prev) }
      return statusOf(prev)
    }
    if (prev) {
      if (prev.backTimer) { deps.clearTimer(prev.backTimer); prev.backTimer = undefined }
      stopRun(prev)
    }
    const e: Entry = {
      spec, token: deps.randomToken(), state: 'off', since: deps.now(), restarts: 0, attempt: 0, gen: prev ? prev.gen + 1 : 0,
      program: 'primary', exitTimes: [],
    }
    save(e)
    entries.set(home, e)
    start(e)
    return statusOf(e)
  }

  /** A new daemon: adopt the servers an earlier one started, start the rest. */
  function boot(): void {
    let names: string[] = []
    try { names = fs.readdirSync(deps.dir) } catch { return }
    for (const name of names) {
      if (!name.startsWith('server-') || !name.endsWith('.json')) continue
      let spec: HostServerSpec
      let token: string
      let fallback: Entry['fallback']
      try {
        const saved = JSON.parse(fs.readFileSync(path.join(deps.dir, name), 'utf8')) as { spec?: unknown; token?: unknown; fallback?: unknown }
        spec = validate(saved.spec)
        if (typeof saved.token !== 'string' || saved.token.length < 32) continue
        token = saved.token
        const f = saved.fallback as Entry['fallback'] | undefined
        if (spec.fallback && f && typeof f.since === 'number' && typeof f.until === 'number') fallback = f
      } catch { continue }
      if (entries.has(spec.home)) continue
      if (isSelf(spec.home)) {
        const home = deps.self!.home
        if (entries.has(home)) continue
        entries.set(home, selfEntry({ ...spec, home }, token))
        deps.log('info', 'host server: this service is the follower', { home, pid: deps.self!.pid })
        continue
      }
      const e: Entry = { spec, token, state: 'off', since: deps.now(), restarts: 0, attempt: 0, gen: 0, program: 'primary', exitTimes: [] }
      // The fallback hour an earlier daemon began keeps its end (one already over ends at once).
      if (fallback) {
        e.program = 'fallback'
        e.fallback = fallback
        e.backTimer = deps.setTimer(() => { e.backTimer = undefined; toPrimary(e, 'the fallback hour is over') }, Math.max(0, fallback.until - deps.now()))
      }
      entries.set(spec.home, e)
      const { pid, startTime } = deps.heldAt(fs, pidFile(spec.home))
      if (pid > 1 && startTime !== null && deps.startTimeOf(pid) === startTime) {
        e.pid = pid
        e.startTime = startTime
        e.startedAt = deps.now()
        setState(e, 'running')
        deps.log('info', 'host server: adopted', { home: spec.home, pid })
        watch(e, e.gen)
        watchLog(e, e.gen)
      } else {
        start(e)
      }
    }
  }

  return {
    configure,
    boot,
    status: (home: string): HostServerStatus => statusOf(entryOf(home)),
    /** Whether `token` is the one the server for `home` was started with. */
    tokenMatches: (home: string, token: unknown): boolean => {
      const want = entryOf(home)?.token
      if (!want || typeof token !== 'string' || token.length !== want.length) return false
      let diff = 0
      for (let i = 0; i < want.length; i++) diff |= want.charCodeAt(i) ^ token.charCodeAt(i)
      return diff === 0
    },
    /** The settings the leader gave the server for `home`. */
    settingsOf: (home: string): Record<string, unknown> => entryOf(home)?.spec.settings ?? {},
    /** The program the leader configured for `home` (its node and `<appDir>/dist/cli.js`), or null: an ask's MCP mount (host-start-core.ts). */
    programOf: (home: string): { command: string; args: string[] } | null => {
      const e = entryOf(home)
      return e ? { command: e.spec.command, args: [...e.spec.args] } : null
    },
    /** The server says how it is (kept in memory only). False when too large or unknown. */
    report: (home: string, body: unknown): boolean => {
      const e = entryOf(home)
      if (!e || !body || typeof body !== 'object' || Array.isArray(body)) return false
      if (JSON.stringify(body).length > MAX_REPORT_CHARS) return false
      e.report = body as Record<string, unknown>
      e.reportedAt = deps.now()
      return true
    },
    homes: (): string[] => [...entries.keys()],
    /** Each server's data dir on this host (OPEN_WALNUT_HOME of its spec and of its fallback). */
    dataDirs: (): string[] => {
      const out: string[] = []
      for (const e of entries.values()) {
        for (const env of [e.spec.env, e.spec.fallback?.env]) {
          const dir = env?.OPEN_WALNUT_HOME
          if (typeof dir === 'string' && dir) out.push(dir)
        }
      }
      return out
    },
    /**
     * Where the server for `home` writes its logs (logs.tail, WP14): its stdout
     * log and its own run dir (WALNUT_DAEMON_DIR of its spec and of its
     * fallback), absolute paths only; null when this Walnut runs nothing here.
     */
    logsOf: (home: string): { stdout: string; dirs: string[] } | null => {
      const e = entryOf(home)
      if (!e) return null
      const dirs: string[] = []
      for (const env of [e.spec.env, e.spec.fallback?.env]) {
        const dir = env?.WALNUT_DAEMON_DIR
        if (typeof dir === 'string' && dir.startsWith('/') && dirs.indexOf(dir) === -1) dirs.push(dir)
      }
      return { stdout: e.spec.log, dirs }
    },
  }
}

export type HostServerSupervisor = ReturnType<typeof createHostServerSupervisor>

/**
 * The pid file the supervisor keeps for a running server, `{ pid, startTime }`: pid 0 and no start
 * time when it is missing or does not read. One reader for the supervisor's adoption at boot
 * (`deps.heldAt`) and stopRecordedServer. Self-contained: the source twin inlines its text.
 */
export function heldServerAt(fs: Pick<typeof import('node:fs'), 'readFileSync'>, file: string): { pid: number; startTime: string | null } {
  let held: { pid?: unknown; startTime?: unknown } | null = null
  try { held = JSON.parse(fs.readFileSync(file, 'utf8')) } catch { /* none */ }
  const pid = typeof held?.pid === 'number' && Number.isSafeInteger(held.pid) ? held.pid : 0
  return { pid, startTime: typeof held?.startTime === 'string' ? held.startTime : null }
}

/**
 * The host's one Walnut service starting (src/binary/main.ts) ends the follower child an older
 * daemon left for its home: it survives its daemon by design and still holds the data dir's lock
 * and the port. The supervisor's own stop (stopRun): the recorded pid only while its start time
 * still matches, SIGTERM to its group, SIGKILL after 10 s; then its pid file goes. The spec file is
 * never touched: an older daemon put back by a rollback starts the follower from it again.
 *
 * A live pid whose start time cannot be read (ps timed out on a loaded Mac) is not "another
 * process": asked again a few times, then `unknown`, signalled never and its pid file kept, so the
 * next start (or a daemon put back) still finds the follower (review A3b S34-L1: the file went,
 * and a rolled-back daemon started a second follower beside the one still running).
 */
export async function stopRecordedServer(o: {
  pidFile: string
  fs: Pick<typeof import('node:fs'), 'readFileSync' | 'rmSync'>
  startTimeOf: (pid: number) => string | null
  killGroup: (pid: number, signal: 'SIGTERM' | 'SIGKILL') => void
  /** Whether a pid names any process (default: signal 0; EPERM is a process too). */
  exists?: (pid: number) => boolean
  killAfterMs?: number
  pollMs?: number
  /** How often, and how far apart, an unreadable start time of a live pid is asked again. */
  unknownTries?: number
  unknownRetryMs?: number
}): Promise<'none' | 'stopped' | 'killed' | 'stays' | 'unknown'> {
  const { pid, startTime } = heldServerAt(o.fs, o.pidFile)
  const exists = o.exists ?? ((p: number): boolean => {
    try { process.kill(p, 0); return true } catch (err) { return (err as NodeJS.ErrnoException).code === 'EPERM' }
  })
  // 'yes' the recorded follower still runs, 'no' gone or another process, 'unknown' a live pid whose start time did not read.
  const state = (): 'yes' | 'no' | 'unknown' => {
    if (pid <= 1 || startTime === null) return 'no'
    const now = o.startTimeOf(pid)
    if (now !== null) return now === startTime ? 'yes' : 'no'
    return exists(pid) ? 'unknown' : 'no'
  }
  const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))
  const done = (verdict: 'none' | 'stopped' | 'killed' | 'stays' | 'unknown') => {
    if (verdict !== 'stays' && verdict !== 'unknown') { try { o.fs.rmSync(o.pidFile, { force: true }) } catch { /* the next start tries again */ } }
    return verdict
  }
  let first = state()
  for (let i = 1; first === 'unknown' && i < (o.unknownTries ?? 3); i++) {
    await pause(o.unknownRetryMs ?? 1_000)
    first = state()
  }
  if (first === 'unknown') return done('unknown')
  if (first === 'no') return done('none')
  const wait = async (ms: number): Promise<boolean> => {
    for (const end = Date.now() + ms; Date.now() < end;) {
      if (state() === 'no') return true
      await pause(o.pollMs ?? 100)
    }
    return state() === 'no'
  }
  try { o.killGroup(pid, 'SIGTERM') } catch { /* gone */ }
  if (await wait(o.killAfterMs ?? 10_000)) return done('stopped')
  try { o.killGroup(pid, 'SIGKILL') } catch { /* gone */ }
  return done(await wait(2_000) ? 'killed' : 'stays')
}
