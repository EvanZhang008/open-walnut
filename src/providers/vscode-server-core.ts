/**
 * Host-local embedded VS Code (code-server) lifecycle — capability 'vscode-v1'.
 *
 * Runs next to the files it edits (per the repo's host-local design principle):
 * for remote hosts inside the daemon, for the local host in-process in the
 * walnut server. The editor's file/terminal/git traffic never crosses the
 * tunnel; only the small {port, token} result does.
 *
 * Ownership & restarts: instance identity is persisted to
 * ~/.open-walnut/code-server/instance.json, so a restarted owner (daemon
 * upgrade, dev:prod redeploy) ADOPTS the live instance instead of leaking it
 * and spawning a second one — same philosophy as CLI session adoption.
 *
 * Idle reaping: keyed on code-server's own heartbeat file (touched about once
 * a minute while a browser is connected), NOT on our last-ensure time — a
 * user with the panel open for 3 hours must never have the editor killed
 * under them. No heartbeat for VSCODE_IDLE_KILL_MS → no client → safe kill.
 *
 * Security model:
 *  - binds 127.0.0.1 only, never the network; remote access is exclusively
 *    via Walnut's SSH local forward.
 *  - `--auth none`: the loopback bind is the boundary — anything that can
 *    reach the port is already a local process on that host, the same trust
 *    level as the daemon itself. The returned token identifies the instance
 *    (stale-URL detection), it is not web auth.
 *
 * Self-contained on purpose (node builtins only): bundled as a sidecar
 * (`vscode-server-core.cjs`) for source-deployed daemons, same mechanism as
 * path-resolve-core.cjs.
 */

import path from 'node:path'
import fsp from 'node:fs/promises'
import fs from 'node:fs'
import os from 'node:os'
import http from 'node:http'
import crypto from 'node:crypto'
import net from 'node:net'
import { spawn, execFile } from 'node:child_process'

/** Pinned release — bump deliberately. */
export const CODE_SERVER_VERSION = '4.98.2'

const START_COOLDOWN_MS = 30_000
const HEALTH_TIMEOUT_MS = 2_000
const SPAWN_WAIT_MS = 15_000
const GIT_TIMEOUT_MS = 5_000
/** No browser heartbeat for 2h → nobody is editing → reap (same posture as CLI sessions). */
export const VSCODE_IDLE_KILL_MS = 2 * 60 * 60 * 1000

export interface VscodeEnsureResult {
  ok: boolean
  running: boolean
  installed: boolean
  port?: number
  /** Random per-instance secret; identifies the instance so a stale URL can be told from a live one. */
  token?: string
  version?: string
  error?: string
  /** Present when installed=false: what a human would need to do by hand. */
  installHint?: string
}

interface InstanceRecord {
  port: number
  token: string
  pid: number
  version: string
  startedAt: number
  /** Runtime binary that spawned this instance. Absent = pre-runtime-fix
   *  record, treated as suspect (may be bun) and respawned. */
  runtime?: string
}

// In-flight spawn guard (within this process) + last attempt for the cooldown.
let starting: Promise<VscodeEnsureResult> | null = null
let lastStartAttempt = 0

function homeDir(): string {
  return process.env.WALNUT_HOME_OVERRIDE || process.env.HOME || os.homedir()
}

function libDir(): string {
  return path.join(homeDir(), '.local', 'lib')
}

function dataDir(): string {
  return path.join(homeDir(), '.open-walnut', 'code-server')
}

function instanceFile(): string {
  return path.join(dataDir(), 'instance.json')
}

/** code-server touches this ~1/min while a browser is connected. */
function heartbeatFile(): string {
  return path.join(dataDir(), 'data', 'heartbeat')
}

async function readInstance(): Promise<InstanceRecord | null> {
  try {
    const raw = await fsp.readFile(instanceFile(), 'utf-8')
    const rec = JSON.parse(raw) as InstanceRecord
    if (typeof rec.port !== 'number' || typeof rec.pid !== 'number' || typeof rec.token !== 'string') return null
    return rec
  } catch {
    return null
  }
}

async function writeInstance(rec: InstanceRecord): Promise<void> {
  await fsp.mkdir(dataDir(), { recursive: true })
  await fsp.writeFile(instanceFile(), JSON.stringify(rec, null, 2))
}

/** Find an installed code-server entry point (any version, newest name wins). */
export async function findCodeServerEntry(): Promise<{ entry: string; version: string } | null> {
  try {
    const entries = await fsp.readdir(libDir())
    const dirs = entries.filter((d) => d.startsWith('code-server-')).sort().reverse()
    for (const d of dirs) {
      const entry = path.join(libDir(), d, 'out', 'node', 'entry.js')
      try {
        await fsp.access(entry)
        return { entry, version: d.replace('code-server-', '') }
      } catch { /* try next */ }
    }
  } catch { /* lib dir missing */ }
  return null
}

function platformTarball(): { file: string; url: string } | null {
  const arch = process.arch === 'arm64' ? 'arm64' : process.arch === 'x64' ? 'amd64' : null
  if (!arch) return null
  const plat = process.platform === 'darwin' ? 'macos' : process.platform === 'linux' ? 'linux' : null
  if (!plat) return null
  const file = `code-server-${CODE_SERVER_VERSION}-${plat}-${arch}.tar.gz`
  return {
    file,
    url: `https://github.com/coder/code-server/releases/download/v${CODE_SERVER_VERSION}/${file}`,
  }
}

/**
 * Download + unpack code-server into ~/.local/lib. curl/wget rather than
 * fetch: node's fetch buffers the ~100MB tarball in memory; curl streams.
 */
async function installCodeServer(): Promise<{ ok: boolean; error?: string }> {
  const tar = platformTarball()
  if (!tar) return { ok: false, error: `unsupported platform ${process.platform}/${process.arch}` }
  const tmp = path.join(os.tmpdir(), `walnut-code-server-${process.pid}-${Date.now()}`)
  await fsp.mkdir(tmp, { recursive: true })
  await fsp.mkdir(libDir(), { recursive: true })
  const tarPath = path.join(tmp, tar.file)

  const dl = await new Promise<{ ok: boolean; error?: string }>((resolve) => {
    const curl = spawn('curl', ['-fsSL', '--retry', '2', '-o', tarPath, tar.url], { stdio: 'ignore' })
    curl.on('error', () => {
      const wget = spawn('wget', ['-qO', tarPath, tar.url], { stdio: 'ignore' })
      wget.on('error', () => resolve({ ok: false, error: 'neither curl nor wget available' }))
      wget.on('exit', (code) => resolve(code === 0 ? { ok: true } : { ok: false, error: `wget exit ${code}` }))
    })
    curl.on('exit', (code) => resolve(code === 0 ? { ok: true } : { ok: false, error: `curl exit ${code}` }))
  })
  if (!dl.ok) {
    await fsp.rm(tmp, { recursive: true, force: true })
    return dl
  }

  const untar = await new Promise<{ ok: boolean; error?: string }>((resolve) => {
    const p = spawn('tar', ['-xzf', tarPath, '-C', tmp], { stdio: 'ignore' })
    p.on('error', (e) => resolve({ ok: false, error: `tar: ${e.message}` }))
    p.on('exit', (code) => resolve(code === 0 ? { ok: true } : { ok: false, error: `tar exit ${code}` }))
  })
  if (!untar.ok) {
    await fsp.rm(tmp, { recursive: true, force: true })
    return untar
  }

  // Tarball unpacks as code-server-<ver>-<plat>-<arch>/ — normalize the name.
  const unpacked = (await fsp.readdir(tmp)).find((d) => d.startsWith('code-server-') && !d.endsWith('.tar.gz'))
  if (!unpacked) {
    await fsp.rm(tmp, { recursive: true, force: true })
    return { ok: false, error: 'tarball unpacked to unexpected layout' }
  }
  const dest = path.join(libDir(), `code-server-${CODE_SERVER_VERSION}`)
  try {
    await fsp.rename(path.join(tmp, unpacked), dest)
  } catch {
    // EXDEV (tmp on another fs) → copy fallback
    await new Promise<void>((resolve, reject) => {
      const p = spawn('cp', ['-R', path.join(tmp, unpacked), dest], { stdio: 'ignore' })
      p.on('error', reject)
      p.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`cp exit ${code}`))))
    })
  }
  await fsp.rm(tmp, { recursive: true, force: true })
  const entry = path.join(dest, 'out', 'node', 'entry.js')
  try {
    await fsp.access(entry)
    return { ok: true }
  } catch {
    return { ok: false, error: 'install finished but entry.js missing' }
  }
}

function healthz(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const req = http.get({ host: '127.0.0.1', port, path: '/healthz', timeout: HEALTH_TIMEOUT_MS }, (res) => {
      res.resume()
      resolve(res.statusCode === 200 || res.statusCode === 302)
    })
    req.on('error', () => resolve(false))
    req.on('timeout', () => { req.destroy(); resolve(false) })
  })
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer()
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address()
      const port = typeof addr === 'object' && addr ? addr.port : 0
      srv.close(() => resolve(port))
    })
    srv.on('error', reject)
  })
}

function pidAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true } catch { return false }
}

/** Does this binary run AND report itself as node? (bun answers `bun-x.y`; a
 *  glibc-mismatched bundled node dies before printing anything). */
function worksAsNode(bin: string): Promise<boolean> {
  return new Promise((resolve) => {
    execFile(bin, ['-e', 'process.stdout.write(process.versions.node && !process.versions.bun ? "ok" : "no")'],
      { timeout: 5_000, encoding: 'utf-8' },
      (err, stdout) => resolve(!err && stdout === 'ok'))
  })
}

let cachedNodeRuntime: string | null | undefined

/**
 * Resolve a REAL Node.js binary to run code-server under. process.execPath is
 * wrong whenever the owner is the bun-compiled daemon: bun serves code-server's
 * static HTML fine but its node-compat layer breaks the workbench's WebSocket
 * path (ERR_STREAM_DESTROYED, missing net APIs) — healthz 200, blank editor.
 * Candidates, first that verifiably runs as node wins:
 *  1. code-server's own bundled lib/node (version-matched; dies on old-glibc hosts)
 *  2. process.execPath when the owner itself IS node (local Mac server)
 *  3. `node` from PATH and well-known user install locations
 */
async function resolveNodeRuntime(entry: string): Promise<string | null> {
  if (cachedNodeRuntime !== undefined) return cachedNodeRuntime
  const home = homeDir()
  // entry = <install>/out/node/entry.js → bundled node at <install>/lib/node
  const bundled = path.join(path.dirname(path.dirname(path.dirname(entry))), 'lib', 'node')
  const candidates = [
    bundled,
    ...(path.basename(process.execPath).startsWith('node') ? [process.execPath] : []),
    'node',
    path.join(home, '.local', 'bin', 'node'),
    '/usr/local/bin/node',
    '/opt/homebrew/bin/node',
    '/usr/bin/node',
  ]
  for (const cand of candidates) {
    if (await worksAsNode(cand)) {
      cachedNodeRuntime = cand
      return cand
    }
  }
  cachedNodeRuntime = null
  return null
}

function killInstance(pid: number): void {
  // code-server handles SIGTERM with hot-exit (unsaved-buffer backups).
  try { process.kill(-pid, 'SIGTERM') } catch { try { process.kill(pid, 'SIGTERM') } catch { /* gone */ } }
}

async function waitForHealthy(port: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await healthz(port)) return true
    await new Promise((r) => setTimeout(r, 400))
  }
  return false
}

async function startCodeServer(entry: string, version: string): Promise<VscodeEnsureResult> {
  // A verified REAL node — never bun (inc-1787164003087: the bun-compiled
  // daemon spawned code-server under bun; static HTML served fine so healthz
  // was 200, but the workbench's WebSocket path died in bun's node-compat
  // layer and the editor rendered blank).
  const runtime = await resolveNodeRuntime(entry)
  if (!runtime) {
    return {
      ok: false, running: false, installed: true,
      error: 'no working Node.js runtime found for code-server (bundled lib/node failed and no system node)',
      installHint: 'install Node.js ≥18 on this host (e.g. ~/.local/bin/node)',
    }
  }

  const port = await freePort()
  const token = crypto.randomBytes(16).toString('hex')
  await fsp.mkdir(dataDir(), { recursive: true })
  const logPath = path.join(dataDir(), 'code-server.log')
  const logFd = fs.openSync(logPath, 'a')

  const child = spawn(runtime, [
    entry,
    '--auth', 'none',
    '--bind-addr', `127.0.0.1:${port}`,
    '--disable-telemetry',
    '--disable-update-check',
    '--disable-workspace-trust',
    '--user-data-dir', path.join(dataDir(), 'data'),
    '--extensions-dir', path.join(dataDir(), 'extensions'),
  ], {
    detached: true,
    stdio: ['ignore', logFd, logFd],
    env: { ...process.env },
  })
  child.unref()
  fs.closeSync(logFd)

  const pid = child.pid ?? 0
  if (!pid) return { ok: false, running: false, installed: true, error: 'spawn returned no pid' }

  const healthy = await waitForHealthy(port, SPAWN_WAIT_MS)
  if (!healthy) {
    killInstance(pid)
    return {
      ok: false, running: false, installed: true,
      error: `code-server did not become healthy on :${port} within ${SPAWN_WAIT_MS / 1000}s (log: ${logPath})`,
    }
  }

  await writeInstance({ port, token, pid, version, startedAt: Date.now(), runtime })
  return { ok: true, running: true, installed: true, port, token, version }
}

/**
 * The single entry point. Idempotent: adopts a live instance (this process's
 * or a predecessor's, via the disk record), restarts a dead one, installs
 * when missing (unless noInstall).
 */
export async function ensureCodeServer(opts: { noInstall?: boolean } = {}): Promise<VscodeEnsureResult> {
  // Adopt a live instance from the disk record (survives owner restarts) —
  // but only one whose record proves a real-node spawn. A record without
  // `runtime` predates the bun fix and may be a bun-spawned instance that
  // answers healthz yet serves a blank workbench: kill and respawn.
  const existing = await readInstance()
  if (existing && pidAlive(existing.pid) && await healthz(existing.port)) {
    if (existing.runtime) {
      return { ok: true, running: true, installed: true, port: existing.port, token: existing.token, version: existing.version }
    }
    killInstance(existing.pid)
    try { fs.rmSync(instanceFile()) } catch { /* already gone */ }
  }

  // A concurrent ensure in this process is already starting one — join it.
  if (starting) return starting

  // Cooldown: don't stack spawn attempts while one might still be warming.
  if (Date.now() - lastStartAttempt < START_COOLDOWN_MS) {
    return { ok: false, running: false, installed: true, error: 'recent start attempt still settling; retry shortly' }
  }

  let found = await findCodeServerEntry()
  if (!found) {
    if (opts.noInstall) {
      return {
        ok: false, running: false, installed: false,
        installHint: `download code-server ${CODE_SERVER_VERSION} into ~/.local/lib/`,
      }
    }
    const inst = await installCodeServer()
    if (!inst.ok) {
      return {
        ok: false, running: false, installed: false, error: inst.error,
        installHint: `download code-server ${CODE_SERVER_VERSION} into ~/.local/lib/`,
      }
    }
    found = await findCodeServerEntry()
    if (!found) return { ok: false, running: false, installed: false, error: 'install succeeded but entry not found' }
  }

  lastStartAttempt = Date.now()
  starting = startCodeServer(found.entry, found.version)
  try {
    return await starting
  } finally {
    starting = null
  }
}

/** Status without side effects (for reapers and diagnostics). */
export async function codeServerStatus(): Promise<{ running: boolean; port?: number; pid?: number }> {
  const rec = await readInstance()
  if (!rec || !pidAlive(rec.pid)) return { running: false }
  return { running: true, port: rec.port, pid: rec.pid }
}

/**
 * Kill the instance if no browser has been connected for VSCODE_IDLE_KILL_MS.
 * Signal = code-server's own heartbeat file (touched ~1/min per live client),
 * so an OPEN editor is never reaped, no matter how long since we spawned it.
 * Returns true if reaped.
 */
export function reapIdleCodeServer(now: number = Date.now()): boolean {
  let rec: InstanceRecord | null = null
  try {
    rec = JSON.parse(fs.readFileSync(instanceFile(), 'utf-8')) as InstanceRecord
  } catch {
    return false
  }
  if (!rec || !pidAlive(rec.pid)) return false
  let lastAlive = rec.startedAt
  try {
    lastAlive = Math.max(lastAlive, fs.statSync(heartbeatFile()).mtimeMs)
  } catch { /* no heartbeat yet — judge from start time */ }
  if (now - lastAlive < VSCODE_IDLE_KILL_MS) return false
  killInstance(rec.pid)
  try { fs.rmSync(instanceFile()) } catch { /* already gone */ }
  return true
}

/** Stop unconditionally (isolated/test daemon exit — production owners let successors adopt). */
export function stopCodeServer(): void {
  let rec: InstanceRecord | null = null
  try {
    rec = JSON.parse(fs.readFileSync(instanceFile(), 'utf-8')) as InstanceRecord
  } catch {
    return
  }
  if (rec && pidAlive(rec.pid)) killInstance(rec.pid)
  try { fs.rmSync(instanceFile()) } catch { /* already gone */ }
}

function expandHome(p: string): string {
  if (p === '~') return homeDir()
  if (p.startsWith('~/')) return path.join(homeDir(), p.slice(2))
  return p
}

async function findGitRootLocal(cwd: string): Promise<string | null> {
  return new Promise((resolve) => {
    execFile('git', ['-C', cwd, 'rev-parse', '--show-toplevel'],
      { timeout: GIT_TIMEOUT_MS, encoding: 'utf-8' },
      (err, stdout) => resolve(err ? null : (stdout.trim() || null)))
  })
}

/**
 * Resolve what to open for a session cwd. Same target the vscode:// deep link
 * picks (git root when inside a repo — the whole tree in the explorer beats a
 * subdir), plus the workspace-file precedence:
 *  1. an existing *.code-workspace directly inside the root (alphabetical first)
 *  2. the root as a plain folder
 * (Auto-GENERATION of workspace files is deliberately not done:
 * Walnut sessions point at arbitrary repos; writing files uninvited is out.)
 */
export async function resolveOpenTarget(dir: string): Promise<{ kind: 'workspace' | 'folder'; path: string }> {
  const expanded = expandHome(dir)
  const root = await findGitRootLocal(expanded) ?? expanded
  try {
    const entries = await fsp.readdir(root, { withFileTypes: true })
    const ws = entries
      .filter((e) => e.isFile() && e.name.endsWith('.code-workspace'))
      .map((e) => e.name)
      .sort()
    if (ws.length > 0) return { kind: 'workspace', path: path.join(root, ws[0]) }
  } catch { /* unreadable dir → let code-server surface it */ }
  return { kind: 'folder', path: root }
}
