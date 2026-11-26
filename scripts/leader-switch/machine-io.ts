/**
 * How the cross-machine rehearsal reaches one machine: its files, the product's readers of its records, and its
 * processes, each an operation of machine-ops.ts. Two ways, one interface:
 *
 *   LOCAL    the machine is this computer: the operation runs in this process (rehearsal (a), and machines A and
 *            H of rehearsal (b))
 *   agent    the machine is another computer: the operation runs in machine-agent.ts there, one JSON line each
 *            way over the agent's stdin and stdout (an ssh channel; in the driver's own test, a local process)
 *
 * The rehearsal names a machine's places by their paths on that machine, so a path says where it is: `ioAt(p)`
 * is the agent of the machine whose root holds `p` (registerMachineRoot), else LOCAL. The shared checks of
 * rehearsal.ts read through it and run unchanged in both rehearsals.
 */
import path from 'node:path'
import type { ChildProcessWithoutNullStreams } from 'node:child_process'
import { runOp, type OpName, type OpResult, type Ops } from './machine-ops.js'

export interface MachineIO {
  /** 'local', or the agent's machine (for messages). */
  readonly where: string
  /** One operation of machine-ops.ts on that machine. */
  op<K extends OpName>(name: K, ...args: Parameters<Ops[K]>): Promise<OpResult<K>>
}

export const LOCAL: MachineIO = {
  where: 'local',
  op: (name, ...args) => runOp(name, args),
}

/** The line prefix of the agent's answers: anything else on its stdout (a module's own print) is only logged. */
export const AGENT_LINE = '\u0001RB '

/**
 * The agent's side of the channel: requests `{id, op, args}` to its stdin, answers `AGENT_LINE{id, ok, value|error}`
 * from its stdout. Its first answer (id 0) is its hello. Every pending request fails when it exits.
 */
export class AgentIO implements MachineIO {
  private next = 1
  private readonly pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void; op: string }>()
  private ended: string | null = null
  private buf = ''
  readonly hello: Promise<{ pid: number; bun: string; platform: string; cwd: string; repo: string }>

  constructor(readonly where: string, private readonly proc: ChildProcessWithoutNullStreams, private readonly log: (s: string) => void = () => {}) {
    let helloResolve: (v: unknown) => void = () => {}
    let helloReject: (e: Error) => void = () => {}
    this.hello = new Promise((res, rej) => { helloResolve = res as (v: unknown) => void; helloReject = rej }) as AgentIO['hello']
    this.pending.set(0, { resolve: helloResolve, reject: helloReject, op: 'hello' })
    proc.stdout.setEncoding('utf8')
    proc.stdout.on('data', (d: string) => {
      this.buf += d
      for (let i = this.buf.indexOf('\n'); i >= 0; i = this.buf.indexOf('\n')) {
        const line = this.buf.slice(0, i)
        this.buf = this.buf.slice(i + 1)
        this.onLine(line)
      }
    })
    proc.stderr.setEncoding('utf8')
    proc.stderr.on('data', (d: string) => { for (const l of d.split('\n')) if (l.trim()) this.log(`[agent ${where}] ${l}`) })
    proc.on('exit', (code, signal) => this.end(`the agent on ${where} exited (${code ?? signal})`))
    proc.on('error', (err) => this.end(`the agent on ${where} failed: ${err.message}`))
    proc.stdin.on('error', () => { /* its end is reported by exit */ })
  }

  private onLine(line: string): void {
    if (!line.startsWith(AGENT_LINE)) { if (line.trim()) this.log(`[agent ${this.where} stdout] ${line}`); return }
    let msg: { id: number; ok: boolean; value?: unknown; error?: string }
    try { msg = JSON.parse(line.slice(AGENT_LINE.length)) } catch { this.log(`[agent ${this.where}] unreadable answer: ${line.slice(0, 200)}`); return }
    const p = this.pending.get(msg.id)
    if (!p) return
    this.pending.delete(msg.id)
    if (msg.ok) p.resolve(msg.value)
    else p.reject(new Error(`${p.op} on ${this.where}: ${msg.error}`))
  }

  private end(why: string): void {
    if (this.ended) return
    this.ended = why
    for (const [, p] of this.pending) p.reject(new Error(`${p.op}: ${why}`))
    this.pending.clear()
  }

  /** Why the channel ended, or null while it is up. */
  get endedWhy(): string | null { return this.ended }

  op<K extends OpName>(name: K, ...args: Parameters<Ops[K]>): Promise<OpResult<K>> {
    if (this.ended) return Promise.reject(new Error(`${String(name)}: ${this.ended}`))
    const id = this.next++
    return new Promise<OpResult<K>>((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject, op: String(name) })
      this.proc.stdin.write(`${JSON.stringify({ id, op: name, args })}\n`)
    })
  }

  /** Ask the agent to stop what it keeps and end; resolves once it exited (or after `ms`, when it is ended by a signal). */
  async close(ms = 30_000): Promise<void> {
    if (this.ended) return
    const exited = new Promise<void>((r) => this.proc.once('exit', () => r()))
    await this.op('stopAllKept').catch(() => {})
    this.proc.stdin.end()
    const t = setTimeout(() => { try { this.proc.kill('SIGTERM') } catch { /* gone */ } }, ms)
    await exited
    clearTimeout(t)
  }
}

const roots: Array<{ root: string; io: MachineIO }> = []

/** Every path under `root` is on the machine `io` reaches. */
export function registerMachineRoot(root: string, io: MachineIO): () => void {
  const entry = { root: path.resolve(root), io }
  roots.push(entry)
  return () => { const i = roots.indexOf(entry); if (i >= 0) roots.splice(i, 1) }
}

/** The machine that holds `p`: a registered root's, else this computer. */
export function ioAt(p: string): MachineIO {
  const abs = path.resolve(p)
  for (const r of roots) if (abs === r.root || abs.startsWith(`${r.root}${path.sep}`)) return r.io
  return LOCAL
}
