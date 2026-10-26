/**
 * One-shot Claude Code runs on the host, shared by both daemon twins
 * (capability 'oneshot-v1').
 *
 * Every `claude -p` Walnut starts runs as daemon work, also the ones Walnut never
 * shows as a session (user rule 2026-10-26): micro-Claude (AI search, the direct
 * route of `ai.run`), inline subagents, and the claude-cli model adapter (titles,
 * summaries, `model.fastText`). The server builds the whole spawn (command,
 * argv, env, cwd, stdin) exactly as it did in-process and sends it here; the
 * daemon runs it and streams every stdout line back. No session record, no
 * registry row, no FIFO: these children are hidden.
 *
 * - run: spawn (or take a pre-booted child from the pool), write the input,
 *   stream stdout lines (`oneshot.out`), stderr (`oneshot.err`, capped) and the
 *   exit (`oneshot.exit`) to the socket that asked. `endInput` closes stdin
 *   after the input (text mode); `endOnResult` closes it when the CLI prints
 *   its `result` line and SIGTERMs a straggler after a grace (stream-json mode:
 *   a warm child is single-use). `maxMs` is a backstop SIGKILL for a caller that
 *   went away without cancelling.
 * - prewarm: keep ONE pre-booted stream-json child per warm key (the server's
 *   hash of the whole spawn), at most poolMax of them, the least recently
 *   warmed giving way (a `warmKeep` child only when all are kept, so plugins
 *   that vary their prompts never push AI search out); idle ones are reaped
 *   after poolIdleMs. What a pooled
 *   child prints while it boots (its `system:init` line) is held and replayed
 *   to the run that takes it. A run with a warm key pre-boots its replacement.
 * - cancel: signal one run. dropClient: the socket that owned runs closed, so
 *   nobody reads them any more: they are killed. disposeAll: shutdown.
 *
 * How each twin gets it: daemon-standalone.ts imports createOneShotCore;
 * daemon-source.ts inlines `createOneShotCore.toString()` through
 * `__CREATE_ONESHOT__`. So the factory body references NOTHING at module scope:
 * every capability comes from `deps`, and it carries no backticks. The server
 * runs the same factory in-process when the local daemon is older than
 * 'oneshot-v1' (src/providers/oneshot-client.ts).
 */

export interface OneShotChild {
  pid?: number
  exitCode: number | null
  killed?: boolean
  stdin: { write(data: string): unknown; end(): unknown; on(ev: string, cb: (...a: unknown[]) => void): unknown } | null
  stdout: { setEncoding?(enc: string): unknown; on(ev: string, cb: (chunk: string | Buffer) => void): unknown } | null
  stderr: { setEncoding?(enc: string): unknown; on(ev: string, cb: (chunk: string | Buffer) => void): unknown } | null
  on(ev: string, cb: (...a: unknown[]) => void): unknown
  kill(sig?: string): boolean
}

export interface OneShotDeps<W> {
  /** child_process.spawn */
  spawn: (cmd: string, args: string[], opts: Record<string, unknown>) => OneShotChild
  /** Push one event to the socket that started the run. */
  send: (ws: W, ev: string, data: Record<string, unknown>) => void
  /** The env a spawn without its own gets (the daemon's). */
  env?: Record<string, string | undefined>
  now?: () => number
  log?: (level: 'info' | 'warn' | 'error', msg: string, data?: Record<string, unknown>) => void
  poolMax?: number
  poolIdleMs?: number
  exitGraceMs?: number
}

/** The spawn the server built. */
export interface OneShotSpawnSpec {
  command: string
  args: string[]
  cwd?: string
  env?: Record<string, string | undefined>
}

export interface OneShotRunSpec extends OneShotSpawnSpec {
  runId: string
  input?: string
  endInput?: boolean
  endOnResult?: boolean
  warmKey?: string
  maxMs?: number
}

/** Self-contained factory: see the file comment before adding any reference outside it. */
export function createOneShotCore<W>(deps: OneShotDeps<W>) {
  var POOL_MAX = deps.poolMax || 3
  var POOL_IDLE_MS = deps.poolIdleMs || 15 * 60000
  var EXIT_GRACE_MS = deps.exitGraceMs || 5000
  var BOOT_LINES_MAX = 200
  var STDERR_MAX = 10000
  var CLOSE_WAIT_MS = 2000
  var now = deps.now || function () { return Date.now() }
  var log = deps.log || function () {}

  interface Pooled {
    key: string
    child: OneShotChild
    spec: OneShotSpawnSpec
    /** What it printed while nobody had taken it (its init line). */
    boot: string[]
    partial: string
    spawnedAt: number
    reap: ReturnType<typeof setTimeout> | null
    taken: boolean
    /** Evicted last: a caller every user waits on (AI search) keeps its child. */
    keep: boolean
  }
  interface Run {
    id: string
    ws: W
    child: OneShotChild
    startedAt: number
    stderrBytes: number
    grace: ReturnType<typeof setTimeout> | null
    backstop: ReturnType<typeof setTimeout> | null
    inputEnded: boolean
    exited: boolean
  }

  var pool = new Map<string, Pooled>()
  var runs = new Map<string, Run>()

  function str(v: unknown): string { return typeof v === 'string' ? v : '' }

  function cleanSpec(raw: Record<string, unknown>): OneShotSpawnSpec {
    var command = str(raw.command)
    if (!command) throw new Error('command is required')
    var args = Array.isArray(raw.args) ? (raw.args as unknown[]).map(function (a) { return String(a) }) : []
    var env: Record<string, string | undefined> | undefined
    if (raw.env && typeof raw.env === 'object') {
      env = {}
      var src = raw.env as Record<string, unknown>
      for (var k in src) if (typeof src[k] === 'string') env[k] = src[k] as string
    }
    var spec: OneShotSpawnSpec = { command: command, args: args }
    if (str(raw.cwd)) spec.cwd = str(raw.cwd)
    if (env) spec.env = env
    return spec
  }

  function spawnChild(spec: OneShotSpawnSpec): OneShotChild {
    var opts: Record<string, unknown> = { stdio: ['pipe', 'pipe', 'pipe'], env: spec.env || deps.env }
    if (spec.cwd) opts.cwd = spec.cwd
    var child = deps.spawn(spec.command, spec.args, opts)
    // A child that died before reading its input must not crash the daemon on EPIPE.
    if (child.stdin && typeof child.stdin.on === 'function') child.stdin.on('error', function () {})
    if (child.stdout && child.stdout.setEncoding) child.stdout.setEncoding('utf8')
    if (child.stderr && child.stderr.setEncoding) child.stderr.setEncoding('utf8')
    return child
  }

  function alive(child: OneShotChild): boolean {
    return child.exitCode === null && !child.killed
  }

  function signalChild(child: OneShotChild, sig: string): void {
    try { child.kill(sig) } catch (e) { /* already gone */ }
  }

  /** SIGTERM now, SIGKILL after the grace when it is still there. */
  function terminate(child: OneShotChild): void {
    signalChild(child, 'SIGTERM')
    var t = setTimeout(function () { if (child.exitCode === null) signalChild(child, 'SIGKILL') }, EXIT_GRACE_MS)
    if (t && (t as { unref?: () => void }).unref) (t as { unref: () => void }).unref()
  }

  function splitLines(state: { partial: string }, chunk: string | Buffer): string[] {
    var text = state.partial + (typeof chunk === 'string' ? chunk : chunk.toString('utf8'))
    var parts = text.split('\n')
    state.partial = parts.pop() || ''
    var out: string[] = []
    for (var i = 0; i < parts.length; i++) {
      var line = parts[i].charAt(parts[i].length - 1) === '\r' ? parts[i].slice(0, -1) : parts[i]
      if (line) out.push(line)
    }
    return out
  }

  function isResultLine(line: string): boolean {
    if (line.indexOf('"result"') < 0) return false
    try { return JSON.parse(line).type === 'result' } catch (e) { return false }
  }

  function disposePooled(key: string): void {
    var p = pool.get(key)
    if (!p) return
    pool.delete(key)
    if (p.reap) clearTimeout(p.reap)
    terminate(p.child)
  }

  function prewarm(raw: Record<string, unknown>): { ok: true; warm: 'kept' | 'spawned' } {
    var key = str(raw.warmKey)
    if (!key) throw new Error('warmKey is required')
    var existing = pool.get(key)
    if (existing && alive(existing.child)) return { ok: true, warm: 'kept' }
    disposePooled(key)
    // Past the cap the least recently warmed child gives way, a kept one
    // (warmKeep: AI search) only when every child is kept.
    while (pool.size >= POOL_MAX) {
      var victim: string | null = null
      pool.forEach(function (c, k) { if (victim === null && !c.keep) victim = k })
      disposePooled(victim !== null ? victim : pool.keys().next().value as string)
    }
    var spec = cleanSpec(raw)
    var child = spawnChild(spec)
    var p: Pooled = { key: key, child: child, spec: spec, boot: [], partial: '', spawnedAt: now(), reap: null, taken: false, keep: raw.warmKeep === true }
    if (child.stdout) child.stdout.on('data', function (chunk) {
      if (p.taken) return
      var lines = splitLines(p, chunk)
      for (var i = 0; i < lines.length && p.boot.length < BOOT_LINES_MAX; i++) p.boot.push(lines[i])
    })
    child.on('exit', function () {
      if (pool.get(key) === p) { pool.delete(key); if (p.reap) clearTimeout(p.reap) }
    })
    child.on('error', function () {
      if (pool.get(key) === p) { pool.delete(key); if (p.reap) clearTimeout(p.reap) }
    })
    p.reap = setTimeout(function () { if (pool.get(key) === p) disposePooled(key) }, POOL_IDLE_MS)
    if (p.reap && (p.reap as { unref?: () => void }).unref) (p.reap as { unref: () => void }).unref()
    pool.set(key, p)
    return { ok: true, warm: 'spawned' }
  }

  /** The pooled child for this key, removed from the pool, or null. */
  function take(key: string): Pooled | null {
    var p = pool.get(key)
    if (!p) return null
    pool.delete(key)
    if (p.reap) clearTimeout(p.reap)
    p.reap = null
    if (!alive(p.child)) return null
    p.taken = true
    return p
  }

  function finish(run: Run, code: number | null, signal: string | null, error: string | undefined): void {
    if (run.exited) return
    run.exited = true
    if (run.grace) clearTimeout(run.grace)
    if (run.backstop) clearTimeout(run.backstop)
    if (runs.get(run.id) === run) runs.delete(run.id)
    var data: Record<string, unknown> = { runId: run.id, code: code, signal: signal, durationMs: now() - run.startedAt }
    if (error) data.error = error
    try { deps.send(run.ws, 'oneshot.exit', data) } catch (e) { /* socket gone */ }
  }

  function endInput(run: Run): void {
    if (run.inputEnded) return
    run.inputEnded = true
    try { if (run.child.stdin) run.child.stdin.end() } catch (e) { /* closed */ }
  }

  function run(ws: W, raw: Record<string, unknown>): { ok: true; runId: string; warm: boolean; pid?: number } {
    var id = str(raw.runId)
    if (!id) throw new Error('runId is required')
    if (runs.has(id)) throw new Error('run ' + id + ' already exists')
    var spec = cleanSpec(raw)
    var warmKey = str(raw.warmKey)
    var pooled = warmKey ? take(warmKey) : null
    var child = pooled ? pooled.child : spawnChild(spec)
    var state = { partial: pooled ? pooled.partial : '' }
    var r: Run = {
      id: id, ws: ws, child: child, startedAt: now(), stderrBytes: 0,
      grace: null, backstop: null, inputEnded: false, exited: false,
    }
    runs.set(id, r)
    var endOnResult = raw.endOnResult === true

    function deliver(lines: string[]): void {
      if (lines.length === 0) return
      try { deps.send(ws, 'oneshot.out', { runId: id, lines: lines }) } catch (e) { /* socket gone */ }
      if (!endOnResult || r.inputEnded) return
      for (var i = 0; i < lines.length; i++) {
        if (!isResultLine(lines[i])) continue
        endInput(r)
        r.grace = setTimeout(function () { if (!r.exited && r.child.exitCode === null) terminate(r.child) }, EXIT_GRACE_MS)
        break
      }
    }

    if (pooled && pooled.boot.length > 0) deliver(pooled.boot.splice(0))
    if (child.stdout) child.stdout.on('data', function (chunk) { deliver(splitLines(state, chunk)) })
    if (child.stderr) child.stderr.on('data', function (chunk) {
      if (r.stderrBytes >= STDERR_MAX) return
      var text = (typeof chunk === 'string' ? chunk : chunk.toString('utf8')).slice(0, STDERR_MAX - r.stderrBytes)
      r.stderrBytes += text.length
      try { deps.send(ws, 'oneshot.err', { runId: id, text: text }) } catch (e) { /* socket gone */ }
    })
    // 'close' comes after stdout drained, so the last lines are never cut off;
    // a grandchild still holding the pipe open delays it, so 'exit' plus a short
    // wait ends the run too.
    var exitCode: number | null = null
    var exitSignal: string | null = null
    var closeWait: ReturnType<typeof setTimeout> | null = null
    function settle(): void {
      if (closeWait) clearTimeout(closeWait)
      // stdout can still hold a last line without its newline.
      if (state.partial) { var last = state.partial; state.partial = ''; deliver([last]) }
      finish(r, exitCode, exitSignal, undefined)
    }
    child.on('exit', function (code: unknown, signal: unknown) {
      exitCode = typeof code === 'number' ? code : null
      exitSignal = typeof signal === 'string' ? signal : null
      if (!closeWait && !r.exited) closeWait = setTimeout(settle, CLOSE_WAIT_MS)
    })
    child.on('close', function (code: unknown, signal: unknown) {
      if (typeof code === 'number') exitCode = code
      if (typeof signal === 'string') exitSignal = signal
      settle()
    })
    child.on('error', function (err: unknown) {
      finish(r, null, null, err && (err as Error).message ? (err as Error).message : String(err))
    })
    var maxMs = typeof raw.maxMs === 'number' && raw.maxMs > 0 ? raw.maxMs : 0
    if (maxMs) r.backstop = setTimeout(function () {
      if (r.exited) return
      log('warn', 'oneshot run passed its backstop, killing it', { runId: id, maxMs: maxMs })
      signalChild(r.child, 'SIGKILL')
    }, maxMs)

    var input = str(raw.input)
    if (input && child.stdin) {
      try { child.stdin.write(input) } catch (e) { /* the exit event reports it */ }
    }
    if (raw.endInput === true) endInput(r)
    // The replacement for the next call boots while this one answers.
    if (warmKey) {
      try { prewarm(Object.assign({}, raw, { warmKey: warmKey })) } catch (e) { /* prewarming is an optimization */ }
    }
    var out: { ok: true; runId: string; warm: boolean; pid?: number } = { ok: true, runId: id, warm: !!pooled }
    if (typeof child.pid === 'number') out.pid = child.pid
    return out
  }

  function cancel(raw: Record<string, unknown>): { ok: true; found: boolean } {
    var r = runs.get(str(raw.runId))
    if (!r) return { ok: true, found: false }
    var sig = str(raw.signal) || 'SIGTERM'
    if (sig === 'end') endInput(r)
    else signalChild(r.child, sig)
    return { ok: true, found: true }
  }

  /** The socket that owned these runs closed: nobody reads them any more. */
  function dropClient(ws: W): number {
    var n = 0
    runs.forEach(function (r) {
      if (r.ws !== ws) return
      n++
      signalChild(r.child, 'SIGTERM')
      if (r.grace) clearTimeout(r.grace)
      r.grace = setTimeout(function () { if (r.child.exitCode === null) signalChild(r.child, 'SIGKILL') }, EXIT_GRACE_MS)
    })
    return n
  }

  function disposeAll(): void {
    pool.forEach(function (_p, key) { disposePooled(key) })
    runs.forEach(function (r) { signalChild(r.child, 'SIGTERM') })
  }

  function stats(): { runs: number; pool: number } {
    return { runs: runs.size, pool: pool.size }
  }

  return { run: run, prewarm: prewarm, cancel: cancel, dropClient: dropClient, disposeAll: disposeAll, stats: stats }
}
