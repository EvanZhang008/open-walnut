/**
 * The session registry's writer (sessions.json, the write-ahead inventory of live CLIs), one for
 * both twins.
 *
 * Why: every registry write was a synchronous writeFile + fsync + rename (+ a dir fsync for a
 * managed service) on the daemon's one thread, once per start, per session end and per stop. In a
 * server that runs the daemon runtime in its own process (in_process_daemon) that thread is the
 * web server's: ten sessions ending together held every route for 94 to 199 ms, nearly all of it
 * in fsync and rename (2026-11-21 stall investigation). Now:
 *
 *   - `request()`: a change to remember. Writes are coalesced: one write in flight at a time, and
 *     every change asked for meanwhile is written once after it, from the latest inventory. The
 *     write runs on fs.promises, so the thread only queues it.
 *   - `durable(strict)`: resolves once a write that took the inventory AFTER this call is on disk.
 *     The write-ahead rule (a spawned CLI is in the registry before its start answers ok, so a
 *     crash never loses it) awaits this. `strict` (a managed service, and the handover) rejects
 *     when the write could not be made durable, as the synchronous write threw.
 *   - `writeSync()`: one synchronous write now, for a process that exits before an await could
 *     finish (a server's shutdown bail, the exit cleanup). Its own temp is written and fsynced
 *     first; only then is an async write already begun given up (a generation check before its
 *     rename, and its temp file unlinked so a rename already in the kernel's hands finds nothing
 *     to move), and the temp renamed. A sync write that fails gives nothing up and answers no one.
 *   - A wedged file pool (2026-08-15: open() on a FIFO with no writer held pool threads for hours;
 *     a dead mount does the same) never hangs a write: an async write still in flight after
 *     asyncDeadlineMs (2 s) whose pool does not answer a probe either (file-pool-deadline.ts) is
 *     made synchronously, as every write was before this writer, and every write after it too
 *     until the stuck one ends. So a stop, an update's strict write and a start's write-ahead
 *     always finish. A pool that answers means a slow disk: the write is left to finish, never
 *     turned into a multi-second fsync on the (possibly the web server's) thread.
 *   - Temp names carry the pid: a zombie daemon's exit write never unlinks or renames its
 *     successor's temp (two processes on one dir).
 *   - `hold()`: a stop that reaps without blocking writes the registry once and keeps it: the
 *     reaped CLIs' exits must not drop them from it (the next daemon reads the sessions it may
 *     resume there). Every later request is ignored; a `writeSync()` before the hold's write
 *     finished writes the held inventory.
 *
 * How each twin gets it: daemon-core.ts (daemon-standalone.ts) imports createRegistryWriter;
 * daemon-source.ts inlines `createRegistryWriter.toString()` through `__CREATE_REGISTRY_WRITER__`.
 * So the factory body references NOTHING at module scope; every helper arrives through deps.
 */

/** The session fields the registry records (daemon-core.ts CoreSessionData, a subset). */
export interface RegistrySessionLike {
  state: string
  pid: number | null
  startTime?: string | null
  pipePath?: string
  jsonlPath?: string
  pgidPath?: string
  cwd?: string
  args?: string[]
  parented?: boolean
  mode?: string
  pendingCtrl?: unknown
  budgetGracefulStop?: boolean
  turnRetry?: unknown
  bootId?: string | null
  cliVersion?: string | null
  cronMetadataOrigin?: unknown
}

export interface RegistryWriterDeps {
  fs: typeof import('node:fs')
  dirname: (p: string) => string
  file: string
  sessions: { entries(): IterableIterator<[string, RegistrySessionLike]> } | Map<string, RegistrySessionLike>
  now: () => number
  /** A managed service: a write that cannot be made durable is an error, not a warning. */
  strict: () => boolean
  log: (level: 'info' | 'warn' | 'error', msg: string, meta: Record<string, unknown>) => void
  /** Called with the moment each write starts (tests, the stall bench). */
  onWrite?: (kind: 'async' | 'sync' | 'hold') => void
  /** This process: its temp files are its own. Default process.pid. */
  pid?: number
  /** An async write in flight longer than this probes the pool, and is made synchronously if it is wedged. Default 2000. */
  asyncDeadlineMs?: number
  /** The deadline rule (file-pool-deadline.ts armFilePoolDeadline), shared with the log appender. */
  armDeadline: typeof import('./file-pool-deadline.js').armFilePoolDeadline
}

export interface RegistryWriter {
  request(): void
  durable(strict?: boolean): Promise<void>
  writeSync(opts?: { strict?: boolean; unlessClean?: boolean }): void
  hold(): Promise<void>
  readonly held: boolean
  stats(): { async: number; sync: number; requests: number }
}

export function createRegistryWriter(deps: RegistryWriterDeps): RegistryWriter {
  const fs = deps.fs
  const fsp = deps.fs.promises
  const file = deps.file
  const pid = typeof deps.pid === 'number' && deps.pid > 0 ? deps.pid : process.pid
  const tmp = file + '.' + pid + '.tmp'
  const syncTmp = file + '.' + pid + '.sync.tmp'
  const deadlineMs = typeof deps.asyncDeadlineMs === 'number' && deps.asyncDeadlineMs > 0 ? deps.asyncDeadlineMs : 2000
  type Waiter = { strict: boolean; resolve: () => void; reject: (err: unknown) => void }
  /** One async write: its batch is answered once, by it, by a sync write that covers it, or at its deadline. */
  type Flight = { batch: Waiter[]; strict: boolean; answered: boolean; cancel: (() => void) | null; answer: (err: unknown) => void }
  let waiters: Waiter[] = []
  /** The async write running now (at most one per process: they share the temp file). */
  let inFlight: Flight | null = null
  /** A write past its deadline that has not ended: the pool is wedged, writes are made here until it ends. */
  let stuck: Flight | null = null
  /** Called once no async write runs (it ended, or it went past its deadline). */
  let idle: Array<() => void> = []
  let scheduled = false
  /** A change asked for since the last write took its inventory. */
  let dirty = false
  /** The last write finished and nothing was asked for since (writeSync's unlessClean). */
  let clean = false
  /** Bumped by every synchronous write once its temp is on disk: an async write begun before it never renames. */
  let gen = 0
  /** The generation of the last synchronous write that landed. */
  let landedGen = 0
  let held = false
  let heldBody: string | null = null
  let holdDone = false
  let holding: Promise<void> | null = null
  const counts = { async: 0, sync: 0, requests: 0 }

  function body(): string {
    const out: Record<string, unknown> = {}
    const spawnedAt = new Date(deps.now()).toISOString()
    for (const [sid, s] of deps.sessions.entries()) {
      if (s.state !== 'running' || !s.pid) continue
      out[sid] = {
        pid: s.pid,
        startTime: s.startTime,
        pipePath: s.pipePath,
        jsonlPath: s.jsonlPath,
        pgidPath: s.pgidPath,
        cwd: s.cwd,
        args: s.args,
        spawnedAt,
        parented: s.parented,
        mode: s.mode,
        pendingCtrl: s.pendingCtrl || undefined,
        ...(s.budgetGracefulStop ? { budgetGracefulStop: true } : {}),
        // Carry the retry streak across daemon restarts (budget continuity).
        turnRetry: s.turnRetry || undefined,
        // Supervision identity: a pid+startTime pair only proves identity within one boot,
        // and a resume needs the CLI version it recorded.
        bootId: s.bootId || undefined,
        cliVersion: s.cliVersion || undefined,
        cronMetadataOrigin: s.cronMetadataOrigin,
      }
    }
    return JSON.stringify({ version: 1, sessions: out })
  }

  function current(): string { return held && heldBody !== null ? heldBody : body() }

  /** writeFile(tmp) -> fsync -> rename(tmp) (-> dir fsync when strict), on fs.promises. False: a sync write went first. */
  async function writeAsync(text: string, strict: boolean, myGen: number): Promise<boolean> {
    const fh = await fsp.open(tmp, 'w', 0o600)
    try {
      await fh.writeFile(text)
      try { await fh.sync() } catch (err) { if (strict) throw err }
    } finally {
      await fh.close().catch(() => {})
    }
    // A synchronous write went first: it holds a newer inventory, so this one is dropped.
    if (myGen !== gen) { await fsp.unlink(tmp).catch(() => {}); return false }
    try { await fsp.rename(tmp, file) } catch (err) {
      // writeSync unlinked the temp file under a rename already asked for: it wrote newer.
      if ((err as { code?: string }).code === 'ENOENT' && myGen !== gen) return false
      throw err
    }
    if (strict) {
      const dir = await fsp.open(deps.dirname(file), 'r')
      try { await dir.sync() } finally { await dir.close().catch(() => {}) }
    }
    return true
  }

  /**
   * One synchronous write: the temp written and fsynced first, and only then the async write in
   * flight given up (gen) and the rename made. null when it landed, else the error; a failure
   * before the rename leaves the async write alone (it still lands, or fails and says so).
   */
  function writeNow(text: string, strict: boolean): Error | null {
    counts.sync++
    if (deps.onWrite) deps.onWrite('sync')
    const asError = (err: unknown) => err instanceof Error ? err : new Error(String(err))
    try {
      fs.writeFileSync(syncTmp, text, { mode: 0o600 })
      try {
        const fd = fs.openSync(syncTmp, 'r+')
        try { fs.fsyncSync(fd) } finally { fs.closeSync(fd) }
      } catch (error) { if (strict) throw error }
    } catch (err) {
      try { fs.unlinkSync(syncTmp) } catch { /* none */ }
      return asError(err)
    }
    const myGen = ++gen
    // An async rename already asked for: without its temp file it moves nothing over this write.
    try { fs.unlinkSync(tmp) } catch { /* none */ }
    try {
      fs.renameSync(syncTmp, file)
      if (strict) {
        const directory = fs.openSync(deps.dirname(file), 'r')
        try { fs.fsyncSync(directory) } finally { fs.closeSync(directory) }
      }
    } catch (err) {
      try { fs.unlinkSync(syncTmp) } catch { /* renamed or none */ }
      return asError(err)
    }
    landedGen = myGen
    return null
  }

  function settle(batch: Waiter[], strict: boolean, err: unknown): void {
    if (err === undefined) { for (const w of batch) w.resolve(); return }
    deps.log('warn', 'registry persist failed', { error: (err as Error)?.message || String(err) })
    for (const w of batch) {
      if (w.strict || strict) w.reject(err)
      else w.resolve()
    }
  }

  function wentIdle(): void {
    const waiting = idle
    idle = []
    for (const go of waiting) go()
  }

  /** Starts one async write of `text` for `batch`; resolves when it is on disk, rejects when it could not be. */
  function startFlight(text: string, strict: boolean, batch: Waiter[]): Promise<void> {
    counts.async++
    const myGen = gen
    let done!: { resolve: () => void; reject: (err: unknown) => void }
    const result = new Promise<void>((resolve, reject) => { done = { resolve, reject } })
    const flight: Flight = {
      batch, strict, answered: false, cancel: null,
      answer(err: unknown) {
        if (flight.answered) return
        flight.answered = true
        // The deadline stays armed until the write ends: a flight a writeSync answered while the
        // pool is wedged still turns into `stuck` there, so later requests are not left behind it.
        settle(batch, strict, err)
        if (err === undefined && !dirty && waiters.length === 0 && !inFlight) clean = true
        if (err === undefined) done.resolve()
        else done.reject(err)
      },
    }
    inFlight = flight
    const ended = (err: unknown) => {
      if (flight.cancel) { flight.cancel(); flight.cancel = null }
      if (inFlight === flight) inFlight = null
      if (stuck === flight) stuck = null
      // inFlight is cleared before the waiters hear: what they do next sees no write in flight.
      flight.answer(err)
      wentIdle()
      kick()
    }
    writeAsync(text, strict, myGen).then(
      (wrote) => ended(wrote || landedGen > myGen ? undefined : new Error('registry write given up for a synchronous write that failed')),
      (err) => ended(err === undefined ? new Error('registry write failed') : err),
    )
    let slowLogged = false
    flight.cancel = deps.armDeadline({
      fsp,
      deadlineMs,
      onSlow(waitedMs) {
        // The pool answers: the disk is slow. The write is left to finish (no fsync on this thread).
        if (slowLogged) return
        slowLogged = true
        deps.log('warn', 'registry write slow: the file pool answers, so the write is left to finish', { waitedMs })
      },
      onWedged() {
        flight.cancel = null
        if (inFlight !== flight) return
        // The file pool does not answer (a wedged thread): this write, and every one until it
        // ends, is made here, as before the async writer.
        inFlight = null
        stuck = flight
        deps.log('warn', 'registry write: the file pool did not answer; writing synchronously', { waitedMs: deadlineMs })
        if (!flight.answered) {
          const err = writeNow(current(), strict)
          if (err) dirty = true
          else if (held) holdDone = true
          flight.answer(err === null ? undefined : err)
        }
        wentIdle()
        kick()
      },
    })
    return result
  }

  function kick(): void {
    if (scheduled || inFlight || held) return
    if (!dirty && waiters.length === 0) return
    scheduled = true
    // A microtask, not a timer: every change made in this turn shares the write, and fake timers
    // in tests never hold it.
    Promise.resolve().then(run)
  }

  function run(): void {
    scheduled = false
    if (inFlight || held) return
    if (!dirty && waiters.length === 0) return
    const batch = waiters
    waiters = []
    dirty = false
    clean = false
    const strict = deps.strict() || batch.some((w) => w.strict)
    if (stuck) {
      // The pool is still wedged: written here (a failure answers the batch, never retried in a loop).
      const err = writeNow(body(), strict)
      settle(batch, strict, err === null ? undefined : err)
      if (err === null && !dirty && waiters.length === 0) clean = true
      return
    }
    if (deps.onWrite) deps.onWrite('async')
    startFlight(body(), strict, batch).catch(() => { /* answered through the batch */ })
  }

  function request(): void {
    counts.requests++
    if (held) return
    dirty = true
    clean = false
    kick()
  }

  function durable(strict?: boolean): Promise<void> {
    if (held) return holding || Promise.resolve()
    return new Promise<void>((resolve, reject) => {
      waiters.push({ strict: strict === true, resolve, reject })
      clean = false
      kick()
    })
  }

  function writeSync(opts?: { strict?: boolean; unlessClean?: boolean }): void {
    if (held && holdDone) return
    if (opts && opts.unlessClean && clean && !inFlight && !scheduled) return
    const strict = opts && typeof opts.strict === 'boolean' ? opts.strict : deps.strict()
    const err = writeNow(current(), strict)
    if (err) {
      deps.log('warn', 'registry persist failed', { error: err.message })
      // Not clean, and no one told it is on disk: a later write takes it again.
      dirty = true
      clean = false
      if (!stuck) kick()
      if (strict) throw err
      return
    }
    if (held) { holdDone = true; return }
    // What the waiters asked for is in this write, and so is what the write in flight took.
    const batch = waiters
    waiters = []
    dirty = false
    if (inFlight) inFlight.answer(undefined)
    clean = !inFlight
    for (const w of batch) w.resolve()
  }

  function hold(): Promise<void> {
    if (holding) return holding
    held = true
    heldBody = body()
    const batch = waiters
    waiters = []
    const strict = deps.strict()
    if (deps.onWrite) deps.onWrite('hold')
    holding = new Promise<void>((resolve, reject) => {
      const fail = (err: unknown) => { if (strict) reject(err); else resolve() }
      const go = () => {
        // A writeSync of the held inventory went first: it is on disk.
        if (holdDone) { settle(batch, strict, undefined); resolve(); return }
        if (stuck) {
          const err = writeNow(heldBody as string, strict)
          if (err === null) holdDone = true
          settle(batch, strict, err === null ? undefined : err)
          if (err === null) resolve(); else fail(err)
          return
        }
        startFlight(heldBody as string, strict, batch).then(() => { holdDone = true; resolve() }, fail)
      }
      if (inFlight) idle.push(go)
      else go()
    })
    return holding
  }

  return {
    request,
    durable,
    writeSync,
    hold,
    get held() { return held },
    stats: () => ({ async: counts.async, sync: counts.sync, requests: counts.requests }),
  }
}
