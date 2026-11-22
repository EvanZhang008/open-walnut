/**
 * The leader's side of a retry a host gave up on (sessions/held-error.ts): a `session:retry-over`
 * fact of a session its host runs raises the held error card (the server's, installed by
 * web/server.ts) and moves the phase edge the host's give-up made. Only for a session a host judges:
 * the leader's own retriers raise their own.
 *
 * A give-up that a later turn of the same session already outran is stale: no card, no phase edge.
 * The leader learns of the later turn from that session's `session:result` facts (said here with
 * the time they happened), so:
 *   fresh   acted on at once, and its phase edge checks again after the card's await
 *   late    read back after the leader was away (`late`): gathered until the backlog went quiet
 *           (late-gather.ts), so a turn end later in the same backlog is seen first, then acted on
 *           only if no turn ended after it
 */
import { log } from '../../logging/index.js'
import { bus, EventNames, type BusEvent } from '../event-bus.js'
import { judgingHostOf } from '../sessions/judge-of.js'
import { RETRY_OVER_SUBSCRIBER, type HeldErrorCard } from '../sessions/held-error.js'
import { createLateGather, type LateGather } from './late-gather.js'
import type { SessionRetryOverEvent } from '../event-types.js'
import type { SessionRecord } from '../types.js'

let card: HeldErrorCard | null = null

/** The server's error card (web/server.ts): installed with its own retriers. */
export function setRetryOverCard(fn: HeldErrorCard | null): void {
  card = fn
}

const TURNS_SUBSCRIBER = 'host-retry-over-turns'
/** When the newest turn of each host-run session ended, on this leader's clock (the fact's own time). */
const lastTurnEnd = new Map<string, number>()
const TURNS_MAX = 5_000

function noteTurnEnd(event: BusEvent): void {
  const sid = (event.data as { sessionId?: unknown } | null)?.sessionId
  if (typeof sid !== 'string' || !sid || !judgingHostOf(sid)) return
  const at = event.timestamp
  if (at <= (lastTurnEnd.get(sid) ?? 0)) return
  lastTurnEnd.delete(sid)
  if (lastTurnEnd.size >= TURNS_MAX) lastTurnEnd.delete(lastTurnEnd.keys().next().value!)
  lastTurnEnd.set(sid, at)
}

/** Did a turn of `sid` end after the give-up that happened at `at`? */
function outrun(sid: string, at: number): boolean {
  return (lastTurnEnd.get(sid) ?? 0) > at
}

async function act(event: BusEvent): Promise<void> {
  const d = event.data as SessionRetryOverEvent | null
  const sid = d?.sessionId
  if (!sid || !judgingHostOf(sid)) return
  const at = event.timestamp
  if (outrun(sid, at)) {
    log.session.info('host-run session: a give-up a later turn outran raises nothing', { sessionId: sid, late: event.late === true })
    return
  }
  const { getSessionByClaudeId } = await import('../session-tracker.js')
  const rec: SessionRecord = (await getSessionByClaudeId(sid).catch(() => null)) ?? ({ claudeSessionId: sid, ...(d.taskId ? { taskId: d.taskId } : {}) } as SessionRecord)
  const taskId = d.taskId ?? rec.taskId
  if (d.card && typeof d.card.words === 'string' && card) {
    await card({ ...rec, ...(taskId ? { taskId } : {}) }, d.card.words).catch((err: unknown) => {
      log.session.warn('host-run session: the held error card was not raised', { sessionId: sid, error: err instanceof Error ? err.message : String(err) })
    })
  }
  if (d.phase && taskId && (d.phase.trigger === 'session:error' || d.phase.trigger === 'session:result')) {
    // Asked again after the awaits above: a turn end said meanwhile moved the phase already.
    if (outrun(sid, at)) return
    const { applySessionPhase } = await import('../phase.js')
    await applySessionPhase(taskId, d.phase.trigger, String(d.phase.why ?? 'host-retry-over'), { sessionId: sid, retryOver: true }).catch((err: unknown) => {
      log.session.warn('host-run session: the give-up\'s phase was not applied', { sessionId: sid, taskId, error: err instanceof Error ? err.message : String(err) })
    })
  }
}

/** Kept for the handler's callers: one give-up, acted on now (a late one waits for its backlog). */
export async function onRetryOver(event: BusEvent): Promise<void> {
  if (event.late === true && gather) {
    lateOnes.push(event)
    gather.add((event.data as { sessionId?: string } | null)?.sessionId ?? '')
    return
  }
  await act(event)
}

let gather: LateGather | null = null
let lateOnes: BusEvent[] = []

export function startLeaderRetryOver(o: { lateQuietMs?: number; lateMaxMs?: number } = {}): () => void {
  gather = createLateGather(() => {
    const events = lateOnes
    lateOnes = []
    void (async () => { for (const e of events) await act(e) })()
  }, { quietMs: o.lateQuietMs, maxMs: o.lateMaxMs })
  bus.subscribe(RETRY_OVER_SUBSCRIBER, (e) => { if (e.name === EventNames.SESSION_RETRY_OVER) void onRetryOver(e) })
  bus.subscribe(TURNS_SUBSCRIBER, noteTurnEnd, { global: true, interest: [EventNames.SESSION_RESULT] })
  return () => {
    bus.unsubscribe(RETRY_OVER_SUBSCRIBER)
    bus.unsubscribe(TURNS_SUBSCRIBER)
    gather?.stop()
    gather = null
    lateOnes = []
    lastTurnEnd.clear()
  }
}
