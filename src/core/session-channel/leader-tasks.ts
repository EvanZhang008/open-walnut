/**
 * The task side of a session its host runs and judges, done on the leader
 * (docs/plan/one-service-every-host.md, phase 2). Tasks are the leader's data: a host cannot write
 * them (until the machine credential lets it call the leader's API, it gets needs_leader), so the
 * leader does from what it sees what its runner does for a session of its own:
 *
 *   start      the start the host answered, or a session the host started itself (its `born`
 *              row, which leader-side.ts says as a session:started; a native start on the host says
 *              its own with no id yet): the task's exec (or plan) slot and its session link, and
 *              its phase to IN_PROGRESS (handleStart does both for a session of the leader's). One
 *              session:started per session on this bus, whoever says it first (claimHostStarted).
 *   send       a message the leader forwarded: the phase edge of an input (session:input, with the
 *              send's source) and the task's last session update (handleSend does both)
 *   turn end   nothing here: server.ts applies the phase of every session:result and session:error
 *              on this bus, the forwarded facts included
 */
import { log } from '../../logging/index.js'
import { bus, EventNames, type BusEvent } from '../event-bus.js'
import { judgingHostOf } from '../sessions/judge-of.js'

/** Sessions whose start effects ran here (a start answered, then its started fact). */
const linked = new Set<string>()
const LINKED_MAX = 5_000

/** Sessions whose session:started this leader said (the start it handed on, or the channel's first word of it). */
const said = new Set<string>()
const SAID_MAX = 5_000

/**
 * Take the one session:started of a host-run session on this bus: true the first time (the caller
 * says it now), false after. The start the leader handed on, the host's born row of it and the
 * host's own session:started fact all ask, in whatever order they come.
 */
export function claimHostStarted(sid: string): boolean {
  if (!sid || said.has(sid)) return false
  if (said.size >= SAID_MAX) said.delete(said.values().next().value!)
  said.add(sid)
  return true
}

/** Was the session:started of `sid` said on this bus already? */
export function hostStartedSaid(sid: string): boolean {
  return said.has(sid)
}

/** Link a host-judged session to its task and move the task to IN_PROGRESS, once per session. */
export async function noteHostSessionStarted(sid: string, taskId: string | undefined, mode?: string): Promise<void> {
  if (!sid || !taskId || linked.has(sid)) return
  if (linked.size >= LINKED_MAX) linked.clear()
  linked.add(sid)
  try {
    const { getSessionByClaudeId } = await import('../session-tracker.js')
    const { addSessionToHistory, linkSession, linkSessionSlot, updateTask } = await import('../task-manager.js')
    const record = await getSessionByClaudeId(sid)
    // An archived session goes to the task's history only, as handleStart does.
    if (record?.archived) { await addSessionToHistory(taskId, sid); return }
    await linkSessionSlot(taskId, sid, (mode ?? record?.mode) === 'plan' ? 'plan' : 'exec')
    const { task } = await linkSession(taskId, sid)
    bus.emit(EventNames.TASK_UPDATED, { task }, ['web-ui'], { source: 'session-link' })
    await updateTask(taskId, { phase: 'IN_PROGRESS' }, { source: 'session-start' })
  } catch (err) {
    linked.delete(sid)
    log.session.warn('host-run session: linking it to its task failed', { sessionId: sid, taskId, error: err instanceof Error ? err.message : String(err) })
  }
}

/** A message the leader sent to a host-judged session: the task's input edge and its last update. */
export async function noteHostSessionSend(sid: string, source: string, endsWait: boolean): Promise<void> {
  try {
    const { getSessionByClaudeId } = await import('../session-tracker.js')
    const record = await getSessionByClaudeId(sid)
    if (!record?.taskId) return
    const { applySessionPhase, sendSourceReopensTerminal } = await import('../phase.js')
    await applySessionPhase(record.taskId, 'session:input', 'host-judged:send', {
      sessionId: sid, reopenTerminal: sendSourceReopensTerminal(source), sendSource: source, sendEndsWait: endsWait,
    })
    const { touchLastSessionUpdate } = await import('../task-manager.js')
    await touchLastSessionUpdate(record.taskId)
  } catch (err) {
    log.session.warn('host-run session: the task side of a send failed', { sessionId: sid, error: err instanceof Error ? err.message : String(err) })
  }
}

const SUBSCRIBER = 'host-session-tasks'

/** A `session:started` fact of a session its host runs: link it, whoever started it. */
function onStarted(event: BusEvent): void {
  const d = event.data as { sessionId?: string; claudeSessionId?: string; taskId?: string } | null
  const sid = d?.sessionId ?? d?.claudeSessionId
  if (!sid || !judgingHostOf(sid)) return
  void noteHostSessionStarted(sid, d?.taskId)
}

export function startHostSessionTasks(): () => void {
  bus.subscribe(SUBSCRIBER, onStarted, { global: true, interest: [EventNames.SESSION_STARTED] })
  return () => bus.unsubscribe(SUBSCRIBER)
}

export function _resetHostSessionTasksForTesting(): void {
  linked.clear()
  said.clear()
}
