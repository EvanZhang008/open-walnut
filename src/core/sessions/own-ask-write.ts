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

/** The turn-end report, with the ask the session wrote itself kept while it still asks it. Pure. */
export function keepOwnAskWrite(report: StatusReport, prev: StatusReport | null | undefined, sessionId: string): StatusReport {
  // Still asking: a needs line, or one Walnut turned into a report to its lead for naming no kind
  // (readStatusReport's kindless_ask), which the session's own ask did name.
  const stillAsks = report.state === 'needs' || report.kindless_ask === true;
  if (!stillAsks || !prev?.ask_by_self || prev.state !== 'needs' || !prev.ask || prev.session_id !== sessionId) return report;
  if (namesAnotherDecision(report, prev)) return report;
  const { waiting_kind: _kind, waiting_on: _on, ...rest } = report;
  const kept: StatusReport = report.state === 'needs' ? { ...report } : { ...rest, state: 'needs' };
  for (const f of OWN_ASK_FIELDS) delete kept[f];
  for (const f of OWN_ASK_FIELDS) if (prev[f] !== undefined) (kept as unknown as Record<string, unknown>)[f] = prev[f];
  return kept;
}
