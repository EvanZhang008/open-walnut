/**
 * An ask a session wrote itself (task_report_set) outlives its turns' own reports.
 *
 * 2026-11-23 and 11-24: a task put the full English message the user was to approve into its ask's
 * detail (ask_more) with task_report_set and read it back; at the turn's end Walnut stored the
 * turn's status answer over it, a Chinese summary, so the card asked him to approve words that were
 * not the message. The session's own write is the deliberate one: report-set marks it
 * (`ask_by_self`), and every report a turn end stores (saveStatusAnswer, status-question.ts, for the
 * status question, the summary with status lines and a watch's mid-turn ask) keeps its ask while
 * the answer still asks and names no other decision. An answer that stops asking, or says the ask
 * is another decision (FOR_USER_ASK_ID: new, or another id), replaces it, and the mark goes with it.
 *
 * Once he wrote in the task after the report that showed him the ask, a turn end that asks nothing
 * is no longer that ask (2026-11-26, replaying one of his cases: he answered the ask, the session
 * replied and ended its turn "needs you" only for him to read the reply, with no ask and no
 * decision named; the answered question came back on his card, options and all, three runs in
 * three). It is kept then only when the answer asks something in words. "Since it was shown" is
 * read from when the decision began being asked (`ask_since`, which report-set stamps and every
 * kept report carries), never the stored report's own time: that one moves to each turn-end answer,
 * so an answer he gave before the writing turn's status was stored, or before a watch's mid-turn
 * answer, read as written before the ask (review 2026-11-26).
 */
import type { StatusReport } from '../user-status.js';
import { readDeclared } from '../ask-decision.js';

/** The fields that make the ask: its words, how he answers, its detail, its kind, its decision, the mark. */
export const OWN_ASK_FIELDS = [
  'ask', 'ask_kind', 'ask_options', 'ask_more', 'ask_own', 'kindless_ask',
  'ask_id', 'ask_new', 'same_as', 'ask_distinct', 'decision_owner', 'ask_by_self',
] as const satisfies ReadonlyArray<keyof StatusReport>;

/** Whether the answer says its ask is another decision than the stored one. */
function namesAnotherDecision(report: StatusReport, prev: StatusReport): boolean {
  const said = readDeclared(report.ask_id, report.ask_new);
  return !!said.isNew || (!!said.id && said.id !== prev.ask_id);
}

/** Whether a person wrote in the task after the ask was first shown to him (ask_since; an older record: its report's time). */
function wroteSince(personWroteAt: string | undefined, prev: StatusReport): boolean {
  const wrote = Date.parse(personWroteAt ?? '');
  const shown = Date.parse(prev.ask_since ?? prev.at ?? '');
  return Number.isFinite(wrote) && Number.isFinite(shown) && wrote > shown;
}

/** Whether the answer asks him something in words (a status answer reads a decision's id only beside an ask: readStatusReport). */
function asksItStill(report: StatusReport): boolean {
  return report.kindless_ask === true || !!report.ask?.trim();
}

/**
 * The turn-end report, with the ask the session wrote itself kept while it still asks it. Pure.
 * `personWroteAt`: when a person last sent the session a message (SessionRecord.humanInputAt).
 */
export function keepOwnAskWrite(report: StatusReport, prev: StatusReport | null | undefined, sessionId: string, personWroteAt?: string): StatusReport {
  // Still asking: a needs line, or one Walnut turned into a report to its lead for naming no kind
  // (readStatusReport's kindless_ask), which the session's own ask did name.
  const stillAsks = report.state === 'needs' || report.kindless_ask === true;
  if (!stillAsks || !prev?.ask_by_self || prev.state !== 'needs' || !prev.ask || prev.session_id !== sessionId) return report;
  if (namesAnotherDecision(report, prev)) return report;
  // He wrote since the ask was shown, and this turn end asks nothing: his reply is for reading, the ask is over.
  if (wroteSince(personWroteAt, prev) && !asksItStill(report)) return report;
  const { waiting_kind: _kind, waiting_on: _on, ...rest } = report;
  const kept: StatusReport = report.state === 'needs' ? { ...report } : { ...rest, state: 'needs' };
  for (const f of OWN_ASK_FIELDS) delete kept[f];
  for (const f of OWN_ASK_FIELDS) if (prev[f] !== undefined) (kept as unknown as Record<string, unknown>)[f] = prev[f];
  return kept;
}
