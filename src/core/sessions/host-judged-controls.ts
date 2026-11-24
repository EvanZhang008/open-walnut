/**
 * The session controls a leader hands whole to the host that runs and judges the session
 * (docs/plan/one-service-every-host.md, phase 2): what the control writes of the session is the
 * host's (its process, its mode, its stop), so the host carries it out on its own row and its own
 * live session, and the leader keeps only its own part (a person's fields, the task's slots).
 * Each goes as one `lifecycle` call (session-channel/host-calls.ts) answered by the same function
 * of session-lifecycle.ts on the host.
 *
 *   stop   terminateSession on the host: its stop coordinator, its cron check, its ACP stop
 *   mode   changeSessionModeOf on the host: its row's mode and the live apply; the task's
 *          plan and exec slots follow here, on the leader
 *   checks readSessionSupervision, lineAlreadyRan, cancelPendingStart (host-lifecycle.ts): what the
 *          host's own daemon says of its own session, asked by the host (session-command-gate.ts)
 */
import type { SessionMode, SessionRecord } from '../types.js'
import type { TerminateResult } from './session-lifecycle.js'
import type { HOST_CALL_ALLOWLIST } from '../session-channel/host-calls.js'
import { hostTakesChecks } from './session-command-gate.js'

export type HostLifecycleMember = (typeof HOST_CALL_ALLOWLIST)['lifecycle'][number]

/** The members a host answers only once it names SESSION_HOST_CHECKS_CAP (switch.ts). */
const CHECKS: ReadonlySet<HostLifecycleMember> = new Set(['readSessionSupervision', 'lineAlreadyRan', 'cancelPendingStart'])

/** The host that runs the session is on a Walnut from before the check: it is not asked. */
export class HostNeedsUpdateError extends Error {
  readonly code = 'host_needs_update'
  constructor(readonly host: string, readonly member: string) {
    super(`the service on ${host} that runs this session needs a Walnut update before it can answer ${member}; it updates with its next deploy`)
    this.name = 'HostNeedsUpdateError'
  }
}

async function proxyOf(sessionId: string) {
  const { hostJudgedSession } = await import('../../providers/host-judged-runner.js')
  const p = hostJudgedSession(sessionId)
  if (!p) throw new Error(`session ${sessionId} is not run by a host`)
  return p
}

/** One `lifecycle` member (host-calls.ts) carried out by the host that runs `sessionId`: its answer, or a throw. */
export async function onJudgingHost(sessionId: string, member: HostLifecycleMember, args: unknown[] = []): Promise<unknown> {
  const p = await proxyOf(sessionId)
  if (CHECKS.has(member) && !hostTakesChecks(p.host)) throw new HostNeedsUpdateError(p.host, member)
  return p.call(member, args, 'lifecycle')
}

/** A stop of a host-run session: its host's answer. */
export async function terminateOnHost(sessionId: string, opts: { force?: boolean; by?: string }): Promise<TerminateResult> {
  return await (await proxyOf(sessionId)).call('terminateSession', [opts], 'lifecycle') as TerminateResult
}

/**
 * A mode change of a host-run session. The leader's own fields of the same patch (a title, a
 * note) are written here; the mode goes to the host, which keeps it on its row (its next row
 * record brings it back here) and applies it to its live session. Answers the leader's row with
 * the mode the host took.
 */
export async function changeModeOnHost(existing: SessionRecord, sessionId: string, mode: SessionMode, updates: Partial<SessionRecord>): Promise<SessionRecord> {
  const p = await proxyOf(sessionId)
  const taken = await p.call('changeSessionModeOf', [mode], 'lifecycle') as Partial<SessionRecord> | null
  const { getSessionByClaudeId, updateSessionRecord } = await import('../session-tracker.js')
  const row = Object.keys(updates).length > 0 ? await updateSessionRecord(sessionId, updates) : (await getSessionByClaudeId(sessionId)) ?? existing
  const { reconcileModeSlots } = await import('./session-lifecycle.js')
  await reconcileModeSlots(row, sessionId, existing.mode, mode)
  return { ...row, mode: (taken?.mode as SessionMode | undefined) ?? mode }
}
