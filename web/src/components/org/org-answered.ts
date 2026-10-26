/**
 * An ask the user answered from its Org row stops counting at once (2026-10-26, the lead on the
 * user's ask: "答完立刻不再算需要你，计数马上变"). The server re-derives the task's status a moment
 * later (src/core/user-status-sync.ts) and the session's prompt clears a moment later; until then
 * the page shows the task as working, which is what an answer starts.
 *
 * A hold keeps what the task showed when it was answered: its whole status (statusSig; `at` alone
 * is the session's last report, which the next ask may share) and the live prompt its session
 * showed. It hides only those. Any move of the status is the server's word, and a prompt that
 * appears after the answered one went (or a different one) is a new ask: either ends the hold, as
 * does a minute for an answer the server never saw.
 */
import type { Task } from '@open-walnut/core';

export const ANSWERED_HOLD_MS = 60_000;

export interface AnsweredHold {
  /** The task's status when it was answered (statusSig). */
  sig: string;
  /** The live prompt its session showed then (promptKey), '' for none. */
  probe: string;
  until: number;
  /** That prompt has gone since: the next one is new. */
  cleared?: boolean;
}

/** Answered asks by task id. */
export type AnsweredHolds = ReadonlyMap<string, AnsweredHold>;

/** A task's status, all of it: a change in any part is the server moving it. */
export function statusSig(t: Task | undefined): string {
  const s = t?.user_status;
  return s ? [s.state, s.source ?? '', s.ask ?? '', s.at ?? ''].join('\u0001') : '';
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
      // The server moved the status, and no answered prompt is left on screen to hide.
      if (statusSig(t) !== h.sig && !promptHeld) keep = null;
      else if (cleared !== !!h.cleared) keep = { ...h, cleared };
    }
    if (keep !== h) {
      next ??= new Map(holds);
      if (keep) next.set(id, keep); else next.delete(id);
    }
  }
  return next ?? holds;
}

/** The tasks as the page shows them: a held one reads as working while its status has not moved. */
export function withAnswered(tasks: readonly Task[], holds: AnsweredHolds, nowMs: number): readonly Task[] {
  if (!holds.size) return tasks;
  return tasks.map((t) => {
    const h = holds.get(t.id);
    if (!h || h.until <= nowMs || statusSig(t) !== h.sig) return t;
    const { ask: _ask, source: _source, ...rest } = t.user_status ?? { state: 'working' as const };
    return { ...t, user_status: { ...rest, state: 'working' as const } };
  });
}

/** Whether the live prompt the page sees for a task is the one it answered (hide it). */
export function promptAnswered(holds: AnsweredHolds, taskId: string, key: string, nowMs: number): boolean {
  const h = holds.get(taskId);
  return !!h && h.until > nowMs && !!key && !h.cleared && key === h.probe;
}
