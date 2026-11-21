/**
 * Child processes started off the main thread, for a daemon runtime inside a server's process
 * (experiment in_process_daemon). Starting a process blocks the thread that starts it until the
 * child has exec'd: measured with Bun 1.4.4, about 30 ms a start on Linux with an open-file limit of
 * 32768 (2.5 ms at 4096: the child closes every descriptor up to it) and 3 to 130 ms on a loaded
 * Mac. On the server's thread each one holds every request; in this pool's thread (one Worker) none.
 *
 * Two shapes, the ones the runtime starts all the time:
 *   - execFile(file, args, options, callback): a helper (git, ps, mkfifo). The callback gets what
 *     node's gives (error with code/killed/signal, stdout, stderr); the returned object stands in for
 *     the ChildProcess: pid once started, kill(), stdin write/end and its 'error', 'spawn', 'exit',
 *     'close', 'error' (a start that failed: 'error' then 'close', never 'exit', as from node).
 *     `signal` (an AbortSignal) is honoured here: an abort kills the child and answers AbortError.
 *   - spawnDetached(command, args, options): a session's CLI, whose stdio are descriptors this
 *     process opened (a descriptor is the process's, so the pool's thread passes it on as it is).
 *     Resolves once started, with its pid; 'exit' follows when it ends.
 * The umask a child gets is set by a shell in front of it (`umask 077; exec ...`), never by the
 * pool: a umask is the whole process's, and the server's own thread runs meanwhile.
 *
 * The pool's thread survives its children: a child's EPIPE goes to the caller's `stdin.on('error')`
 * (dropped when none, never thrown), any other stray throw to onError. Should the thread end anyway,
 * what still waits is answered POOL_WORKER_DIED (see giveUp), onError hears it, and the next call
 * starts a new thread; a detached child that runs on is followed by its pid until it ends (see
 * followLost). A message of the thread that cannot be read is told to onError; the thread runs on.
 *
 * The Worker's code is the text below, loaded from a blob: no build entry of its own.
 */
import { EventEmitter } from 'node:events'
import fsp from 'node:fs/promises'

type Signal = NodeJS.Signals | number
type Callback = (error: Error | null, stdout: unknown, stderr: unknown) => void
type Send = (msg: Record<string, unknown>) => void

interface Pending { child: PooledChild; callback?: Callback; started?: () => void; failed?: (error: Error) => void; unwatch?: () => void }

/** Text crosses as it is; bytes as a compact copy (a Buffer's view would clone its whole slab). */
const bytesOf = (chunk: unknown): unknown =>
  ArrayBuffer.isView(chunk) ? new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength).slice() : String(chunk)

/** A pooled child's stdin: write/end reach the child; its 'error' (EPIPE) comes back here. */
export class PooledStdin extends EventEmitter {
  constructor(private readonly send: Send, private readonly id: number) { super() }
  write(chunk: unknown): boolean { this.send({ op: 'stdin', id: this.id, data: bytesOf(chunk) }); return true }
  end(chunk?: unknown): this { if (chunk != null) this.write(chunk); this.send({ op: 'stdin-end', id: this.id }); return this }
}

/** What a pooled child shows the caller (the parts of a ChildProcess the runtime uses). */
export class PooledChild extends EventEmitter {
  pid: number | undefined = undefined
  exitCode: number | null = null
  signalCode: NodeJS.Signals | null = null
  killed = false
  /** Its end is known (or it never started): kill() has nothing to reach. */
  ended = false
  /** Its pool's thread is gone while it runs on: kill() signals its pid itself. */
  lost = false
  readonly stdout = null
  readonly stderr = null
  readonly stdin: PooledStdin
  constructor(private readonly send: Send, readonly id: number) { super(); this.stdin = new PooledStdin(send, id) }
  /** As node's: false for a child that already ended. */
  kill(signal: Signal = 'SIGTERM'): boolean {
    if (this.ended) return false
    if (this.lost) {
      if (!this.pid || this.pid <= 1) return false
      try { process.kill(this.pid!, signal); this.killed = true; return true } catch { return false }
    }
    this.killed = true
    this.send({ op: 'kill', id: this.id, signal })
    return true
  }
  ref(): this { return this }
  unref(): this { return this }
}

const WORKER_SOURCE = String.raw`
const cp = require('node:child_process')
const fs = require('node:fs')
const path = require('node:path')
const children = new Map()
const errorOf = (err) => err && ({ message: err.message, code: err.code, killed: err.killed, signal: err.signal, cmd: err.cmd, errno: err.errno, syscall: err.syscall, path: err.path })
// A throw nothing below caught would end this thread, and with it the following of every child:
// told to the pool instead, and the thread runs on.
process.on('uncaughtException', (err) => postMessage({ op: 'fault', error: errorOf(err) }))
process.on('unhandledRejection', (err) => postMessage({ op: 'fault', error: errorOf(err instanceof Error ? err : new Error(String(err))) }))
// The program as the shell will exec it: a missing one is ENOENT, as node's own spawn says, never
// the shell's exit 127; one that is there but cannot run (no execute bit, a directory) is EACCES, as
// node says too (a PATH search goes on past it, and says EACCES only when nothing later runs). A
// relative path (and a relative PATH entry) is the child's cwd's, as for exec.
const resolveExe = (file, env, cwd) => {
  const check = (p) => {
    let st
    try { st = fs.statSync(p) } catch { return 'ENOENT' }
    if (!st.isFile()) return 'EACCES'
    try { fs.accessSync(p, fs.constants.X_OK); return 'ok' } catch { return 'EACCES' }
  }
  const base = cwd || process.cwd()
  if (file.includes('/')) { const p = path.resolve(base, file); const r = check(p); return r === 'ok' ? { exe: p } : { code: r } }
  let code = 'ENOENT'
  for (const dir of String((env && env.PATH) || process.env.PATH || '').split(':')) {
    const p = dir && path.resolve(base, dir, file)
    if (!p) continue
    const r = check(p)
    if (r === 'ok') return { exe: p }
    if (r === 'EACCES') code = 'EACCES'
  }
  return { code }
}
const ERRNO = { ENOENT: -2, EACCES: -13 }
const spawnError = (file, code) => Object.assign(new Error('spawn ' + file + ' ' + code), { code, errno: ERRNO[code], syscall: 'spawn ' + file, path: file })
const umasked = (umask, file, args, options) => {
  if (umask == null) return [file, args]
  const found = resolveExe(file, options && options.env, options && options.cwd)
  if (!found.exe) throw spawnError(file, found.code)
  return ['/bin/sh', ['-c', 'umask ' + umask.toString(8).padStart(3, '0') + ' && exec "$0" "$@"', found.exe, ...args]]
}
// Every stream of a child has a listener: an EPIPE is that child's matter, never this thread's end.
const guard = (id, child) => {
  if (child.stdin) child.stdin.on('error', (err) => postMessage({ op: 'stdin-error', id, error: errorOf(err) }))
  if (child.stdout) child.stdout.on('error', () => {})
  if (child.stderr) child.stderr.on('error', () => {})
}
const handle = (m) => {
  if (m.op === 'execFile') {
    let child
    try {
      const [file, args] = umasked(m.umask, m.file, m.args, m.options)
      child = cp.execFile(file, args, m.options, (err, stdout, stderr) => {
        children.delete(m.id)
        postMessage({ op: 'done', id: m.id, error: errorOf(err), stdout, stderr, exitCode: child.exitCode, signalCode: child.signalCode, spawnFailed: !child.pid })
      })
    } catch (err) { postMessage({ op: 'done', id: m.id, error: errorOf(err), stdout: '', stderr: '', spawnFailed: true }); return }
    children.set(m.id, child)
    guard(m.id, child)
    if (child.pid) postMessage({ op: 'spawn', id: m.id, pid: child.pid })
  } else if (m.op === 'spawnDetached') {
    let child
    try { const [file, args] = umasked(m.umask, m.command, m.args, m.options); child = cp.spawn(file, args, m.options) } catch (err) { postMessage({ op: 'failed', id: m.id, error: errorOf(err) }); return }
    guard(m.id, child)
    if (!child.pid) {
      // Why comes as 'error' (ENOENT, EACCES): wait for it, briefly.
      let told = false
      const fail = (error) => { if (!told) { told = true; postMessage({ op: 'failed', id: m.id, error }) } }
      child.on('error', (err) => fail(errorOf(err)))
      setTimeout(() => fail({ message: 'spawn failed: no pid' }), 1000)
      return
    }
    children.set(m.id, child)
    postMessage({ op: 'spawn', id: m.id, pid: child.pid })
    child.on('error', (err) => postMessage({ op: 'error', id: m.id, error: errorOf(err) }))
    child.on('exit', (code, signal) => { children.delete(m.id); postMessage({ op: 'exit', id: m.id, code, signal }) })
    child.unref()
  } else if (m.op === 'kill') {
    try { children.get(m.id)?.kill(m.signal) } catch {}
  } else if (m.op === 'stdin') {
    try { children.get(m.id)?.stdin?.write(m.data) } catch {}
  } else if (m.op === 'stdin-end') {
    try { children.get(m.id)?.stdin?.end() } catch {}
  }
}
self.onmessage = (event) => {
  const m = event.data
  try { handle(m) } catch (err) { postMessage({ op: 'fault', id: m && m.id, error: errorOf(err) }) }
}
`

/** One blob for every Worker this process starts (a pool's next one after a death too). */
let workerUrl: string | null = null

/** Options that cross to the pool's thread: plain values only (no streams, no AbortSignal, no functions). */
function plainOptions(options: Record<string, unknown> | undefined): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(options ?? {})) {
    if (v === undefined || typeof v === 'function' || k === 'signal') continue
    if (k === 'env' && v && typeof v === 'object') {
      out.env = Object.fromEntries(Object.entries(v as Record<string, unknown>).filter(([, x]) => typeof x === 'string'))
      continue
    }
    out[k] = v
  }
  return out
}

function errorFrom(e: Record<string, unknown>): Error {
  return Object.assign(new Error(String(e.message ?? 'child process failed')), Object.fromEntries(Object.entries(e).filter(([k, v]) => k !== 'message' && v !== undefined)))
}
const poolError = (message: string, code: string) => Object.assign(new Error(message), { code })
const abortError = (signal: AbortSignal) =>
  Object.assign(new Error('The operation was aborted', { cause: signal.reason }), { name: 'AbortError', code: 'ABORT_ERR' })
/** Bytes cross the thread as a plain Uint8Array: a caller of encoding 'buffer' gets a Buffer, as from node. */
const asBuffer = (v: unknown) => (v instanceof Uint8Array && !Buffer.isBuffer(v) ? Buffer.from(v.buffer, v.byteOffset, v.byteLength) : v)
const emitError = (target: EventEmitter, error: Error) => { if (target.listenerCount('error') > 0) target.emit('error', error) }

/** How often a lost child (see followLost) is checked for its end. */
export const LOST_POLL_MS = 1000

/**
 * Linux: has `pid` ended? Its /proc stat says Z (a zombie: ended, not reaped) or X, or is gone; a
 * different start time than first seen is a new process under a reused pid. `null`: unknown.
 */
async function procEnded(pid: number, seen: { start?: string }): Promise<boolean | null> {
  let stat: string
  try { stat = await fsp.readFile(`/proc/${pid}/stat`, 'utf8') } catch (err) {
    const code = (err as NodeJS.ErrnoException).code
    return code === 'ENOENT' || code === 'ESRCH' ? true : null
  }
  // "pid (comm) state ppid ...": comm may hold spaces and parens, so fields count from the last ')'.
  const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ')
  const state = fields[0]
  const start = fields[19] // field 22, starttime
  if (state === 'Z' || state === 'X') return true
  if (seen.start === undefined) seen.start = start
  return seen.start !== start
}

export interface SpawnPool {
  /** node's execFile, started on the pool's thread. */
  execFile(file: string, args: string[], options: Record<string, unknown> | undefined, callback?: Callback): PooledChild
  /** A child whose stdio are descriptors (or 'ignore'), detached: resolves started, with its pid. */
  spawnDetached(command: string, args: string[], options: Record<string, unknown>): Promise<PooledChild>
  /** Children still followed. */
  readonly pending: number
  /** Ends the pool's thread: what still waits is answered POOL_CLOSED, helpers are killed, detached children run on (no longer followed). */
  close(): void
  /** @internal Tests only: ends the pool's thread as a crash would. */
  __terminateWorkerForTest(): void
}

export interface SpawnPoolOptions {
  umask: number | null
  onError?: (err: unknown) => void
  /** @internal How a lost child's end is checked (default: 'proc' on Linux, 'ps' elsewhere); tests pick one. */
  endCheck?: 'proc' | 'ps'
}

export function createSpawnPool(opts: SpawnPoolOptions = { umask: null }): SpawnPool {
  let worker: Worker | null = null
  let nextId = 0
  const pending = new Map<number, Pending>()
  const send: Send = (msg) => { worker?.postMessage(msg) }
  const report = (err: unknown) => { try { opts.onError?.(err) } catch { /* the reporter's own */ } }
  const endCheck = opts.endCheck ?? (process.platform === 'linux' ? 'proc' : 'ps')

  /**
   * Detached children whose pool thread died while they ran. Only that thread could reap one, so
   * when it ends it stays a zombie of this process, and kill(pid, 0) (the daemon's own check of a
   * pid) still says it lives. So the pool watches them itself, every LOST_POLL_MS while there are
   * any (an unref'd clock), with a check that counts a zombie as ended (Linux: /proc/<pid>/stat;
   * elsewhere `ps -o stat=`, run through this pool, never on this thread), and tells 'exit' then
   * 'close' (code and signal null: unknown). Nothing here can reap the zombie (JS has no waitpid):
   * its process-table entry stays until this process exits, holding nothing but its pid.
   */
  const lost = new Map<PooledChild, { start?: string }>()
  let lostClock: ReturnType<typeof setInterval> | null = null
  let checking = false
  let checkFailureTold = false
  const unfollow = (child: PooledChild) => {
    lost.delete(child)
    if (!lost.size && lostClock) { clearInterval(lostClock); lostClock = null }
  }
  const psEnded = (pid: number) => new Promise<boolean | null>((resolve) => {
    pool.execFile('ps', ['-o', 'stat=', '-p', String(pid)], { encoding: 'utf8', timeout: 5000 }, (error, stdout) => {
      const out = String(stdout ?? '').trim()
      // ps exits 1 with nothing printed for a pid that is not there.
      if (error) resolve((error as { code?: unknown }).code === 1 && !out ? true : null)
      else resolve(out.startsWith('Z'))
    })
  })
  const checkLost = async () => {
    if (checking) return
    checking = true
    try {
      await Promise.all([...lost].map(async ([child, seen]) => {
        const ended = endCheck === 'proc' ? await procEnded(child.pid!, seen) : await psEnded(child.pid!)
        if (!lost.has(child)) return // closed meanwhile
        if (ended === null) {
          if (!checkFailureTold) { checkFailureTold = true; report(poolError(`the spawn pool could not check whether lost child ${child.pid} ended; it checks again`, 'POOL_LOST_CHECK_FAILED')) }
          return
        }
        if (!ended) return
        unfollow(child)
        child.ended = true
        try {
          child.emit('exit', null, null)
          child.emit('close', null, null)
        } catch (err) { report(err) }
      }))
    } catch (err) { report(err) } finally { checking = false }
  }
  const followLost = (child: PooledChild) => {
    lost.set(child, {})
    if (lostClock) return
    lostClock = setInterval(() => { void checkLost() }, LOST_POLL_MS)
    ;(lostClock as { unref?: () => void }).unref?.()
  }
  /** The call is no longer followed (`ended`: its end is known, or it never started). */
  const settle = (id: number, p: Pending, ended: boolean) => {
    pending.delete(id)
    p.unwatch?.()
    if (ended) p.child.ended = true
  }

  /**
   * Answers a call the pool's thread will not answer (the pool closed, the thread died, a throw
   * there). A helper (execFile) still running is killed and its callback gets the error. A detached
   * child not yet started rejects. One already started runs on: the thread can no longer tell its
   * end, so it gets 'error' (unless `quiet`), kill() then signals its pid directly, and the pool
   * follows the pid itself (followLost) to tell its 'exit' when it ends. Not after close() (`quiet`):
   * a closed pool follows nothing, and its detached children run on for the next runtime to adopt.
   */
  const giveUp = (id: number, p: Pending, error: Error, quiet = false) => {
    const { child } = p
    const running = child.pid !== undefined
    settle(id, p, !(p.failed && running))
    if (p.failed && running) {
      child.lost = true
      if (!quiet) { followLost(child); emitError(child, error) }
      return
    }
    if (running && (child.pid ?? 0) > 1) { try { process.kill(child.pid!, 'SIGTERM') } catch { /* gone */ } }
    if (p.failed) { p.failed(error); return }
    emitError(child, error)
    p.callback?.(error, '', '')
  }

  const done = (id: number, p: Pending, m: Record<string, unknown>) => {
    settle(id, p, true)
    const { child } = p
    const error = m.error ? errorFrom(m.error as Record<string, unknown>) : null
    const stdout = asBuffer(m.stdout)
    const stderr = asBuffer(m.stderr)
    if (m.spawnFailed) {
      // As from node: 'error', then 'close' with the negative errno; never 'exit'.
      const errno = (error as { errno?: unknown } | null)?.errno
      child.exitCode = typeof errno === 'number' ? errno : null
      if (error) emitError(child, error)
      p.callback?.(error, stdout, stderr)
      child.emit('close', child.exitCode, null)
      return
    }
    child.exitCode = (m.exitCode as number | null) ?? null
    child.signalCode = (m.signalCode as NodeJS.Signals | null) ?? null
    child.emit('exit', child.exitCode, child.signalCode)
    p.callback?.(error, stdout, stderr)
    child.emit('close', child.exitCode, child.signalCode)
  }

  const onMessage = (event: MessageEvent) => {
    const m = event.data as Record<string, unknown> & { id: number }
    const p = pending.get(m.id)
    try {
      if (m.op === 'fault') {
        // A throw while starting this call answers it; any other is only told.
        if (p && p.child.pid === undefined) giveUp(m.id, p, errorFrom(m.error as Record<string, unknown>))
        else report(errorFrom(m.error as Record<string, unknown>))
        return
      }
      if (!p) return
      if (m.op === 'spawn') {
        p.child.pid = m.pid as number
        p.child.emit('spawn')
        p.started?.()
      } else if (m.op === 'done') done(m.id, p, m)
      else if (m.op === 'failed') {
        settle(m.id, p, true)
        p.failed?.(errorFrom(m.error as Record<string, unknown>))
      } else if (m.op === 'error') emitError(p.child, errorFrom(m.error as Record<string, unknown>))
      else if (m.op === 'stdin-error') emitError(p.child.stdin, errorFrom(m.error as Record<string, unknown>))
      else if (m.op === 'exit') {
        settle(m.id, p, true)
        p.child.exitCode = (m.code as number | null) ?? null
        p.child.signalCode = (m.signal as NodeJS.Signals | null) ?? null
        p.child.emit('exit', p.child.exitCode, p.child.signalCode)
        p.child.emit('close', p.child.exitCode, p.child.signalCode)
      }
    } catch (err) { report(err) }
  }

  /** The thread ended (or a message of it was lost): answer everything, start anew on the next call. */
  const died = (w: Worker, why: string) => {
    if (worker !== w) return
    worker = null
    try { w.terminate() } catch { /* already gone */ }
    const error = poolError(`the spawn pool's thread ended (${why}); the next call starts a new one`, 'POOL_WORKER_DIED')
    for (const [id, p] of [...pending]) { try { giveUp(id, p, error) } catch (err) { report(err) } }
    report(error)
  }

  const ensure = () => {
    if (worker) return
    workerUrl ??= URL.createObjectURL(new Blob([WORKER_SOURCE], { type: 'application/javascript' }))
    const w = new Worker(workerUrl)
    ;(w as unknown as { unref?: () => void }).unref?.()
    w.onmessage = onMessage
    w.addEventListener('error', (e) => { e.preventDefault(); died(w, `error: ${(e as ErrorEvent).message}`) })
    // One unreadable message is told, never the end of a thread every child depends on.
    w.addEventListener('messageerror', () => report(poolError("a message of the spawn pool's thread could not be read; the call it answered may wait on", 'POOL_MESSAGE_UNREADABLE')))
    w.addEventListener('close', () => died(w, 'it closed'))
    worker = w
  }

  /** An abort kills the child (with its killSignal) and answers AbortError, as node's does. */
  const watchAbort = (id: number, child: PooledChild, options: Record<string, unknown> | undefined) => {
    const signal = options?.signal as AbortSignal | undefined
    if (!signal) return undefined
    const onAbort = () => {
      child.kill((options?.killSignal as Signal | undefined) ?? 'SIGTERM')
      const error = abortError(signal)
      emitError(child, error)
      const p = pending.get(id)
      if (p?.callback) { const callback = p.callback; p.callback = undefined; callback(error, '', '') }
    }
    signal.addEventListener('abort', onAbort, { once: true })
    return () => signal.removeEventListener('abort', onAbort)
  }

  const pool: SpawnPool = {
    execFile(file, args, options, callback) {
      const id = ++nextId
      const child = new PooledChild(send, id)
      const signal = options?.signal as AbortSignal | undefined
      if (signal?.aborted) {
        // Aborted before it began: nothing runs, and the answer comes on the next tick.
        child.ended = true
        process.nextTick(() => { const error = abortError(signal); emitError(child, error); callback?.(error, '', '') })
        return child
      }
      ensure()
      pending.set(id, { child, callback, unwatch: watchAbort(id, child, options) })
      send({ op: 'execFile', id, file, args, options: plainOptions(options), umask: opts.umask })
      return child
    },
    spawnDetached(command, args, options) {
      const signal = options.signal as AbortSignal | undefined
      if (signal?.aborted) return Promise.reject(abortError(signal))
      ensure()
      const id = ++nextId
      const child = new PooledChild(send, id)
      return new Promise((resolve, reject) => {
        pending.set(id, { child, started: () => resolve(child), failed: reject, unwatch: watchAbort(id, child, options) })
        send({ op: 'spawnDetached', id, command, args, options: plainOptions(options), umask: opts.umask })
      })
    },
    get pending() { return pending.size },
    close() {
      const w = worker
      worker = null
      const error = poolError('the spawn pool closed', 'POOL_CLOSED')
      for (const [id, p] of [...pending]) { try { giveUp(id, p, error, true) } catch { /* the caller's own */ } }
      for (const child of [...lost.keys()]) unfollow(child)
      w?.terminate()
    },
    __terminateWorkerForTest() { worker?.terminate() },
  }
  return pool
}
