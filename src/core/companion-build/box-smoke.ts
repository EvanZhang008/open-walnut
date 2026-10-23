/**
 * One isolated boot of a build before the companion switches to it: the
 * dev-prod.sh smoke recipe (scripts/dev-prod.sh, "Pre-kill smoke boot"), the
 * build run by the box's own bun. A probe port, a temporary home and daemon
 * dir, ready when GET /api/v1/instance answers 200; then the server and the
 * daemon it started are stopped and the temporary dir removed.
 *
 * The temporary dir is `walnut-smoke-XXXX`, never `open-walnut-*`: a home
 * under {tmpdir}/open-walnut-* is reverted to ~/.open-walnut for a process that
 * is not ephemeral, which would boot the smoke server on the box's real data.
 */

import { execFile, spawn, type ChildProcess } from 'node:child_process'
import fsp from 'node:fs/promises'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { bunCommand } from '../../lib/runtime.js'

/** Variables that would point the smoke server at the live server's state, or make it a test. */
const DROP_ENV = new Set(['VITEST', 'OPEN_WALNUT_EPHEMERAL', 'WALNUT_STREAMS_DIR', 'WALNUT_GIT_HUB_DIR', 'WALNUT_SETUP_TOKEN_FILE', 'WALNUT_SETUP_TOKEN'])

export function smokeEnv(base: NodeJS.ProcessEnv, tmp: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {}
  for (const [k, v] of Object.entries(base)) {
    if (v === undefined || DROP_ENV.has(k) || k.startsWith('WALNUT_COMPANION_')) continue
    env[k] = v
  }
  return {
    ...env,
    OPEN_WALNUT_HOME: path.join(tmp, 'home'),
    WALNUT_DAEMON_DIR: path.join(tmp, 'daemon'),
    // Not just dropped: unset, it falls back to the box's real hub dir (/var/lib/walnut/git).
    WALNUT_GIT_HUB_DIR: path.join(tmp, 'git'),
    WALNUT_DISABLE_SEARCH: '1',
    WALNUT_DAEMON_HEARTBEAT_MS: '2000',
    WALNUT_STT_AUTO_SETUP: '0',
    WALNUT_NO_AUTO_UPDATE: '1',
  }
}

export interface SmokeResult {
  ok: boolean
  /** Why it failed, one sentence. */
  reason?: string
  /** The last lines of the smoke log. */
  logTail: string[]
  ms: number
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = net.createServer()
    s.once('error', reject)
    s.listen(0, '127.0.0.1', () => {
      const addr = s.address()
      const port = addr && typeof addr === 'object' ? addr.port : 0
      s.close(() => (port ? resolve(port) : reject(new Error('no free port'))))
    })
  })
}

async function answers(port: number, budgetMs: number): Promise<boolean> {
  try {
    const r = await fetch(`http://127.0.0.1:${port}/api/v1/instance`, { signal: AbortSignal.timeout(Math.max(200, Math.min(2_000, budgetMs))) })
    await r.arrayBuffer().catch(() => {})
    return r.status === 200
  } catch {
    return false
  }
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (err) {
    // EPERM: alive, but not this user's; never ours to signal.
    return (err as NodeJS.ErrnoException).code === 'EPERM'
  }
}

function signal(pid: number, sig: NodeJS.Signals): void {
  if (!Number.isInteger(pid) || pid <= 1) return
  try { process.kill(pid, sig) } catch { /* gone */ }
}

async function stopChild(child: ChildProcess, exited: Promise<unknown>): Promise<void> {
  const pid = child.pid
  if (!pid || pid <= 1 || child.exitCode !== null || child.signalCode !== null) return
  child.kill('SIGTERM')
  const gone = await Promise.race([exited.then(() => true), sleep(10_000).then(() => false)])
  if (!gone) {
    child.kill('SIGKILL')
    await Promise.race([exited, sleep(2_000)])
  }
}

function commandOf(pid: number): Promise<string> {
  return new Promise((resolve) => {
    execFile('ps', ['-o', 'command=', '-p', String(pid)], { timeout: 5_000 }, (_err, stdout) => resolve(String(stdout ?? '').trim()))
  })
}

/** The smoke server's local daemon detaches and outlives it (dev-prod.sh smoke_cleanup). */
async function stopDaemon(tmp: string): Promise<void> {
  let text = ''
  try { text = (await fsp.readFile(path.join(tmp, 'daemon', 'daemon.pid'), 'utf8')).trim() } catch { return }
  if (!/^\d+$/.test(text)) return
  const pid = Number(text)
  if (pid <= 1 || pid === process.pid || !alive(pid)) return
  if (!/daemon|open-walnut/.test(await commandOf(pid))) return
  signal(pid, 'SIGTERM')
  for (let i = 0; i < 6 && alive(pid); i++) await sleep(500)
  if (alive(pid)) signal(pid, 'SIGKILL')
}

/** The last `n` lines of a file, read from its end (a smoke log can be large). */
export async function tailLines(file: string, n: number): Promise<string[]> {
  let fh: fsp.FileHandle | null = null
  try {
    fh = await fsp.open(file, 'r')
    const { size } = await fh.stat()
    const len = Math.min(size, 16 * 1024)
    const buf = Buffer.alloc(len)
    await fh.read(buf, 0, len, size - len)
    return buf.toString('utf8').split('\n').map((l) => l.trimEnd()).filter(Boolean).slice(-n)
  } catch {
    return []
  } finally {
    await fh?.close().catch(() => {})
  }
}

/** Boot `cli` once, isolated, and say whether it served /api/v1/instance within `timeoutMs`. */
export async function smokeBoot(opts: { cli: string; cwd: string; logFile: string; timeoutMs: number; env?: NodeJS.ProcessEnv }): Promise<SmokeResult> {
  const started = Date.now()
  const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'walnut-smoke-'))
  let child: ChildProcess | null = null
  let exited: Promise<{ code: number | null; signal: string | null }> = Promise.resolve({ code: null, signal: null })
  // A server that ends mid-smoke must not leave the candidate running on its probe port.
  const onExit = () => { if (child?.pid && child.pid > 1) child.kill('SIGTERM') }
  let result: Omit<SmokeResult, 'logTail' | 'ms'>
  try {
    await fsp.mkdir(path.join(tmp, 'home'), { recursive: true })
    await fsp.mkdir(path.join(tmp, 'daemon'), { recursive: true })
    const port = await freePort()
    const out = await fsp.open(opts.logFile, 'w')
    try {
      // The box's own bun runs the candidate (a compiled walnut file acts as bun for a script outside it).
      const bun = bunCommand(smokeEnv(opts.env ?? process.env, tmp))
      child = spawn(bun.command, [opts.cli, 'web', '--port', String(port)], {
        cwd: opts.cwd,
        env: bun.env,
        stdio: ['ignore', out.fd, out.fd],
      })
    } finally {
      await out.close()
    }
    const c = child
    let exit: { code: number | null; signal: string | null } | null = null
    exited = new Promise((resolve) => {
      c.once('exit', (code, sig) => resolve({ code, signal: sig }))
      c.once('error', (err) => resolve({ code: null, signal: err.message }))
    })
    void exited.then((e) => { exit = e })
    process.once('exit', onExit)
    const deadline = started + opts.timeoutMs
    let ok = false
    while (!exit && Date.now() < deadline) {
      if (await answers(port, deadline - Date.now())) { ok = true; break }
      await Promise.race([sleep(500), exited])
    }
    const e = exit as { code: number | null; signal: string | null } | null
    result = ok
      ? { ok: true }
      : e
        ? { ok: false, reason: `the build exited (${e.code !== null ? `code ${e.code}` : e.signal ?? 'unknown'}) before it served /api/v1/instance` }
        : { ok: false, reason: `the build did not serve /api/v1/instance within ${Math.round(opts.timeoutMs / 1000)} s` }
  } catch (err) {
    result = { ok: false, reason: `the smoke boot could not run: ${err instanceof Error ? err.message : String(err)}` }
  } finally {
    if (child) await stopChild(child, exited)
    process.removeListener('exit', onExit)
    await stopDaemon(tmp)
    await fsp.rm(tmp, { recursive: true, force: true }).catch(() => {})
  }
  return { ...result, logTail: result.ok ? [] : await tailLines(opts.logFile, 3), ms: Date.now() - started }
}
