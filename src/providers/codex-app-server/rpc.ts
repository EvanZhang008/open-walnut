/**
 * NDJSON JSON-RPC over the stdio of one `codex app-server` child.
 *
 * Every request carries a deadline (a provider that stops answering must never
 * hold a turn or a stop forever), server requests (approvals) are handed to one
 * handler that must answer, and the child's exit is reported at once: every
 * request still waiting fails with `exited`, so the worker can journal it as a
 * runtime error and the next turn starts a fresh process.
 *
 * stderr is counted, never quoted: it can carry configuration and credentials.
 */

import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { StringDecoder } from 'node:string_decoder'

const DEFAULT_REQUEST_TIMEOUT_MS = 60_000
const MAX_LINE_CHARS = 64 * 1024 * 1024
const CLOSE_GRACE_MS = 3_000

export class AppServerRpcError extends Error {
  constructor(
    message: string,
    readonly method: string,
    readonly code?: number,
    readonly data?: unknown,
    /** The request ran out of time (the peer may still act on it). */
    readonly timedOut = false,
    /** The app-server process ended before it answered. */
    readonly exited = false,
  ) {
    super(message)
    this.name = 'AppServerRpcError'
  }
}

export interface AppServerExit { code: number | null; signal: NodeJS.Signals | null; stderrBytes: number }

export interface AppServerRpcOptions {
  command: string
  args: string[]
  cwd: string
  env: NodeJS.ProcessEnv
  /** Run through the shell (a Windows shim); `command` is then the whole line. */
  shell?: boolean
  requestTimeoutMs?: number
  /** Answers one server request (an approval). Throwing answers it with an error. */
  onServerRequest?: (method: string, params: unknown) => Promise<unknown>
  onNotification?: (method: string, params: unknown) => void
  onExit?: (exit: AppServerExit) => void
  onStderr?: (bytes: number) => void
}

type Pending = {
  method: string
  resolve: (value: unknown) => void
  reject: (error: AppServerRpcError) => void
  timer: ReturnType<typeof setTimeout>
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value)

export class AppServerRpc {
  private child: ChildProcessWithoutNullStreams | null = null
  private pending = new Map<number, Pending>()
  private nextId = 1
  private exited: AppServerExit | null = null
  private stderrBytes = 0
  private readonly timeoutMs: number

  constructor(private readonly opts: AppServerRpcOptions) {
    this.timeoutMs = opts.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS
  }

  get pid(): number | undefined { return this.child?.pid }
  get alive(): boolean { return this.child !== null && this.exited === null }
  get exit(): AppServerExit | null { return this.exited }

  /** Spawn the child; resolves once it runs, rejects when it cannot start. */
  async start(): Promise<void> {
    // Not detached: the worker leads its process group, so a hard abort ends this child too.
    const child = spawn(this.opts.command, this.opts.args, {
      cwd: this.opts.cwd, env: this.opts.env, stdio: ['pipe', 'pipe', 'pipe'], shell: this.opts.shell === true, windowsHide: true,
    })
    this.child = child
    for (const stream of [child.stdin, child.stdout, child.stderr]) stream.on('error', () => {})
    await new Promise<void>((resolve, reject) => {
      child.once('spawn', resolve)
      child.once('error', reject)
    })
    // A later 'error' (a failed kill) must not crash the worker; the exit is seen by 'exit'.
    child.on('error', () => {})
    child.stderr.on('data', (chunk: Buffer) => {
      this.stderrBytes += chunk.length
      this.opts.onStderr?.(chunk.length)
    })
    const decoder = new StringDecoder('utf8')
    let carry = ''
    child.stdout.on('data', (chunk: Buffer) => {
      const text = carry + decoder.write(chunk)
      const lines = text.split('\n')
      carry = lines.pop() ?? ''
      if (carry.length > MAX_LINE_CHARS) carry = ''
      for (const line of lines) if (line.trim()) this.onLine(line)
    })
    child.once('exit', (code, signal) => {
      this.exited = { code, signal, stderrBytes: this.stderrBytes }
      const words = `codex app-server exited (${signal ? `signal ${signal}` : `code ${code}`})`
      for (const [id, p] of this.pending) {
        clearTimeout(p.timer)
        this.pending.delete(id)
        p.reject(new AppServerRpcError(`${words} before answering ${p.method}`, p.method, undefined, undefined, false, true))
      }
      this.opts.onExit?.(this.exited)
    })
  }

  request<T = unknown>(method: string, params: unknown, timeoutMs = this.timeoutMs): Promise<T> {
    if (!this.alive) {
      return Promise.reject(new AppServerRpcError(`codex app-server is not running (${method})`, method, undefined, undefined, false, true))
    }
    const id = this.nextId++
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new AppServerRpcError(`codex app-server did not answer ${method} within ${Math.round(timeoutMs / 1000)}s`, method, undefined, undefined, true))
      }, timeoutMs)
      this.pending.set(id, { method, resolve: resolve as (v: unknown) => void, reject, timer })
      this.write({ id, method, params })
    })
  }

  notify(method: string, params?: unknown): void {
    this.write(params === undefined ? { method } : { method, params })
  }

  /** stdin EOF ends app-server; a child that does not go is killed. */
  async close(): Promise<void> {
    const child = this.child
    if (!child || this.exited) return
    try { child.stdin.end() } catch { /* closed */ }
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => { try { child.kill('SIGKILL') } catch { /* gone */ } resolve() }, CLOSE_GRACE_MS)
      child.once('exit', () => { clearTimeout(timer); resolve() })
    })
  }

  /** Immediate end (the worker is going away). */
  kill(): void {
    if (this.child && !this.exited) try { this.child.kill('SIGKILL') } catch { /* gone */ }
  }

  private write(msg: Record<string, unknown>): void {
    if (!this.child || this.exited) return
    try { this.child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', ...msg })}\n`) } catch { /* exit reports */ }
  }

  private onLine(line: string): void {
    let msg: unknown
    try { msg = JSON.parse(line) } catch { return }
    if (!isRecord(msg)) return
    const hasId = msg.id !== undefined && msg.id !== null
    if (typeof msg.method === 'string') {
      if (!hasId) {
        try { this.opts.onNotification?.(msg.method, msg.params) } catch { /* a mapping bug never ends the stream */ }
        return
      }
      void this.answerServerRequest(msg.id, msg.method, msg.params)
      return
    }
    if (typeof msg.id !== 'number') return
    const p = this.pending.get(msg.id)
    if (!p) return
    this.pending.delete(msg.id)
    clearTimeout(p.timer)
    if (isRecord(msg.error)) {
      const err = msg.error
      p.reject(new AppServerRpcError(
        typeof err.message === 'string' && err.message ? err.message : `${p.method} failed`,
        p.method, typeof err.code === 'number' ? err.code : undefined, err.data,
      ))
      return
    }
    p.resolve(msg.result)
  }

  private async answerServerRequest(id: unknown, method: string, params: unknown): Promise<void> {
    const handler = this.opts.onServerRequest
    if (!handler) {
      this.write({ id, error: { code: -32601, message: `${method} is not supported by Walnut` } })
      return
    }
    try {
      const result = await handler(method, params)
      this.write({ id, result })
    } catch (error) {
      const code = (error as { code?: unknown } | null)?.code === -32601 ? -32601 : -32603
      this.write({ id, error: { code, message: error instanceof Error ? error.message : String(error) } })
    }
  }
}
