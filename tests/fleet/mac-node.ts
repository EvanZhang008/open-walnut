/**
 * The fleet's Mac: this machine, as a Walnut server child with its own data dir,
 * daemon dir, temp dir, HOME and port (never :3456, never ~/.open-walnut). It is
 * started like tests/helpers/replica-cluster.ts's Mac (startServer, NON-ephemeral:
 * an ephemeral server does not deploy to remote hosts), but it reaches its hosts
 * the real way: `ssh` on its PATH is ssh-identity.ts's wrapper, so every connect,
 * deploy, tunnel and bulk lane is OpenSSH to a container's sshd.
 *
 * sleep() is the lid: SIGSTOP to the server, its own local daemon and its ssh
 * processes (they are frozen too when a real Mac sleeps), wake() is SIGCONT. Each
 * process is one this run started and pinned when first seen (pid, start time,
 * command line), and is signalled only while all three still match (the pin
 * helpers of replica-cluster.ts):
 *   the server: the process the boot file reports, running that boot file
 *   its daemon: the pid in its daemon dir's daemon.pid, running `--start`
 *   its ssh:    every process whose command line starts with this run's
 *               `<ssh> -F <this run's config>` (no other ssh has that config)
 */
import { spawn, type ChildProcess } from 'node:child_process'
import fs from 'node:fs'
import http from 'node:http'
import path from 'node:path'
import { _signalSafetyForTesting, ROOT, waitFor } from '../helpers/replica-cluster.js'
import type { SshIdentity } from './ssh-identity.js'

const { pin, stillPinned, signalPinned, signalChild, pidsRunning, readPid } = _signalSafetyForTesting
type Pinned = NonNullable<ReturnType<typeof pin>>

const TSX = path.join(ROOT, 'node_modules', '.bin', 'tsx')

export interface MacSeed {
  /** Notes to write into the vault before boot: relative path to text. */
  notes?: Record<string, string>
  /** MEMORY.md's text. */
  memory?: string
}

export interface MacNode {
  port: number
  pid: number
  data: string
  daemonDir: string
  call(method: string, p: string, body?: unknown): Promise<{ status: number; json: any; text: string }>
  sleep(opts?: { ssh?: boolean }): void
  wake(): void
  asleep(): boolean
  /** The server's structured log lines (its LOG_DIR is its daemon dir) that match `re`. */
  logLines(re: RegExp): string[]
  stderrTail(): string
  stop(): Promise<void>
}

export const sleepMs = (ms: number) => new Promise((r) => setTimeout(r, ms))

function bootScript(data: string): string {
  const src = (f: string) => JSON.stringify(path.join(ROOT, f))
  return `
const c = await import(${src('src/constants.ts')})
if (c.WALNUT_HOME !== ${JSON.stringify(data)} || c.CLOUD_MODE || c.IS_EPHEMERAL) { process.stderr.write('REFUSING: wrong home ' + c.WALNUT_HOME + '\\n'); process.exit(3) }
const { startServer, stopServer, armGracefulSignalExit } = await import(${src('src/web/server.ts')})
const server = await startServer({ port: 0, dev: true })
const addr = server.address()
process.stdout.write(JSON.stringify({ pid: process.pid }) + '\\n')
process.stdout.write('WALNUT_PORT=' + (typeof addr === 'object' && addr ? addr.port : addr) + '\\n')
let closing = false
const close = async () => { if (closing) return; closing = true; try { await stopServer() } catch {} process.exit(0) }
process.on('SIGTERM', close)
process.on('SIGINT', close)
armGracefulSignalExit()
`
}

function config(): string {
  return ['version: 1', 'user:', '  name: Fleet Tester', 'defaults:', '  priority: none', '  platform: local', 'provider:', '  type: claude-code', ''].join('\n')
}

function request(port: number, method: string, p: string, body?: unknown): Promise<{ status: number; text: string }> {
  return new Promise((resolve, reject) => {
    const data = body === undefined ? null : Buffer.from(JSON.stringify(body))
    const req = http.request({
      host: '127.0.0.1', port, method, path: p, agent: false, timeout: 60_000,
      headers: data ? { 'content-type': 'application/json', 'content-length': String(data.length) } : {},
    }, (res) => {
      const parts: Buffer[] = []
      res.on('data', (c: Buffer) => parts.push(c))
      res.on('end', () => resolve({ status: res.statusCode ?? 0, text: Buffer.concat(parts).toString('utf8') }))
    })
    req.on('timeout', () => req.destroy(new Error(`${method} ${p} timed out`)))
    req.on('error', reject)
    req.end(data ?? undefined)
  })
}

export async function startMac(base: string, ssh: SshIdentity, windows: Record<string, string>, seed: MacSeed = {}): Promise<MacNode> {
  // TMPDIR stays the runner's, the dir that holds `base`: a data home under the temp dir is what
  // tells the server it is an isolated one (no embedding model, no speech runtime download).
  const d = { home: path.join(base, 'mh'), data: path.join(base, 'mh', 'data'), daemon: path.join(base, 'md'), tmp: path.dirname(base) }
  for (const x of [d.data, d.daemon, path.join(d.home, '.ssh')]) fs.mkdirSync(x, { recursive: true, mode: 0o700 })
  // The Mac's own claude is the same mock (its local daemon may probe one); never the real CLI.
  fs.copyFileSync(path.join(import.meta.dirname, 'host-image', 'mock-claude.cjs'), path.join(ssh.bin, 'mock-claude.cjs'))
  fs.writeFileSync(path.join(ssh.bin, 'claude'), `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(path.join(ssh.bin, 'mock-claude.cjs'))} "$@"\n`, { mode: 0o755 })
  fs.writeFileSync(path.join(d.data, 'config.yaml'), config())
  for (const [rel, text] of Object.entries(seed.notes ?? {})) {
    const f = path.join(d.data, 'notes', rel)
    fs.mkdirSync(path.dirname(f), { recursive: true })
    fs.writeFileSync(f, text)
  }
  if (seed.memory !== undefined) {
    fs.mkdirSync(path.join(d.data, 'memory'), { recursive: true })
    fs.writeFileSync(path.join(d.data, 'memory', 'MEMORY.md'), seed.memory)
  }
  const bootFile = path.join(base, 'mac-boot.mts')
  fs.writeFileSync(bootFile, bootScript(d.data))
  // Built from nothing: no variable of the runner (VITEST, an agent's socket, SSH_AUTH_SOCK) reaches the Mac.
  const env: Record<string, string> = {
    PATH: `${ssh.bin}${path.delimiter}${process.env.PATH ?? ''}`, HOME: d.home, USERPROFILE: d.home, SHELL: '/bin/sh', TMPDIR: d.tmp,
    ...(process.env.LANG ? { LANG: process.env.LANG } : {}),
    OPEN_WALNUT_HOME: d.data, WALNUT_DAEMON_DIR: d.daemon, WALNUT_STREAMS_DIR: path.join(d.daemon, 'streams'),
    WALNUT_LEGACY_STREAMS_DIR: path.join(d.daemon, 'no-legacy'), WALNUT_SPAWN_JOURNAL: path.join(d.daemon, 'spawn-journal.jsonl'),
    WALNUT_DISABLE_BACKGROUND_AI: '1', WALNUT_DISABLE_SEARCH: '1', WALNUT_LOCAL_CLAUDE_PROBE: '0', WALNUT_NO_AUTO_UPDATE: '1',
    WALNUT_STT_AUTO_SETUP: '0', WALNUT_SEARCH_V2_SEMANTIC: '0',
    ...windows, NODE_ENV: 'production',
  }
  let stderr = ''
  const proc: ChildProcess = spawn(TSX, [bootFile], { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] })
  proc.stderr!.on('data', (b: Buffer) => {
    stderr = (stderr + b.toString()).slice(-200_000)
    if (process.env.DEBUG_FLEET) process.stderr.write(`[mac] ${b}`)
  })
  const booted = await new Promise<{ port: number; pid: number }>((resolve, reject) => {
    let out = ''
    let pid = 0
    const t = setTimeout(() => { signalChild(proc, 'SIGTERM'); reject(new Error(`fleet: the Mac did not report a port in 240 s\n${stderr.slice(-3000)}`)) }, 240_000)
    proc.stdout!.on('data', (b: Buffer) => {
      out += b.toString()
      for (const l of out.split('\n')) if (l.startsWith('{"pid"')) { try { pid = Number(JSON.parse(l).pid) } catch { /* partial */ } }
      const m = /WALNUT_PORT=(\d+)/.exec(out)
      if (m && pid) { clearTimeout(t); resolve({ port: Number(m[1]), pid }) }
    })
    proc.once('exit', (code) => { clearTimeout(t); reject(new Error(`fleet: the Mac exited early (${code})\n${stderr.slice(-3000)}`)) })
  })
  const macPin = pin('mac', booted.pid, (c) => c.startsWith(`${process.execPath} `) && c.includes(bootFile))
  if (!macPin) { signalChild(proc, 'SIGTERM'); throw new Error(`fleet: the Mac reported pid ${booted.pid}, which does not run ${bootFile}`) }
  let daemonPin: Pinned | null = await waitFor(() => pin('mac-daemon', readPid(path.join(d.daemon, 'daemon.pid')), (c) => / --start(\s|$)/.test(c)), 60_000, 'the Mac\'s own daemon').catch(() => null)
  const sshPins = (): Pinned[] => pidsRunning(ssh.commandPrefix).map((pid) => pin('mac-ssh', pid, (c) => c.startsWith(ssh.commandPrefix))).filter((p): p is Pinned => p !== null)
  let frozenSsh: Pinned[] = []
  let paused = false

  const signalMac = (sig: NodeJS.Signals, withSsh: boolean) => {
    // The Mac may have restarted its daemon: the one its pid file names now, pinned again.
    if (!daemonPin || !stillPinned(daemonPin)) daemonPin = pin('mac-daemon', readPid(path.join(d.daemon, 'daemon.pid')), (c) => / --start(\s|$)/.test(c)) ?? daemonPin
    for (const p of [macPin, daemonPin]) {
      if (!signalPinned(p, sig)) throw new Error(`fleet: refusing ${sig}: ${p?.name ?? 'a Mac process'} (${p?.pid ?? '?'}) is not the process this run started`)
    }
    if (sig === 'SIGSTOP') frozenSsh = withSsh ? sshPins() : []
    for (const p of frozenSsh) signalPinned(p, sig)
    if (sig === 'SIGCONT') frozenSsh = []
  }
  const logLines = (re: RegExp): string[] => {
    let names: string[] = []
    try { names = fs.readdirSync(d.daemon).filter((f) => /^open-walnut-.*\.log$/.test(f)).sort() } catch { return [] }
    return names.flatMap((f) => fs.readFileSync(path.join(d.daemon, f), 'utf8').split('\n')).filter((l) => re.test(l))
  }
  let stopped = false
  return {
    port: booted.port, pid: booted.pid, data: d.data, daemonDir: d.daemon,
    async call(method, p, body) {
      const r = await request(booted.port, method, p, body)
      let json: any
      try { json = JSON.parse(r.text) } catch { json = null }
      return { status: r.status, json, text: r.text }
    },
    sleep(opts = {}) { signalMac('SIGSTOP', opts.ssh !== false); paused = true },
    wake() { signalMac('SIGCONT', true); paused = false },
    asleep: () => paused,
    logLines,
    stderrTail: () => stderr.slice(-20_000),
    async stop() {
      if (stopped) return
      stopped = true
      // SIGCONT first (a stopped process keeps a SIGTERM pending), then SIGTERM, then SIGKILL for what outlived it.
      for (const p of [macPin, daemonPin, ...frozenSsh]) signalPinned(p, 'SIGCONT')
      paused = false
      signalPinned(macPin, 'SIGTERM')
      signalPinned(daemonPin, 'SIGTERM')
      await waitFor(() => !stillPinned(macPin) && (!daemonPin || !stillPinned(daemonPin)), 20_000, 'the Mac to stop').catch(() => undefined)
      // Its ssh (a ControlMaster outlives the server by design) and anything left.
      const left = [...sshPins(), macPin, ...(daemonPin ? [daemonPin] : [])].filter((p) => stillPinned(p))
      for (const p of left) signalPinned(p, 'SIGTERM')
      await waitFor(() => left.every((p) => !stillPinned(p)), 10_000, 'the Mac\'s ssh to stop').catch(() => undefined)
      for (const p of left) signalPinned(p, 'SIGKILL')
      signalChild(proc, 'SIGKILL')
    },
  }
}

