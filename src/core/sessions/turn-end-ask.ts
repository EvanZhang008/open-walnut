/**
 * A turn end's report asks the user only what that turn asked (2026-11-13: a lead's task read
 * "needs you" for a cloud cleanup the user had said yes to the day before. Its turn after a Walnut
 * compaction asked nothing (the turn before it was an agent-ack), yet the status question named the
 * old decision as "your ask to the user", and the freshly compacted session gave it back, id and
 * all: a three-day-old ask was back on the Org page).
 *
 * Every report derived at a turn end, for every engine (the native side question, an ACP engine's
 * summary self-report, the re-asks after a restart, by the reconcile loop and by a watch), is stored
 * through applyStatusAnswer (status-question.ts), which hands it here once its decision is stamped
 * (ask-decision.ts). The rule: a turn that wrote nothing for the user (only the agent-ack line,
 * nothing at all, a Walnut compaction: quiet-turn.ts, or one the session record saw after its last
 * words) asks nothing new. Its report keeps only the ask that still stands (the report before it
 * asked that same decision) and never brings back an older one, answered or not; the report before
 * it stays, as of this turn end. An ask from a turn with words is that turn's own: the session wrote
 * it to the user in that turn.
 *
 * The status question itself names the task's decision only while it still stands
 * (ask-decision.ts askDecisionQuestion), so nothing leads a session into asking a closed decision
 * again; a decision a lead answered stays answered (same-ask.ts answerHolds).
 * Guard: tests/core/sessions/turn-end-ask-ratchet.test.ts.
 */
import { log } from '../../logging/index.js';
import type { StatusReport } from '../user-status.js';

/** What the turn that just ended wrote: words for the user, none, or unknown (no transcript read). */
export type TurnWords = 'words' | 'quiet' | 'unknown';

export interface TurnEndAskFacts {
  turn: TurnWords;
}

export type TurnEndAskVerdict = { ok: true } | { ok: false; why: 'quiet-turn' };

/** The report still asks the decision the report before it asked. */
function stillStanding(report: StatusReport, prev: StatusReport | null | undefined): boolean {
  if (prev?.state !== 'needs' || !prev.ask) return false;
  // A decision an older Walnut stored with no id got one at stamping, keeping its words' key.
  if (!prev.ask_id) return !!report.ask_legacy_key;
  return report.ask_id === prev.ask_id;
}

/** Whether a stamped turn-end report may ask what it asks. Pure. */
export function judgeTurnEndAsk(
  report: StatusReport, prev: StatusReport | null | undefined, facts: TurnEndAskFacts,
): TurnEndAskVerdict {
  if (report.state !== 'needs' || !report.ask) return { ok: true };
  if (stillStanding(report, prev)) return { ok: true };
  if (facts.turn === 'quiet') return { ok: false, why: 'quiet-turn' };
  return { ok: true };
}

/** The report stored when a turn end's ask is refused: the one before it, as of this turn end. */
export function keptReport(report: StatusReport, prev: StatusReport): StatusReport {
  const { answered_person: _a, ...rest } = prev;
  return {
    ...rest, at: report.at, ...(report.rule ? { rule: report.rule } : {}),
    ...(report.turn_ended_at ? { turn_ended_at: report.turn_ended_at } : {}),
    ...(report.answered_person ? { answered_person: true } : {}),
    ...(report.session_id ? { session_id: report.session_id } : {}),
  };
}

/** What the session's last turn wrote: a quiet turn Walnut runs is quiet, else its transcript says. */
async function readTurnWords(sessionId: string, compactedAt?: string): Promise<TurnWords> {
  const { isQuietTurn } = await import('./quiet-turn.js');
  if (isQuietTurn(sessionId)) return 'quiet';
  const { readLastTurnWroteWords } = await import('./session-request-notify.js');
  const wrote = await readLastTurnWroteWords(sessionId, { compactedAt });
  return wrote === undefined ? 'unknown' : wrote ? 'words' : 'quiet';
}

/**
 * The report a turn end stores: `report` (stamped) when it may ask what it asks, else the report
 * before it as of this turn end, or null when there is none. `compactedAt`: the session's last
 * compaction (SessionRecord.lastCompactAt). `midTurn`: asked inside a running turn (a watch), whose
 * words are not all written yet: never judged quiet.
 */
export async function admitTurnEndAsk(
  report: StatusReport, prev: StatusReport | null | undefined,
  ctx: { taskId: string; sessionId: string; compactedAt?: string; midTurn?: boolean },
): Promise<StatusReport | null> {
  if (report.state !== 'needs' || !report.ask || stillStanding(report, prev)) return report;
  const turn: TurnWords = ctx.midTurn ? 'unknown' : await readTurnWords(ctx.sessionId, ctx.compactedAt);
  const verdict = judgeTurnEndAsk(report, prev, { turn });
  if (verdict.ok) return report;
  log.session.warn('turn-end report: ask refused, the report before it kept', {
    taskId: ctx.taskId, sessionId: ctx.sessionId, why: verdict.why, askId: report.ask_id, prevState: prev?.state ?? null,
  });
  return prev ? keptReport(report, prev) : null;
}
