/**
 * The host network on THIS host (capability 'net-v1'): the daemon starts and watches
 * walnut-net (native/walnut-net, Rust, iroh), which holds this host's network identity
 * and carries Walnut daemon links between the user's own machines, direct or through
 * the user's own relay (docs/reference/host-network.md).
 *
 * The daemon owns its lifecycle: it runs walnut-net while `<state>/config.json` exists,
 * restarts it when it exits (exit 75 = "the config changed what I am": at once; else
 * with a backoff), and walnut-net exits when the daemon's pipe to it closes, so a dead
 * daemon never leaves one behind. The server only writes the config (`net.configure`)
 * and asks for links (`net.forward`): a 127.0.0.1 port whose every connection is a
 * stream to another member's daemon.
 *
 * Security lives in walnut-net: a connection is closed before any stream unless its
 * endpoint id (its key, proven by the handshake) is a member with `accept: true`, the
 * machines that drive this daemon (the Mac, the cloud companion). The key file is 0600
 * and never leaves this host; the config holds no secret.
 *
 * Bundled into the binary daemon and shipped as the net-core.cjs sidecar for the source
 * twin; 'net-v1' is advertised only where it loads. It never signals a process group:
 * it ends its own child with SIGTERM, then SIGKILL.
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import net from 'node:net'
import type { ChildProcess, SpawnOptions } from 'node:child_process'
import { fetchNetBinary, netInstallName } from './net-binary.js'

export const NET_CONFIG_VERSION = 1
/** walnut-net's "start me again" exit code. */
const EXIT_RESTART = 75
const BACKOFF_MS = [1_000, 2_000, 5_000, 10_000, 30_000, 60_000]
/** A run this long counts as healthy: the next failure starts the backoff over. */
const HEALTHY_MS = 60_000
const CONTROL_TIMEOUT_MS = 30_000
const LOG_MAX_BYTES = 1024 * 1024
/** A unix socket path must fit sockaddr_un (104 bytes on macOS, 108 on Linux). */
const SOCKET_PATH_MAX = 100
const ID_RE = /^[0-9a-f]{64}$/
const NAME_MAX = 80
const MEMBERS_MAX = 256

export interface NetMember {
  id: string
  name: string
  accept: boolean
  addrs?: string[]
}

export interface NetConfigureRequest {
  enabled?: unknown
  relays?: unknown
  relayRoots?: unknown
  members?: unknown
}

export interface NetDeps {
  spawn: (cmd: string, args: string[], opts: SpawnOptions) => ChildProcess
  /** This host's net state dir (0700): key, config, log. Never under a synced data dir. */
  stateDir: string
  /** The daemon's port file (walnut-net pipes each accepted stream to the port it holds). */
  portFile: string
  /** The walnut-net executable, or null when this install has none. */
  bin: () => string | null
  /** Get one when `bin` has none (default: the pinned release build, net-binary.ts; off with WALNUT_NET_NO_DOWNLOAD=1). */
  fetchBin?: () => Promise<string>
  log?: (level: 'info' | 'warn', msg: string, fields?: Record<string, unknown>) => void
  now?: () => number
}

export interface NetStatus {
  /** A walnut-net executable exists here. */
  available: boolean
  /** A config exists (the server turned the network on for this host). */
  enabled: boolean
  running: boolean
  pid: number | null
  /** This host's endpoint id (its public key), once its key exists. (Not `id`: that is the RPC's.) */
  endpointId: string | null
  restarts: number
  lastExit: { code: number | null; signal: string | null; at: number } | null
  lastError: string | null
  /** walnut-net's own status (relays, peers and their paths), when it answered. */
  node: Record<string, unknown> | null
}

/** The control socket: inside the state dir when the path fits, else a 0700 dir in /tmp. */
export function netControlPath(stateDir: string, uid = process.getuid?.() ?? 0, tmp = '/tmp'): string {
  const inside = path.join(stateDir, 'ctl.sock')
  if (Buffer.byteLength(inside) <= SOCKET_PATH_MAX) return inside
  const hash = crypto.createHash('sha256').update(path.resolve(stateDir)).digest('hex').slice(0, 16)
  return path.join(tmp, `walnut-net-${uid}`, `${hash}.sock`)
}

/** A private dir for the socket: made 0700, refused when it is someone else's or a link. */
function ensurePrivateDir(dir: string): void {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
  const st = fs.lstatSync(dir)
  const uid = process.getuid?.()
  if (!st.isDirectory() || st.isSymbolicLink() || (uid !== undefined && st.uid !== uid)) {
    throw new Error(`${dir} is not a directory of this account; refusing to put the network control socket there`)
  }
  if ((st.mode & 0o077) !== 0) fs.chmodSync(dir, 0o700)
}

function str(v: unknown, max: number): string | null {
  return typeof v === 'string' && v.length > 0 && v.length <= max ? v : null
}

/** Validate a configure request into walnut-net's config fields. Throws on anything off. */
/** `1.2.3.4:5` or `[::1]:5`, as Rust's SocketAddr reads it. */
function socketAddr(a: unknown): boolean {
  if (typeof a !== 'string' || a.length > 64) return false
  const m = /^(?:\[([0-9a-fA-F:.]+)\]|(\d{1,3}(?:\.\d{1,3}){3})):(\d{1,5})$/.exec(a)
  if (!m) return false
  const port = Number(m[3])
  if (port < 1 || port > 65535) return false
  return m[1] ? net.isIPv6(m[1]) : net.isIPv4(m[2])
}

export function parseNetConfig(req: NetConfigureRequest): { relays: string[]; relayRoots: string[]; members: NetMember[] } {
  // The same rules walnut-net applies when it reads the file (config.rs): a config it would
  // refuse is refused here, before it replaces one that works.
  const httpOk = process.env.WALNUT_NET_ALLOW_HTTP_RELAY === '1'
  const relays = Array.isArray(req.relays) ? req.relays : []
  for (const r of relays) {
    if (typeof r !== 'string' || !/^https?:\/\/[^\s]+$/.test(r) || r.length > 512) throw new Error(`bad relay URL ${String(r).slice(0, 80)}`)
    if (!r.startsWith('https://') && !httpOk) throw new Error(`relay ${r.slice(0, 80)} is not https`)
  }
  const roots = Array.isArray(req.relayRoots) ? req.relayRoots : []
  for (const c of roots) {
    if (typeof c !== 'string' || !c.includes('-----BEGIN CERTIFICATE-----') || c.length > 16_384) throw new Error('relayRoots: PEM certificates only')
  }
  const raw = Array.isArray(req.members) ? req.members : []
  if (raw.length > MEMBERS_MAX) throw new Error(`at most ${MEMBERS_MAX} members`)
  const seen = new Set<string>()
  const members: NetMember[] = raw.map((m) => {
    const o = (m && typeof m === 'object' ? m : {}) as Record<string, unknown>
    const id = typeof o.id === 'string' ? o.id.toLowerCase() : ''
    if (!ID_RE.test(id)) throw new Error(`bad member id ${String(o.id).slice(0, 80)}`)
    if (seen.has(id)) throw new Error(`member ${id} listed twice`)
    seen.add(id)
    const addrs = Array.isArray(o.addrs) ? o.addrs.slice(0, 16) : []
    for (const a of addrs) if (!socketAddr(a)) throw new Error(`member ${id}: bad address ${String(a).slice(0, 64)}`)
    return { id, name: str(o.name, NAME_MAX) ?? '', accept: o.accept === true, ...(addrs.length ? { addrs } : {}) }
  })
  return { relays: relays as string[], relayRoots: roots as string[], members }
}

function writeFileAtomic(file: string, data: string): void {
  const tmp = `${file}.tmp-${process.pid}-${crypto.randomBytes(4).toString('hex')}`
  fs.writeFileSync(tmp, data, { mode: 0o600 })
  fs.renameSync(tmp, file)
}

/** One JSON request on the control socket, one JSON answer. */
export function netControlCall(socketPath: string, req: Record<string, unknown>, timeoutMs = CONTROL_TIMEOUT_MS): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const sock = net.createConnection(socketPath)
    let buf = ''
    const timer = setTimeout(() => { sock.destroy(); reject(new Error(`walnut-net did not answer ${String(req.op)} in ${timeoutMs} ms`)) }, timeoutMs)
    sock.setEncoding('utf8')
    sock.on('connect', () => sock.write(JSON.stringify(req) + '\n'))
    sock.on('data', (d: string) => {
      buf += d
      const nl = buf.indexOf('\n')
      if (nl < 0) return
      clearTimeout(timer)
      sock.destroy()
      try { resolve(JSON.parse(buf.slice(0, nl)) as Record<string, unknown>) } catch { reject(new Error('walnut-net answered something that is not JSON')) }
    })
    sock.on('error', (err) => { clearTimeout(timer); reject(err) })
    sock.on('close', () => { clearTimeout(timer); if (!buf.includes('\n')) reject(new Error('walnut-net closed the control socket without an answer')) })
  })
}

export function createNetSupervisor(deps: NetDeps) {
  const now = deps.now ?? Date.now
  const log = deps.log ?? (() => {})
  const stateDir = deps.stateDir
  const configFile = path.join(stateDir, 'config.json')
  const keyFile = path.join(stateDir, 'net.key')
  const logFile = path.join(stateDir, 'walnut-net.log')
  const control = netControlPath(stateDir)
  let child: ChildProcess | null = null
  let childStartedAt = 0
  let ready = false
  let id: string | null = null
  let restarts = 0
  let failures = 0
  let lastExit: NetStatus['lastExit'] = null
  let lastError: string | null = null
  let timer: ReturnType<typeof setTimeout> | null = null
  let stopping = false
  let readyWaiters: Array<(ok: boolean) => void> = []
  const fetchBin = deps.fetchBin ?? (() => fetchNetBinary({ dir: path.join(stateDir, 'bin'), log }))

  /** The executable, downloaded the first time this host needs one. */
  async function haveBin(): Promise<string> {
    const found = deps.bin()
    if (found) return found
    if (process.env.WALNUT_NET_NO_DOWNLOAD === '1') throw new Error('walnut-net is not installed on this host')
    try {
      await fetchBin()
    } catch (err) {
      lastError = `walnut-net is not installed on this host, and its download failed: ${(err as Error).message}`
      throw new Error(lastError)
    }
    const got = deps.bin()
    if (!got) throw new Error('walnut-net downloaded, but it is not where this daemon looks')
    return got
  }

  function ensureState(): void {
    fs.mkdirSync(stateDir, { recursive: true, mode: 0o700 })
    try { fs.chmodSync(stateDir, 0o700) } catch { /* best effort */ }
    if (path.dirname(control) !== stateDir) ensurePrivateDir(path.dirname(control))
  }

  function appendLog(line: string): void {
    try {
      try { if (fs.statSync(logFile).size > LOG_MAX_BYTES) fs.renameSync(logFile, logFile + '.1') } catch { /* absent */ }
      fs.appendFileSync(logFile, line.endsWith('\n') ? line : line + '\n', { mode: 0o600 })
    } catch { /* logging never breaks the network */ }
  }

  function settleReady(ok: boolean): void {
    const w = readyWaiters
    readyWaiters = []
    for (const f of w) f(ok)
  }

  function spawnChild(): void {
    timer = null
    if (stopping || child || !fs.existsSync(configFile)) return
    const bin = deps.bin()
    if (!bin) { lastError = 'walnut-net is not installed on this host'; settleReady(false); return }
    ensureState()
    ready = false
    childStartedAt = now()
    let proc: ChildProcess
    try {
      proc = deps.spawn(bin, ['run', '--config', configFile, '--exit-on-stdin-eof'], { stdio: ['pipe', 'pipe', 'pipe'], detached: false })
    } catch (err) {
      lastError = `walnut-net did not start: ${(err as Error).message}`
      scheduleRestart()
      return
    }
    child = proc
    let out = ''
    proc.stdout?.setEncoding('utf8')
    proc.stdout?.on('data', (d: string) => {
      out += d
      let nl: number
      while ((nl = out.indexOf('\n')) >= 0) {
        const line = out.slice(0, nl)
        out = out.slice(nl + 1)
        try {
          const ev = JSON.parse(line) as { event?: string; id?: string }
          if (ev.event === 'ready' && typeof ev.id === 'string') {
            ready = true
            id = ev.id
            lastError = null
            log('info', 'walnut-net ready', { id: ev.id, pid: proc.pid })
            settleReady(true)
          }
        } catch { /* not ours */ }
      }
    })
    let errTail = ''
    proc.stderr?.setEncoding('utf8')
    proc.stderr?.on('data', (d: string) => { appendLog(d); errTail = (errTail + d).slice(-2000) })
    proc.stdin?.on('error', () => { /* it exited */ })
    proc.on('error', (err) => { lastError = `walnut-net: ${err.message}` })
    proc.on('exit', (code, signal) => {
      if (child === proc) child = null
      ready = false
      lastExit = { code, signal, at: now() }
      settleReady(false)
      if (stopping) return
      if (code === EXIT_RESTART) { restarts++; log('info', 'walnut-net restarts for a new config'); spawnChild(); return }
      const tail = errTail.trim().split('\n').slice(-3).join(' | ')
      lastError = `walnut-net exited (${signal ?? code})${tail ? `: ${tail.slice(-400)}` : ''}`
      log('warn', 'walnut-net exited', { code, signal, tail: tail.slice(-400) })
      if (now() - childStartedAt > HEALTHY_MS) failures = 0
      scheduleRestart()
    })
  }

  function scheduleRestart(): void {
    if (stopping || timer) return
    const wait = BACKOFF_MS[Math.min(failures, BACKOFF_MS.length - 1)]
    failures++
    restarts++
    timer = setTimeout(spawnChild, wait)
    timer.unref?.()
  }

  function waitReady(timeoutMs: number): Promise<boolean> {
    if (ready) return Promise.resolve(true)
    return new Promise((resolve) => {
      const t = setTimeout(() => { readyWaiters = readyWaiters.filter((f) => f !== done); resolve(false) }, timeoutMs)
      const done = (ok: boolean) => { clearTimeout(t); resolve(ok) }
      readyWaiters.push(done)
    })
  }

  async function call(req: Record<string, unknown>): Promise<Record<string, unknown>> {
    if (!ready && !(await waitReady(10_000))) throw new Error(lastError ?? 'walnut-net is not running on this host')
    const res = await netControlCall(control, req)
    if (res.ok !== true) throw new Error(typeof res.error === 'string' ? res.error : 'walnut-net refused')
    return res
  }

  /** This host's endpoint id, making the key on first use (no network needed). */
  async function identity(): Promise<string> {
    if (id) return id
    const bin = await haveBin()
    ensureState()
    const out = await new Promise<string>((resolve, reject) => {
      const p = deps.spawn(bin, ['id', '--key', keyFile], { stdio: ['ignore', 'pipe', 'pipe'] })
      let o = ''
      let e = ''
      p.stdout?.on('data', (d: Buffer) => { o += d.toString() })
      p.stderr?.on('data', (d: Buffer) => { e += d.toString() })
      p.on('error', reject)
      p.on('exit', (code) => code === 0 ? resolve(o) : reject(new Error(`walnut-net id failed: ${e.trim().slice(-300)}`)))
    })
    const got = (JSON.parse(out.trim()) as { id?: string }).id
    if (!got || !ID_RE.test(got)) throw new Error('walnut-net id answered no id')
    id = got
    return got
  }

  /** End the child (SIGTERM, then SIGKILL after 3 s) and wait for it; the supervisor keeps running. */
  async function stopChild(): Promise<void> {
    if (timer) { clearTimeout(timer); timer = null }
    const proc = child
    if (!proc) return
    const was = stopping
    stopping = true
    await new Promise<void>((resolve) => {
      const kill = setTimeout(() => { try { proc.kill('SIGKILL') } catch { /* gone */ } }, 3_000)
      proc.once('exit', () => { clearTimeout(kill); resolve() })
      try { proc.kill('SIGTERM') } catch { clearTimeout(kill); resolve() }
    })
    stopping = was
  }

  return {
    controlPath: control,
    /** At daemon start: run it when this host has a config. */
    start(): void {
      if (fs.existsSync(configFile)) spawnChild()
    },

    async status(): Promise<NetStatus> {
      const enabled = fs.existsSync(configFile)
      let node: Record<string, unknown> | null = null
      if (ready) {
        try { node = await netControlCall(control, { op: 'status' }, 5_000) } catch (err) { lastError = (err as Error).message }
      }
      if (!id && deps.bin() && fs.existsSync(keyFile)) { try { await identity() } catch { /* reported below */ } }
      return {
        available: !!deps.bin(), enabled, running: !!child && ready, pid: child?.pid ?? null, endpointId: id, restarts,
        lastExit, lastError, node,
      }
    },

    identity,

    /** Write the config the server sent and (re)start walnut-net; `enabled: false` stops and removes it. */
    async configure(req: NetConfigureRequest): Promise<{ endpointId: string; running: boolean }> {
      if (req.enabled === false) {
        // The config first: the server's link to this daemon may ride the child it stops.
        try { fs.rmSync(configFile, { force: true }) } catch { /* gone */ }
        await stopChild()
        return { endpointId: await identity(), running: false }
      }
      const parsed = parseNetConfig(req)
      ensureState()
      const me = await identity()
      const cfg = {
        version: NET_CONFIG_VERSION, key: keyFile, ...parsed,
        // A member never lists this host itself.
        members: parsed.members.filter((m) => m.id !== me),
        daemonPortFile: deps.portFile, control,
      }
      const text = JSON.stringify(cfg, null, 2) + '\n'
      let before = ''
      try { before = fs.readFileSync(configFile, 'utf8') } catch { /* first */ }
      const changed = before !== text
      if (changed) writeFileAtomic(configFile, text)
      // A child already running read its config before this write (it reads it once,
      // before it says ready): it is told to read it again, once it is ready.
      const running = !!child
      if (!running) {
        failures = 0
        if (timer) { clearTimeout(timer); timer = null }
        spawnChild()
      }
      const ok = await waitReady(15_000)
      if (ok && running && changed) {
        let res: Record<string, unknown>
        try {
          res = await netControlCall(control, { op: 'reload' }, 10_000)
        } catch (err) {
          log('warn', 'walnut-net reload failed', { error: (err as Error).message })
          return { endpointId: me, running: ok }
        }
        if (res.ok !== true) {
          // It refused the new config: the one it runs on stays, on disk too.
          if (before) writeFileAtomic(configFile, before)
          throw new Error(`walnut-net refused the config: ${typeof res.error === 'string' ? res.error : 'invalid'}`)
        }
        // A new key, relay or root: it exits 75 and comes back; until then it is not ready.
        if (res.restart === true) ready = false
      }
      return { endpointId: me, running: ok }
    },

    async forward(req: { to?: unknown }): Promise<{ port: number }> {
      const to = typeof req.to === 'string' ? req.to.toLowerCase() : ''
      if (!ID_RE.test(to)) throw new Error('`to` must be an endpoint id')
      const res = await call({ op: 'forward', to })
      return { port: Number(res.port) }
    },

    async probe(req: { to?: unknown }): Promise<Record<string, unknown>> {
      const to = typeof req.to === 'string' ? req.to.toLowerCase() : ''
      if (!ID_RE.test(to)) throw new Error('`to` must be an endpoint id')
      const res = await call({ op: 'probe', to })
      return (res.link ?? {}) as Record<string, unknown>
    },

    stopChild,

    /** Daemon shutdown. */
    async stop(): Promise<void> {
      stopping = true
      if (timer) { clearTimeout(timer); timer = null }
      const proc = child
      if (!proc) return
      await new Promise<void>((resolve) => {
        const kill = setTimeout(() => { try { proc.kill('SIGKILL') } catch { /* gone */ } resolve() }, 3_000)
        proc.once('exit', () => { clearTimeout(kill); resolve() })
        try { proc.kill('SIGTERM') } catch { clearTimeout(kill); resolve() }
      })
    },
  }
}

export type NetSupervisor = ReturnType<typeof createNetSupervisor>

/**
 * This host's net state dir. ONE per account for the account's own daemon, whichever
 * way it runs (the login service, or the daemon a server or an SSH connect started):
 * the key is the machine's identity on the network, and a second key would cut the
 * machine off from every member that knows the first. A daemon in any other dir (a
 * test's, the companion's tunnel daemon) keeps its own beside it.
 */
export function netStateDir(opts: { serviceStateDir?: string | null; prodDaemon: boolean; daemonDir: string; env?: NodeJS.ProcessEnv; home?: string }): string {
  if (opts.serviceStateDir || opts.prodDaemon) {
    const env = opts.env ?? process.env
    const state = env.XDG_STATE_HOME && path.isAbsolute(env.XDG_STATE_HOME) ? env.XDG_STATE_HOME : path.join(opts.home ?? os.homedir(), '.local', 'state')
    return path.join(state, 'open-walnut', 'net')
  }
  return path.join(opts.daemonDir, 'net')
}

/** The walnut-net executable for this install: $WALNUT_NET_BIN, else beside the daemon, else none. */
export function resolveNetBinary(opts: { env?: NodeJS.ProcessEnv; dirs: string[] }): string | null {
  const env = opts.env ?? process.env
  const runs = (f: string) => { try { fs.accessSync(f, fs.constants.X_OK); return fs.statSync(f).isFile() } catch { return false } }
  if (env.WALNUT_NET_BIN) return path.isAbsolute(env.WALNUT_NET_BIN) && runs(env.WALNUT_NET_BIN) ? env.WALNUT_NET_BIN : null
  const name = `walnut-net-${process.platform}-${process.arch}`
  for (const d of opts.dirs) {
    for (const f of [path.join(d, 'walnut-net'), path.join(d, name), path.join(d, netInstallName())]) if (runs(f)) return f
  }
  return null
}
