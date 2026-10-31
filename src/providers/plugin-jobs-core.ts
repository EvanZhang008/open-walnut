/**
 * Plugin jobs: the daemon keeps a plugin's compute running on its machine
 * (the Mac's own daemon, or a host's). A plugin declares jobs in its manifest
 * (`"jobs": {"poll": {"every": "5m"}, "worker": {"kind": "long-running"}}`) and
 * exports them from its server module; the leader (the Mac's server) bundles
 * that module into one file, puts it in `<dir>/bundles/<sha256>.mjs` here and
 * says which jobs run on this machine with `jobs.configure {home, walnutId,
 * jobs}` (the FULL set for its Walnut: a job left out is stopped). The daemon:
 *   - runs each job as its own process group: `<program> <bundle> <job>`, where
 *     the program is this daemon's own `walnut plugin-job` (plugin-job-harness.ts);
 *     output appended to `<runs>/<plugin>/<job>/job.log`, capped by size;
 *   - long-running: an exit (crash or return) is started again after 5 s,
 *     doubling to 5 min; a run that lasted 10 min starts the count again;
 *   - every N: one run per period, never two at once; a run past its timeout
 *     (twice the period, at least 10 min, at most 6 h) is stopped; the last run's
 *     time is kept on disk, so a new daemon (an upgrade, a reboot) neither runs it
 *     again at once nor forgets an overdue one;
 *   - writes the spec (0600) and each run's pid with its start time, so a new
 *     daemon adopts a job that is still running instead of starting a second one;
 *   - a process is this daemon's run only while it can tell: its own child until
 *     the exit, else a live pid whose start time is the saved one (another start
 *     time: another process). One it cannot tell (`ps` failing) is neither signalled
 *     nor replaced, and a new run of a job waits until the run before has exited,
 *     so two runs of one job never overlap, a daemon restart in between included;
 *   - gives each run its own caller id (`plugin-job:<token>`, in WALNUT_PLUGIN_JOB):
 *     the agent gateway sends that run's walnut.ops to the server of the Walnut that
 *     configured it (homeOfRun), and refuses an id no live run holds;
 *   - writes `<run dir>/supervised` every minute while a run goes; a run that finds
 *     it older than 6 h (no daemon looks after it any more) ends itself;
 *   - never runs a bundle whose sha256 is not the one the spec names, and removes a
 *     bundle no job names after a day, the run dir of a job gone for 7 days;
 *   - stops a job with SIGTERM to its group, SIGKILL after 10 s.
 * It does not stop the jobs when the daemon itself exits: they outlive a daemon
 * upgrade the way sessions do. One spec per Walnut (keyed by the leader's data
 * dir, `home`), so a test server never touches the real one's jobs.
 *
 * How the daemon twins get it: daemon-standalone.ts imports
 * createPluginJobSupervisor; daemon-source.ts inlines its `toString()` through
 * `__CREATE_PLUGIN_JOBS__`. So the factory body references NOTHING at module
 * scope; every side effect arrives through deps.
 */

export type PluginJobKind = 'every' | 'long-running'

export interface PluginJobSpec {
  plugin: string
  version: string
  job: string
  kind: PluginJobKind
  /** For `every`: the period. */
  everyMs?: number
  /** The bundle the leader put here: its sha256 and its absolute path inside `<dir>/bundles/`. */
  bundle: { sha256: string; file: string }
  /** The plugin's settings (never its secrets). */
  config: Record<string, unknown>
  /** This machine as the leader names it (`__local__` for the leader's own). */
  host: string
  /** Where the plugin's secrets live on this machine; absent = `$HOME/.open-walnut/secrets/plugins/<plugin>.json`. */
  secretsFile?: string
}

export interface PluginJobsSpec {
  v: 1
  home: string
  walnutId: string
  jobs: PluginJobSpec[]
}

export type PluginJobState = 'idle' | 'starting' | 'running' | 'retrying' | 'refused'

export interface PluginJobStatus {
  plugin: string
  job: string
  kind: PluginJobKind
  everyMs?: number
  version: string
  state: PluginJobState
  since: number
  pid?: number
  startedAt?: number
  /** Starts of a long-running job after the first, and runs of an every job. */
  restarts: number
  runs: number
  failures: number
  lastExit?: { code: number | null; signal: string | null; at: number }
  lastError?: string
  lastRunAt?: number
  lastRunMs?: number
  nextRunAt?: number
  /** What the job last wrote with walnut.metrics, and when (this machine's clock). */
  metrics?: Record<string, number>
  metricsAt?: number
  bundleSha256: string
}

interface ChildLike {
  pid?: number
  once(event: 'exit', cb: (code: number | null, signal: string | null) => void): unknown
  once(event: 'error', cb: (err: Error) => void): unknown
  unref(): void
}

export interface PluginJobDeps {
  fs: typeof import('node:fs')
  path: typeof import('node:path')
  spawn: (command: string, args: string[], opts: { cwd: string; env: Record<string, string>; detached: true; stdio: ['ignore', number, number] }) => ChildLike
  /** Where specs, run state, bundles and logs live (0700). */
  dir: string
  keyOf: (home: string) => string
  now: () => number
  setTimer: (fn: () => void, ms: number) => unknown
  clearTimer: (t: unknown) => void
  log: (level: 'info' | 'warn' | 'error', msg: string, data?: Record<string, unknown>) => void
  /** The process's start time, or null when there is no such process or it cannot be read now. */
  startTimeOf: (pid: number) => string | null
  /** Whether a process with this pid exists (`process.kill(pid, 0)`; EPERM counts as yes). */
  alive: (pid: number) => boolean
  /** When this machine booted (epoch ms), or null: a run that began before it is gone. */
  bootTime?: () => number | null
  /** 32 random bytes as hex: each run's caller id. */
  randomToken: () => string
  /** Signal a whole process group (`process.kill(-pid, sig)`). */
  killGroup: (pid: number, signal: 'SIGTERM' | 'SIGKILL') => void
  /** How to run this daemon's `walnut plugin-job`: the bundle and the job name are appended. */
  program: () => { command: string; args: string[] }
  /** What every job starts with (this daemon's PATH, HOME, ...), before the job's own variables. */
  baseEnv: () => Record<string, string>
  /** This daemon's agent gateway socket: the job's walnut.ops reach Walnut through it. */
  gatewaySocket: () => string
  /** sha256 (hex) of a file's bytes, or null when it cannot be read. */
  sha256File: (file: string) => string | null
  /** The job log's size cap (default 10 MB). */
  maxLogBytes?: number
  /** The shortest `every` period (default 1 min; tests set less, never on a production daemon dir). */
  minEveryMs?: number
}

export function createPluginJobSupervisor(deps: PluginJobDeps) {
  const { fs, path } = deps
  const FIRST_DELAY_MS = 5_000
  const MAX_DELAY_MS = 5 * 60_000
  const STEADY_MS = 10 * 60_000
  const POLL_MS = 5_000
  const KILL_AFTER_MS = 10_000
  const MIN_EVERY_MS = typeof deps.minEveryMs === 'number' && deps.minEveryMs > 0 ? deps.minEveryMs : 60_000
  const MAX_EVERY_MS = 7 * 24 * 60 * 60_000
  /** A new every job's first run, and an overdue one after a daemon restart: soon, not in the same tick. */
  const FIRST_RUN_DELAY_MS = 2_000
  const MIN_TIMEOUT_MS = 10 * 60_000
  const MAX_TIMEOUT_MS = 6 * 60 * 60_000
  const MAX_LOG_BYTES = typeof deps.maxLogBytes === 'number' && deps.maxLogBytes > 0 ? deps.maxLogBytes : 10 * 1024 * 1024
  const LOG_CHECK_MS = 5_000
  const MAX_JOBS = 64
  const MAX_CONFIG_CHARS = 64 * 1024
  const MAX_METRICS_CHARS = 16 * 1024
  /** How often a run's `supervised` file is rewritten (plugin-job-harness.ts reads it under the same name). */
  const BEAT_MS = 60_000
  const SUPERVISED_FILE = 'supervised'
  const BUNDLE_KEEP_MS = 24 * 60 * 60_000
  const RUN_DIR_KEEP_MS = 7 * 24 * 60 * 60_000
  const PRUNE_EVERY_MS = 6 * 60 * 60_000
  /** A run that began this long before the machine booted cannot be the process its pid names now. */
  const BOOT_SLACK_MS = 60_000
  const RUN_SID_PREFIX = 'plugin-job:'
  const ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/
  const JOB_NAME = /^[a-z0-9][a-z0-9-]{0,39}$/
  const SHA = /^[0-9a-f]{64}$/

  /**
   * One process of a job. `spawned`: this daemon's own child whose exit it has not
   * seen, so its pid can belong to no other process. `startTime` null: not read yet.
   */
  interface Proc { pid: number; startTime: string | null; sid: string; spawned: boolean; exited: boolean }

  interface Entry {
    spec: PluginJobSpec
    home: string
    walnutId: string
    state: PluginJobState
    since: number
    proc?: Proc
    startedAt?: number
    restarts: number
    runs: number
    failures: number
    attempt: number
    lastExit?: PluginJobStatus['lastExit']
    lastError?: string
    lastRunAt?: number
    lastRunMs?: number
    nextRunAt?: number
    timer?: unknown
    poll?: unknown
    logPoll?: unknown
    killTimer?: unknown
    beatAt?: number
    unknownLogged?: boolean
    /** Bumped on every start and stop: an exit of an older run is ignored. */
    gen: number
    /** Why this run was stopped by the daemon itself (its timeout): the exit reads as that. */
    stopping?: string
  }

  /** A run being stopped: until it is gone, a new run of the same job waits. */
  interface Drain { proc: Proc; home: string; key: string; termAt?: number; killAt?: number; timer?: unknown }

  /** home -> job key (`<plugin>/<job>`) -> entry. */
  const homes = new Map<string, Map<string, Entry>>()
  const walnutIds = new Map<string, string>()
  /** `<home>\n<plugin>/<job>` -> the runs of that job being stopped, and the start waiting for them. */
  const draining = new Map<string, Drain[]>()
  const waiters = new Map<string, { e: Entry; gen: number }>()
  let pruneTimer: unknown = null

  function keyOfJob(s: { plugin: string; job: string }): string { return `${s.plugin}/${s.job}` }
  function drainKey(home: string, key: string): string { return `${home}\n${key}` }
  function specFile(home: string): string { return path.join(deps.dir, `jobs-${deps.keyOf(home)}.json`) }
  function stateFile(home: string): string { return path.join(deps.dir, `jobs-${deps.keyOf(home)}.state.json`) }
  function runDir(home: string, s: { plugin: string; job: string }): string {
    return path.join(deps.dir, 'runs', deps.keyOf(home), s.plugin, s.job)
  }
  function logFile(home: string, s: { plugin: string; job: string }): string { return path.join(runDir(home, s), 'job.log') }
  function bundlesDir(): string { return path.join(deps.dir, 'bundles') }

  function writeAtomic(file: string, body: string): void {
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 })
    const tmp = `${file}.${process.pid}.tmp`
    fs.writeFileSync(tmp, body, { mode: 0o600 })
    fs.renameSync(tmp, file)
  }

  function validateJob(raw: unknown, i: number): PluginJobSpec {
    const j = raw as Partial<PluginJobSpec> | null
    const at = `jobs.configure: jobs[${i}]`
    if (!j || typeof j !== 'object') throw new Error(`${at} must be an object`)
    if (typeof j.plugin !== 'string' || !ID.test(j.plugin)) throw new Error(`${at}.plugin is not a plugin id`)
    if (typeof j.job !== 'string' || !JOB_NAME.test(j.job)) throw new Error(`${at}.job is not a job name`)
    if (j.kind !== 'every' && j.kind !== 'long-running') throw new Error(`${at}.kind must be "every" or "long-running"`)
    let everyMs: number | undefined
    if (j.kind === 'every') {
      everyMs = Number(j.everyMs)
      if (!Number.isInteger(everyMs) || everyMs < MIN_EVERY_MS || everyMs > MAX_EVERY_MS) throw new Error(`${at}.everyMs must be between ${MIN_EVERY_MS} ms and 7 days`)
    }
    const b = j.bundle as { sha256?: unknown; file?: unknown } | undefined
    if (!b || typeof b.sha256 !== 'string' || !SHA.test(b.sha256)) throw new Error(`${at}.bundle.sha256 must be 64 hex characters`)
    if (b.file !== path.join(bundlesDir(), `${b.sha256}.mjs`)) throw new Error(`${at}.bundle.file must be <dir>/bundles/<sha256>.mjs`)
    const config = j.config && typeof j.config === 'object' && !Array.isArray(j.config) ? j.config : {}
    if (JSON.stringify(config).length > MAX_CONFIG_CHARS) throw new Error(`${at}.config is too large`)
    if (typeof j.host !== 'string' || !j.host || j.host.length > 128) throw new Error(`${at}.host must name this machine`)
    if (j.secretsFile !== undefined && (typeof j.secretsFile !== 'string' || !j.secretsFile.startsWith('/') || j.secretsFile.length > 1024)) {
      throw new Error(`${at}.secretsFile must be an absolute path`)
    }
    const version = typeof j.version === 'string' ? j.version.slice(0, 64) : ''
    return {
      plugin: j.plugin, version, job: j.job, kind: j.kind,
      ...(everyMs !== undefined ? { everyMs } : {}),
      bundle: { sha256: b.sha256, file: b.file as string }, config, host: j.host,
      ...(j.secretsFile ? { secretsFile: j.secretsFile } : {}),
    }
  }

  function validate(raw: unknown): PluginJobsSpec {
    const s = raw as Partial<PluginJobsSpec> | null
    if (!s || typeof s !== 'object') throw new Error('jobs.configure: spec must be an object')
    if (typeof s.home !== 'string' || !s.home) throw new Error('jobs.configure: missing home')
    if (typeof s.walnutId !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(s.walnutId)) throw new Error('jobs.configure: bad walnutId')
    const list = Array.isArray(s.jobs) ? s.jobs : []
    if (list.length > MAX_JOBS) throw new Error(`jobs.configure: at most ${MAX_JOBS} jobs`)
    const jobs = list.map((j, i) => validateJob(j, i))
    const seen = new Set<string>()
    for (const j of jobs) {
      const k = keyOfJob(j)
      if (seen.has(k)) throw new Error(`jobs.configure: ${k} is named twice`)
      seen.add(k)
    }
    return { v: 1, home: s.home, walnutId: s.walnutId, jobs }
  }

  /** Everything that needs a new run when it changes. */
  function runKey(s: PluginJobSpec): string {
    return JSON.stringify([s.version, s.kind, s.everyMs ?? null, s.bundle.sha256, s.config, s.host, s.secretsFile ?? null])
  }

  function saveSpec(home: string): void {
    const m = homes.get(home)
    const walnutId = walnutIds.get(home)
    if (!m || !walnutId) return
    writeAtomic(specFile(home), JSON.stringify({ v: 1, home, walnutId, jobs: [...m.values()].map((e) => e.spec) }))
  }

  function procState(p: Proc): Record<string, unknown> {
    return { pid: p.pid, startTime: p.startTime, sid: p.sid }
  }

  /**
   * Pids, start times, caller ids and run times: what a new daemon needs to adopt a run,
   * to finish stopping one, and to keep the schedule. No jobs and nothing stopping: no file.
   */
  function saveState(home: string): void {
    const m = homes.get(home)
    const stopping: Array<Record<string, unknown>> = []
    for (const list of draining.values()) for (const d of list) if (d.home === home) stopping.push({ job: d.key, ...procState(d.proc) })
    if (!m && stopping.length === 0) {
      try { fs.unlinkSync(stateFile(home)) } catch { /* none */ }
      return
    }
    const jobs: Record<string, unknown> = {}
    for (const [k, e] of m ?? []) {
      jobs[k] = {
        ...(e.proc ? { ...procState(e.proc), startedAt: e.startedAt ?? null } : {}),
        ...(e.lastRunAt ? { lastRunAt: e.lastRunAt } : {}),
        runs: e.runs, failures: e.failures, restarts: e.restarts,
      }
    }
    try { writeAtomic(stateFile(home), JSON.stringify({ v: 2, home, jobs, stopping })) } catch (err) {
      deps.log('warn', 'plugin jobs: state not saved', { home, error: (err as Error).message })
    }
  }

  function setState(e: Entry, state: PluginJobState): void {
    if (e.state !== state) { e.state = state; e.since = deps.now() }
  }

  function clearTimers(e: Entry): void {
    for (const k of ['timer', 'poll', 'logPoll'] as const) {
      if (e[k]) { deps.clearTimer(e[k]); e[k] = undefined }
    }
  }

  function openLog(file: string): number {
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 })
    try {
      if (fs.statSync(file).size > MAX_LOG_BYTES) fs.renameSync(file, `${file}.1`)
    } catch { /* no log yet */ }
    return fs.openSync(file, 'a', 0o600)
  }

  /** A running job holds its log open for appending: copy to `.1` and empty it in place. */
  function capLog(e: Entry): void {
    const file = logFile(e.home, e.spec)
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
    } catch (err) {
      deps.log('warn', 'plugin jobs: log not capped', { job: keyOfJob(e.spec), bytes: size, error: (err as Error).message })
    }
  }

  /** `<run dir>/supervised`: a daemon looks after this run (at most once a minute unless `force`). */
  function beat(e: Entry, force = false): void {
    const now = deps.now()
    if (!force && e.beatAt !== undefined && now - e.beatAt < BEAT_MS) return
    e.beatAt = now
    try { writeAtomic(path.join(runDir(e.home, e.spec), SUPERVISED_FILE), String(now)) } catch { /* the next beat */ }
  }

  function watchLog(e: Entry, gen: number): void {
    if (e.logPoll) deps.clearTimer(e.logPoll)
    e.logPoll = deps.setTimer(() => {
      e.logPoll = undefined
      if (gen !== e.gen || e.state !== 'running') return
      capLog(e)
      const p = e.proc
      // Its own child's start time, when `ps` could not tell it at the spawn: a new daemon adopts by it.
      if (p && p.spawned && p.startTime === null) {
        const st = deps.startTimeOf(p.pid)
        if (st !== null) { p.startTime = st; saveState(e.home) }
      }
      if (p && p.spawned) beat(e)
      watchLog(e, gen)
    }, LOG_CHECK_MS)
  }

  /** Whether `p` is still this daemon's run: yes, no, or cannot tell now. */
  function identity(p: Proc): 'ours' | 'gone' | 'unknown' {
    if (p.exited) return 'gone'
    if (p.spawned) return 'ours'
    if (!p.pid || p.pid <= 1) return 'gone'
    let alive: boolean
    try { alive = deps.alive(p.pid) } catch { return 'unknown' }
    if (!alive) return 'gone'
    const now = deps.startTimeOf(p.pid)
    if (now === null || p.startTime === null) return 'unknown'
    return now === p.startTime ? 'ours' : 'gone'
  }

  function timeoutOf(s: PluginJobSpec): number {
    return Math.min(MAX_TIMEOUT_MS, Math.max(MIN_TIMEOUT_MS, 2 * (s.everyMs ?? 0)))
  }

  /** SIGTERM to a run that is this daemon's, SIGKILL after 10 s if it still is. */
  function signalRun(p: Proc): void {
    if (identity(p) !== 'ours') return
    try { deps.killGroup(p.pid, 'SIGTERM') } catch { /* gone */ }
    deps.setTimer(() => {
      if (identity(p) === 'ours') { try { deps.killGroup(p.pid, 'SIGKILL') } catch { /* gone */ } }
    }, KILL_AFTER_MS)
  }

  /** Stop one run of a job for good: SIGTERM, SIGKILL 10 s on; a new run of the job waits until it is gone. */
  function retire(home: string, key: string, p: Proc): void {
    const dk = drainKey(home, key)
    const d: Drain = { proc: p, home, key }
    draining.set(dk, [...(draining.get(dk) ?? []), d])
    drainTick(dk, d)
  }

  function drainTick(dk: string, d: Drain): void {
    if (!draining.get(dk)?.includes(d)) return
    const id = identity(d.proc)
    if (id === 'gone') { drained(dk, d); return }
    const now = deps.now()
    if (id === 'ours') {
      if (d.termAt === undefined) {
        d.termAt = now
        try { deps.killGroup(d.proc.pid, 'SIGTERM') } catch { /* gone */ }
      } else if (d.killAt === undefined && now - d.termAt >= KILL_AFTER_MS) {
        d.killAt = now
        try { deps.killGroup(d.proc.pid, 'SIGKILL') } catch { /* gone */ }
      }
    }
    // Cannot tell: neither signalled nor replaced until it can.
    const soon = d.termAt !== undefined && now - d.termAt < 2 * KILL_AFTER_MS
    d.timer = deps.setTimer(() => { d.timer = undefined; drainTick(dk, d) }, soon ? 1_000 : POLL_MS)
  }

  function drained(dk: string, d: Drain): void {
    const list = draining.get(dk)
    if (!list?.includes(d)) return
    if (d.timer) { deps.clearTimer(d.timer); d.timer = undefined }
    const rest = list.filter((x) => x !== d)
    if (rest.length > 0) draining.set(dk, rest)
    else draining.delete(dk)
    saveState(d.home)
    if (rest.length > 0) return
    const w = waiters.get(dk)
    waiters.delete(dk)
    if (w && w.e.gen === w.gen && homes.get(w.e.home)?.get(keyOfJob(w.e.spec)) === w.e) start(w.e)
  }

  /** Its own child ended: a stop waiting on it is over now, not at its next tick. */
  function procExited(home: string, key: string, p: Proc): void {
    p.spawned = false
    p.exited = true
    const dk = drainKey(home, key)
    const d = draining.get(dk)?.find((x) => x.proc === p)
    if (d) drained(dk, d)
  }

  function scheduleRun(e: Entry, at: number): void {
    if (e.timer) deps.clearTimer(e.timer)
    e.nextRunAt = at
    setState(e, 'idle')
    e.timer = deps.setTimer(() => { e.timer = undefined; start(e) }, Math.max(0, at - deps.now()))
  }

  function exited(e: Entry, gen: number, code: number | null, signal: string | null, error?: string): void {
    if (gen !== e.gen) return
    if (e.poll) { deps.clearTimer(e.poll); e.poll = undefined }
    if (e.logPoll) { deps.clearTimer(e.logPoll); e.logPoll = undefined }
    if (e.killTimer) { deps.clearTimer(e.killTimer); e.killTimer = undefined }
    const now = deps.now()
    const ranMs = e.startedAt ? now - e.startedAt : 0
    const startedAt = e.startedAt
    e.lastExit = { code, signal, at: now }
    const stopping = e.stopping
    e.stopping = undefined
    if (stopping) error = stopping
    const failed = error !== undefined || code !== 0
    if (error) e.lastError = error
    else if (code !== 0) e.lastError = code !== null ? `exited with code ${code}` : `ended by ${signal ?? 'an unknown signal'}`
    else e.lastError = undefined
    e.proc = undefined
    e.startedAt = undefined
    e.unknownLogged = false
    if (e.spec.kind === 'every') {
      e.runs += 1
      if (failed) e.failures += 1
      e.lastRunMs = ranMs
      if (startedAt) e.lastRunAt = startedAt
      saveState(e.home)
      deps.log(failed ? 'warn' : 'info', 'plugin jobs: run ended', { job: keyOfJob(e.spec), code, signal, ranMs, error: e.lastError })
      // Never two at once, and never sooner than a second after the last one ended.
      const due = Math.max((startedAt ?? now) + (e.spec.everyMs ?? MIN_EVERY_MS), now + 1_000)
      scheduleRun(e, due)
      return
    }
    if (ranMs >= STEADY_MS) e.attempt = 0
    const delay = Math.min(MAX_DELAY_MS, FIRST_DELAY_MS * 2 ** e.attempt)
    e.attempt += 1
    e.restarts += 1
    if (failed) e.failures += 1
    retryAfter(e, delay)
    saveState(e.home)
    deps.log('warn', 'plugin jobs: exited, starting again', { job: keyOfJob(e.spec), code, signal, ranMs, delayMs: delay, error: e.lastError })
  }

  /** An adopted run (no exit event reaches this daemon): looked at every 5 s. */
  function watch(e: Entry, gen: number): void {
    e.poll = deps.setTimer(() => {
      e.poll = undefined
      if (gen !== e.gen || !e.proc) return
      const id = identity(e.proc)
      if (id === 'gone') { exited(e, gen, null, null, 'is no longer running'); return }
      if (id === 'unknown' && !e.unknownLogged) {
        e.unknownLogged = true
        deps.log('warn', 'plugin jobs: cannot tell whether a run still goes; it is left alone', { job: keyOfJob(e.spec), pid: e.proc.pid })
      }
      if (id === 'ours') e.unknownLogged = false
      beat(e)
      watch(e, gen)
    }, POLL_MS)
  }

  function refuse(e: Entry, why: string): void {
    clearTimers(e)
    e.gen += 1
    e.lastError = why
    e.nextRunAt = undefined
    setState(e, 'refused')
    deps.log('warn', 'plugin jobs: not started', { job: keyOfJob(e.spec), error: why })
  }

  function start(e: Entry): void {
    clearTimers(e)
    const gen = ++e.gen
    e.nextRunAt = undefined
    const key = keyOfJob(e.spec)
    // Never two runs of one job: a new one waits until the one before has exited.
    const dk = drainKey(e.home, key)
    if (draining.has(dk)) {
      waiters.set(dk, { e, gen })
      setState(e, 'starting')
      return
    }
    // The bundle is exactly the one the spec names, or nothing runs.
    const have = deps.sha256File(e.spec.bundle.file)
    if (have === null) { refuse(e, 'its code is not on this machine yet'); return }
    if (have !== e.spec.bundle.sha256) { refuse(e, 'its code on this machine is not the version Walnut sent'); return }
    setState(e, 'starting')
    const dir = runDir(e.home, e.spec)
    let fd: number
    try {
      fd = openLog(logFile(e.home, e.spec))
    } catch (err) {
      exited(e, gen, null, null, `cannot open its log: ${(err as Error).message}`)
      return
    }
    beat(e, true)
    const sid = RUN_SID_PREFIX + deps.randomToken()
    let child: ChildLike
    try {
      const program = deps.program()
      const env: Record<string, string> = {
        ...deps.baseEnv(),
        WALNUT_AGENT_SOCKET: deps.gatewaySocket(),
        WALNUT_PLUGIN_JOB: JSON.stringify({
          plugin: e.spec.plugin, version: e.spec.version, job: e.spec.job, kind: e.spec.kind,
          ...(e.spec.everyMs ? { everyMs: e.spec.everyMs } : {}),
          host: e.spec.host, config: e.spec.config, stateDir: dir, sid,
          ...(e.spec.secretsFile ? { secretsFile: e.spec.secretsFile } : {}),
        }),
      }
      child = deps.spawn(program.command, [...program.args, e.spec.bundle.file, e.spec.job], {
        cwd: dir, env, detached: true, stdio: ['ignore', fd, fd],
      })
    } catch (err) {
      try { fs.closeSync(fd) } catch { /* closed */ }
      exited(e, gen, null, null, `could not start: ${(err as Error).message}`)
      return
    }
    try { fs.closeSync(fd) } catch { /* the child holds its own copy */ }
    let done = false
    let proc: Proc | undefined
    child.once('error', (err) => {
      if (done) return
      done = true
      if (proc) procExited(e.home, key, proc)
      exited(e, gen, null, null, `could not start: ${err.message}`)
    })
    child.once('exit', (code, signal) => {
      if (done) return
      done = true
      if (proc) procExited(e.home, key, proc)
      exited(e, gen, code, signal)
    })
    child.unref()
    if (!child.pid) return // the error event follows
    proc = { pid: child.pid, startTime: deps.startTimeOf(child.pid), sid, spawned: true, exited: false }
    e.proc = proc
    e.startedAt = deps.now()
    setState(e, 'running')
    saveState(e.home)
    watchLog(e, gen)
    if (e.spec.kind === 'every') armTimeout(e, gen)
    deps.log('info', 'plugin jobs: started', { job: key, pid: proc.pid, kind: e.spec.kind })
  }

  /** An every job's run past its timeout is stopped, so the schedule goes on. */
  function armTimeout(e: Entry, gen: number): void {
    if (e.killTimer) deps.clearTimer(e.killTimer)
    const left = Math.max(0, (e.startedAt ?? deps.now()) + timeoutOf(e.spec) - deps.now())
    e.killTimer = deps.setTimer(() => {
      e.killTimer = undefined
      if (gen !== e.gen || !e.proc) return
      e.stopping = `ran past its ${Math.round(timeoutOf(e.spec) / 60_000)} min limit and was stopped`
      deps.log('warn', 'plugin jobs: run timed out', { job: keyOfJob(e.spec), pid: e.proc.pid })
      signalRun(e.proc)
    }, left)
  }

  /** Stop the job's run (if any) and its timers; the entry may start again later. */
  function stopRun(e: Entry): void {
    clearTimers(e)
    if (e.killTimer) { deps.clearTimer(e.killTimer); e.killTimer = undefined }
    e.gen += 1
    const p = e.proc
    e.proc = undefined
    e.startedAt = undefined
    if (p) retire(e.home, keyOfJob(e.spec), p)
  }

  /** A long-running job's retry after `delay`. */
  function retryAfter(e: Entry, delay: number): void {
    setState(e, 'retrying')
    e.nextRunAt = deps.now() + delay
    e.timer = deps.setTimer(() => { e.timer = undefined; start(e) }, delay)
  }

  function newEntry(home: string, walnutId: string, spec: PluginJobSpec): Entry {
    return { spec, home, walnutId, state: 'idle', since: deps.now(), restarts: 0, runs: 0, failures: 0, attempt: 0, gen: 0 }
  }

  /** Begin a job just configured or found on boot: run now (long-running) or at its next time (every). */
  function begin(e: Entry, lastRunAt?: number): void {
    if (e.spec.kind === 'long-running') { start(e); return }
    const now = deps.now()
    const due = lastRunAt ? lastRunAt + (e.spec.everyMs ?? MIN_EVERY_MS) : now + FIRST_RUN_DELAY_MS
    scheduleRun(e, Math.max(due, now + FIRST_RUN_DELAY_MS))
  }

  function statusOf(e: Entry): PluginJobStatus {
    let metrics: Record<string, number> | undefined
    let metricsAt: number | undefined
    try {
      const file = path.join(runDir(e.home, e.spec), 'metrics.json')
      const raw = fs.readFileSync(file, 'utf8')
      if (raw.length <= MAX_METRICS_CHARS) {
        const parsed = JSON.parse(raw) as { values?: unknown; at?: unknown }
        if (parsed.values && typeof parsed.values === 'object' && !Array.isArray(parsed.values)) {
          metrics = {}
          for (const [k, v] of Object.entries(parsed.values as Record<string, unknown>)) {
            if (typeof v === 'number' && Number.isFinite(v)) metrics[k] = v
          }
          if (typeof parsed.at === 'number') metricsAt = parsed.at
        }
      }
    } catch { /* none written yet */ }
    return {
      plugin: e.spec.plugin, job: e.spec.job, kind: e.spec.kind,
      ...(e.spec.everyMs ? { everyMs: e.spec.everyMs } : {}),
      version: e.spec.version, state: e.state, since: e.since,
      ...(e.proc ? { pid: e.proc.pid } : {}),
      ...(e.startedAt ? { startedAt: e.startedAt } : {}),
      restarts: e.restarts, runs: e.runs, failures: e.failures,
      ...(e.lastExit ? { lastExit: e.lastExit } : {}),
      ...(e.lastError ? { lastError: e.lastError } : {}),
      ...(e.lastRunAt ? { lastRunAt: e.lastRunAt } : {}),
      ...(e.lastRunMs !== undefined ? { lastRunMs: e.lastRunMs } : {}),
      ...(e.nextRunAt ? { nextRunAt: e.nextRunAt } : {}),
      ...(metrics ? { metrics, ...(metricsAt ? { metricsAt } : {}) } : {}),
      bundleSha256: e.spec.bundle.sha256,
    }
  }

  function status(home: string): { dir: string; bundles: string; jobs: PluginJobStatus[] } {
    const m = homes.get(home)
    return { dir: deps.dir, bundles: bundlesDir(), jobs: m ? [...m.values()].map(statusOf) : [] }
  }

  /** The leader says which jobs run here for its Walnut: the whole set, each changed one restarted. */
  function configure(home: string, raw: unknown): { dir: string; bundles: string; jobs: PluginJobStatus[] } {
    if (typeof home !== 'string' || !home) throw new Error('jobs.configure: missing home')
    const spec = validate(raw)
    if (spec.home !== home) throw new Error('jobs.configure: the spec belongs to another Walnut')
    const m = homes.get(home) ?? new Map<string, Entry>()
    homes.set(home, m)
    walnutIds.set(home, spec.walnutId)
    const wanted = new Map(spec.jobs.map((j) => [keyOfJob(j), j]))
    for (const [k, e] of m) {
      if (wanted.has(k)) continue
      stopRun(e)
      m.delete(k)
      deps.log('info', 'plugin jobs: removed', { job: k })
    }
    for (const [k, j] of wanted) {
      const prev = m.get(k)
      if (prev && runKey(prev.spec) === runKey(j)) {
        // The same job: a refused one (its code arrived since) tries again now. A waiting
        // retry keeps its backoff: a set sent again changes nothing.
        if (prev.state === 'refused') begin(prev, prev.lastRunAt)
        continue
      }
      if (prev) {
        // A changed every job keeps its schedule, counted from the run in flight if one is.
        const lastRunAt = prev.proc && prev.startedAt ? prev.startedAt : prev.lastRunAt
        stopRun(prev)
        const e = newEntry(home, spec.walnutId, j)
        e.runs = prev.runs; e.failures = prev.failures; e.restarts = prev.restarts; e.lastRunAt = lastRunAt
        e.lastRunMs = prev.lastRunMs; e.lastExit = prev.lastExit; e.gen = prev.gen + 1
        m.set(k, e)
        deps.log('info', 'plugin jobs: changed, starting the new one', { job: k })
        // A long-running one starts over once the old run has exited.
        begin(e, e.lastRunAt)
        continue
      }
      const e = newEntry(home, spec.walnutId, j)
      m.set(k, e)
      deps.log('info', 'plugin jobs: added', { job: k, kind: j.kind })
      begin(e)
    }
    saveSpec(home)
    if (m.size === 0) {
      homes.delete(home)
      walnutIds.delete(home)
      try { fs.unlinkSync(specFile(home)) } catch { /* none */ }
    }
    saveState(home)
    return status(home)
  }

  function num(v: unknown): number | undefined { return typeof v === 'number' && Number.isFinite(v) ? v : undefined }

  /** A proc saved by an earlier daemon, or null when the record is not one. */
  function savedProc(s: { pid?: unknown; startTime?: unknown; sid?: unknown }): Proc | null {
    const pid = num(s.pid) ?? 0
    if (pid <= 1) return null
    const startTime = typeof s.startTime === 'string' ? s.startTime : null
    const sid = typeof s.sid === 'string' && s.sid.startsWith(RUN_SID_PREFIX) && s.sid.length <= 200 ? s.sid : RUN_SID_PREFIX + deps.randomToken()
    return { pid, startTime, sid, spawned: false, exited: false }
  }

  /** A new daemon: finish the stops an earlier one began, adopt the runs still going, schedule or start the rest. */
  function boot(): void {
    let names: string[] = []
    try { names = fs.readdirSync(deps.dir) } catch { return }
    const booted = deps.bootTime?.() ?? null
    const states = new Map<string, Record<string, unknown>>()
    for (const name of names) {
      if (!/^jobs-[^.]+\.state\.json$/.test(name)) continue
      let raw: Record<string, unknown>
      try { raw = JSON.parse(fs.readFileSync(path.join(deps.dir, name), 'utf8')) } catch { continue }
      if (!raw || typeof raw !== 'object' || raw.v !== 2 || typeof raw.home !== 'string' || stateFile(raw.home) !== path.join(deps.dir, name)) continue
      states.set(raw.home, raw)
      for (const s of Array.isArray(raw.stopping) ? raw.stopping as Array<Record<string, unknown>> : []) {
        const p = savedProc(s)
        if (!p || typeof s.job !== 'string' || !s.job.includes('/') || identity(p) === 'gone') continue
        if (draining.get(drainKey(raw.home, s.job))?.some((d) => d.proc.pid === p.pid)) continue
        deps.log('info', 'plugin jobs: finishing a stop an earlier daemon began', { job: s.job, pid: p.pid })
        retire(raw.home, s.job, p)
      }
    }
    for (const name of names) {
      if (!/^jobs-[^.]+\.json$/.test(name)) continue
      let spec: PluginJobsSpec
      try {
        spec = validate(JSON.parse(fs.readFileSync(path.join(deps.dir, name), 'utf8')))
      } catch (err) {
        deps.log('warn', 'plugin jobs: a saved spec was not read', { file: name, error: (err as Error).message })
        continue
      }
      if (homes.has(spec.home)) continue
      const savedJobs = (states.get(spec.home)?.jobs ?? {}) as Record<string, Record<string, unknown>>
      const m = new Map<string, Entry>()
      homes.set(spec.home, m)
      walnutIds.set(spec.home, spec.walnutId)
      for (const j of spec.jobs) {
        const k = keyOfJob(j)
        const e = newEntry(spec.home, spec.walnutId, j)
        const s = savedJobs[k] ?? {}
        e.runs = num(s.runs) ?? 0
        e.failures = num(s.failures) ?? 0
        e.restarts = num(s.restarts) ?? 0
        e.lastRunAt = num(s.lastRunAt)
        m.set(k, e)
        const p = savedProc(s)
        const startedAt = num(s.startedAt)
        let id = p ? identity(p) : 'gone'
        // Rebooted since that run began: whatever holds its pid now is another process.
        if (id === 'unknown' && booted !== null && startedAt !== undefined && startedAt < booted - BOOT_SLACK_MS) id = 'gone'
        if (p && id !== 'gone') {
          e.proc = p
          e.startedAt = startedAt ?? deps.now()
          setState(e, 'running')
          deps.log('info', 'plugin jobs: adopted', { job: k, pid: p.pid, ...(id === 'unknown' ? { unconfirmed: true } : {}) })
          beat(e, true)
          watch(e, e.gen)
          watchLog(e, e.gen)
          if (j.kind === 'every') armTimeout(e, e.gen)
        } else {
          begin(e, e.lastRunAt)
        }
      }
      saveState(spec.home)
    }
    prune()
  }

  function readdir(dir: string): string[] {
    try { return fs.readdirSync(dir) } catch { return [] }
  }

  /** The newest mtime of a run dir and the files in it (0 when it cannot be read). */
  function newestIn(dir: string): number {
    let newest = 0
    try { newest = fs.statSync(dir).mtimeMs } catch { return 0 }
    for (const name of readdir(dir)) {
      try { newest = Math.max(newest, fs.lstatSync(path.join(dir, name)).mtimeMs) } catch { /* gone */ }
    }
    return newest
  }

  /**
   * Bundles no job names, a day after they were last written (an upload waiting for its
   * jobs.configure is newer), and the run dirs of jobs no Walnut configures here, 7 days
   * after their last write. Then again every 6 h.
   */
  function prune(): void {
    if (pruneTimer) deps.clearTimer(pruneTimer)
    pruneTimer = deps.setTimer(() => { pruneTimer = null; prune() }, PRUNE_EVERY_MS)
    const now = deps.now()
    const named = new Set<string>()
    const live = new Set<string>()
    for (const [home, m] of homes) {
      for (const e of m.values()) {
        named.add(e.spec.bundle.sha256)
        live.add(runDir(home, e.spec))
      }
    }
    for (const list of draining.values()) {
      for (const d of list) {
        const [plugin, job] = d.key.split('/')
        if (plugin && job) live.add(runDir(d.home, { plugin, job }))
      }
    }
    for (const name of readdir(bundlesDir())) {
      const m = /^([0-9a-f]{64})\.mjs(\..+)?$/.exec(name)
      if (!m || (named.has(m[1]!) && !m[2])) continue
      const file = path.join(bundlesDir(), name)
      try {
        const st = fs.lstatSync(file)
        if (now - st.mtimeMs < BUNDLE_KEEP_MS) continue
        if (st.isDirectory()) fs.rmSync(file, { recursive: true, force: true })
        else if (st.isFile()) fs.unlinkSync(file)
        else continue
        deps.log('info', 'plugin jobs: removed code no job uses', { file: name })
      } catch { /* gone, or not removable */ }
    }
    const runs = path.join(deps.dir, 'runs')
    for (const hk of readdir(runs)) {
      for (const plugin of readdir(path.join(runs, hk))) {
        for (const job of readdir(path.join(runs, hk, plugin))) {
          const dir = path.join(runs, hk, plugin, job)
          if (live.has(dir) || !ID.test(plugin) || !JOB_NAME.test(job)) continue
          if (now - newestIn(dir) < RUN_DIR_KEEP_MS) continue
          try {
            fs.rmSync(dir, { recursive: true, force: true })
            deps.log('info', 'plugin jobs: removed the logs of a job gone for 7 days', { job: `${plugin}/${job}` })
          } catch { /* the next pass */ }
        }
        try { fs.rmdirSync(path.join(runs, hk, plugin)) } catch { /* not empty */ }
      }
      try { fs.rmdirSync(path.join(runs, hk)) } catch { /* not empty */ }
    }
  }

  /** The newest lines of one job's log (its current file only), at most 2000. */
  function logs(home: string, plugin: string, job: string, lines: unknown): { lines: string[]; bytes: number } {
    const m = homes.get(home)
    const e = m?.get(`${plugin}/${job}`)
    if (!e) throw new Error('jobs.logs: no such job here')
    const n = Math.max(1, Math.min(2000, Math.floor(Number(lines) || 200)))
    const file = logFile(home, e.spec)
    let size = 0
    try { size = fs.statSync(file).size } catch { return { lines: [], bytes: 0 } }
    const want = Math.min(size, 512 * 1024)
    const fd = fs.openSync(file, 'r')
    try {
      const buf = Buffer.alloc(want)
      fs.readSync(fd, buf, 0, want, size - want)
      const all = buf.toString('utf8').split('\n')
      if (want < size) all.shift() // a cut first line
      if (all.length && all[all.length - 1] === '') all.pop()
      return { lines: all.slice(-n), bytes: size }
    } finally {
      fs.closeSync(fd)
    }
  }

  /** The Walnut (its home) whose job holds this caller id now, or null: no live run has it. */
  function homeOfRun(sid: unknown): string | null {
    if (typeof sid !== 'string' || !sid.startsWith(RUN_SID_PREFIX)) return null
    for (const [home, m] of homes) {
      for (const e of m.values()) if (e.proc && e.proc.sid === sid) return home
    }
    // A run being stopped still ends its work in its grace (a last op call).
    for (const list of draining.values()) for (const d of list) if (d.proc.sid === sid) return d.home
    return null
  }

  return {
    configure,
    boot,
    status,
    logs,
    prune,
    homeOfRun,
    /** Whether a gateway caller id is a plugin job's (live or not). */
    isRunSid: (sid: unknown): boolean => typeof sid === 'string' && sid.startsWith(RUN_SID_PREFIX),
    homes: (): string[] => [...homes.keys()],
    /** Where the leader puts a bundle (`<dir>/bundles/<sha256>.mjs`). */
    bundlePath: (sha256: string): string => {
      if (!SHA.test(sha256)) throw new Error('bad sha256')
      return path.join(bundlesDir(), `${sha256}.mjs`)
    },
  }
}

export type PluginJobSupervisor = ReturnType<typeof createPluginJobSupervisor>
