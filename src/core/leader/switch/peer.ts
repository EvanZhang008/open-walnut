/**
 * The copy link (docs/reference/leader-switch.md, "Two jobs"): what the old leader's SERVER can
 * ask of the new leader's machine, the only link between the two machines during a switch. Only
 * that server holds one (it already sends its standby batches over it); the switch jobs never do.
 *
 *   batch, verify      the standby transport (the final batch rides it)
 *   switch files       a small file under <standby_dir>/switch/ (the ticket, the final mark), read back
 *   start the job      the new leader's target job, detached (check mode, then for real)
 *
 * Kinds:
 *   local    both machines on one computer, or a standby folder this machine reaches as a path
 *   daemon   the leader's link to the other machine's daemon, the one `standby.host` uses: the
 *            batches are RemoteStandbyTarget's, the files `fs.write {atomic}` and `fs.read`, the
 *            job `exec.run {detach}`. Only existing capability-gated commands (DAEMON_PEER_CAPABILITIES);
 *            `ready()` names the ones the daemon's hello lacks
 *   door     frames on a socket the other machine's host service dialed (a later step: refused by name)
 */
import fs from 'node:fs'
import path from 'node:path'
import { randomBytes } from 'node:crypto'
import { spawn } from 'node:child_process'
import type { BatchOutcome } from '../../standby/index.js'
import type { DaemonLink } from '../../standby/remote-transport.js'
import type { MachinePlace } from './settings.js'
import { readSwitchFile, switchFolder, writeSwitchFile } from './ticket.js'
import { serverCommand } from '../../trial-start/process.js'

export type PeerKind = 'local' | 'daemon' | 'door'

export interface StartJobResult { ok: boolean; why?: string; pid?: number }

export interface SwitchPeer {
  readonly kind: PeerKind
  /** The machine the lead goes to. */
  readonly machine: MachinePlace
  /** Its standby folder (where the batches land, and the switch's files). */
  readonly standbyDir: string
  /** One standby batch of `home` into that folder. */
  batch(home: string): Promise<BatchOutcome>
  /** A verify pass of that folder (the copy rebuilt from its chunks where it drifted): how many paths had drifted. */
  verify(): Promise<{ drift: number }>
  /** Why this link cannot carry a switch now (the other machine's daemon lacks a command), or null. */
  ready(): Promise<string | null>
  /** A file under `<standbyDir>/switch/`, durable when this returns. `null` stands for "none" (a check report cleared). */
  writeFile(name: string, value: unknown): Promise<void>
  readFile<T>(name: string): Promise<T | null>
  /** Start the target job of `switchId` on that machine, detached; a job of it that runs already is left alone. */
  startTargetJob(switchId: string, opts: { check: boolean }): Promise<StartJobResult>
  /** Stop sending there (the final stop closes every link). */
  close(): void
}

/** The argv of the target job (the same command on every kind: `exec.run` runs it on the other machine). */
export function targetJobArgs(switchId: string, standbyDir: string, check: boolean): string[] {
  return ['leader', 'switch', '--job', 'target', '--switch', switchId, '--standby-dir', standbyDir, ...(check ? ['--check'] : [])]
}

/** A detached job's output, beside its state: outside every home. */
export function targetJobLog(standbyDir: string, switchId: string, check: boolean): string {
  return path.join(switchFolder(standbyDir), `${switchId}${check ? '.check' : ''}.log`)
}

export class LocalPeer implements SwitchPeer {
  readonly kind = 'local' as const
  constructor(readonly machine: MachinePlace, readonly standbyDir: string, private readonly env: NodeJS.ProcessEnv = process.env) {}

  async batch(home: string): Promise<BatchOutcome> {
    const { snapshotTo } = await import('../../standby/index.js')
    return snapshotTo(home, this.standbyDir)
  }

  async verify(): Promise<{ drift: number }> {
    const { verifyStandby } = await import('../../standby/index.js')
    return { drift: (await verifyStandby(this.standbyDir)).drift.length }
  }

  async ready(): Promise<string | null> { return null }

  async writeFile(name: string, value: unknown): Promise<void> { writeSwitchFile(this.standbyDir, name, value) }
  async readFile<T>(name: string): Promise<T | null> { return readSwitchFile<T>(this.standbyDir, name) }

  async startTargetJob(switchId: string, opts: { check: boolean }): Promise<StartJobResult> {
    const { targetJobRunning } = await import('./target-job.js')
    if (!opts.check) {
      const pid = targetJobRunning(this.standbyDir, switchId)
      if (pid) return { ok: true, pid }
    }
    const log = targetJobLog(this.standbyDir, switchId, opts.check)
    fs.mkdirSync(path.dirname(log), { recursive: true, mode: 0o700 })
    const out = fs.openSync(log, 'a', 0o600)
    // The other machine's own environment (its HOME, machine id), as its daemon would run it; the home
    // is named, never made: the job's promotion renames the copy to it.
    const env: NodeJS.ProcessEnv = { ...this.env, ...this.machine.env, OPEN_WALNUT_HOME: this.machine.home }
    for (const k of ['WALNUT_LEADER_TRIAL', 'WALNUT_LEADER_SWITCH_COMMIT', 'WALNUT_LEADER_SWITCH_KILL_AT', 'WALNUT_LEADER_SWITCH_START']) delete env[k]
    const cmd = serverCommand(targetJobArgs(switchId, this.standbyDir, opts.check))
    const child = spawn(cmd[0]!, cmd.slice(1), { env, detached: true, stdio: ['ignore', out, out] })
    fs.closeSync(out)
    child.unref()
    return { ok: true, ...(child.pid ? { pid: child.pid } : {}) }
  }

  close(): void { /* nothing held */ }
}

/** What a daemon must say in its hello to carry a switch's copy link (each gates a command DaemonPeer sends). */
export const DAEMON_PEER_CAPABILITIES = [
  'fs-write-part-v1',    // the batches' chunks and uploads (fs.writePart)
  'host-script-v1',      // `walnut standby receive` (exec.script)
  'host-exec-v1',        // the apply and the target job (exec.run with argv, background and a job id)
  'host-exec-group-v1',  // a run that ends its process group
  'host-exec-detach-v1', // the target job outlives the daemon there (exec.run detach)
  'fs-write-atomic-v1',  // the ticket and the final mark (fs.write atomic: renamed into place after an fsync)
] as const

/** The daemon's job id of a target job (host-exec-core.ts JOB_ID_RE: hx- and at most 64 more). */
export function targetJobId(switchId: string, check: boolean): string {
  return `hx-leader-switch-${switchId.replace(/[^A-Za-z0-9_-]/g, '_')}${check ? `-check-${randomBytes(3).toString('hex')}` : ''}`
}

/** Who the target job is for, in the daemon's job log there. */
const CALLER = { task: 'leader-switch' }
/** The target job's limit there: the daemon's own for a background run (host-exec-core.ts BACKGROUND_MAX_MS). */
const JOB_MAX_MS = 2 * 60 * 60_000
const FILE_TIMEOUT_MS = 60_000

/**
 * The copy link over the leader's link to the new leader's machine's daemon (`standby.host`). The
 * batches go through the same RemoteStandbyTarget the standby runner uses; the rest is three
 * commands every current daemon has. Every command waits for a dropped link as the target does
 * (the link is dialled again), so a short cut costs time, never a wrong answer: a file write is
 * the same write twice, and a job start sent again is refused `job_exists` by the daemon.
 */
export class DaemonPeer implements SwitchPeer {
  readonly kind = 'daemon' as const
  private readonly target: import('../../standby/remote-transport.js').RemoteStandbyTarget
  private link: DaemonLink | null = null
  private closed = false

  constructor(
    readonly machine: MachinePlace,
    readonly standbyDir: string,
    private readonly o: {
      host: string
      connect: () => Promise<DaemonLink>
      /** The leader's home: the chunks wait in its tmp/ (as the standby runner's do). */
      home: string
      /** The walnut program there (`standby.walnut`, default walnut). */
      walnut?: string[]
      linkWaitMs?: number
      target: import('../../standby/remote-transport.js').RemoteStandbyTarget
    },
  ) {
    this.target = o.target
  }

  private async conn(): Promise<DaemonLink> {
    if (this.closed) throw new Error('the copy link was closed')
    this.link ??= await this.o.connect()
    return this.link
  }

  /** One command, sent again over a new link while the link is down (for `linkWaitMs`); a refusal throws. */
  private async call(cmd: string, params: Record<string, unknown>, timeoutMs = FILE_TIMEOUT_MS): Promise<Record<string, unknown>> {
    const { linkFailureKind } = await import('../../../providers/link-failure.js')
    const until = Date.now() + (this.o.linkWaitMs ?? 120_000)
    for (let attempt = 0; ; attempt++) {
      let reply: Record<string, unknown>
      try {
        reply = await (await this.conn()).send(cmd, params, timeoutMs)
      } catch (err) {
        if (!linkFailureKind(err) || Date.now() >= until || this.closed) throw err
        this.link = null
        await new Promise((r) => setTimeout(r, Math.min(5_000, 250 * 2 ** attempt)))
        continue
      }
      if (reply.ok === false) {
        const why = String(reply.error ?? reply.code ?? 'refused')
        throw Object.assign(new Error(`${cmd} on ${this.o.host}: ${why}`), { code: typeof reply.code === 'string' ? reply.code : '' })
      }
      return reply
    }
  }

  private file(name: string): string { return path.join(switchFolder(this.standbyDir), name) }

  async batch(home: string): Promise<BatchOutcome> {
    const { takeBatch } = await import('../../standby/index.js')
    return takeBatch({ home, transport: this.target, stagingDir: path.join(home, 'tmp', 'standby-staging') })
  }

  async verify(): Promise<{ drift: number }> {
    return { drift: (await this.target.verify()).verify.drift.length }
  }

  async ready(): Promise<string | null> {
    let c: DaemonLink
    try { c = await this.conn() } catch (err) { return `the daemon on ${this.o.host} does not answer: ${err instanceof Error ? err.message : String(err)}` }
    if (typeof c.hasCapability !== 'function') return `the link to ${this.o.host} does not say what its daemon can do`
    const missing = DAEMON_PEER_CAPABILITIES.filter((x) => !c.hasCapability!(x))
    return missing.length ? `the Walnut daemon on ${this.o.host} lacks ${missing.join(', ')} (update Walnut there): it cannot carry the switch's copy link` : null
  }

  async writeFile(name: string, value: unknown): Promise<void> {
    await this.call('fs.write', { path: this.file(name), data: Buffer.from(`${JSON.stringify(value, null, 2)}\n`).toString('base64'), encoding: 'base64', atomic: true })
  }

  async readFile<T>(name: string): Promise<T | null> {
    let r: Record<string, unknown>
    try {
      r = await this.call('fs.read', { path: this.file(name), encoding: 'utf-8' })
    } catch (err) {
      if (/\(ENOENT\)|ENOENT/.test(String((err as Error).message))) return null
      throw err
    }
    try { return JSON.parse(String(r.data ?? '')) as T } catch { return null }
  }

  async startTargetJob(switchId: string, opts: { check: boolean }): Promise<StartJobResult> {
    // The other machine's own environment as its leader_switch entry names it, and the home it is to lead (named, never
    // made: the promotion renames the copy to it). exec.run has no env field: `env` in front, as `standby receive` runs.
    const env = Object.entries({ ...(this.machine.env ?? {}), OPEN_WALNUT_HOME: this.machine.home }).map(([k, v]) => `${k}=${v}`)
    const argv = ['env', ...env, ...(this.o.walnut ?? ['walnut']), ...targetJobArgs(switchId, this.standbyDir, opts.check)]
    try {
      const r = await this.call('exec.run', {
        jobId: targetJobId(switchId, opts.check), argv, background: true, endGroup: true, detach: true, timeoutMs: JOB_MAX_MS, caller: CALLER,
      })
      return { ok: true, ...(typeof r.pid === 'number' ? { pid: r.pid } : {}) }
    } catch (err) {
      // Started already (a start sent again after its answer was lost, or a resumed source job asking again).
      if ((err as { code?: string }).code === 'job_exists') return { ok: true }
      return { ok: false, why: err instanceof Error ? err.message : String(err) }
    }
  }

  close(): void {
    this.closed = true
    this.target.close()
  }
}

/**
 * The copy link of this leader to the machine `to`, from its own standby setting: the same place its
 * standby runner sends to (a folder here: kind local; a folder on the host `standby.host`: kind daemon,
 * over `connect`, the server's own link to that host). Refused (with why) when that is not `to`'s.
 */
export async function peerFor(o: { to: MachinePlace; standby: { dir?: string; host?: string; walnut?: string[] }; home: string; env?: NodeJS.ProcessEnv; connect?: (host: string) => Promise<DaemonLink>; linkWaitMs?: number }): Promise<SwitchPeer | { refused: string }> {
  if (!o.standby.dir) return { refused: 'this leader has no standby.dir: its copy goes nowhere' }
  if (o.standby.host) {
    if (o.standby.host !== o.to.id && o.standby.host !== o.to.hostKey) return { refused: `this leader's standby copy is on host ${o.standby.host}, not on ${o.to.id}` }
    if (path.resolve(o.standby.dir) !== path.resolve(o.to.standbyDir)) return { refused: `this leader's standby copy goes to ${o.standby.host}:${o.standby.dir}, not to ${o.to.id}'s standby_dir ${o.to.standbyDir}` }
    const host = o.standby.host
    const connect = o.connect ?? (async (h: string) => (await import('../../hosts/link.js')).link(h))
    const { RemoteStandbyTarget } = await import('../../standby/remote-transport.js')
    const target = new RemoteStandbyTarget({ connect: () => connect(host), dir: o.to.standbyDir, ...(o.standby.walnut ? { walnut: o.standby.walnut } : {}), spoolDir: path.join(o.home, 'tmp', 'standby-spool'), ...(o.linkWaitMs ? { linkWaitMs: o.linkWaitMs } : {}) })
    return new DaemonPeer(o.to, o.to.standbyDir, { host, connect: () => connect(host), home: o.home, ...(o.standby.walnut ? { walnut: o.standby.walnut } : {}), ...(o.linkWaitMs ? { linkWaitMs: o.linkWaitMs } : {}), target })
  }
  if (path.resolve(o.standby.dir) !== path.resolve(o.to.standbyDir)) return { refused: `this leader's standby copy goes to ${o.standby.dir}, not to ${o.to.id}'s standby_dir ${o.to.standbyDir}` }
  return new LocalPeer(o.to, o.to.standbyDir, o.env)
}
