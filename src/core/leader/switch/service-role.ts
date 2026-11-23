/**
 * The service role after a switch (docs/reference/leader-switch.md, "Service role"): the host's one
 * Walnut service starts as the leader or as a replica, on a home, as `<install root>/service-mode.json`
 * says (src/binary/service-mode.ts). The switch says what it should be at two places:
 *
 *   after the commit, on the new leader:     { role: 'leader',  home: the promoted home }
 *   after the hand-off, on the old leader:   { role: 'replica', home: the new leader's data dir (the Walnut it follows) }
 *
 * Records first, mode second: the job writes the role it wants into its own state, then asks for the
 * mode (`setServiceRole`, the mode file's one writer), then marks it set. A kill between the two is
 * healed by the service's start hook (service-start-hook.ts), which reads this machine's switch record
 * and asks for the same role again. The mode is never the truth of who leads: the witnesses' record stays that.
 *
 * The install root is always the service's own (`serviceInstallRoot()`): a machine whose job runs
 * outside a service has none, and its role step is recorded as not set, with why. Once the commit
 * stood nothing here rolls back: a refusal (another Walnut's service, no follower spec) is recorded for
 * a person; `mode_busy` (an update holds the mode this moment) is tried again a few times, and after
 * that the next start's hook or the job's `--resume` asks again.
 */
import fs from 'node:fs'
import { writeDurableJson } from './records.js'
import type { RoleStep } from './flow.js'
import { switchPointerFile, type SwitchPointer } from './service-start-hook.js'

export { readSwitchPointer, switchPointerFile, type SwitchPointer } from './service-start-hook.js'

export interface ServiceRoleRequest { role: 'leader' | 'replica'; home: string; walnutId: string; switchId: string }
export type ServiceRoleResult = { changed: boolean } | { notSet: true; why: string }
/** Idempotent: the same role and home again changes nothing. */
export type SetServiceRole = (r: ServiceRoleRequest) => Promise<ServiceRoleResult>

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
const BUSY_TRIES = 5

/** The real setter: setServiceRole on this machine's service install root, `mode_busy` tried again. */
export const serviceModeSetter: SetServiceRole = async (r) => {
  const [{ serviceInstallRoot }, { setServiceRole, ServiceRoleError }] = await Promise.all([import('../../server-role.js'), import('../../../binary/service-mode.js')])
  const root = serviceInstallRoot()
  if (!root) return { notSet: true, why: 'no Walnut service runs this machine (no service install root): nothing to set' }
  for (let i = 1; ; i++) {
    try {
      return { changed: setServiceRole(root, { role: r.role, home: r.home, walnutId: r.walnutId }).changed }
    } catch (err) {
      if (err instanceof ServiceRoleError && err.code === 'mode_busy' && i < BUSY_TRIES) { await sleep(500 * i); continue }
      return { notSet: true, why: err instanceof Error ? err.message : String(err) }
    }
  }
}

export function writeSwitchPointer(p: Omit<SwitchPointer, 'at'>, env: NodeJS.ProcessEnv = process.env): void {
  writeDurableJson(switchPointerFile(env), { ...p, at: new Date().toISOString() } satisfies SwitchPointer)
}

/**
 * The role step of a job: `record(want)` writes the wanted role into the job's state (durable) BEFORE
 * the mode is asked for, then the mode, then `record` again with `set`. Returns the step as recorded.
 */
export async function applyServiceRole(o: { want: Omit<RoleStep, 'at' | 'set' | 'why'>; switchId: string; current?: RoleStep; record: (r: RoleStep) => void; set?: SetServiceRole }): Promise<RoleStep> {
  const same = o.current && o.current.role === o.want.role && o.current.home === o.want.home && o.current.walnutId === o.want.walnutId
  if (same && o.current!.set) return o.current!
  const wanted: RoleStep = same ? o.current! : { ...o.want, at: new Date().toISOString() }
  if (!same) o.record(wanted)
  const r = await (o.set ?? serviceModeSetter)({ role: o.want.role, home: o.want.home, walnutId: o.want.walnutId, switchId: o.switchId })
    .catch((err: unknown): ServiceRoleResult => ({ notSet: true, why: err instanceof Error ? err.message : String(err) }))
  const done: RoleStep = 'notSet' in r ? { ...wanted, set: false, why: r.why } : { ...wanted, set: true }
  o.record(done)
  return done
}

/**
 * Before the commit, on the new leader's machine: when a Walnut service runs it, the version its
 * launcher goes back to must say it can lead (`__daemon --service-roles`), or the commit would make a
 * leader its service cannot keep. A machine with no service has nothing to check. Null: may commit.
 */
export async function serviceLeadRefusalHere(o: { ask?: (exe: string) => Promise<string | null> } = {}): Promise<string | null> {
  const { serviceInstallRoot } = await import('../../server-role.js')
  const root = serviceInstallRoot()
  if (!root) return null
  let good = ''
  try { good = fs.readFileSync(`${root}/launcher/state`, 'utf8').split('\n').find((l) => l.startsWith('good='))?.slice('good='.length) ?? '' } catch { /* none */ }
  if (!good.startsWith('/')) return `this machine's Walnut service names no version its launcher goes back to (${root}/launcher/state): it cannot be told it can lead`
  const ask = o.ask ?? (async (exe: string) => {
    const [{ daemonFileSays, SERVICE_ROLES_FLAG }, { execFile }] = await Promise.all([import('../../../providers/service-roles.js'), import('node:child_process')])
    return daemonFileSays(exe, SERVICE_ROLES_FLAG, execFile as never)
  })
  const said = await ask(good).catch(() => null)
  return said !== null && said.split(/\s+/).includes('leader') ? null : `the version this machine's launcher goes back to (${good}) does not say it can lead (${said === null ? 'no answer' : `it says "${said}"`})`
}

/** The facts a leader keeps of a host (fleet-model.ts FleetHost.daemon), the parts that say it can lead. */
export interface HostServiceFacts { serviceRoles?: ReadonlyArray<string>; launcher?: { goodRoles?: ReadonlyArray<string> } | null }

/**
 * The preflight's rule for a target reached as a host: its running version says `leader` in its hello
 * (`serviceRoles`) and the version its launcher goes back to says it too (`goodRoles`). Missing is a no.
 */
export function hostLeadRefusal(host: string, d: HostServiceFacts | null | undefined): string | null {
  if (!d) return `host ${host} is not connected: whether its service can lead is not known`
  if (!d.serviceRoles?.includes('leader')) return `host ${host}'s running version does not say it can lead (hello serviceRoles: ${JSON.stringify(d.serviceRoles ?? null)})`
  if (!d.launcher?.goodRoles?.includes('leader')) return `the version host ${host}'s launcher goes back to does not say it can lead (goodRoles: ${JSON.stringify(d.launcher?.goodRoles ?? null)})`
  return null
}
