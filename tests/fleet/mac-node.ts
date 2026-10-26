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
import net from 'node:net'
import path from 'node:path'
import { bunRuntime } from '../helpers/bun-runtime.js'
import { _signalSafetyForTesting, ROOT, waitFor } from '../helpers/replica-cluster.js'
import type { SshIdentity } from './ssh-identity.js'

const { pin, stillPinned, signalPinned, signalChild, pidsRunning, readPid } = _signalSafetyForTesting
type Pinned = NonNullable<ReturnType<typeof pin>>

/** The bun the Mac's sources and its mock claude run on: this runner's own (tests/helpers/bun-runtime.ts). */
const MAC_RUNTIME = bunRuntime()

export interface MacSeed {
  /** Notes to write into the vault before boot: relative path to text. */
  notes?: Record<string, string>
  /** MEMORY.md's text. */
  memory?: string
}

/**
 * What the Mac runs: this tree's sources on bun (the default), or an installed
 * release, started the way a person's install starts it: `<command> web --port <n>`
 * (a Node archive's bin/walnut, or a compiled walnut file). Every program runs on
 * the same data, daemon and temp dirs, so one can replace another (an upgrade, a
 * rollback) on the same Mac.
 */
export type MacProgram =
  | { kind: 'source' }
  | { kind: 'release'; label: string; command: string; env?: Record<string, string> }

export interface MacNode {
  port: number
  pid: number
  data: string
  daemonDir: string
  program: MacProgram
  call(method: string, p: string, body?: unknown): Promise<{ status: number; json: any; text: string }>
  sleep(opts?: { ssh?: boolean }): void
  wake(): void
  asleep(): boolean
  /** The server's structured log lines (its LOG_DIR is its daemon dir) that match `re`. */
  logLines(re: RegExp): string[]
  stderrTail(): string
  /**
   * Stops the server alone, as an update or a rollback replaces it: its own daemon and
   * its ssh (the ControlMaster) keep running for the next server to find.
   */
  stopServer(): Promise<void>
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
  // updates.auto off: a release Mac would otherwise look for a newer release and install it before it starts.
  return ['version: 1', 'user:', '  name: Fleet Tester', 'defaults:', '  priority: none', '  platform: local', 'provider:', '  type: claude-code', 'updates:', '  auto: false', ''].join('\n')
}

/** A port nothing listens on now (never 3456 or 3457, the user's servers). */
function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer()
    srv.once('error', reject)
    srv.listen(0, '127.0.0.1', () => {
      const a = srv.address()
      const port = typeof a === 'object' && a ? a.port : 0
      srv.close(() => (port && port !== 3456 && port !== 3457 ? resolve(port) : freePort().then(resolve, reject)))
    })
  })
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

/**
 * FLEET_EVIDENCE_DIR=<dir>: a run copies its Mac's logs (the server's and its daemon's) to
 * <dir>/<name> before it removes its temp dir, so a run can end clean and still be read.
 */
export function saveMacLogs(daemonDir: string, name: string): void {
  const into = process.env.FLEET_EVIDENCE_DIR?.trim()
  if (!into) return
  try {
    const dest = path.join(into, name)
    fs.mkdirSync(dest, { recursive: true })
    for (const f of fs.readdirSync(daemonDir)) if (f.endsWith('.log')) fs.copyFileSync(path.join(daemonDir, f), path.join(dest, f))
  } catch { /* evidence only */ }
}

/** The Mac's dirs under a fleet's base: the same on every start, so one program can replace another on the same data. */
export function macDirs(base: string) {
  // TMPDIR stays the runner's, the dir that holds `base`: a data home under the temp dir is what
  // tells the server it is an isolated one (no embedding model, no speech runtime download).
  return {
    home: path.join(base, 'mh'), data: path.join(base, 'mh', 'data'), daemon: path.join(base, 'md'), tmp: path.dirname(base),
    // Where a compiled walnut file unpacks its runtime tree (WALNUT_RUNTIME_DIR).
    runtime: path.join(base, 'mruntime'),
  }
}

/**
 * Waits until `port` answers `probe` (GET) with 200, while `proc` runs. A server
 * in cloud mode answers only paired devices, and unpaired requests count toward
 * its rate limit: it is asked for /api/system/health, which needs no token.
 */
async function untilServes(port: number, proc: ChildProcess, timeoutMs: number, stderr: () => string, probe = '/api/config'): Promise<void> {
  const until = Date.now() + timeoutMs
  for (;;) {
    if (proc.exitCode !== null || proc.signalCode !== null) throw new Error(`fleet: the Mac exited early (${proc.exitCode ?? proc.signalCode})\n${stderr().slice(-3000)}`)
    const ok = await request(port, 'GET', probe).then((r) => r.status === 200, () => false)
    if (ok) return
    if (Date.now() > until) { signalChild(proc, 'SIGTERM'); throw new Error(`fleet: the Mac did not serve :${port} in ${timeoutMs / 1000} s\n${stderr().slice(-3000)}`) }
    await sleepMs(500)
  }
}

export async function startMac(base: string, ssh: SshIdentity, windows: Record<string, string>, seed: MacSeed = {}, program: MacProgram = { kind: 'source' }): Promise<MacNode> {
  const d = macDirs(base)
  const fresh = !fs.existsSync(path.join(d.data, 'config.yaml'))
  for (const x of [d.data, d.daemon, path.join(d.home, '.ssh')]) fs.mkdirSync(x, { recursive: true, mode: 0o700 })
  // The Mac's own claude is the same mock (its local daemon may probe one); never the real CLI.
  fs.copyFileSync(path.join(import.meta.dirname, 'host-image', 'mock-claude.cjs'), path.join(ssh.bin, 'mock-claude.cjs'))
  fs.writeFileSync(path.join(ssh.bin, 'claude'), `#!/bin/sh\nexec ${JSON.stringify(MAC_RUNTIME)} ${JSON.stringify(path.join(ssh.bin, 'mock-claude.cjs'))} "$@"\n`, { mode: 0o755 })
  // The data is the person's from the second start on: an upgrade or a rollback finds it as the last server left it.
  if (fresh) {
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
  }
  const bootFile = path.join(base, 'mac-boot.mts')
  if (program.kind === 'source') fs.writeFileSync(bootFile, bootScript(d.data))
  // Built from nothing: no variable of the runner (VITEST, an agent's socket, SSH_AUTH_SOCK) reaches the Mac.
  // A release Mac gets the PATH of a plain Mac (no Node or bun of this checkout's): what it runs, it carries.
  const basePath = program.kind === 'source' ? (process.env.PATH ?? '') : '/usr/bin:/bin:/usr/sbin:/sbin'
  const env: Record<string, string> = {
    PATH: `${ssh.bin}${path.delimiter}${basePath}`, HOME: d.home, USERPROFILE: d.home, SHELL: '/bin/sh', TMPDIR: d.tmp,
    ...(process.env.LANG ? { LANG: process.env.LANG } : {}),
    OPEN_WALNUT_HOME: d.data, WALNUT_DAEMON_DIR: d.daemon, WALNUT_STREAMS_DIR: path.join(d.daemon, 'streams'),
    WALNUT_LEGACY_STREAMS_DIR: path.join(d.daemon, 'no-legacy'), WALNUT_SPAWN_JOURNAL: path.join(d.daemon, 'spawn-journal.jsonl'),
    WALNUT_DISABLE_BACKGROUND_AI: '1', WALNUT_DISABLE_SEARCH: '1', WALNUT_LOCAL_CLAUDE_PROBE: '0', WALNUT_NO_AUTO_UPDATE: '1',
    WALNUT_STT_AUTO_SETUP: '0', WALNUT_SEARCH_V2_SEMANTIC: '0', WALNUT_RUNTIME_DIR: d.runtime,
    ...windows, NODE_ENV: 'production',
    ...(program.kind === 'release' ? program.env ?? {} : {}),
  }
  let stderr = ''
  let proc: ChildProcess
  let booted: { port: number; pid: number }
  let looksRight: (c: string) => boolean
  if (program.kind === 'source') {
    proc = spawn(MAC_RUNTIME, [bootFile], { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] })
  } else {
    const port = await freePort()
    proc = spawn(program.command, ['web', '--port', String(port)], { cwd: d.home, env, stdio: ['ignore', 'pipe', 'pipe'] })
    proc.stdout!.on('data', (b: Buffer) => { if (process.env.DEBUG_FLEET) process.stderr.write(`[mac ${program.label}] ${b}`) })
  }
  proc.stderr!.on('data', (b: Buffer) => {
    stderr = (stderr + b.toString()).slice(-200_000)
    if (process.env.DEBUG_FLEET) process.stderr.write(`[mac] ${b}`)
  })
  if (program.kind === 'source') {
    booted = await new Promise<{ port: number; pid: number }>((resolve, reject) => {
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
    looksRight = (c) => c.startsWith(`${MAC_RUNTIME} `) && c.includes(bootFile)
  } else {
    const port = Number(proc.spawnargs[proc.spawnargs.length - 1])
    await untilServes(port, proc, 240_000, () => stderr, env.WALNUT_CLOUD_MODE === '1' ? '/api/system/health' : '/api/config')
    // A Node archive's bin/walnut is a sh script that execs its node: the same pid, now running the package.
    booted = { port, pid: proc.pid! }
    looksRight = (c) => c.includes(` web --port ${port}`)
  }
  const macPin = pin('mac', booted.pid, looksRight)
  if (!macPin) { signalChild(proc, 'SIGTERM'); throw new Error(`fleet: the Mac reported pid ${booted.pid}, which is not the server this run started`) }
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
  // stopServer ends the server alone; stop ends everything this Mac left (also after a stopServer:
  // a replacement that failed to boot leaves the daemon and the ssh of this one running).
  let serverStopped = false
  let stopped = false
  return {
    port: booted.port, pid: booted.pid, data: d.data, daemonDir: d.daemon, program,
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
    async stopServer() {
      if (serverStopped || stopped) return
      serverStopped = true
      for (const p of [macPin, daemonPin, ...frozenSsh]) signalPinned(p, 'SIGCONT')
      paused = false
      frozenSsh = []
      signalPinned(macPin, 'SIGTERM')
      await waitFor(() => !stillPinned(macPin), 30_000, 'the Mac server to stop').catch(() => undefined)
      signalPinned(macPin, 'SIGKILL')
      signalChild(proc, 'SIGKILL')
    },
    async stop() {
      if (stopped) return
      stopped = true
      serverStopped = true
      // The daemon the pid file names now (the server may have replaced the one first pinned).
      if (!daemonPin || !stillPinned(daemonPin)) daemonPin = pin('mac-daemon', readPid(path.join(d.daemon, 'daemon.pid')), (c) => / --start(\s|$)/.test(c)) ?? daemonPin
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

