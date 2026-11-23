/**
 * The copy link (docs/reference/leader-switch.md, "Two jobs"): what the old leader's SERVER can
 * ask of the new leader's machine, the only link between the two machines during a switch. Only
 * that server holds one (it already sends its standby batches over it); the switch jobs never do.
 *
 *   batch, verify      the standby transport (the final batch rides it)
 *   switch files       a small file under <standby_dir>/switch/ (the ticket, the final mark), read back
 *   start the job      the new leader's target job, detached (check mode, then for real)
 *
 * Kinds: `local` (both machines on one computer, or a standby folder this machine reaches as a
 * path), built here. `daemon` (the leader's link to the other machine's daemon: RemoteStandbyTarget,
 * `fs.write`, `exec.run {detach}`) and `door` (frames on a socket the other machine's host service
 * dialed) implement the same interface in later steps; `peerFor` refuses them by name until then.
 */
import fs from 'node:fs'
import path from 'node:path'
import { spawn } from 'node:child_process'
import type { BatchOutcome } from '../../standby/index.js'
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
  /** A verify pass of that folder (the copy rebuilt from its chunks where it drifted). */
  verify(): Promise<void>
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

  async verify(): Promise<void> {
    const { verifyStandby } = await import('../../standby/index.js')
    await verifyStandby(this.standbyDir)
  }

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

/**
 * The copy link of this leader to the machine `to`, from its own standby setting: the same place its
 * standby runner sends to. Refused (with why) when that is not `to`'s standby folder, or a kind not built yet.
 */
export function peerFor(o: { to: MachinePlace; standby: { dir?: string; host?: string }; env?: NodeJS.ProcessEnv }): SwitchPeer | { refused: string } {
  if (!o.standby.dir) return { refused: 'this leader has no standby.dir: its copy goes nowhere' }
  if (o.standby.host) return { refused: `the standby copy goes to host ${o.standby.host}: the copy link over a daemon is the next step of the cross-machine switch, not built yet` }
  if (path.resolve(o.standby.dir) !== path.resolve(o.to.standbyDir)) return { refused: `this leader's standby copy goes to ${o.standby.dir}, not to ${o.to.id}'s standby_dir ${o.to.standbyDir}` }
  return new LocalPeer(o.to, o.to.standbyDir, o.env)
}
