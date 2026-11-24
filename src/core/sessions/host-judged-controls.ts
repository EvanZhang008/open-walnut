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

/**
 * A stop of a host-run session: its host's answer. A stop the host answered as done (confirmed or
 * failed) is taken into the leader's row at once, as the host's own writer (writingAsHost): the row
 * record that says the same comes later over the channel, and until then the leader's copy still
 * read `pending`, so a send right after the stop met the stop fence (409). mergeHostFacts keeps it
 * against an older record of the same stop that still says `pending`.
 */
export async function terminateOnHost(sessionId: string, opts: { force?: boolean; by?: string }): Promise<TerminateResult> {
  const result = await onJudgingHost(sessionId, 'terminateSession', [opts]) as TerminateResult
  await takeAnsweredStop(sessionId, result)
  return result
}

async function takeAnsweredStop(sessionId: string, result: TerminateResult | null | undefined): Promise<void> {
  const stop = result?.stopRequest
  if (!stop || result.status === 'pending' || (stop.state !== 'confirmed' && stop.state !== 'failed')) return
  const { getSessionByClaudeId, updateSessionRecord } = await import('../session-tracker.js')
  const { judgedByHost, writingAsHost } = await import('./session-row-owner.js')
  const row = await getSessionByClaudeId(sessionId)
  if (!row || !judgedByHost(row)) return
  const kept = row.stopRequest
  // A later stop the channel already brought stays.
  if (kept && kept.id !== stop.id && kept.requestedAt > stop.requestedAt) return
  const stopRequest = { ...(kept?.id === stop.id ? kept : {}), ...stop } as NonNullable<SessionRecord['stopRequest']>
  await writingAsHost(() => updateSessionRecord(sessionId, { stopRequest }))
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
