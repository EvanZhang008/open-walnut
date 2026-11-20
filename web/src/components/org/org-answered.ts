/**
 * An ask the user answered from its Org row stops counting at once (2026-10-26, the lead on the
 * user's ask: "答完立刻不再算需要你，计数马上变"). The server re-derives the task's status a moment
 * later (src/core/user-status-sync.ts) and the session's prompt clears a moment later; until then
 * the page shows the task as working, which is what an answer starts.
 *
 * A hold keeps what the task showed when it was answered: its phase, which is what makes it need
 * the user (src/core/user-status.ts), the source of its ask, and the live prompt its session
 * showed. It hides the ask until the task asks again: it is handed back to the user anew (it takes
 * NEED_ACTION again, after the session took the answer), another letter or Board choice of its own
 * waits on the user, its session fails, or a prompt appears after the answered one went (or a
 * different one). Until then its status reads as working: the server may re-derive "its turn
 * handed it back" before the answer has reached the session, and a status derived a moment before
 * the session took the answer still says Needs you.
 * The status leaving Needs you ends the hold too, as does a minute for an answer that never moved
 * the task.
 *
 * The status itself is the task store's prediction (hooks/status-prediction.ts, predictStatus with
 * `answerPending` as its `holds` and ANSWERED_HOLD_MS as its `keepMs`), so Home, the board and
 * every count read the answered task as working too, and nothing here lays a second copy over it
 * (2026-11-19: the page's hold ended the moment the store's prediction read Working, and that
 * prediction lapsed after 10 s, so the row went back to Needs you until the server derived it).
 * The hold here keeps what only this page shows: the answered prompt, hidden until it goes.
 */
import type { Task } from '@open-walnut/core';
import { userStateOf } from '@open-walnut/org-tree';
import type { UserStatus } from '@open-walnut/user-status';

export const ANSWERED_HOLD_MS = 60_000;

export interface AnsweredHold {
  /** The task's phase when it was answered, with when it took it (phaseMark): a phase that left and
   *  came back between two reads (the session took the answer and handed the task back) is a move. */
  phase: string;
  /** Where its ask lived then (UserStatus.source) and its words, '' for none. */
  source: string;
  ask: string;
  /** The live prompt its session showed then (promptKey), '' for none. */
  probe: string;
  until: number;
  /** That prompt has gone since: the next one is new. */
  cleared?: boolean;
}

/** Answered asks by task id. */
export type AnsweredHolds = ReadonlyMap<string, AnsweredHold>;

// The rows' own rule (collectAlerts): a task not derived yet needs the user by its phase.
const needs = (t: Task): boolean => userStateOf(t) === 'needs';

/** The task's phase and when it took it. */
export const phaseMark = (t: Task | undefined): string => (t ? `${t.phase}@${t.phase_changed_at ?? ''}` : '');

/** The task asks again since the answer: handed back to the user anew, another of its letters or
 *  choices waits, or its session failed. Only the fallback words ("its turn handed it back") are
 *  the same ask said again. */
function askedAgain(h: AnsweredHold, t: Task): boolean {
  if (t.phase === 'NEED_ACTION' && phaseMark(t) !== h.phase) return true;
  const src = t.user_status?.source ?? '';
  if ((src === 'letter' || src === 'choice') && (src !== h.source || (t.user_status?.ask ?? '') !== h.ask)) return true;
  return src === 'error' && h.source !== 'error';
}

/** The live prompt key of a probe result ('' for none). */
export function promptKey(p: { kind: string; tool?: string } | null): string {
  return p ? `${p.kind}:${p.tool ?? ''}` : '';
}

/** The holds still in force, given the tasks and their live prompts now. The same map when none moved. */
export function settleHolds(
  holds: AnsweredHolds,
  tasks: readonly Task[],
  live: (t: Task) => string,
  nowMs: number,
): AnsweredHolds {
  if (!holds.size) return holds;
  const byId = new Map(tasks.filter((t) => holds.has(t.id)).map((t) => [t.id, t]));
  let next: Map<string, AnsweredHold> | null = null;
  for (const [id, h] of holds) {
    const t = byId.get(id);
    const p = t ? live(t) : '';
    let keep: AnsweredHold | null = h;
    if (!t || h.until <= nowMs) keep = null;
    // A prompt after the answered one went, or another one: a new ask.
    else if (p && (h.cleared || p !== h.probe)) keep = null;
    else {
      const cleared = h.cleared || (!!h.probe && !p);
      const promptHeld = !!h.probe && !cleared;
      // The task asks again (or needs no one), and no answered prompt is left on screen to hide.
      if ((askedAgain(h, t) || !needs(t)) && !promptHeld) keep = null;
      else if (cleared !== !!h.cleared) keep = { ...h, cleared };
    }
    if (keep !== h) {
      next ??= new Map(holds);
      if (keep) next.set(id, keep); else next.delete(id);
    }
  }
  return next ?? holds;
}

/** Whether a server row has not caught up with the answer yet: it still reads Needs you and does
 *  not ask again. The store's prediction of Working stays over such a row (PredictOptions.holds). */
export function answerPending(h: AnsweredHold, t: Task, nowMs = Date.now()): boolean {
  return h.until > nowMs && needs(t) && !askedAgain(h, t);
}

/** What an answered task reads as until the server derives it: working, its ask gone. */
export function answeredStatus(t: Task): UserStatus | undefined {
  if (!needs(t)) return t.user_status;
  const { ask: _ask, source: _source, ...rest } = t.user_status ?? { state: 'working' as const };
  return { ...rest, state: 'working' };
}

/** Whether the live prompt the page sees for a task is the one it answered (hide it). */
export function promptAnswered(holds: AnsweredHolds, taskId: string, key: string, nowMs: number): boolean {
  const h = holds.get(taskId);
  return !!h && h.until > nowMs && !!key && !h.cleared && key === h.probe;
}

/** The map without `key`: the same map when it has none. */
export function without<V>(map: ReadonlyMap<string, V>, key: string): ReadonlyMap<string, V> {
  if (!map.has(key)) return map;
  const next = new Map(map);
  next.delete(key);
  return next;
}
