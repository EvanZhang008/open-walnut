/**
 * The old leader's steps for its hosts and its own machine around a switch's handover
 * (docs/reference/leader-switch.md, "Hosts follow the new leader"), as the handover route calls them.
 * The steps themselves are host-follow.ts's; this file is the small interface the route compiles
 * against, so the order lives in one place and the steps can be set once they land:
 *
 *   before the handover record:  prepareOldMachineAsHost, pushNewLeaderDoors,
 *                                configureOldMachineHostService, announceSwitchStop (last)
 *   after the record:            retellNetMembers, dropOwnDaemonDuties
 *   a handover that did not happen (refused, or taken back while this server runs): undoHandoverHostSteps
 *
 * Not set (the default): no step runs, as before hosts followed. Set but the target machine names no
 * `doors` or this machine no `host_key`: no step runs either, and the handover says why in the log.
 */
import type { MachinePlace } from './settings.js'

export type HostStepResult = { ok: true } | { ok: false; why: string }

export interface HandoverHostSteps {
  prepareOldMachineAsHost(o: { walnutId: string; machineId: string; hostKey: string; doors: readonly string[] }): Promise<HostStepResult>
  pushNewLeaderDoors(doors: readonly string[]): Promise<HostStepResult>
  configureOldMachineHostService(o: { home: string; walnutId: string; hostKey: string; switchId?: string }): Promise<HostStepResult>
  announceSwitchStop(commitWindowMs: number): Promise<unknown>
  retellNetMembers(): Promise<HostStepResult>
  dropOwnDaemonDuties(o: { home: string }): Promise<HostStepResult>
  undoHandoverHostSteps(o: { home: string; walnutId: string; machineId: string }): Promise<HostStepResult>
}

let steps: HandoverHostSteps | null = null

/** The host-follow steps (null: none run). */
export function setHandoverHostSteps(s: HandoverHostSteps | null): void { steps = s }

export interface HostStepsContext {
  home: string
  walnutId: string
  /** This machine (the old leader): its id, and the name the new leader gives it as a host. */
  machineId: string
  self: MachinePlace
  /** The machine the lead goes to: where its server is reached. */
  target: MachinePlace
  commitWindowMs: number
  switchId?: string
  log: (level: 'info' | 'warn', msg: string, data?: Record<string, unknown>) => void
}

/** The steps for this handover, or why none run. */
function stepsFor(c: HostStepsContext): { s: HandoverHostSteps; hostKey: string; doors: readonly string[] } | null {
  if (!steps) return null
  if (!c.target.doors?.length || !c.self.hostKey) {
    c.log('warn', 'leader switch: hosts do not follow this handover (leader_switch.machines names no doors for the new leader, or no host_key for this machine)', { to: c.target.id })
    return null
  }
  return { s: steps, hostKey: c.self.hostKey, doors: c.target.doors }
}

/** Before the handover record, in order; the first that fails takes back the ones before it and refuses. */
export async function beforeHandoverRecord(c: HostStepsContext): Promise<HostStepResult> {
  const h = stepsFor(c)
  if (!h) return { ok: true }
  const run = async (name: string, step: () => Promise<HostStepResult>): Promise<HostStepResult> => {
    const r = await step().catch((err: unknown): HostStepResult => ({ ok: false, why: err instanceof Error ? err.message : String(err) }))
    return r.ok ? r : { ok: false, why: `${name}: ${r.why}` }
  }
  for (const [name, step] of [
    ['prepareOldMachineAsHost', () => h.s.prepareOldMachineAsHost({ walnutId: c.walnutId, machineId: c.machineId, hostKey: h.hostKey, doors: h.doors })],
    ['pushNewLeaderDoors', () => h.s.pushNewLeaderDoors(h.doors)],
    ['configureOldMachineHostService', () => h.s.configureOldMachineHostService({ home: c.home, walnutId: c.walnutId, hostKey: h.hostKey, ...(c.switchId ? { switchId: c.switchId } : {}) })],
  ] as const) {
    const r = await run(name, step)
    if (!r.ok) { await undoHostSteps(c); return r }
  }
  // Last, right before the record: after it the outward door refuses every heartbeat.
  await h.s.announceSwitchStop(c.commitWindowMs).catch((err: unknown) => c.log('warn', 'leader switch: the switch stop was not announced', { error: String(err) }))
  return { ok: true }
}

/** After the record stood: the network's members again, and this machine's daemon drops the old leader's duties. Logged, never refused. */
export async function afterHandoverRecord(c: HostStepsContext): Promise<void> {
  const h = stepsFor(c)
  if (!h) return
  for (const [name, step] of [['retellNetMembers', () => h.s.retellNetMembers()], ['dropOwnDaemonDuties', () => h.s.dropOwnDaemonDuties({ home: c.home })]] as const) {
    const r = await step().catch((err: unknown): HostStepResult => ({ ok: false, why: String(err) }))
    if (!r.ok) c.log('warn', `leader switch: ${name} after the handover failed`, { why: r.why })
  }
}

/** A handover that did not happen while this server runs on: every step above taken back. */
export async function undoHostSteps(c: Omit<HostStepsContext, 'self' | 'target' | 'commitWindowMs'> & Partial<Pick<HostStepsContext, 'self' | 'target'>>): Promise<void> {
  if (!steps) return
  const r = await steps.undoHandoverHostSteps({ home: c.home, walnutId: c.walnutId, machineId: c.machineId }).catch((err: unknown): HostStepResult => ({ ok: false, why: String(err) }))
  if (!r.ok) c.log('warn', 'leader switch: the host steps of a handover that did not happen were not all taken back', { why: r.why })
}
