/**
 * The manual leader switch (docs/reference/leader-switch.md): two jobs, one per machine, and the
 * witnesses between them. A stop, not a live freeze.
 *
 *   source job (the old leader's machine, source-job.ts; state in its home's local/leader-switch/)
 *     preflight     refuse with the reason, nothing changed (the candidate's own check included)
 *     handover      the marker, then the old leader's server writes the handover record, the ticket,
 *                   and starts the target job over its copy link (peer.ts)
 *     stop-source   the switch stop: the server closes its doors and stores, sends its final batch
 *                   until one finds nothing changed, writes the final mark, closes its links, exits
 *     wait-target   until the witnesses show the new leader's commit (or it gave up, or the deadline)
 *     hand-off      the marker says handed over; the service role turns replica
 *   target job (the new leader's machine, target-job.ts; state in its standby_dir/switch/)
 *     wait-mark     until the final mark (never promotes without it)
 *     promote       the copy becomes the new home (promote.ts)
 *     trial         the new leader starts with every outward door closed and checks itself
 *     commit        the new leader starts for real, told the handover's number: its own record on top
 *                   of the handover reaches a majority. From here there is no way back but a switch
 *     role          the service role turns leader
 *     start-target  the new leader opens its doors
 * Each job writes its step before it runs it and takes `--resume`. Before the commit any failure
 * rolls back, each side on its own: the target job demotes and leaves a `gave-up` note; the source
 * job takes the handover back while the old server runs, else starts it again (it leads once its
 * handover ran out). The witnesses' record decides; a note only says it sooner.
 *
 * This file: what both jobs and the command share. The command: switch-command.ts.
 */
import fs from 'node:fs'
import path from 'node:path'
import Database from '../../../lib/sqlite.js'
import type { PermitRecord } from '../permit/types.js'
import { switchDir } from './records.js'
import { readSwitchFile, targetStateName } from './ticket.js'
import type { LeaderSwitchSettings } from './settings.js'
import type { SwitchSide } from './side.js'

export type SourceStep = 'preflight' | 'handover' | 'stop-source' | 'wait-target' | 'hand-off' | 'done' | 'cancel' | 'restore' | 'start-source' | 'rolled-back'
export type TargetStep = 'wait-mark' | 'promote' | 'trial' | 'commit' | 'role' | 'start-target' | 'done' | 'cancel' | 'restore' | 'rolled-back'
export type SwitchStep = SourceStep | TargetStep

export interface StepLog { step: SwitchStep; at: string; note?: string }

/** Who asked for a switch, on which machine (the begin route records it: console and Walnut Health). */
export interface StartedBy { machine: string; via: 'cli' | 'forwarded' }

/** A service role the job asked for and whether it was set: recorded before the mode (service-role.ts). */
export interface RoleStep { role: 'leader' | 'replica'; home: string; walnutId: string; at: string; set?: boolean; why?: string }

export interface SwitchState {
  id: string
  from: string
  to: string
  sourceHome: string
  targetHome: string
  /** Where the batches of the old leader land (the target machine's standby_dir). */
  standbyDir: string
  /** Where the new leader's batches go (the old machine's standby_dir). */
  reverseStandbyDir: string
  sourceAccountHome?: string
  targetAccountHome?: string
  sourceVersion: string
  sourceWasRunning: boolean
  step: SourceStep
  log: StepLog[]
  handover?: number
  commit?: number
  finalBatch?: number
  startedAt: string
  startedBy?: StartedBy
  /** The handover's deadline: the new leader starts no commit after it (commit_window_s). */
  commitDeadline?: string
  /** The old leader's server began its switch stop: the downtime starts. */
  stoppedAt?: string
  /**
   * The pid of the server asked for the switch stop. Its instance lock goes before its final batch runs (server.ts
   * stopServer), so a job resumed during that batch finds the stopping server by this, not by the lock.
   */
  stopPid?: number
  rollbackWhy?: string
  sourceHomeOnHosts?: { home: string; formerHomes: string[] }
  serviceRole?: RoleStep
}

export interface TargetState {
  id: string
  from: string
  to: string
  standbyDir: string
  sourceHome: string
  targetHome: string
  reverseStandbyDir: string
  reverseStandbyHost?: string
  targetHostKey?: string
  sourceAccountHome?: string
  targetAccountHome?: string
  sourceVersion: string
  sourceHomeOnHosts?: { home: string; formerHomes: string[] }
  handover: number
  commitDeadline: string
  step: TargetStep
  log: StepLog[]
  /** The handover stood at a majority this machine reaches by its own ways (the old leader then stops). */
  handoverSeen?: boolean
  finalBatch?: number
  commit?: number
  stoppedAt?: string
  readyAt?: string
  downtimeMs?: number
  rollbackWhy?: string
  offlineChecked?: boolean
  /** What the copy held as it became the home (self-check.ts readCopyFacts): the trial compares with it, never with the old home. */
  copyFacts?: import('./self-check.js').CopyFacts
  outcomeUnknown?: string[]
  serviceRole?: RoleStep
  /** Tests only, from the ticket. */
  test?: { killAt?: string; skipLedgerRewrite?: boolean }
}

export class SwitchRefused extends Error {
  constructor(message: string) { super(message); this.name = 'SwitchRefused' }
}

/** A step that failed: before the commit the job rolls back, after it it stops and says how to go on. */
export class StepFailed extends Error {
  constructor(message: string) { super(message); this.name = 'StepFailed' }
}

export function switchStateFile(home: string): string {
  return path.join(switchDir(home), 'switch-state.json')
}

/** The source job's state in the old leader's home. */
export function readSwitchState(home: string): SwitchState | null {
  try { return JSON.parse(fs.readFileSync(switchStateFile(home), 'utf8')) as SwitchState } catch { return null }
}

/** The target job's state in the new leader's standby folder. */
export function readTargetState(standbyDir: string, switchId: string): TargetState | null {
  return readSwitchFile<TargetState>(standbyDir, targetStateName(switchId))
}

export const SOURCE_FINAL = new Set<SourceStep>(['done', 'rolled-back'])
export const TARGET_FINAL = new Set<TargetStep>(['done', 'rolled-back'])

/** Tests only: the job dies here as a crash would (SIGKILL: no cleanup runs). */
export function killPoint(killAt: string | undefined, name: string): void {
  if (killAt === name) process.kill(process.pid, 'SIGKILL')
}

/**
 * A record of the new holder above this switch's handover: the switch committed. Its renew or
 * grant names it the holder; its release (a planned stop of the new leader) names no holder,
 * but only a holder releases, so it committed too.
 */
export function committedRecord(standing: PermitRecord | null | undefined, st: { handover?: number; to: string }): boolean {
  if (!standing || standing.number <= (st.handover ?? 0)) return false
  if (standing.kind === 'release') return standing.by === st.to
  return standing.holder === st.to && standing.kind !== 'handover'
}

/** The handover of this switch is what the witnesses hold. */
export function handoverStanding(standing: PermitRecord | null | undefined, st: { from: string; to: string; handover?: number }): boolean {
  return !!standing && standing.kind === 'handover' && standing.from === st.from && standing.to === st.to && (st.handover === undefined || standing.number === st.handover)
}

/**
 * How long a server may take to hold the permission when the record standing was written by a
 * process that is gone: the witness's hold of it, the grant's back-off, and some room.
 */
export function takeBackMs(settings: LeaderSwitchSettings): number {
  const p = settings.params
  return p.validMs + p.witnessMarginMs + p.backoffMaxMs + 30_000
}

export function accountHomes(st: { sourceAccountHome?: string; targetAccountHome?: string }): { previousAccountHome?: string; accountHome?: string } {
  return { ...(st.sourceAccountHome ? { previousAccountHome: st.sourceAccountHome } : {}), ...(st.targetAccountHome ? { accountHome: st.targetAccountHome } : {}) }
}

export function freeBytes(dir: string): number | null {
  try {
    let d = dir
    while (!fs.existsSync(d)) d = path.dirname(d)
    const s = fs.statfsSync(d)
    return Number(s.bavail) * Number(s.bsize)
  } catch { return null }
}

export async function waitDoorsOpen(side: SwitchSide, timeoutMs = 30_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const r = await side.api('GET', '/api/leader/status').catch(() => null)
    if ((r?.json as { permit?: { mayAct?: boolean } } | null)?.permit?.mayAct) return true
    await new Promise((res) => setTimeout(res, 250))
  }
  return false
}

/** One step of a job's state: written durably before the step runs, its line printed. */
export function stepLogger<S extends { step: string; log: StepLog[] }>(st: S, write: (st: S) => void, out: (line: string) => void): (step: S['step'], note?: string) => void {
  return (step, note) => {
    st.step = step
    st.log.push({ step: step as SwitchStep, at: new Date().toISOString(), ...(note ? { note } : {}) })
    write(st)
    out(`${step}${note ? `: ${note}` : ''}`)
  }
}

/**
 * Mail sends the old leader claimed (`sending`) or could not settle (`unknown`): the new
 * leader's ledger has them as they were, its reaper makes `sending` into `unknown`, and none
 * is ever sent again. Listed for a person to check.
 */
export function listUnsettledSends(home: string): string[] {
  const out: string[] = []
  const root = path.join(home, 'plugins')
  const walk = (dir: string, depth: number) => {
    if (depth > 4) return
    let entries: fs.Dirent[] = []
    try { entries = fs.readdirSync(dir, { withFileTypes: true }) } catch { return }
    for (const e of entries) {
      const p = path.join(dir, e.name)
      if (e.isDirectory()) walk(p, depth + 1)
      else if (e.isFile() && e.name.endsWith('.sqlite')) out.push(...unsettledIn(p))
    }
  }
  walk(root, 0)
  return out
}

function unsettledIn(file: string): string[] {
  try {
    const db = new Database(file, { readonly: true })
    try {
      const cols = (db.prepare("SELECT name FROM pragma_table_info('sends')").all() as { name: string }[]).map((c) => c.name)
      if (!cols.includes('idempotency_key') || !cols.includes('state')) return []
      return (db.prepare("SELECT idempotency_key AS k, state FROM sends WHERE state IN ('sending', 'unknown')").all() as { k: string; state: string }[]).map((r) => `mail ${r.k} (${r.state})`)
    } finally { db.close() }
  } catch { return [] }
}

/** A cancel asked for by hand (`--cancel`): each job looks for it between its steps. */
export function sourceCancelFile(home: string): string {
  return path.join(switchDir(home), 'cancel-request.json')
}
export const targetCancelName = (id: string) => `${id}.cancel.json`

/**
 * Both jobs' states of the switch from `home`, as one, when the target's standby folder is on this
 * computer (one machine; elsewhere `target` is null): the step is the source's, or the target's while it
 * is not done after the source is; the downtime and the sends of unknown outcome are the target's.
 */
export interface SwitchOutcomeView extends Omit<SwitchState, 'step'> {
  step: SwitchStep
  target: TargetState | null
  downtimeMs?: number
  outcomeUnknown?: string[]
}

export function readSwitchOutcome(home: string): SwitchOutcomeView | null {
  const src = readSwitchState(home)
  if (!src) return null
  const tgt = readTargetState(src.standbyDir, src.id)
  const step: SwitchStep = src.step === 'done' && tgt && tgt.step !== 'done' ? tgt.step : src.step
  const log = [...src.log, ...(tgt?.log ?? [])].sort((a, b) => Date.parse(a.at) - Date.parse(b.at))
  return { ...src, step, log, target: tgt, ...(tgt?.downtimeMs !== undefined ? { downtimeMs: tgt.downtimeMs } : {}), ...(tgt?.outcomeUnknown ? { outcomeUnknown: tgt.outcomeUnknown } : {}) }
}
