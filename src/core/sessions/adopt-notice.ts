/**
 * Adopt notice: when a task becomes a worker (subtask) of another task, or is
 * released from one, its own LIVE session is told, so it knows whose messages
 * to answer and that its state now reaches a leader (subtask-notices.ts).
 *
 * Sent by PATCH /api/v1/tasks/:id after the parent link changed. Bounded on
 * purpose:
 *  - only a session in the middle of a turn hears, where the notice rides along
 *    for free. An idle or stopped one is NOT woken: adopting is bookkeeping, and
 *    a turn spent on "this is only a notice" is the whole cost (2026-10-02: a
 *    leader adopted five idle workers and each woke to say exactly that). It
 *    reads the link from its task when it next runs, and the leader's own
 *    message tells it how to reply;
 *    The status is a snapshot: a turn that ends between the check and the
 *    delivery is woken once, which is the old behaviour, not a new failure;
 *  - never the caller's own session (it made the change and knows);
 *  - never a COMPLETE task (a notice would only spend a turn on finished work);
 *  - the leader is not told here: the op outcome and the state notices cover it.
 * Best effort: it never throws, so the PATCH never fails because of it.
 */

import { log } from '../../logging/index.js';
import type { SessionRecord, Task } from '../types.js';
import { createEnvelopeKit } from '../peers/envelope-kit.js';

const kit = createEnvelopeKit();

/** Same bus source as every Walnut notice: it never reopens a finished task (phase.ts). */
const NOTICE_SOURCE = 'walnut-notify';
/** The note every Walnut status notice carries (envelope-kit.ts NOTE_NOTIFICATION). */
const NOTE_NOTIFICATION = 'automated Walnut status notice';
/** Statuses that read a message without a turn being started for it. */
const MID_TURN_STATUSES = new Set(['running']);

export type AdoptNoticeKind = 'adopted' | 'released';

export interface AdoptNotice {
  kind: AdoptNoticeKind;
  /** The task whose leader changed: the notice goes to its session. */
  task: Pick<Task, 'id' | 'title' | 'phase'>;
  /** The new leader (`adopted`) or the one it left (`released`). */
  leader: { id: string; title?: string };
  /** The session that made the change, if any: it is never told. */
  callerSid?: string;
}

export type AdoptNoticeResult =
  | { delivered: true; sessionId: string; delivery: 'queued' | 'deferred' }
  | { delivered: false; reason: 'complete' | 'no_running_session' | 'caller_session' | 'failed' };

/** The envelope text the adopted (or released) task's session reads. */
export function buildAdoptNoticeText(n: Pick<AdoptNotice, 'kind' | 'leader'>): string {
  const title = kit.sessionHandle(n.leader.title, undefined) || 'untitled';
  const leader = `"${title}" (${n.leader.id})`;
  const lead = n.kind === 'adopted'
    ? `Your task is now a worker of ${leader}. A message from that task ending in "Reply when done" is its session's; `
      + 'the reply it names is how your result gets back. Walnut tells it when you stop, complete, hit an error or wait on the user.'
    : `Your task no longer has a leader; ${leader} released it.`;
  return kit.buildWalnutMessage({
    kind: 'notification',
    attrs: {
      from: 'Walnut',
      about: title,
      'about-task': n.leader.id,
      outcome: n.kind,
      note: NOTE_NOTIFICATION,
    },
    body: [
      `${lead} A status notice, not a request: nothing waits on an answer.`,
      ...(n.kind === 'adopted'
        ? [`Next:\n  walnut tools call task_get '{"id":"${n.leader.id}"}'          # the task that leads yours`]
        : []),
    ].join('\n\n'),
  });
}

/** The task's session in the middle of a turn, newest first; null when none. */
async function midTurnSessionOf(taskId: string): Promise<SessionRecord | null> {
  const { getSessionsForTask, isListableSession } = await import('../session-tracker.js');
  const rows = (await getSessionsForTask(taskId))
    .filter((s) => !s.archived && isListableSession(s) && MID_TURN_STATUSES.has(s.process_status));
  rows.sort((a, b) => (b.lastActiveAt ?? '').localeCompare(a.lastActiveAt ?? ''));
  return rows[0] ?? null;
}

/** Tell the task's session, mid-turn, that its leader changed. Never throws. */
export async function notifyAdoptedTask(n: AdoptNotice): Promise<AdoptNoticeResult> {
  const fields = { taskId: n.task.id, leaderTaskId: n.leader.id, kind: n.kind };
  try {
    if (n.task.phase === 'COMPLETE') return { delivered: false, reason: 'complete' };
    const target = await midTurnSessionOf(n.task.id);
    if (!target) return { delivered: false, reason: 'no_running_session' };
    if (n.callerSid && target.claudeSessionId === n.callerSid.trim()) return { delivered: false, reason: 'caller_session' };
    const text = buildAdoptNoticeText(n);
    const { deliverToSession } = await import('./session-send-core.js');
    const { delivery, messageId } = await deliverToSession(target, {
      busText: text, enqueueText: text, source: NOTICE_SOURCE, taskId: n.task.id,
    });
    log.session.info('adopt notice delivered', { ...fields, sessionId: target.claudeSessionId, delivery, messageId });
    return { delivered: true, sessionId: target.claudeSessionId, delivery };
  } catch (err) {
    log.session.warn('adopt notice failed', { ...fields, error: err instanceof Error ? err.message : String(err) });
    return { delivered: false, reason: 'failed' };
  }
}
