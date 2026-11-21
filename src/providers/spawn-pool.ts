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
 *     the ChildProcess: pid once started, kill(), stdin write/end, 'spawn', 'exit', 'close', 'error'.
 *   - spawnDetached(command, args, options): a session's CLI, whose stdio are descriptors this
 *     process opened (a descriptor is the process's, so the pool's thread passes it on as it is).
 *     Resolves once started, with its pid; 'exit' follows when it ends.
 * The umask a child gets is set by a shell in front of it (`umask 077; exec ...`), never by the
 * pool: a umask is the whole process's, and the server's own thread runs meanwhile.
 *
 * The Worker's code is the text below, loaded from a blob: no build entry of its own.
 */
import { EventEmitter } from 'node:events'

type Signal = NodeJS.Signals | number

interface Pending { child: PooledChild; callback?: (error: Error | null, stdout: unknown, stderr: unknown) => void; started?: (pid: number) => void; failed?: (error: Error) => void }

/** What a pooled child shows the caller (the parts of a ChildProcess the runtime uses). */
export class PooledChild extends EventEmitter {
  pid: number | undefined = undefined
  exitCode: number | null = null
  signalCode: NodeJS.Signals | null = null
  killed = false
  readonly stdout = null
  readonly stderr = null
  readonly stdin: { write(chunk: unknown): boolean; end(chunk?: unknown): void; on(): unknown; once(): unknown }
  constructor(private readonly send: (msg: Record<string, unknown>) => void, readonly id: number) {
    super()
    const toText = (chunk: unknown) => (typeof chunk === 'string' ? chunk : Buffer.from(chunk as Uint8Array).toString('utf8'))
    this.stdin = {
      write: (chunk) => { send({ op: 'stdin', id, data: toText(chunk) }); return true },
      end: (chunk) => { if (chunk != null) send({ op: 'stdin', id, data: toText(chunk) }); send({ op: 'stdin-end', id }) },
      on: () => this.stdin,
      once: () => this.stdin,
    }
  }
  kill(signal: Signal = 'SIGTERM'): boolean {
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
// The program as the shell will exec it: a missing one is ENOENT, as node's own spawn says, never
// the shell's exit 127.
const resolveExe = (file, env) => {
  const ok = (p) => { try { fs.accessSync(p, fs.constants.X_OK); return fs.statSync(p).isFile() } catch { return false } }
  if (file.includes('/')) return ok(file) ? file : null
  for (const dir of String((env && env.PATH) || process.env.PATH || '').split(':')) if (dir && ok(path.join(dir, file))) return path.join(dir, file)
  return null
}
const enoent = (file) => Object.assign(new Error('spawn ' + file + ' ENOENT'), { code: 'ENOENT', errno: -2, syscall: 'spawn ' + file, path: file })
const umasked = (umask, file, args, options) => {
  if (umask == null) return [file, args]
  const exe = resolveExe(file, options && options.env)
  if (!exe) throw enoent(file)
  return ['/bin/sh', ['-c', 'umask ' + umask.toString(8).padStart(3, '0') + ' && exec "$0" "$@"', exe, ...args]]
}
const errorOf = (err) => err && ({ message: err.message, code: err.code, killed: err.killed, signal: err.signal, cmd: err.cmd, errno: err.errno, syscall: err.syscall, path: err.path })
self.onmessage = (event) => {
  const m = event.data
  if (m.op === 'execFile') {
    let child
    try {
      const [file, args] = umasked(m.umask, m.file, m.args, m.options)
      child = cp.execFile(file, args, m.options, (err, stdout, stderr) => {
        children.delete(m.id)
        postMessage({ op: 'done', id: m.id, error: errorOf(err), stdout, stderr, exitCode: child.exitCode, signalCode: child.signalCode })
      })
    } catch (err) { postMessage({ op: 'done', id: m.id, error: errorOf(err), stdout: '', stderr: '', thrown: true }); return }
    children.set(m.id, child)
    if (child.pid) postMessage({ op: 'spawn', id: m.id, pid: child.pid })
    child.on('error', () => {})
  } else if (m.op === 'spawnDetached') {
    let child
    try { const [file, args] = umasked(m.umask, m.command, m.args, m.options); child = cp.spawn(file, args, m.options) } catch (err) { postMessage({ op: 'failed', id: m.id, error: errorOf(err) }); return }
    if (!child.pid) { child.on('error', () => {}); postMessage({ op: 'failed', id: m.id, error: { message: 'spawn failed: no pid' } }); return }
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
`

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

export interface SpawnPool {
  /** node's execFile, started on the pool's thread. */
  execFile(file: string, args: string[], options: Record<string, unknown> | undefined, callback?: (error: Error | null, stdout: unknown, stderr: unknown) => void): PooledChild
  /** A child whose stdio are descriptors (or 'ignore'), detached: resolves started, with its pid. */
  spawnDetached(command: string, args: string[], options: Record<string, unknown>): Promise<PooledChild>
  /** Children still followed. */
  readonly pending: number
  /** Ends the pool's thread (children already started run on). */
  close(): void
}

export function createSpawnPool(opts: { umask: number | null; onError?: (err: unknown) => void } = { umask: null }): SpawnPool {
  let worker: Worker | null = null
  let nextId = 0
  const pending = new Map<number, Pending>()
  const send = (msg: Record<string, unknown>) => { worker?.postMessage(msg) }
  const ensure = (): Worker => {
    if (worker) return worker
    const url = URL.createObjectURL(new Blob([WORKER_SOURCE], { type: 'application/javascript' }))
    const w = new Worker(url)
    ;(w as unknown as { unref?: () => void }).unref?.()
    w.onmessage = (event: MessageEvent) => {
      const m = event.data as Record<string, unknown> & { id: number }
      const p = pending.get(m.id)
      if (!p) return
      try {
        if (m.op === 'spawn') {
          p.child.pid = m.pid as number
          p.child.emit('spawn')
          p.started?.(m.pid as number)
        } else if (m.op === 'done') {
          pending.delete(m.id)
          p.child.exitCode = (m.exitCode as number | null) ?? null
          p.child.signalCode = (m.signalCode as NodeJS.Signals | null) ?? null
          const error = m.error ? errorFrom(m.error as Record<string, unknown>) : null
          // As from node's execFile, whose own listener takes the error: an emit with none would throw.
          if (error && m.thrown && p.child.listenerCount('error') > 0) p.child.emit('error', error)
          if (!m.thrown) p.child.emit('exit', p.child.exitCode, p.child.signalCode)
          // Bytes cross the thread as a plain Uint8Array: a caller of encoding 'buffer' gets a Buffer, as from node.
          const bytes = (v: unknown) => (v instanceof Uint8Array && !Buffer.isBuffer(v) ? Buffer.from(v.buffer, v.byteOffset, v.byteLength) : v)
          p.callback?.(error, bytes(m.stdout), bytes(m.stderr))
          if (!m.thrown) p.child.emit('close', p.child.exitCode, p.child.signalCode)
        } else if (m.op === 'failed') {
          pending.delete(m.id)
          p.failed?.(errorFrom(m.error as Record<string, unknown>))
        } else if (m.op === 'error') {
          if (p.child.listenerCount('error') > 0) p.child.emit('error', errorFrom(m.error as Record<string, unknown>))
        } else if (m.op === 'exit') {
          pending.delete(m.id)
          p.child.exitCode = (m.code as number | null) ?? null
          p.child.signalCode = (m.signal as NodeJS.Signals | null) ?? null
          p.child.emit('exit', p.child.exitCode, p.child.signalCode)
        }
      } catch (err) { opts.onError?.(err) }
    }
    worker = w
    return w
  }
  return {
    execFile(file, args, options, callback) {
      ensure()
      const id = ++nextId
      const child = new PooledChild(send, id)
      pending.set(id, { child, callback })
      send({ op: 'execFile', id, file, args, options: plainOptions(options), umask: opts.umask })
      return child
    },
    spawnDetached(command, args, options) {
      ensure()
      const id = ++nextId
      const child = new PooledChild(send, id)
      return new Promise((resolve, reject) => {
        pending.set(id, { child, started: () => resolve(child), failed: reject })
        send({ op: 'spawnDetached', id, command, args, options: plainOptions(options), umask: opts.umask })
      })
    },
    get pending() { return pending.size },
    close() {
      for (const p of pending.values()) {
        try { p.callback?.(Object.assign(new Error('the spawn pool closed'), { code: 'POOL_CLOSED' }), '', '') } catch { /* the caller's own */ }
        try { p.failed?.(new Error('the spawn pool closed')) } catch { /* the same */ }
      }
      pending.clear()
      worker?.terminate()
      worker = null
    },
  }
}
