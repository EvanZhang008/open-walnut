/**
 * The old leader's steps for its hosts and its own machine around a switch's handover
 * (docs/reference/leader-switch.md, "Hosts follow the new leader"), as the handover route calls them.
 * The steps themselves are host-follow.ts's; this file is the small interface the route compiles
 * against, so the order lives in one place and the steps can be set once they land:
 *
 *   before the handover record:  prepareOldMachineAsHost, pushNewLeaderDoors,
 *                                configureOldMachineHostService, announceSwitchStop (last)
 *   after the record:            retellNetMembers (until every net host took the lists and the new
 *                                leader is let in: tried again for a while, else the handover is taken
 *                                back naming the hosts), then dropOwnDaemonDuties
 *   a handover that did not happen (refused, or taken back while this server runs): undoHandoverHostSteps
 *                                (it also restores this machine's daemon duties and withdraws the
 *                                switch stop's announcement)
 *
 * A take-back can land while the after-record steps run (a short stop wait, a cancel by hand): the
 * drop runs only while the caller says the handover is still its own (`stillOurs`), and the undo waits
 * for the after-record steps and every retell still in flight (one that lost its time race) before it
 * restores anything, so nothing of the drop or the retell lands after the undo.
 *
 * Not set (a trial start, tests): no step runs, as before hosts followed. A leader's permit sets them
 * (boot.ts, host-follow-steps.ts). Set but the target machine names no `doors` or this machine no
 * `host_key`: no step runs either, and the handover says why in the log.
 */
import type { MachinePlace } from './settings.js'

export type HostStepResult = { ok: true } | { ok: false; why: string }

export interface HandoverHostSteps {
  prepareOldMachineAsHost(o: { walnutId: string; machineId: string; hostKey: string; doors: readonly string[] }): Promise<HostStepResult>
  pushNewLeaderDoors(doors: readonly string[]): Promise<HostStepResult>
  configureOldMachineHostService(o: { home: string; walnutId: string; hostKey: string; switchId?: string }): Promise<HostStepResult>
  announceSwitchStop(commitWindowMs: number): Promise<unknown>
  /** Every net host told the member lists and the new leader let in; else why (the hosts it missed). */
  retellNetMembers(o: { target: MachinePlace }): Promise<HostStepResult>
  dropOwnDaemonDuties(o: { home: string }): Promise<HostStepResult>
  undoHandoverHostSteps(o: { home: string; walnutId: string; machineId: string }): Promise<HostStepResult>
}

let steps: HandoverHostSteps | null = null
/** The after-record steps running now, and retells that lost their time race and still run: the undo waits for them. */
let afterRunning: Promise<unknown> | null = null
const lateRetells = new Set<Promise<unknown>>()
/**
 * How long an undo waits for those: the after-record steps end by themselves (the retell's hard bound, a drop's 20 s);
 * a retell past its race may wait on a sync of its own. Past it, the undo runs anyway and says so in the log.
 */
const UNDO_WAITS_MS = 45_000

/** The host-follow steps (null: none run). Set anew, the runs of the steps before are forgotten (a test's, a boot's). */
export function setHandoverHostSteps(s: HandoverHostSteps | null): void {
  steps = s
  afterRunning = null
  lateRetells.clear()
}

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
  /** How long the network's lists are told again before the handover is taken back (default: half the commit window, at most 60 s), and how often. */
  retellWaitMs?: number
  retellEveryMs?: number
  /** No retell starts with less than this left of the wait (default 5 s). */
  retellMinTryMs?: number
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

/** What afterHandoverRecord answers when the handover was taken back while it ran (nothing was dropped). */
export const TAKEN_BACK = 'the handover was taken back while the hosts were told'

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

/**
 * After the record stood, before anything stops: the network's member lists again, until every net host
 * took them and the new leader is let in (a net host that missed them would let in only this leader, and
 * once it stops nobody tells it again). Tried again within its wait; not done by then: not ok, naming the
 * hosts, and the caller takes the handover back. Then this machine's daemon drops the old leader's duties
 * (logged when it fails: a rollback's undo pushes them again either way).
 */
export async function afterHandoverRecord(c: HostStepsContext, o: { stillOurs?: () => boolean } = {}): Promise<HostStepResult> {
  const h = stepsFor(c)
  if (!h) return { ok: true }
  const run = afterRecordSteps(c, h, o.stillOurs ?? (() => true))
  afterRunning = run
  try {
    return await run
  } finally {
    if (afterRunning === run) afterRunning = null
  }
}

/** How long the retell is asked again before the handover is taken back (the route's stop wait adds it). */
export function retellWaitMs(c: Pick<HostStepsContext, 'retellWaitMs' | 'commitWindowMs'>): number {
  return c.retellWaitMs ?? Math.min(60_000, Math.floor(c.commitWindowMs / 2))
}

async function afterRecordSteps(c: HostStepsContext, h: NonNullable<ReturnType<typeof stepsFor>>, stillOurs: () => boolean): Promise<HostStepResult> {
  const waitMs = retellWaitMs(c)
  const everyMs = c.retellEveryMs ?? 2_000
  // A hard bound: every call races the time left (a call can wait for a sync already running, and each host's
  // configure for up to 20 s), and no call starts with less than `minTryMs` left. A call that loses the race goes on
  // unheard: the switch is taken back, and the hosts follow the record, which names this leader again.
  const minTryMs = c.retellMinTryMs ?? 5_000
  const until = Date.now() + waitMs
  let told: HostStepResult = { ok: false, why: 'not asked' }
  for (let tries = 1; ; tries++) {
    const left = until - Date.now()
    if (tries > 1 && left < minTryMs) {
      c.log('warn', 'leader switch: the network\'s hosts did not all take the new leader within the wait', { why: told.why, tries: tries - 1, waitMs })
      break
    }
    if (!stillOurs()) return { ok: false, why: TAKEN_BACK }
    let timer: ReturnType<typeof setTimeout> | undefined
    const call = h.s.retellNetMembers({ target: c.target }).catch((err: unknown): HostStepResult => ({ ok: false, why: err instanceof Error ? err.message : String(err) }))
    lateRetells.add(call)
    void call.finally(() => lateRetells.delete(call))
    told = await Promise.race([
      call,
      new Promise<HostStepResult>((r) => { timer = setTimeout(() => r({ ok: false, why: `no answer within the ${Math.round(waitMs / 1000)} s wait` }), Math.max(1, left)) }),
    ])
    clearTimeout(timer)
    if (told.ok) break
    if (until - Date.now() < minTryMs + everyMs) {
      c.log('warn', 'leader switch: the network\'s hosts did not all take the new leader within the wait', { why: told.why, tries, waitMs })
      break
    }
    await new Promise((r) => setTimeout(r, everyMs))
  }
  if (!told.ok) return { ok: false, why: `retellNetMembers: ${told.why}` }
  // Taken back meanwhile (its undo waits for this run): this machine's daemon keeps its duties.
  if (!stillOurs()) return { ok: false, why: TAKEN_BACK }
  const d = await h.s.dropOwnDaemonDuties({ home: c.home }).catch((err: unknown): HostStepResult => ({ ok: false, why: String(err) }))
  if (!d.ok) c.log('warn', 'leader switch: dropOwnDaemonDuties after the handover failed', { why: d.why })
  return { ok: true }
}

/** A handover that did not happen while this server runs on: every step above taken back. */
export async function undoHostSteps(c: Omit<HostStepsContext, 'self' | 'target' | 'commitWindowMs'> & Partial<Pick<HostStepsContext, 'self' | 'target'>>): Promise<void> {
  if (!steps) return
  // After the after-record steps and every retell still in flight: nothing of them lands after this undo.
  const running = [afterRunning, ...lateRetells].filter((x): x is Promise<unknown> => !!x)
  if (running.length) {
    const { withDeadline } = await import('../../../lib/with-deadline.js')
    const settled = await withDeadline(Promise.allSettled(running).then(() => true), UNDO_WAITS_MS, () => false)
    if (!settled) c.log('warn', "leader switch: the handover's retell or drop still ran when its undo began", { waitedMs: UNDO_WAITS_MS })
  }
  const r = await steps.undoHandoverHostSteps({ home: c.home, walnutId: c.walnutId, machineId: c.machineId }).catch((err: unknown): HostStepResult => ({ ok: false, why: String(err) }))
  if (!r.ok) c.log('warn', 'leader switch: the host steps of a handover that did not happen were not all taken back', { why: r.why })
}
