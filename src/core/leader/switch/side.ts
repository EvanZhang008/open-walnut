/**
 * One machine of a switch, as the switch command sees it: its server (running or not, stop,
 * start) and its API. This phase has one kind, local: both machines are on this computer, so
 * a server is found by its home's single-instance lock (server.lock.json: pid and port) and
 * started as a child process. A remote side (a later phase) implements the same calls over
 * the links between machines; the flow (flow.ts) does not change.
 */
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import type { MachinePlace } from './settings.js'
import { switchDir } from './records.js'

export type ServerMode = 'leader' | 'trial'

export interface StartResult { ok: boolean; pid?: number; why?: string; logTail?: string }

export interface SwitchSide {
  readonly machine: MachinePlace
  /** The live server on this side's home, if any. */
  runningServer(): { pid: number; port: number | null } | null
  /** A planned stop (SIGTERM, then SIGKILL after `graceMs`); resolves once the process is gone. */
  stopServer(graceMs?: number): Promise<{ wasRunning: boolean }>
  /**
   * Start the server on this side's home and wait until it answers, or fails to.
   * `commitHandover`: the new leader's start after the trial, told it may commit (renew on) that handover.
   */
  startServer(mode: ServerMode, timeoutMs?: number, commitHandover?: number): Promise<StartResult>
  /** One request to this side's server. */
  api(method: string, urlPath: string, body?: unknown): Promise<{ status: number; json: unknown }>
}

function alive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 1) return false
  try { process.kill(pid, 0); return true } catch (err) { return (err as NodeJS.ErrnoException).code === 'EPERM' }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

function defaultCli(): string {
  // src/core/leader/switch/side.ts -> src/cli.ts; dist/... bundles resolve their own entry.
  const here = path.dirname(fileURLToPath(import.meta.url))
  for (const c of [path.resolve(here, '../../../cli.ts'), path.resolve(here, '../../../cli.js'), path.resolve(here, 'cli.js')]) {
    if (fs.existsSync(c)) return c
  }
  return process.argv[1]
}

export class LocalSide implements SwitchSide {
  constructor(readonly machine: MachinePlace) {}

  runningServer(): { pid: number; port: number | null } | null {
    try {
      const lock = JSON.parse(fs.readFileSync(path.join(this.machine.home, 'server.lock.json'), 'utf8')) as { pid?: number; port?: number | null }
      return typeof lock.pid === 'number' && alive(lock.pid) ? { pid: lock.pid, port: lock.port ?? null } : null
    } catch {
      return null
    }
  }

  async stopServer(graceMs = 30_000): Promise<{ wasRunning: boolean }> {
    const s = this.runningServer()
    if (!s) return { wasRunning: false }
    try { process.kill(s.pid, 'SIGTERM') } catch { /* gone already */ }
    const deadline = Date.now() + graceMs
    while (alive(s.pid) && Date.now() < deadline) await sleep(100)
    if (alive(s.pid)) {
      try { process.kill(s.pid, 'SIGKILL') } catch { /* gone */ }
      while (alive(s.pid)) await sleep(50)
    }
    return { wasRunning: true }
  }

  async startServer(mode: ServerMode, timeoutMs = 120_000, commitHandover?: number): Promise<StartResult> {
    const m = this.machine
    const cmd = m.start ?? [process.execPath, defaultCli(), 'web', '--port', String(m.port)]
    fs.mkdirSync(switchDir(m.home), { recursive: true, mode: 0o700 })
    const logFile = path.join(switchDir(m.home), `server-${mode}.log`)
    const out = fs.openSync(logFile, 'a', 0o600)
    const env: NodeJS.ProcessEnv = { ...process.env, ...m.env, OPEN_WALNUT_HOME: m.home }
    if (mode === 'trial') env.WALNUT_LEADER_TRIAL = '1'
    else delete env.WALNUT_LEADER_TRIAL
    if (mode === 'leader' && commitHandover) env.WALNUT_LEADER_SWITCH_COMMIT = String(commitHandover)
    else delete env.WALNUT_LEADER_SWITCH_COMMIT
    const child = spawn(cmd[0], cmd.slice(1), { env, detached: true, stdio: ['ignore', out, out] })
    fs.closeSync(out)
    let exited: number | null = null
    child.on('exit', (code, signal) => { exited = code ?? (signal ? 128 : 1) })
    child.unref()
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      if (exited !== null) return { ok: false, why: `the server exited during its start (code ${exited})`, logTail: tail(logFile) }
      const r = await this.api('GET', '/api/health').catch(() => null)
      const running = this.runningServer()
      if (r && r.status < 500 && running) return { ok: true, pid: running.pid }
      await sleep(250)
    }
    try { if (child.pid) process.kill(child.pid, 'SIGKILL') } catch { /* gone */ }
    return { ok: false, why: `the server did not answer within ${Math.round(timeoutMs / 1000)} s`, logTail: tail(logFile) }
  }

  async api(method: string, urlPath: string, body?: unknown): Promise<{ status: number; json: unknown }> {
    const res = await fetch(`http://127.0.0.1:${this.machine.port}${urlPath}`, {
      method,
      headers: { 'content-type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      // A handover or cancel waits on the witnesses (seconds, more when some do not answer).
      signal: AbortSignal.timeout(method === 'GET' ? 10_000 : 60_000),
    })
    return { status: res.status, json: await res.json().catch(() => null) }
  }
}

function tail(file: string, bytes = 4_000): string {
  try {
    const b = fs.readFileSync(file)
    return b.subarray(Math.max(0, b.length - bytes)).toString('utf8')
  } catch {
    return ''
  }
}
