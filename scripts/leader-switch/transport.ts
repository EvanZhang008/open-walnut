/**
 * How rehearsal (b)'s driver (real-world.ts, in the dev container) reaches the other machine: a shell command
 * there, a long-lived process there with its stdin and stdout (the agent), and the TCP links between the two
 * loopbacks. Each link keeps ONE port number on both machines (a door URL in the config is read on both), so:
 *
 *   forward(P)   the driver's 127.0.0.1:P reaches the other machine's 127.0.0.1:P
 *   reverse(P)   the other machine's 127.0.0.1:P reaches the driver's 127.0.0.1:P
 *
 * SshTransport: every command is an ssh client of ONE master connection a person opened on the clouddev host
 * (real/ssh-master.sh), through its control socket. The clients never authenticate and never connect on their own
 * (ProxyCommand=/bin/false: a client that finds no master fails at once). The dev container has its own network,
 * so a link is two hops: forward(P) is a relay on the container's 127.0.0.1:P to the host's docker bridge
 * address, where the master's `-L <bridge>:P:127.0.0.1:P` listens; reverse(P) is the master's
 * `-R 127.0.0.1:P:<container>:P` to a relay on the container's own address, which passes to 127.0.0.1:P.
 *
 * FakeTransport: the driver's own test of itself, with no other machine: a command runs here in a shell (env
 * cleared, cwd /), and the "other machine" is a folder of this computer. Its loopback IS this loopback, so a link
 * is nothing to do: the other side's processes listen and dial on the same 127.0.0.1:P.
 */
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import net from 'node:net'
import os from 'node:os'
import fs from 'node:fs'
import type { Readable } from 'node:stream'

export interface ShResult { code: number | null; out: string; err: string }

export interface Transport {
  /** For messages: `ssh <host>` or `fake (this computer)`. */
  readonly label: string
  /** The other machine's loopback is this one (FakeTransport): links need nothing. */
  readonly sharedLoopback: boolean
  /** A /bin/sh script there; `input` is its stdin (a stream, or bytes). */
  sh(script: string, o?: { input?: Readable | Buffer | string; timeoutMs?: number; args?: string[] }): Promise<ShResult>
  /** A /bin/sh script there that keeps running, its stdin and stdout piped to here (the agent). */
  spawn(script: string): ChildProcessWithoutNullStreams
  forward(port: number): Promise<void>
  /** A forward(port) closed again: the master's forward cancelled and its relay closed. */
  unforward(port: number): Promise<void>
  reverse(port: number): Promise<void>
  /** Every link closed; the master connection too when `master` (SshTransport). */
  close(o?: { master?: boolean }): Promise<void>
}

/** Single quotes for /bin/sh (and zsh, bash): the argument as one word. */
export const shq = (s: string): string => `'${s.replace(/'/g, `'\\''`)}'`

function collect(child: ChildProcessWithoutNullStreams, o: { input?: Readable | Buffer | string; timeoutMs?: number }): Promise<ShResult> {
  return new Promise((resolve) => {
    let out = ''
    let err = ''
    child.stdout.setEncoding('utf8').on('data', (d: string) => { out += d })
    child.stderr.setEncoding('utf8').on('data', (d: string) => { err += d })
    const t = o.timeoutMs ? setTimeout(() => { err += `\n(timed out after ${o.timeoutMs} ms)`; child.kill('SIGTERM') }, o.timeoutMs) : null
    child.on('close', (code) => { if (t) clearTimeout(t); resolve({ code, out, err }) })
    child.on('error', (e) => { err += e.message })
    child.stdin.on('error', () => { /* the script ended before it read all its input */ })
    if (o.input === undefined) child.stdin.end()
    else if (typeof o.input === 'string' || Buffer.isBuffer(o.input)) child.stdin.end(o.input)
    else o.input.pipe(child.stdin)
  })
}

/**
 * A TCP relay: listen on `host:port`, each connection piped to `toHost:toPort`. Half open both ways, as ssh's own
 * forward is: one side's end is passed on, and the other side may still answer.
 */
export async function startRelay(host: string, port: number, toHost: string, toPort: number): Promise<{ close: () => Promise<void> }> {
  const socks = new Set<net.Socket>()
  const server = net.createServer({ allowHalfOpen: true }, (a) => {
    const b = net.connect({ port: toPort, host: toHost, allowHalfOpen: true })
    socks.add(a); socks.add(b)
    const kill = () => { a.destroy(); b.destroy() }
    a.on('error', kill); b.on('error', kill)
    // Closed once both of its directions ended: the other socket has nothing left to carry.
    a.on('close', () => { b.destroy(); socks.delete(a) })
    b.on('close', () => { a.destroy(); socks.delete(b) })
    a.pipe(b); b.pipe(a)
  })
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(port, host, () => resolve()) })
  return { close: () => new Promise<void>((r) => { for (const s of socks) s.destroy(); server.close(() => r()) }) }
}

export class FakeTransport implements Transport {
  readonly sharedLoopback = true
  readonly label = 'fake (this computer)'
  constructor(private readonly env: Record<string, string> = { PATH: '/usr/local/bin:/usr/bin:/bin' }) {}
  private run(script: string, args: string[] = []): ChildProcessWithoutNullStreams {
    // Detached, as an ssh session is its own: the other machine's processes are no group of the driver's.
    return spawn('/bin/sh', ['-c', script, 'sh', ...args], { env: this.env, cwd: '/', detached: true, stdio: ['pipe', 'pipe', 'pipe'] })
  }
  sh(script: string, o: { input?: Readable | Buffer | string; timeoutMs?: number; args?: string[] } = {}): Promise<ShResult> { return collect(this.run(script, o.args), o) }
  spawn(script: string): ChildProcessWithoutNullStreams { return this.run(script) }
  async forward(): Promise<void> {}
  async unforward(): Promise<void> {}
  async reverse(): Promise<void> {}
  async close(): Promise<void> {}
}

/** The container's address on the docker bridge, and the host's (its default gateway), read here. */
export function bridgeAddresses(): { container: string; host: string } {
  const container = Object.values(os.networkInterfaces()).flat().find((a) => a && a.family === 'IPv4' && !a.internal)?.address
  // /proc/net/route: the default route's gateway, little-endian hex.
  const gw = fs.readFileSync('/proc/net/route', 'utf8').split('\n').slice(1).map((l) => l.trim().split(/\s+/)).find((f) => f[1] === '00000000')?.[2]
  const host = gw ? [6, 4, 2, 0].map((i) => parseInt(gw.slice(i, i + 2), 16)).join('.') : undefined
  if (!container || !host) throw new Error(`no docker bridge here (container ${container ?? 'none'}, gateway ${host ?? 'none'}): rehearsal (b) runs in the dev container (walnut-dev run)`)
  return { container, host }
}

export interface SshOptions {
  host: string
  /** The master's control socket (real/ssh-master.sh open). */
  socket: string
  /** Defaults: bridgeAddresses(). */
  bridge?: { container: string; host: string }
  /** Tests: the ssh program and how it is run (default `ssh`, spawned). */
  spawnSsh?: (args: string[]) => ChildProcessWithoutNullStreams
}

export class SshTransport implements Transport {
  readonly sharedLoopback = false
  readonly label: string
  private readonly relays: Array<{ kind: 'L' | 'R'; port: number; close: () => Promise<void> }> = []
  private readonly forwards: string[][] = []
  private readonly bridge: { container: string; host: string }
  constructor(private readonly o: SshOptions) {
    this.label = `ssh ${o.host}`
    this.bridge = o.bridge ?? bridgeAddresses()
  }

  /** Every client: the master's socket only, never a connection of its own, never a prompt. */
  clientArgs(): string[] {
    return ['-S', this.o.socket, '-o', 'ControlMaster=no', '-o', 'ProxyCommand=/bin/false', '-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=yes', '-o', 'LogLevel=ERROR']
  }

  private ssh(args: string[]): ChildProcessWithoutNullStreams {
    return this.o.spawnSsh ? this.o.spawnSsh(args) : spawn('ssh', args, { stdio: ['pipe', 'pipe', 'pipe'] })
  }

  /** The remote command line: the script given to /bin/sh as one word (the account's login shell parses it). */
  remoteCommand(script: string, args: string[] = []): string {
    return ['exec', '/bin/sh', '-c', shq(script), 'sh', ...args.map(shq)].join(' ')
  }

  /** The master answers (-O check), or why not. */
  async check(): Promise<{ ok: boolean; why: string }> {
    const r = await collect(this.ssh([...this.clientArgs(), '-O', 'check', this.o.host]), { timeoutMs: 15_000 })
    return { ok: r.code === 0, why: (r.err || r.out).trim() }
  }

  sh(script: string, o: { input?: Readable | Buffer | string; timeoutMs?: number; args?: string[] } = {}): Promise<ShResult> {
    return collect(this.ssh([...this.clientArgs(), '-T', this.o.host, this.remoteCommand(script, o.args)]), o)
  }

  spawn(script: string): ChildProcessWithoutNullStreams {
    return this.ssh([...this.clientArgs(), '-T', this.o.host, this.remoteCommand(script)])
  }

  private async control(op: 'forward' | 'cancel', spec: string[]): Promise<void> {
    const r = await collect(this.ssh([...this.clientArgs(), '-O', op, ...spec, this.o.host]), { timeoutMs: 15_000 })
    if (r.code !== 0) throw new Error(`ssh -O ${op} ${spec.join(' ')} ${this.o.host}: ${(r.err || r.out).trim() || `exit ${r.code}`}`)
  }

  async forward(port: number): Promise<void> {
    const spec = ['-L', `${this.bridge.host}:${port}:127.0.0.1:${port}`]
    await this.control('forward', spec)
    this.forwards.push(spec)
    this.relays.push({ kind: 'L', port, ...(await startRelay('127.0.0.1', port, this.bridge.host, port)) })
  }

  async unforward(port: number): Promise<void> {
    const spec = ['-L', `${this.bridge.host}:${port}:127.0.0.1:${port}`]
    const i = this.forwards.findIndex((f) => f.join(' ') === spec.join(' '))
    if (i >= 0) { this.forwards.splice(i, 1); await this.control('cancel', spec) }
    const j = this.relays.findIndex((r) => r.kind === 'L' && r.port === port)
    if (j >= 0) await this.relays.splice(j, 1)[0]!.close()
  }

  async reverse(port: number): Promise<void> {
    this.relays.push({ kind: 'R', port, ...(await startRelay(this.bridge.container, port, '127.0.0.1', port)) })
    const spec = ['-R', `127.0.0.1:${port}:${this.bridge.container}:${port}`]
    await this.control('forward', spec)
    this.forwards.push(spec)
  }

  async close(o: { master?: boolean } = {}): Promise<void> {
    for (const spec of this.forwards.splice(0)) await this.control('cancel', spec).catch(() => {})
    for (const r of this.relays.splice(0)) await r.close().catch(() => {})
    if (o.master) await collect(this.ssh([...this.clientArgs(), '-O', 'exit', this.o.host]), { timeoutMs: 15_000 }).catch(() => null)
  }
}
