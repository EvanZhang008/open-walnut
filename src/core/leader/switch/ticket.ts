/**
 * The switch's files on the NEW leader's machine, all under `<its standby_dir>/switch/`
 * (docs/reference/leader-switch.md, "Two jobs"). The standby folder is the one place both
 * machines share: the old leader's server already writes there (its batches), and the new
 * leader's copy is made from it.
 *
 *   <id>.json         the ticket: written by the old leader's server at the handover, the target
 *                     job's only input (no secret in it)
 *   <id>.check.json   the candidate check's report (the target job in check mode)
 *   <id>.final.json   the final mark: the last thing the old leader's server writes, after its final
 *                     batch found nothing changed. The target job never promotes without it
 *   <id>.state.json   the target job's state (its steps, so `--resume` goes on)
 *   <id>.lock         the target job running (one at a time)
 *
 * And one file beside the machine's instance lock (machine-id.ts), outside every home: the claim
 * of the home a target job is making (`switch-claim-<hash>.json`). A server started on that home by
 * anyone but the switch (an app, a launcher, a person) waits without the port while it stands
 * (promotion-wait.ts), so nothing fights the switch for the home or its port.
 *
 * Every write is durable when it returns (records.ts writeDurableJson).
 */
import fs from 'node:fs'
import path from 'node:path'
import { createHash, randomBytes } from 'node:crypto'
import { writeDurableJson } from './records.js'
import { machineIdFile } from './machine-id.js'

export function switchFolder(standbyDir: string): string {
  return path.join(standbyDir, 'switch')
}

export const ticketName = (id: string) => `${id}.json`
export const checkReportName = (id: string) => `${id}.check.json`
export const finalMarkName = (id: string) => `${id}.final.json`
export const targetStateName = (id: string) => `${id}.state.json`

/** A switch id as it becomes a file name: the ids newState makes (time and hex), nothing else. */
export function isSwitchId(v: unknown): v is string {
  return typeof v === 'string' && /^[0-9A-Za-z][0-9A-Za-z.T_-]{0,63}$/.test(v)
}

/** A new switch's id: its start (UTC, to the second) and 6 random hex. Made where the command runs, on either machine. */
export function newSwitchId(now = new Date()): string {
  return `${now.toISOString().replace(/[-:]/g, '').slice(0, 15)}-${randomBytes(3).toString('hex')}`
}

export interface SwitchTicket {
  v: 1
  switchId: string
  from: string
  to: string
  /** The handover record the new leader commits on. */
  handover: number
  /** The old leader's home (the promotion's previous home: paths under it move). */
  sourceHome: string
  /** The new leader's home on its machine. */
  targetHome: string
  /** Where the new leader's batches go after the switch (the old machine's standby_dir). */
  reverseStandbyDir: string
  /** The old machine as the new leader's config names it in hosts (its host_key), when the copy link is a daemon: the batches go back over it. */
  reverseStandbyHost?: string
  /** The new machine's host key in that config, sent with reverseStandbyHost when the config gives one: its sessions become its own daemon's. */
  targetHostKey?: string
  sourceAccountHome?: string
  targetAccountHome?: string
  /** The program that wrote the data: the new one must not be older. */
  sourceVersion: string
  /** The data dir the old leader's hosts know it by (moved-home.ts). */
  sourceHomeOnHosts?: { home: string; formerHomes: string[] }
  /** The new leader starts no commit after this (commit_window_s from the handover). */
  commitDeadline: string
  issuedAt: string
  /** Tests only: where the target job dies (WALNUT_LEADER_SWITCH_KILL_AT of the source job), and the ledger control. */
  test?: { killAt?: string; skipLedgerRewrite?: boolean }
}

export interface FinalMark {
  v: 1
  switchId: string
  /** The standby batch that found nothing changed. */
  batch: number
  unchanged: true
  /** The old leader's server is gone after this: it writes nothing more and acts no more. */
  released: true
  /** When the old leader's server began its stop (its doors closed): the downtime starts. */
  stoppedAt: string
  /**
   * The engine records of the sessions in the data home (session-carry.ts): the carry's batch that found nothing changed,
   * and the old home's engine folder name. Absent from an older leader's mark: its sessions in the home do not move.
   */
  carry?: { batch: number; homeFolder: string }
  at: string
}

export interface CheckReport {
  switchId: string
  machine: string | null
  ok: boolean
  problems: string[]
  version: string
  at: string
  /** The data store shapes the candidate's build reads (session-prompts.ts SESSION_STORE_FORMATS); absent: a build before the probe. */
  storeFormats?: Record<string, number>
  /** Each witness as the candidate reached it (witness-reach.ts): by which way, and what it holds (a summary). */
  reach?: Array<{ id: string; answered: boolean; way?: string; via?: string; held: { holder?: string; kind?: string; number?: number } | null; why?: string }>
  /** What the check found worth saying that refuses nothing (a commit majority that rests on one relay's door); printed by the source job. */
  notes?: string[]
}

export function readSwitchFile<T>(standbyDir: string, name: string): T | null {
  try { return JSON.parse(fs.readFileSync(path.join(switchFolder(standbyDir), name), 'utf8')) as T } catch { return null }
}

export function writeSwitchFile(standbyDir: string, name: string, value: unknown): void {
  writeDurableJson(path.join(switchFolder(standbyDir), name), value)
}

export function removeSwitchFile(standbyDir: string, name: string): void {
  try { fs.unlinkSync(path.join(switchFolder(standbyDir), name)) } catch { /* gone */ }
}

/** A final mark of this switch that says what it must: the batch found nothing changed and the old leader is gone. */
export function validFinalMark(m: unknown, switchId: string): m is FinalMark {
  const x = m as Partial<FinalMark> | null
  return !!x && x.v === 1 && x.switchId === switchId && x.unchanged === true && x.released === true && Number.isSafeInteger(x.batch) && typeof x.stoppedAt === 'string'
}

export function validTicket(t: unknown, switchId: string): t is SwitchTicket {
  const x = t as Partial<SwitchTicket> | null
  return !!x && x.v === 1 && x.switchId === switchId && typeof x.from === 'string' && typeof x.to === 'string' && Number.isSafeInteger(x.handover)
    && typeof x.sourceHome === 'string' && typeof x.targetHome === 'string' && typeof x.reverseStandbyDir === 'string' && typeof x.commitDeadline === 'string'
}

// ---- the claim of a home a target job makes -------------------------------------------------

export interface SwitchClaim { switchId: string; pid: number; home: string; at: string }

/** A short stable name of a home, for files about it kept outside it (its claim, its source job's output). */
export function homeKey(home: string): string {
  return createHash('sha256').update(path.resolve(home)).digest('hex').slice(0, 16)
}

export function switchClaimFile(home: string, env: NodeJS.ProcessEnv = process.env): string {
  return path.join(path.dirname(machineIdFile(env)), 'leader-instance', `switch-claim-${homeKey(home)}.json`)
}

/** The claim on `home`, alive or not: a claim whose job died still holds (its home may be half made until `--resume`). */
export function readSwitchClaim(home: string, env: NodeJS.ProcessEnv = process.env): SwitchClaim | null {
  try {
    const c = JSON.parse(fs.readFileSync(switchClaimFile(home, env), 'utf8')) as Partial<SwitchClaim>
    if (typeof c.switchId !== 'string' || c.home !== path.resolve(home)) return null
    return { switchId: c.switchId, pid: Number(c.pid) || 0, home: c.home, at: String(c.at ?? '') }
  } catch { return null }
}

export function writeSwitchClaim(home: string, switchId: string, env: NodeJS.ProcessEnv = process.env): void {
  writeDurableJson(switchClaimFile(home, env), { switchId, pid: process.pid, home: path.resolve(home), at: new Date().toISOString() } satisfies SwitchClaim)
}

export function removeSwitchClaim(home: string, switchId: string, env: NodeJS.ProcessEnv = process.env): void {
  if (readSwitchClaim(home, env)?.switchId !== switchId) return
  try { fs.unlinkSync(switchClaimFile(home, env)) } catch { /* gone */ }
}
