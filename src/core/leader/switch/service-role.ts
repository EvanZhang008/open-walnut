/**
 * The service role after a switch (docs/reference/leader-switch.md, "Service role"): the one
 * launcher-kept service of a machine starts as the leader or as a replica, on a home, as
 * `<install root>/service-mode.json` says. The switch says what it should be at two places:
 *
 *   after the commit, on the new leader:     { role: 'leader', home: the promoted home }
 *   after the hand-off, on the old leader:   { role: 'replica', home: its copy dir (its standby_dir) }
 *
 * Records first, mode second: the job writes the role it wants into its own state, then asks for
 * the mode, then marks it set. A kill between the two writes is healed by the read-only resume entry
 * (`resumeServiceRole`), which the service's start hook calls before any home opens: it reads only
 * this machine's switch records (through a pointer beside the machine id) and asks for the same
 * role again. The mode is never the truth of who leads: the witnesses' record stays that.
 *
 * Not wired yet: the write function is the launcher's (`setServiceRole` in the service entry, its
 * owner's to land); until it is, `serviceRoleSetter()` answers `notWired` and the step is recorded
 * as such. Tests inject a fake with `setServiceRoleSetter`.
 */
import fs from 'node:fs'
import path from 'node:path'
import { writeDurableJson } from './records.js'
import { machineIdFile } from './machine-id.js'
import type { RoleStep } from './flow.js'

export interface ServiceRoleRequest { role: 'leader' | 'replica'; home: string; switchId: string }
export type ServiceRoleResult = { changed: boolean } | { notWired: true; why: string }
/** Idempotent: the same role and home again changes nothing. */
export type SetServiceRole = (r: ServiceRoleRequest) => Promise<ServiceRoleResult>

const notWired: SetServiceRole = async () => ({ notWired: true, why: 'the service launcher has no role setting yet (its owner lands setServiceRole)' })
let setter: SetServiceRole = notWired

export function serviceRoleSetter(): SetServiceRole { return setter }
/** Tests (and, once it lands, the service entry): the function that writes the mode. Null puts back "not wired". */
export function setServiceRoleSetter(fn: SetServiceRole | null): void { setter = fn ?? notWired }

/** This machine's pointer to the switch records the start hook reads: beside its machine id, outside every home. */
export function switchPointerFile(env: NodeJS.ProcessEnv = process.env): string {
  return path.join(path.dirname(machineIdFile(env)), 'leader-switch-pointer.json')
}

export interface SwitchPointer { switchId: string; side: 'source' | 'target'; stateFile: string; at: string }

export function writeSwitchPointer(p: Omit<SwitchPointer, 'at'>, env: NodeJS.ProcessEnv = process.env): void {
  writeDurableJson(switchPointerFile(env), { ...p, at: new Date().toISOString() } satisfies SwitchPointer)
}

export function readSwitchPointer(env: NodeJS.ProcessEnv = process.env): SwitchPointer | null {
  try {
    const p = JSON.parse(fs.readFileSync(switchPointerFile(env), 'utf8')) as Partial<SwitchPointer>
    return typeof p.switchId === 'string' && (p.side === 'source' || p.side === 'target') && typeof p.stateFile === 'string' ? p as SwitchPointer : null
  } catch { return null }
}

/**
 * The role step of a job: `record(want)` writes the wanted role into the job's state (durable) BEFORE
 * the mode is asked for, then the mode, then `record` again with `set`. Returns the step as recorded.
 */
export async function applyServiceRole(o: { want: Omit<RoleStep, 'at' | 'set' | 'why'>; switchId: string; current?: RoleStep; record: (r: RoleStep) => void; set?: SetServiceRole }): Promise<RoleStep> {
  const same = o.current && o.current.role === o.want.role && o.current.home === o.want.home
  if (same && o.current!.set) return o.current!
  const wanted: RoleStep = same ? o.current! : { ...o.want, at: new Date().toISOString() }
  if (!same) o.record(wanted)
  const r = await (o.set ?? setter)({ role: o.want.role, home: o.want.home, switchId: o.switchId }).catch((err: unknown): ServiceRoleResult => ({ notWired: true, why: err instanceof Error ? err.message : String(err) }))
  const done: RoleStep = 'notWired' in r ? { ...wanted, set: false, why: r.why } : { ...wanted, set: true }
  o.record(done)
  return done
}

export interface ServiceStartContext {
  /** What service-mode.json says now (null: none). */
  mode: { role: 'leader' | 'replica'; home: string } | null
  setRole(next: { role: 'leader' | 'replica'; home: string }): Promise<{ changed: boolean }> | { changed: boolean }
  log(level: 'info' | 'warn', msg: string, data?: Record<string, unknown>): void
  env?: NodeJS.ProcessEnv
}

/**
 * The resume entry the service's start hook calls, before any role or home opens: local files only, no
 * network, bounded. When this machine's last switch recorded a role it wanted and the mode differs, it
 * asks for that role again (a kill between the record and the mode). It also hands the first start after a
 * commit its number (WALNUT_LEADER_SWITCH_COMMIT), from the target job's own record.
 */
export async function resumeServiceRole(ctx: ServiceStartContext): Promise<{ env?: Record<string, string>; note?: string }> {
  const env = ctx.env ?? process.env
  const ptr = readSwitchPointer(env)
  if (!ptr) return {}
  let st: { step?: string; handover?: number; serviceRole?: RoleStep; targetHome?: string } | null = null
  try { st = JSON.parse(fs.readFileSync(ptr.stateFile, 'utf8')) } catch { return { note: `switch ${ptr.switchId}: its record ${ptr.stateFile} cannot be read` } }
  const out: { env?: Record<string, string>; note?: string } = {}
  // The commit start of a target job that a launcher now starts: it may commit only on that handover.
  if (ptr.side === 'target' && st?.step === 'commit' && Number.isSafeInteger(st.handover)) out.env = { WALNUT_LEADER_SWITCH_COMMIT: String(st.handover) }
  const want = st?.serviceRole
  if (!want) return out
  if (ctx.mode && ctx.mode.role === want.role && ctx.mode.home === want.home) return out
  const r = await ctx.setRole({ role: want.role, home: want.home })
  ctx.log('info', 'leader switch: the service role follows the switch record', { switchId: ptr.switchId, role: want.role, home: want.home, changed: r.changed })
  return { ...out, note: `switch ${ptr.switchId}: service role ${want.role} on ${want.home}` }
}
