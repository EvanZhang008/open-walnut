/**
 * `walnut plugin-job <bundle> <job>`: one run of a plugin job, the process the
 * daemon starts for it (plugin-jobs-core.ts). It imports the plugin's bundle,
 * finds `jobs[<job>]` among its exports and calls it with the job's `walnut`:
 *
 *   walnut.ops.call(name, args)   one Walnut op, through this daemon's agent
 *                                 gateway (WALNUT_AGENT_SOCKET) under the run's
 *                                 own caller id, which the daemon sends to the
 *                                 server of the Walnut that runs the job; an
 *                                 error answer throws an Error with `code`
 *   walnut.ops.list()             the op catalog
 *   walnut.log.info|warn|error    one JSON line on stdout (the job's log)
 *   walnut.metrics.set|inc|get    numbers kept in <state dir>/metrics.json,
 *                                 which the leader shows beside the job
 *   walnut.secrets.get|set|...    the plugin's secrets ON THIS MACHINE
 *   walnut.config                 the plugin's settings
 *   walnut.plugin, .job, .host    who and where
 *   signal                        aborted on SIGTERM/SIGINT; the run then has 8 s
 *
 * A job function that returns ends the run with 0, one that throws with 1, and
 * so does an uncaught exception or an unhandled rejection anywhere in it (logged
 * as one line). A run whose daemon stopped looking after it (`<state dir>/supervised`
 * older than 6 h at two checks half an hour apart) is stopped the way SIGTERM stops it.
 * What the job runs on is described by WALNUT_PLUGIN_JOB (JSON), which only
 * the daemon sets: started any other way it refuses (exit 2).
 *
 * How the daemon twins get it: wn-cli.ts (the walnut file and the bun daemon)
 * imports createPluginJobHarness; daemon-source.ts inlines its `toString()`
 * through `__CREATE_PLUGIN_JOB_HARNESS__`. So the factory body references
 * NOTHING at module scope; every side effect arrives through deps.
 */

export interface PluginJobInfo {
  plugin: string
  version: string
  job: string
  kind: 'every' | 'long-running'
  everyMs?: number
  host: string
  config: Record<string, unknown>
  stateDir: string
  secretsFile?: string
  /** The run's caller id at the agent gateway (`plugin-job:<token>`). */
  sid?: string
}

export interface PluginJobHarnessDeps {
  fs: typeof import('node:fs')
  path: typeof import('node:path')
  net: typeof import('node:net')
  env: Record<string, string | undefined>
  /** Import an ES module file (the bundle) by its absolute path. */
  importModule: (file: string) => Promise<Record<string, unknown>>
  now: () => number
  setTimer: (fn: () => void, ms: number) => unknown
  clearTimer: (t: unknown) => void
  onSignal: (signal: 'SIGTERM' | 'SIGINT', fn: () => void) => void
  /** One line to stdout (the job's log); the newline is added here. */
  write: (line: string) => void
  /** End the process now (a run that did not stop in its grace). */
  exit: (code: number) => void
  /** Take over the process's uncaught exception and unhandled rejection handlers. */
  onFatal?: (fn: (err: unknown, kind: string) => void) => void
  /** Run `fn` holding the lock the server takes on the same file (utils/file-lock.ts); absent: no lock. */
  lock?: <T>(file: string, fn: () => Promise<T>) => Promise<T>
  home: string
}

export function createPluginJobHarness(deps: PluginJobHarnessDeps) {
  const { fs, path } = deps
  const GRACE_MS = 8_000
  const OP_TIMEOUT_MS = 90_000
  const METRICS_FLUSH_MS = 2_000
  const KEEP_ALIVE_MS = 60_000
  /** The daemon rewrites `<state dir>/supervised` every minute (plugin-jobs-core.ts, same name). */
  const BEAT_CHECK_MS = 30 * 60_000
  const BEAT_STALE_MS = 6 * 60 * 60_000
  const MAX_METRICS = 200
  const SECRET_KEY = /^[a-zA-Z0-9._-]{1,128}$/

  function line(level: string, msg: string, data?: unknown): void {
    const out: Record<string, unknown> = { t: new Date(deps.now()).toISOString(), level, msg: String(msg) }
    if (data !== undefined) out.data = data
    let text: string
    try { text = JSON.stringify(out) } catch { text = JSON.stringify({ t: out.t, level, msg: String(msg), data: '[not serializable]' }) }
    deps.write(text)
  }

  function readInfo(): PluginJobInfo | null {
    const raw = deps.env.WALNUT_PLUGIN_JOB
    if (!raw) return null
    try {
      const v = JSON.parse(raw) as Partial<PluginJobInfo>
      if (!v || typeof v.plugin !== 'string' || typeof v.job !== 'string' || typeof v.stateDir !== 'string') return null
      return {
        plugin: v.plugin, version: typeof v.version === 'string' ? v.version : '', job: v.job,
        kind: v.kind === 'every' ? 'every' : 'long-running',
        ...(typeof v.everyMs === 'number' ? { everyMs: v.everyMs } : {}),
        host: typeof v.host === 'string' ? v.host : '',
        config: v.config && typeof v.config === 'object' ? v.config : {},
        stateDir: v.stateDir,
        ...(typeof v.secretsFile === 'string' ? { secretsFile: v.secretsFile } : {}),
        ...(typeof v.sid === 'string' && v.sid.startsWith('plugin-job:') ? { sid: v.sid } : {}),
      }
    } catch {
      return null
    }
  }

  function writeAtomic(file: string, body: string): void {
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 })
    const tmp = `${file}.${process.pid}.tmp`
    fs.writeFileSync(tmp, body, { mode: 0o600 })
    fs.renameSync(tmp, file)
  }

  /** One request line to the daemon's agent gateway, one answer line back. */
  function gateway(socketPath: string, sid: string, op: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
    return new Promise((resolve, reject) => {
      const sock = deps.net.connect(socketPath)
      const chunks: Buffer[] = []
      let done = false
      const finish = (fn: () => void) => {
        if (done) return
        done = true
        deps.clearTimer(timer)
        try { sock.destroy() } catch { /* closed */ }
        fn()
      }
      const timer = deps.setTimer(() => finish(() => {
        const err = new Error(`no answer from Walnut within ${OP_TIMEOUT_MS / 1000} s`) as Error & { code?: string }
        err.code = 'hub_timeout'
        reject(err)
      }), OP_TIMEOUT_MS)
      sock.on('connect', () => { sock.write(JSON.stringify({ v: 1, op, sid, args }) + '\n') })
      sock.on('data', (chunk: Buffer) => {
        const nl = chunk.indexOf(0x0a)
        chunks.push(nl === -1 ? chunk : chunk.subarray(0, nl))
        if (nl === -1) return
        const text = Buffer.concat(chunks).toString('utf8')
        finish(() => {
          let reply: { ok?: boolean; result?: Record<string, unknown>; error?: { code?: string; message?: string; detail?: unknown } }
          try { reply = JSON.parse(text) } catch { reject(new Error('malformed answer from the Walnut daemon')); return }
          if (reply.ok === true) { resolve(reply.result ?? {}); return }
          const e = reply.error ?? {}
          const err = new Error(e.message || 'the Walnut op failed') as Error & { code?: string; detail?: unknown }
          err.code = e.code || 'internal'
          if (e.detail !== undefined) err.detail = e.detail
          reject(err)
        })
      })
      sock.on('error', (err: Error) => finish(() => {
        const e = new Error(`cannot reach this machine's Walnut daemon: ${err.message}`) as Error & { code?: string }
        e.code = 'daemon_unreachable'
        reject(e)
      }))
      sock.on('close', () => finish(() => reject(new Error('the Walnut daemon closed the connection without an answer'))))
    })
  }

  function makeWalnut(info: PluginJobInfo, signal: AbortSignal) {
    const socketPath = (deps.env.WALNUT_AGENT_SOCKET ?? '').trim()
    const sid = info.sid ?? 'external'
    const metricsFile = path.join(info.stateDir, 'metrics.json')
    const values: Record<string, number> = {}
    try {
      const saved = JSON.parse(fs.readFileSync(metricsFile, 'utf8')) as { values?: Record<string, unknown> }
      for (const [k, v] of Object.entries(saved.values ?? {})) if (typeof v === 'number' && Number.isFinite(v)) values[k] = v
    } catch { /* first run */ }
    let flushTimer: unknown = null
    const flush = (): void => {
      if (flushTimer) { deps.clearTimer(flushTimer); flushTimer = null }
      try { writeAtomic(metricsFile, JSON.stringify({ v: 1, at: deps.now(), values })) } catch (err) {
        line('warn', 'metrics not saved', { error: (err as Error).message })
      }
    }
    const touch = (): void => { if (!flushTimer) flushTimer = deps.setTimer(flush, METRICS_FLUSH_MS) }
    const metricName = (name: unknown): string => {
      if (typeof name !== 'string' || !/^[A-Za-z0-9_.:-]{1,64}$/.test(name)) throw new Error(`metric name ${JSON.stringify(name)} must be 1 to 64 letters, digits or _ . : -`)
      if (!(name in values) && Object.keys(values).length >= MAX_METRICS) throw new Error(`at most ${MAX_METRICS} metrics`)
      return name
    }
    const secretsFile = info.secretsFile ?? path.join(deps.home, '.open-walnut', 'secrets', 'plugins', `${info.plugin}.json`)
    const readSecrets = (): Record<string, string> => {
      try {
        const v = JSON.parse(fs.readFileSync(secretsFile, 'utf8'))
        return v && typeof v === 'object' && !Array.isArray(v) ? v : {}
      } catch { return {} }
    }
    const secretKey = (name: unknown): string => {
      if (typeof name !== 'string' || !SECRET_KEY.test(name)) throw new Error(`Invalid Plugin secret key: ${JSON.stringify(name)}`)
      return name
    }
    /** Read, change, write: under the server's lock on the same file, so no write of either is lost. */
    const updateSecrets = async (change: (all: Record<string, string>) => void): Promise<void> => {
      const apply = async (): Promise<void> => {
        const all = readSecrets()
        change(all)
        writeAtomic(secretsFile, JSON.stringify(all, null, 2))
        try { fs.chmodSync(path.dirname(secretsFile), 0o700) } catch { /* not ours to change */ }
      }
      fs.mkdirSync(path.dirname(secretsFile), { recursive: true, mode: 0o700 })
      if (deps.lock) await deps.lock(secretsFile, apply)
      else await apply()
    }
    const log = {
      debug: (msg: string, data?: unknown) => line('debug', msg, data),
      info: (msg: string, data?: unknown) => line('info', msg, data),
      warn: (msg: string, data?: unknown) => line('warn', msg, data),
      error: (msg: string, data?: unknown) => line('error', msg, data),
    }
    const walnut = {
      plugin: { id: info.plugin, version: info.version },
      job: { name: info.job, kind: info.kind, ...(info.everyMs ? { everyMs: info.everyMs } : {}) },
      host: info.host,
      config: info.config,
      signal,
      log,
      ops: {
        call: async (name: string, args?: Record<string, unknown>): Promise<Record<string, unknown>> => {
          if (typeof name !== 'string' || !name) throw new Error('ops.call needs an op name')
          if (!socketPath) throw new Error('this job has no Walnut daemon to ask (WALNUT_AGENT_SOCKET is unset)')
          return gateway(socketPath, sid, 'tools.call', { name, args: args && typeof args === 'object' ? args : {} })
        },
        list: async (): Promise<unknown[]> => {
          if (!socketPath) throw new Error('this job has no Walnut daemon to ask (WALNUT_AGENT_SOCKET is unset)')
          const r = await gateway(socketPath, sid, 'tools.list', {})
          return Array.isArray(r.ops) ? r.ops : []
        },
      },
      metrics: {
        set: (name: string, value: number): void => {
          if (typeof value !== 'number' || !Number.isFinite(value)) throw new Error('a metric value must be a finite number')
          values[metricName(name)] = value
          touch()
        },
        inc: (name: string, by = 1): number => {
          if (typeof by !== 'number' || !Number.isFinite(by)) throw new Error('a metric step must be a finite number')
          const key = metricName(name)
          values[key] = (values[key] ?? 0) + by
          touch()
          return values[key]
        },
        get: (name: string): number | undefined => values[name],
        all: (): Record<string, number> => ({ ...values }),
      },
      secrets: {
        get: async (name: string): Promise<string | undefined> => readSecrets()[secretKey(name)],
        set: async (name: string, value: string): Promise<void> => {
          if (typeof value !== 'string') throw new Error('Plugin secret value must be a string')
          const key = secretKey(name)
          await updateSecrets((all) => { all[key] = value })
        },
        delete: async (name: string): Promise<void> => {
          const key = secretKey(name)
          await updateSecrets((all) => { delete all[key] })
        },
        keys: async (): Promise<string[]> => Object.keys(readSecrets()).sort(),
      },
    }
    return { walnut, flush }
  }

  /** The job function the bundle exports under `jobs` (or `default.jobs`), or null. */
  function jobFunction(mod: Record<string, unknown>, name: string): ((walnut: unknown, signal: AbortSignal) => unknown) | null {
    const fromJobs = (jobs: unknown) => (jobs && typeof jobs === 'object' ? (jobs as Record<string, unknown>)[name] : undefined)
    const fn = fromJobs(mod.jobs) ?? fromJobs((mod.default as Record<string, unknown> | undefined)?.jobs)
    return typeof fn === 'function' ? fn as (walnut: unknown, signal: AbortSignal) => unknown : null
  }

  async function run(argv: string[]): Promise<number> {
    const [bundle, name] = argv
    if (!bundle || !name || argv.length !== 2) {
      line('error', 'usage: walnut plugin-job <bundle> <job>')
      return 2
    }
    const info = readInfo()
    if (!info) {
      line('error', 'a plugin job is started by the Walnut daemon (WALNUT_PLUGIN_JOB is missing or unreadable)')
      return 2
    }
    if (info.job !== name) {
      line('error', `started for job "${name}" but described as "${info.job}"`)
      return 2
    }
    let mod: Record<string, unknown>
    try {
      mod = await deps.importModule(bundle)
    } catch (err) {
      line('error', 'the plugin code did not load', { error: err instanceof Error ? (err.stack ?? err.message) : String(err) })
      return 1
    }
    const fn = jobFunction(mod, name)
    if (!fn) {
      line('error', `the plugin exports no job "${name}" (export const jobs = { "${name}": async (walnut, signal) => { ... } })`)
      return 2
    }
    const controller = new AbortController()
    const { walnut, flush } = makeWalnut(info, controller.signal)
    let stopping = false
    const stop = (why: string) => {
      if (stopping) return
      stopping = true
      line('info', `stopping (${why})`)
      controller.abort()
      deps.setTimer(() => {
        line('warn', `did not stop within ${GRACE_MS / 1000} s of ${why}; ending it`)
        flush()
        deps.exit(143)
      }, GRACE_MS)
    }
    deps.onSignal('SIGTERM', () => stop('SIGTERM'))
    deps.onSignal('SIGINT', () => stop('SIGINT'))
    // Anything the job leaves uncaught ends the run as a failure, in its own log.
    deps.onFatal?.((err, kind) => {
      line('error', `run failed (${kind})`, { error: err instanceof Error ? (err.stack ?? err.message) : String(err) })
      flush()
      deps.exit(1)
    })
    const started = deps.now()
    line('info', 'run started', { plugin: info.plugin, version: info.version, job: name, kind: info.kind, host: info.host })
    // No daemon looks after a run whose `supervised` file stays old: it ends instead of running unseen.
    let stale = 0
    let beatTimer: unknown = null
    const checkBeat = (): void => {
      let at = NaN
      try { at = Number(fs.readFileSync(path.join(info.stateDir, 'supervised'), 'utf8')) } catch { /* none: stale */ }
      stale = Number.isFinite(at) && deps.now() - at <= BEAT_STALE_MS ? 0 : stale + 1
      if (stale >= 2) { stop(`no Walnut daemon has looked after it for ${BEAT_STALE_MS / 3_600_000} hours`); return }
      beatTimer = deps.setTimer(checkBeat, BEAT_CHECK_MS)
    }
    beatTimer = deps.setTimer(checkBeat, BEAT_CHECK_MS)
    // The run lasts until the job function settles. A job that only awaits its signal
    // holds nothing that keeps the process alive, and Node would end it at once.
    let hold: unknown = null
    const keepAlive = (): void => { hold = deps.setTimer(keepAlive, KEEP_ALIVE_MS) }
    keepAlive()
    let code = 0
    try {
      await fn(walnut, controller.signal)
      line('info', 'run ended', { ms: deps.now() - started })
    } catch (err) {
      code = 1
      line('error', 'run failed', { ms: deps.now() - started, error: err instanceof Error ? (err.stack ?? err.message) : String(err) })
    } finally {
      deps.clearTimer(hold)
      deps.clearTimer(beatTimer)
    }
    flush()
    return code
  }

  return { run, jobFunction, readInfo }
}

export type PluginJobHarness = ReturnType<typeof createPluginJobHarness>
