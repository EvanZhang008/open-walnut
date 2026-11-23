/**
 * The old leader's server during a switch (docs/reference/leader-switch.md, "The switch stop"):
 * between its handover and its exit. Loaded only once a switch's handover asks for it.
 *
 * After the handover the server waits for its switch stop. None within `stop_wait_s` (120 s): it
 * cancels its own handover and leads again (the source job died, or never asked). The switch stop is
 * an API call (`POST /api/leader/switch/final-stop`), not a signal:
 *
 *   1. the server stops as on any planned stop: doors closed at once, every store and job closed,
 *      the HTTP server closed. No release record: the handover stands already
 *   2. the final batch, as the LAST step of stopServer, over its copy link (peer.ts): batches until one
 *      finds nothing changed (a writer that lands after one is in the next), bounded by the commit window
 *   3. a verify pass, then the final mark, its last write to the other machine
 *   4. its result in its home's local/leader-switch/final-stop.json (never in a batch), then every
 *      host link closes and the process exits
 * A signal during it (a launcher's SIGTERM) ends the batch without a mark and the process within
 * 30 s (commands/web.ts): the new leader never promotes, the switch rolls back. A kill does the same.
 */
import fs from 'node:fs'
import type { SwitchPeer } from './peer.js'
import { finalMarkName, type FinalMark } from './ticket.js'
import { finalStopResultFile, writeDurableJson, type FinalStopResult } from './records.js'
import { machineById, type LeaderSwitchSettings } from './settings.js'
import type { StartedBy } from './flow.js'
import { hostLeadRefusal, type HostServiceFacts } from './service-role.js'

export interface HandedOverSwitch {
  switchId: string
  to: string
  peer: SwitchPeer
  /** Wall-clock ms: the new leader starts no commit after it. */
  commitDeadline: number
  /** waiting: for its switch stop; stopping: in it; cancelling: taking the handover back (its stop wait, or a cancel). */
  phase: 'waiting' | 'stopping' | 'cancelling'
}

type Held = HandedOverSwitch & { timer: ReturnType<typeof setTimeout> | null; stopWaitMs: number; onStopWaitOver: (sw: HandedOverSwitch) => void }
let current: Held | null = null
/** The switch whose handover this server took back last (a stop asked after it is told so). */
let cancelledId: string | null = null

/** The switch this server handed over and has not stopped for yet, or null. */
export function handedOverSwitch(): HandedOverSwitch | null { return current }

function armStopWait(sw: Held, ms: number): void {
  if (sw.timer) clearTimeout(sw.timer)
  sw.timer = setTimeout(() => {
    sw.timer = null
    if (current !== sw || sw.phase !== 'waiting') return
    // Synchronous with beginSwitchStop: a stop that comes now is refused, never run beside the take-back.
    sw.phase = 'cancelling'
    sw.onStopWaitOver(sw)
  }, ms)
  sw.timer.unref?.()
}

/**
 * The handover of `switchId` stood: wait `stopWaitMs` for its switch stop, else `onStopWaitOver`
 * (the server takes the handover back itself and leads again; it reports with endTakeBack). A second
 * call for the same switch (a resumed source job asking again) keeps the first deadline.
 */
export function noteHandedOver(o: Omit<HandedOverSwitch, 'phase'> & { stopWaitMs: number; onStopWaitOver: (sw: HandedOverSwitch) => void }): HandedOverSwitch {
  if (current && current.switchId === o.switchId) return current
  if (current?.timer) clearTimeout(current.timer)
  const sw: Held = { switchId: o.switchId, to: o.to, peer: o.peer, commitDeadline: o.commitDeadline, phase: 'waiting', timer: null, stopWaitMs: o.stopWaitMs, onStopWaitOver: o.onStopWaitOver }
  current = sw
  cancelledId = null
  armStopWait(sw, o.stopWaitMs)
  return sw
}

/**
 * A take-back of the handover begins (a cancel by hand, or the stop wait): refused while the switch
 * stop runs or another take-back does. Synchronous, so a stop and a take-back never both start.
 */
export function beginTakeBack(): { ok: true; sw: HandedOverSwitch | null } | { ok: false; why: string } {
  const sw = current
  if (!sw) return { ok: true, sw: null }
  if (sw.phase === 'stopping') return { ok: false, why: 'this server is in its switch stop: its final batch decides' }
  if (sw.phase === 'cancelling') return { ok: false, why: 'this server is taking its handover back already' }
  if (sw.timer) { clearTimeout(sw.timer); sw.timer = null }
  sw.phase = 'cancelling'
  return { ok: true, sw }
}

/**
 * How a take-back ended. Taken back: nothing waits for a stop any more. Not (no witness majority
 * this moment): the switch waits for its stop again, and the take-back is tried again `retryMs` later
 * (whoever began it: a handed-over server is never left with nothing that ends its wait).
 */
export function endTakeBack(sw: HandedOverSwitch | null, ok: boolean, retryMs = 5_000): void {
  if (!sw || current !== sw) return
  if (ok) { if (current.timer) clearTimeout(current.timer); cancelledId = sw.switchId; current = null; return }
  current.phase = 'waiting'
  armStopWait(current, retryMs)
}

/** This server took the handover of `switchId` back: a handover again under that id is refused (a new switch begins anew). */
export function wasTakenBack(switchId: string): boolean { return cancelledId === switchId }

/** The switch stop begins: the stop wait ends here, and a take-back can no longer start. Synchronous, so the two never both run. */
export function beginSwitchStop(switchId: string): { ok: true; sw: HandedOverSwitch } | { ok: false; why: string } {
  const sw = current
  if (!sw || sw.switchId !== switchId) return { ok: false, why: cancelledId === switchId ? 'this server took that handover back (no switch stop came in time, or a cancel)' : `this server handed over no switch ${switchId}` }
  if (sw.phase === 'cancelling') return { ok: false, why: 'this server is taking that handover back' }
  if (sw.phase === 'stopping') return { ok: false, why: 'this server is in its switch stop already' }
  sw.phase = 'stopping'
  if (current?.timer) { clearTimeout(current.timer); current.timer = null }
  return { ok: true, sw }
}

/** The stop was taken but the process could not stop for it: the switch waits for its stop again (and its stop wait runs again). */
export function abandonSwitchStop(sw: HandedOverSwitch): void {
  if (current !== sw || sw.phase !== 'stopping') return
  current.phase = 'waiting'
  armStopWait(current, current.stopWaitMs)
}

/** Tests: forget the switch. */
export function forgetHandedOver(): void {
  if (current?.timer) clearTimeout(current.timer)
  current = null
  cancelledId = null
}

export interface FinalBatchTest {
  /** 'server-during-final-batch': the server dies (SIGKILL) after its first final batch. */
  killAt?: string
  /** A pause after the first final batch (a writer's moment, a launcher's signal). */
  pauseAfterFirstBatchMs?: number
}

export type FinalBatchOutcome = { ok: true; batch: number; batches: number } | { ok: false; why: string; batches: number }

/**
 * Batches of `home` into the peer until one finds nothing changed, then a verify pass. A void batch (a
 * write at the wrong instant) is tried again. Ends with a refusal when `signal` aborts or the deadline passes.
 */
export async function runFinalBatch(o: { home: string; peer: SwitchPeer; deadlineAt: number; signal: AbortSignal; test?: FinalBatchTest; now?: () => number }): Promise<FinalBatchOutcome> {
  const now = o.now ?? Date.now
  let batches = 0
  let last = ''
  for (;;) {
    if (o.signal.aborted) return { ok: false, why: `the final batch was stopped (${String(o.signal.reason ?? 'a signal')}): no final mark`, batches }
    if (now() > o.deadlineAt) return { ok: false, why: `the home still changed when the commit window ended (${last || 'no batch finished'}): a writer outside Walnut is still at it`, batches }
    const r = await o.peer.batch(o.home).catch((err: unknown) => ({ ok: false as const, reason: err instanceof Error ? err.message : String(err) }))
    batches++
    if (o.signal.aborted) return { ok: false, why: `the final batch was stopped (${String(o.signal.reason ?? 'a signal')}): no final mark`, batches }
    if (batches === 1 && o.test?.killAt === 'server-during-final-batch') process.kill(process.pid, 'SIGKILL')
    if (batches === 1 && o.test?.pauseAfterFirstBatchMs) {
      await new Promise<void>((resolve) => {
        const t = setTimeout(resolve, o.test!.pauseAfterFirstBatchMs)
        o.signal.addEventListener('abort', () => { clearTimeout(t); resolve() }, { once: true })
      })
    }
    if (!r.ok) { last = `void: ${r.reason}`; continue }
    if (!r.commit.unchanged) { last = `${r.commit.written} written, ${r.commit.deleted} deleted`; continue }
    await o.peer.verify()
    return { ok: true, batch: r.commit.batch, batches }
  }
}

/**
 * The whole switch stop's last step (stopServer runs it after every store closed): the final batch,
 * the mark, the result beside the home. Never throws: a failure is the result (no mark).
 */
export async function finishSwitchStop(o: { home: string; sw: HandedOverSwitch; stoppedAt: string; signal: AbortSignal; test?: FinalBatchTest; log: (level: 'info' | 'warn', msg: string, data?: Record<string, unknown>) => void }): Promise<FinalStopResult> {
  const write = (r: FinalStopResult) => { try { writeDurableJson(finalStopResultFile(o.home), r) } catch (err) { o.log('warn', 'leader switch: the switch stop\'s result could not be written', { error: String(err) }) } return r }
  try {
    const b = await runFinalBatch({ home: o.home, peer: o.sw.peer, deadlineAt: o.sw.commitDeadline, signal: o.signal, ...(o.test ? { test: o.test } : {}) })
    if (!b.ok) {
      o.log('warn', 'leader switch: no final mark (the switch rolls back)', { switchId: o.sw.switchId, why: b.why, batches: b.batches })
      return write({ switchId: o.sw.switchId, ok: false, why: b.why, stoppedAt: o.stoppedAt, at: new Date().toISOString() })
    }
    if (o.signal.aborted) return write({ switchId: o.sw.switchId, ok: false, why: 'the switch stop was stopped by a signal before its mark', stoppedAt: o.stoppedAt, at: new Date().toISOString() })
    // The new leader starts no commit after the deadline: a mark after it would only say so later.
    if (Date.now() > o.sw.commitDeadline) return write({ switchId: o.sw.switchId, ok: false, why: 'the final batch ended after the commit window: no final mark', stoppedAt: o.stoppedAt, at: new Date().toISOString() })
    const mark: FinalMark = { v: 1, switchId: o.sw.switchId, batch: b.batch, unchanged: true, released: true, stoppedAt: o.stoppedAt, at: new Date().toISOString() }
    await o.sw.peer.writeFile(finalMarkName(o.sw.switchId), mark)
    o.log('info', 'leader switch: final batch sent and marked; this server exits', { switchId: o.sw.switchId, batch: b.batch, batches: b.batches })
    return write({ switchId: o.sw.switchId, ok: true, batch: b.batch, stoppedAt: o.stoppedAt, at: mark.at })
  } catch (err) {
    return write({ switchId: o.sw.switchId, ok: false, why: `the final mark could not be written: ${err instanceof Error ? err.message : String(err)}`, stoppedAt: o.stoppedAt, at: new Date().toISOString() })
  } finally {
    o.sw.peer.close()
  }
}

// ---- who may begin a switch ---------------------------------------------------------------

/**
 * The trust rule for a switch's begin (docs/reference/leader-switch.md, "Running the command on
 * either machine"): `to` is a machine of leader_switch.machines, and it holds this leader's standby
 * target (the copy goes there, so its own copy is what it would lead with). A begin forwarded from
 * another machine is taken only from `to` itself. Null: allowed.
 */
export function beginRefusal(o: { settings: LeaderSwitchSettings; me: string; to: string; standby: { dir?: string; host?: string }; forwardedBy?: string | null; hostService?: HostServiceFacts | null }): string | null {
  const target = machineById(o.settings, o.to)
  if (!target) return `machine ${o.to} is not in leader_switch.machines`
  if (target.id === o.me) return `${o.to} leads already`
  if (!o.standby.dir) return 'this leader keeps no standby copy (standby.dir): no machine holds one to lead with'
  if (o.standby.host) {
    // The copy is on a host: that host must be the machine `to` (the daemon kind of the copy link, the next step).
    if (o.standby.host !== o.to) return `this leader's standby copy is on host ${o.standby.host}, not on ${o.to}`
    // Its service must be able to lead: both versions say so (hello serviceRoles, launcher goodRoles). Never guessed.
    const cannot = hostLeadRefusal(o.standby.host, o.hostService)
    if (cannot) return cannot
  } else if (safeReal(o.standby.dir) !== safeReal(target.standbyDir)) {
    return `this leader's standby copy goes to ${o.standby.dir}, not to ${o.to}'s standby_dir ${target.standbyDir}`
  }
  if (o.forwardedBy !== undefined && o.forwardedBy !== o.to) return `a switch begun from another machine is taken only from the machine it goes to (${o.to}), not from ${o.forwardedBy ?? 'an unknown machine'}`
  return null
}

function safeReal(p: string): string {
  try { return fs.realpathSync.native(p) } catch { return p }
}

/** The line the console and Walnut Health keep of who began a switch, on which machine. */
export function beganLine(o: { switchId: string; from: string; to: string; by: StartedBy }): { title: string; body: string } {
  const where = o.by.via === 'cli' ? `the switch command on ${o.by.machine}` : `${o.by.machine}, forwarded by its replica`
  return { title: `Leader switch ${o.switchId} begun: ${o.from} to ${o.to}`, body: `Started by ${where}. The leader stops once ${o.to} is ready; \`walnut leader switch --status\` on either machine shows where it stands.` }
}
