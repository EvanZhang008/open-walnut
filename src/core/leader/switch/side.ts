/**
 * One machine of a switch, as the switch command sees it: its server (running or not, stop,
 * start) and its API. This phase has one kind, local: both machines are on this computer, so
 * a server is found by its home's single-instance lock (server.lock.json: pid and port) and
 * started as a child process. A remote side (a later phase) implements the same calls over
 * the links between machines; the flow (flow.ts) does not change.
 *
 * A home that handed the leader over may run a standby instead (handed-over.ts): it holds the
 * server's port but no lock in the home, so `runningServer()` (a server that may lead) does not
 * count it. `stopServer()` stops it too, and `startServer()` stops it first: a switch back
 * starts the leader on that port.
 */
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import type { MachinePlace } from './settings.js'
import { switchDir } from './records.js'
import { confirmStandby, readStandbyServer, type StandbyServer } from './handed-over.js'
import { standbyServerFile } from './machine-id.js'
import { alive, serverCommand, stopPid, tail } from '../../trial-start/process.js'
import { waitForConsolePort } from './console-port.js'
import { consoleDir, consoleDirOfAccount } from '../../handed-over-console.js'
import type { WitnessReachReport } from './witness-reach.js'

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

/** End a server this side spawned itself that did not answer in time. */
function killSpawned(child: { pid?: number }): void {
  try { if (child.pid) process.kill(child.pid, 'SIGKILL') } catch { /* gone */ }
}

export type ServerMode = 'leader' | 'trial'

export interface StartResult { ok: boolean; pid?: number; why?: string; logTail?: string }

export interface SwitchSide {
  readonly machine: MachinePlace
  /** The live server on this side's home that may lead (a standby is not one), if any. */
  runningServer(): { pid: number; port: number | null } | null
  /** The standby of a handed-over home running on this side, if any. */
  standbyServer(): StandbyServer | null
  /** A planned stop of the server and of a standby (SIGTERM, then SIGKILL after `graceMs`); resolves once both are gone. `wasRunning`: the server was. */
  stopServer(graceMs?: number): Promise<{ wasRunning: boolean }>
  /**
   * Start the server on this side's home and wait until it answers, or fails to.
   * `commitHandover`: the new leader's start after the trial, told it may commit (renew on) that handover.
   */
  startServer(mode: ServerMode, timeoutMs?: number, commitHandover?: number): Promise<StartResult>
  /**
   * Start this side's home again after its handover, as its launcher would: it boots as the handed-over standby
   * (handed-over.ts), which keeps this machine's witness door up. ok once the standby answers.
   */
  startStandby(timeoutMs?: number): Promise<StartResult>
  /** One request to this side's server. */
  api(method: string, urlPath: string, body?: unknown): Promise<{ status: number; json: unknown }>
  /**
   * What THIS machine reaches of the witnesses with no leader link (ways a and b, witness-reach.ts),
   * as it would on its own: its machine identity, and the config and Walnut id of `copyHome`, its
   * own copy of the leader data (the standby copy, which carries every witness key).
   */
  reachWitnesses(copyHome: string): Promise<WitnessReachReport>
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

  standbyServer(): StandbyServer | null {
    return readStandbyServer(this.machine.home, { ...process.env, ...this.machine.env })
  }

  /** Stops this home's standby, once its port confirmed the pid its file names (a pid is used again). */
  private async stopStandby(graceMs: number): Promise<void> {
    const standby = this.standbyServer()
    if (standby && await confirmStandby(standby)) await stopPid(standby.pid, graceMs)
  }

  async stopServer(graceMs = 30_000): Promise<{ wasRunning: boolean }> {
    await this.stopStandby(graceMs)
    const s = this.runningServer()
    if (!s) return { wasRunning: false }
    await stopPid(s.pid, graceMs)
    return { wasRunning: true }
  }

  async startServer(mode: ServerMode, timeoutMs = 120_000, commitHandover?: number): Promise<StartResult> {
    const m = this.machine
    // A standby of this home holds the port the server is to listen on.
    await this.stopStandby(30_000)
    // So may this machine's console replica, until it sees the home it served is gone (a switch back).
    // Its console files are its account's (its HOME), which need not be this process's.
    const port = await waitForConsolePort(m.home, m.port, 30_000, m.env?.HOME ? consoleDirOfAccount(m.env.HOME) : consoleDir())
    if (!port.ok) return { ok: false, why: port.why }
    const { exited, logFile, child } = this.spawnServer(mode, commitHandover)
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      if (exited() !== null) return { ok: false, why: `the server exited during its start (code ${exited()})`, logTail: tail(logFile) }
      // It came up as a standby (its home handed over, or another machine leads): no start.
      const standby = this.standbyServer()
      if (standby && await confirmStandby(standby)) {
        const st = await this.api('GET', '/api/leader/status').catch(() => null)
        await stopPid(standby.pid, 10_000)
        return { ok: false, why: `it runs as a standby: ${(st?.json as { message?: string } | null)?.message ?? 'another machine leads'}`, logTail: tail(logFile) }
      }
      const r = await this.api('GET', '/api/health').catch(() => null)
      const running = this.runningServer()
      if (r && r.status < 500 && running) return { ok: true, pid: running.pid }
      await sleep(250)
    }
    killSpawned(child)
    return { ok: false, why: `the server did not answer within ${Math.round(timeoutMs / 1000)} s`, logTail: tail(logFile) }
  }

  async startStandby(timeoutMs = 60_000): Promise<StartResult> {
    const running = this.standbyServer()
    if (running && await confirmStandby(running)) return { ok: true, pid: running.pid }
    // Its output goes beside its pid file, outside the home: a handed-over home stays as its final batch left it.
    const env = { ...process.env, ...this.machine.env }
    const { exited, logFile, child } = this.spawnServer('leader', undefined, standbyServerFile(this.machine.home, env).replace(/\.json$/, '.log'))
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      if (exited() !== null) return { ok: false, why: `it exited during its start (code ${exited()})`, logTail: tail(logFile) }
      const standby = this.standbyServer()
      if (standby && await confirmStandby(standby)) return { ok: true, pid: standby.pid }
      // A server that would lead here is no standby: this home is not handed over.
      if (this.runningServer()) {
        await stopPid(this.runningServer()!.pid, 10_000)
        return { ok: false, why: 'it started as a server that may lead, not as a standby (the home is not handed over)', logTail: tail(logFile) }
      }
      await sleep(250)
    }
    killSpawned(child)
    return { ok: false, why: `the standby did not answer within ${Math.round(timeoutMs / 1000)} s`, logTail: tail(logFile) }
  }

  /** Spawn this home's server command, detached, its output to `logFile` (default the switch's log of `mode`). */
  private spawnServer(mode: ServerMode, commitHandover?: number, logTo?: string): { child: ReturnType<typeof spawn>; logFile: string; exited: () => number | null } {
    const m = this.machine
    const cmd = m.start ?? serverCommand(['web', '--port', String(m.port)])
    const logFile = logTo ?? path.join(switchDir(m.home), `server-${mode}.log`)
    fs.mkdirSync(path.dirname(logFile), { recursive: true, mode: 0o700 })
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
    return { child, logFile, exited: () => exited }
  }

  /**
   * On this computer, in this process with the other machine's identity (its machine-id file and
   * witness root from its env): the same function a side on another machine runs there.
   */
  async reachWitnesses(copyHome: string): Promise<WitnessReachReport> {
    const [{ readHomeSwitchConfig }, { instanceIdAt }, { thisMachine }, { probeWitnessReach }] = await Promise.all([
      import('./settings.js'), import('../../device-store.js'), import('./permit-ops.js'), import('./witness-reach.js'),
    ])
    const cfg = readHomeSwitchConfig(copyHome)
    if (!cfg.settings) throw new Error(`${copyHome} has no leader_switch section the new leader would read`)
    const walnutId = await instanceIdAt(copyHome)
    if (!walnutId) throw new Error(`${copyHome} holds no Walnut id`)
    const env = { ...process.env, ...this.machine.env }
    return probeWitnessReach({ places: cfg.settings.witnesses, params: cfg.settings.params, here: thisMachine(env, walnutId), walnutId })
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
