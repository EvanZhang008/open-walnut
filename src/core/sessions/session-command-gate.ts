/**
 * Where a command for one session's process goes (docs/plan/one-service-every-host.md, phase 2,
 * Done when 1: "the leader sends no command to another machine's process manager").
 *
 * A session its host runs and judges (judge-of.ts, judge 'host') has one process manager: its host's
 * own service. So this leader never sends that host's daemon a command about its process: no start,
 * input, stop, liveness probe, state read or supervision change. Each such command has one host-service
 * answer instead (host-api.ts), named here per command:
 *
 *   start, send, interrupt   POST /host-api/sessions/{start,send,interrupt}
 *   call                     POST /host-api/sessions/call: a session, acp, runner or lifecycle member
 *                            (host-calls.ts), the lifecycle ones carried out whole on the host
 *   channel                  what the host's channel already sent: its rows, facts and `live` state
 *                            (remote-judged-session.ts, providers/host-judged-view.ts)
 *
 * Two parts, one rule:
 *  - sessionCommandTarget(sid): every caller of a session-process command asks it first and takes the
 *    host-service way for a host-judged session (probes answer from the mirror, controls go as calls).
 *  - assertSessionCommandReachesDaemon: DaemonConnection.send refuses, before anything leaves, any
 *    command of SESSION_PROCESS_COMMANDS whose session is host-judged, naming the host-service route.
 *    A caller that forgot the first part fails loudly instead of reaching around the host's service.
 *
 * One exception, by definition: while a hand-over of the session is unanswered (handover-marks.ts),
 * the host has not taken it, so the leader's read of whether a CLI of it runs (`status`, `acpState`:
 * host-handover.ts hostVerdict) still goes to the runtime. The at-rest check before a hand-over
 * (host-resume.ts resumeNow) asks while the session is still legacy, before the hand: no exception needed.
 *
 * tests/core/sessions/session-command-gate-ratchet.test.ts enumerates every daemon command from the
 * daemon's switch and every `.send('<name>'` call site of src/, and fails on a session-process command
 * or call site this file and its table do not classify.
 */
import { hostJudgedRowsMayExist, judgingHostOf } from './judge-of.js'
import { hostJudgedOfAcpRuntimeInStore } from '../session-db.js'
import { handOverMarkStands } from '../session-channel/handover-marks.js'
import { log } from '../../logging/index.js'

/** A list of command names, written as words: never a quoted name, which ratchets count as a call site. */
const words = (list: string): string[] => list.split(/\s+/).filter(Boolean)

const START = 'POST /host-api/sessions/start'
const SEND = 'POST /host-api/sessions/send'
const INTERRUPT = 'POST /host-api/sessions/interrupt'
const CHANNEL = "the host's session channel (its rows, facts and live state): no command"
const call = (target: string, member: string) => `POST /host-api/sessions/call ${target}.${member}`

/** Every daemon command that acts on one session's process, by the host-service route that answers it for a host-judged session. */
const ROUTES: ReadonlyArray<readonly [route: string, names: string]> = [
  [START, 'start bridgeResume acpStart acpNewSession agent.start agent.newSession'],
  [SEND, 'send sendRaw appendUserMarker acpSend acpSteer agent.send agent.steer'],
  [INTERRUPT, 'acpCancel agent.cancel'],
  [call('lifecycle', 'terminateSession'), 'stop acpStop agent.stop'],
  [call('lifecycle', 'changeSessionModeOf'), 'setMode'],
  [call('acp', 'setConfigOption'), 'acpSetConfigOption agent.setOption'],
  [call('session', 'resolvePermissionRequest'), 'acpRespond agent.respond'],
  [CHANNEL, 'status getState acpState agent.state attach subscribe-agent unsubscribe-agent acpSubscribe agent.subscribe rename'],
  [call('lifecycle', 'readSessionSupervision'), 'cron.supervision'],
  [call('lifecycle', 'lineAlreadyRan'), 'line.fate'],
  [call('lifecycle', 'cancelPendingStart'), 'cancelPendingStart'],
  ["the host's own start checks who holds the transcript: no command", 'cli.holder'],
]

const ROUTE_OF: ReadonlyMap<string, string> = new Map(ROUTES.flatMap(([route, names]) => words(names).map((n) => [n, route] as const)))

/** The daemon commands about one session's process (the ratchet checks each is a command the daemon takes). */
export const SESSION_PROCESS_COMMANDS: readonly string[] = [...ROUTE_OF.keys()]

/** Commands whose `sid` is an ACP worker's runtime id, not the session's id. */
const RUNTIME_KEYED: ReadonlySet<string> = new Set(SESSION_PROCESS_COMMANDS.filter((n) => n.startsWith('acp') || n.startsWith('agent.')))
/** Reads of whether a CLI runs: allowed through while a hand-over is unanswered (see the header). */
const HAND_OVER_READS: ReadonlySet<string> = new Set(words('status acpState agent.state'))

/** The host-service route that answers `cmd` for a host-judged session, or undefined (not a session-process command). */
export function hostRouteOf(cmd: string): string | undefined {
  return ROUTE_OF.get(cmd)
}

export type SessionCommandTarget = { to: 'daemon' } | { to: 'host'; host: string }
const DAEMON: SessionCommandTarget = { to: 'daemon' }

/**
 * Where a command for session `sid`'s process goes: its host's service when the host runs and
 * judges it, else the daemon as before. `cmd` names a read of whether a CLI runs, which still goes
 * to the daemon while the session's hand-over is unanswered.
 */
export function sessionCommandTarget(sid: string | null | undefined, cmd?: string): SessionCommandTarget {
  if (!sid) return DAEMON
  const host = judgingHostOf(sid)
  if (!host) return DAEMON
  if (cmd && HAND_OVER_READS.has(cmd) && handOverUnanswered(sid)) return DAEMON
  return { to: 'host', host }
}

function handOverUnanswered(sid: string): boolean {
  try { return handOverMarkStands(sid) === true } catch { return false }
}

/** ACP runtime id -> its host-judged session, kept briefly (a miss is asked again after RUNTIME_MISS_MS). */
const runtimeMemo = new Map<string, { sid: string | null; at: number }>()
const RUNTIME_MISS_MS = 30_000
const RUNTIME_MEMO_MAX = 2_000

/** The host-judged session whose ACP worker is `runtimeId`, or null. */
export function hostJudgedSessionOfRuntime(runtimeId: string): string | null {
  if (!runtimeId || !hostJudgedRowsMayExist()) return null
  const m = runtimeMemo.get(runtimeId)
  if (m && (m.sid || Date.now() - m.at < RUNTIME_MISS_MS)) return m.sid
  let sid: string | null = null
  try { sid = hostJudgedOfAcpRuntimeInStore(runtimeId)?.sid ?? null } catch { sid = null }
  if (runtimeMemo.size >= RUNTIME_MEMO_MAX) runtimeMemo.clear()
  runtimeMemo.set(runtimeId, { sid, at: Date.now() })
  return sid
}

/** The session a daemon command is about: its `sid` (an ACP worker's runtime id mapped to its session), or a rename's old id. */
function sessionOfCommand(cmd: string, params: Record<string, unknown>): string | null {
  const id = typeof params.sid === 'string' && params.sid ? params.sid : typeof params.oldSid === 'string' && params.oldSid ? params.oldSid : null
  if (!id) return null
  if (RUNTIME_KEYED.has(cmd) && !judgingHostOf(id)) return hostJudgedSessionOfRuntime(id) ?? id
  return id
}

export class HostJudgedCommandError extends Error {
  readonly code = 'host_judged_session'
  constructor(readonly sessionId: string, readonly host: string, readonly cmd: string, readonly route: string) {
    super(`${cmd} not sent to ${host}'s daemon: session ${sessionId} is run and judged by ${host}'s own service (its answer: ${route})`)
    this.name = 'HostJudgedCommandError'
  }
}

/** Refusals by command since boot (tests and the probe read them; a refusal is a caller that skipped sessionCommandTarget). */
const refusals = new Map<string, number>()
const warned = new Set<string>()
/** Every session-process command aimed at a daemon for a host-judged session, by session: refused or let through. */
const aimed = new Map<string, Record<string, number>>()
const AIMED_MAX = 5_000

/**
 * Throws before a session-process command of a host-judged session leaves for a daemon
 * (DaemonConnection.send). Free for every other command and for a store that never held a host's row.
 */
export function assertSessionCommandReachesDaemon(daemonHost: string, cmd: string, params: Record<string, unknown>): void {
  const route = ROUTE_OF.get(cmd)
  if (!route || !hostJudgedRowsMayExist()) return
  const sid = sessionOfCommand(cmd, params)
  if (!sid || !judgingHostOf(sid)) return
  if (aimed.size >= AIMED_MAX) aimed.clear()
  const mine = aimed.get(sid) ?? {}
  mine[cmd] = (mine[cmd] ?? 0) + 1
  aimed.set(sid, mine)
  const target = sessionCommandTarget(sid, cmd)
  if (target.to === 'daemon') return
  refusals.set(cmd, (refusals.get(cmd) ?? 0) + 1)
  const key = `${cmd}\u0000${sid}`
  if (!warned.has(key)) {
    if (warned.size > 1_000) warned.clear()
    warned.add(key)
    log.session.warn('session command gate: a command for a host-run session was refused before it left', { sessionId: sid, host: target.host, daemonHost, cmd, route })
  }
  throw new HostJudgedCommandError(sid, target.host, cmd, route)
}

export function sessionCommandRefusals(): Record<string, number> {
  return Object.fromEntries(refusals)
}

/** The session-process commands aimed at a daemon for host-judged session `sid` since boot (a hand-over's reads included). */
export function sessionCommandsAimedAt(sid: string): Record<string, number> {
  return { ...(aimed.get(sid) ?? {}) }
}

export function _resetSessionCommandGateForTesting(): void {
  runtimeMemo.clear()
  refusals.clear()
  warned.clear()
  aimed.clear()
}
