/**
 * One decision, one id, whatever its words (2026-11-09, the CEO gathering five VP reflections: a
 * blog task reworded one question four times in a day, six asks sat in front of the user three to
 * four days and read as new at every refresh, and five "changes" in one Brief refresh were all new
 * words ("is it done?" added, "about 50 minutes" added, "go with the recommendation?" added), no new
 * fact in any. The user, 11-07: "can we not ask me everyfucking day").
 *
 * The task that asks keeps the id: Walnut mints one when a task first asks the user something
 * (`ask_id` on its report), shows it to the session in the turn-end status question, and keeps it
 * on every later report that asks again, in any words, unless the session says the ask is a new
 * decision (FOR_USER_ASK_ID: new) or names what is really new about it (FOR_USER_ASK_NEW: a new
 * fact, option or deadline), which counts its revision up. A report set from outside the turn
 * (task_report_set) keeps it the same way.
 *
 * News is the decision and its facts, never the wording: `decisionKey` is the id, its revision, how
 * many options it offers, the task's deadline and the links it points to. Every path that tells
 * someone an ask changed (status-push.ts, brief-fresh.ts, brief-refresh.ts, needs-recheck.ts,
 * org-follow.ts, threads-model.ts) compares that key; tests/core/ask-decision-news-guard.test.ts
 * lists them and runs the real rewordings through each. Pure.
 */
import { askShape, sameAskReworded, SAME_ASK_MIN_WORDS } from './same-ask.js';
import type { StatusReport, UserStatus } from './user-status.js';

/** How a decision id looks: `ask-` and a few base-36 characters. */
export const ASK_ID_RE = /\bask-[a-z0-9]{4,12}\b/i;

/** A decision a task stopped asking (a re-check turn that ran, a wait) is the same one when it asks
 *  it again within this long. */
export const ASK_MEMORY_MS = 7 * 24 * 60 * 60_000;

/** Under this share of shared content words, an ask the session did not say was the same is a new
 *  decision: the real rewordings of 2026-11-08 shared 38% to 100%. */
const DISJOINT_SHARE = 0.15;

/** The decision a report carries, as the next report reads it back. */
export interface AskMemory {
  id: string;
  rev?: number;
  ask: string;
  /** The last thing the session named as new about it (FOR_USER_ASK_NEW). */
  new?: string;
  at: string;
}

/** The decision on a task's shown status (UserStatus.decision). */
export interface StatusDecision {
  id: string;
  /** The id, its revision and its facts: two statuses with one key ask the same, unchanged. */
  key: string;
  rev?: number;
  /** What the session named as new at its last revision. */
  new?: string;
}

export function mintAskId(): string {
  return `ask-${Math.random().toString(36).slice(2, 8).padEnd(6, '0')}`;
}

/** The URLs an ask points to, as its evidence. */
export function askEvidence(text: string | undefined | null): string[] {
  const out = new Set<string>();
  for (const m of (text ?? '').matchAll(/https?:\/\/[^\s<>"'\u3000-\u303f\uff00-\uffef]+/giu)) out.add(m[0].replace(/[.,;:!?)\]}]+$/, ''));
  return [...out].sort();
}

/** The facts of an ask beside its words: its revision, its options, its deadline, its links. */
export function askFactsOf(
  r: Pick<StatusReport, 'ask' | 'ask_kind' | 'ask_options' | 'ask_more' | 'ask_rev'>, dueDate?: string | null,
): string {
  const options = r.ask_kind === 'single' || r.ask_kind === 'multi' ? r.ask_options?.length ?? 0 : 0;
  return [`r${r.ask_rev ?? 0}`, `o${options}`, `d${(dueDate ?? '').trim().slice(0, 10)}`, askEvidence(`${r.ask ?? ''} ${r.ask_more ?? ''}`).join(' ')].join('|');
}

/** The decision of a needs report, or null for one with no id (an older Walnut wrote it). */
export function reportDecision(r: StatusReport | null | undefined, dueDate?: string | null): StatusDecision | null {
  if (!r || r.state !== 'needs' || !r.ask || !r.ask_id || !ASK_ID_RE.test(r.ask_id)) return null;
  return {
    id: r.ask_id, key: `${r.ask_id}|${askFactsOf(r, dueDate)}`,
    ...(r.ask_rev ? { rev: r.ask_rev } : {}), ...(r.ask_new ? { new: r.ask_new } : {}),
  };
}

/** The decision a status shows: the session's own (stamped by derive), or a Board choice's, which
 *  its Board keeps one id for. Null for any other status (a letter, a prompt, a failure: Walnut's
 *  own words, never reworded). */
export function statusDecision(s: Pick<UserStatus, 'state' | 'source' | 'choice' | 'decision'> | null | undefined): StatusDecision | null {
  if (!s || s.state !== 'needs') return null;
  if (s.decision) return s.decision;
  if (s.source === 'choice' && s.choice) {
    const id = `choice:${s.choice.board}/${s.choice.id}`;
    return { id, key: id };
  }
  return null;
}

/** The decision a task asks now: its shown status's, else its stored report's (a status between a
 *  turn's end and its report says nothing yet). */
export function taskDecision(t: { user_status?: UserStatus | null; status_report?: StatusReport | null; due_date?: string | null }): StatusDecision | null {
  const s = t.user_status;
  if (s && !s.transient) return statusDecision(s);
  return reportDecision(t.status_report, t.due_date);
}

/** Whether two statuses ask the user something that is news between them: another decision, or the
 *  same one with new facts. Null when either has no decision, so the caller judges as it did before. */
export function decisionMoved(a: StatusDecision | null | undefined, b: StatusDecision | null | undefined): boolean | null {
  if (!a || !b) return null;
  return a.key !== b.key;
}

/** The decision a report remembers: its own, or the one it carried. */
export function memoryOf(r: StatusReport | null | undefined): AskMemory | null {
  if (!r) return null;
  if (r.state === 'needs' && r.ask && r.ask_id) {
    return { id: r.ask_id, ...(r.ask_rev ? { rev: r.ask_rev } : {}), ask: r.ask, ...(r.ask_new ? { new: r.ask_new } : {}), at: r.at };
  }
  return r.last_ask ?? null;
}

/** Whether two asks share almost no content word: not a rewording, whatever the session said or
 *  left out. */
function disjoint(a: string, b: string): boolean {
  const wa = askShape(a).words;
  const wb = askShape(b).words;
  if (wa.length < SAME_ASK_MIN_WORDS || wb.length < SAME_ASK_MIN_WORDS) return false;
  const inB = new Set(wb);
  return wa.filter((w) => inB.has(w)).length / Math.min(wa.length, wb.length) < DISJOINT_SHARE;
}

/** What the session said of its decision (FOR_USER_ASK_ID, FOR_USER_ASK_NEW), read off the report. */
export interface AskDeclared { id?: string; isNew?: boolean; newFact?: string }

/**
 * The report as stored: a needs report keeps the decision of the one before it (or the one it
 * remembers, asked again within ASK_MEMORY_MS in other words) unless the session says it is a new
 * decision; a new fact the session names counts the revision up once. Any other report remembers the
 * last decision (`last_ask`). `declared` is what the session wrote; with none Walnut keeps the id.
 */
export function stampAskDecision(
  report: StatusReport, prev: StatusReport | null | undefined,
  declared: AskDeclared = {}, opts: { mint?: () => string; nowMs?: number } = {},
): StatusReport {
  const { ask_id: _id, ask_rev: _rev, ask_new: _new, last_ask: _last, ...rest } = report;
  const memory = memoryOf(prev);
  const nowMs = opts.nowMs ?? Date.parse(report.at);
  const recent = !!memory && (prev?.state === 'needs' || nowMs - Date.parse(memory.at) <= ASK_MEMORY_MS);
  if (report.state !== 'needs' || !report.ask) {
    return recent ? { ...rest, last_ask: memory! } : rest;
  }
  const mint = opts.mint ?? mintAskId;
  const asked = prev?.state === 'needs' && !!prev.ask_id;
  let keep = false;
  if (memory && recent && !declared.isNew) {
    if (declared.id && declared.id.toLowerCase() === memory.id.toLowerCase()) keep = true;
    // Said nothing: the same decision while it kept asking, unless the words share nothing; after a
    // break only when the words still say the same.
    else if (asked) keep = !disjoint(memory.ask, report.ask);
    else keep = sameAskReworded(memory.ask, report.ask);
  }
  if (!keep) return { ...rest, ask_id: mint() };
  const fact = declared.newFact?.replace(/\s+/g, ' ').trim();
  // A new fact named again in other words is the same fact: one revision.
  const fresh = !!fact && !(memory!.new && (memory!.new === fact || sameAskReworded(memory!.new, fact)));
  const rev = (memory!.rev ?? 0) + (fresh ? 1 : 0);
  return {
    ...rest, ask_id: memory!.id, ...(rev ? { ask_rev: rev } : {}),
    ...(fresh ? { ask_new: fact } : memory!.new ? { ask_new: memory!.new } : {}),
  };
}

/** What the session declared, from the raw FOR_USER_ASK_ID / FOR_USER_ASK_NEW values. */
export function readDeclared(idWord: string | undefined, newWord: string | undefined): AskDeclared {
  const out: AskDeclared = {};
  const id = (idWord ?? '').trim();
  if (/^new\b/i.test(id)) out.isNew = true;
  else {
    const m = ASK_ID_RE.exec(id);
    if (m) out.id = m[0];
  }
  const fact = (newWord ?? '').replace(/\s+/g, ' ').trim();
  if (fact && !/^(none|n\/a|nothing|no)\b\.?$/i.test(fact)) out.newFact = fact.slice(0, 240);
  return out;
}

/** The turn-end status question's part on the task's own decision: '' when it asks none. */
export function askDecisionQuestion(prev: StatusReport | null | undefined, nowMs = Date.now()): string {
  const memory = memoryOf(prev);
  if (!memory) return '';
  if (prev?.state !== 'needs' && nowMs - Date.parse(memory.at) > ASK_MEMORY_MS) return '';
  const words = memory.ask.replace(/\s+/g, ' ').slice(0, 200);
  const last = memory.new ? ` The last new thing you named about it: "${memory.new.replace(/\s+/g, ' ').slice(0, 160)}".` : '';
  return `\n\nYour ask to the user is decision ${memory.id}: "${words}".${last}\n`
    + `FOR_USER_ASK_ID: needs-you only: ${memory.id} while you ask the user that same decision, in whatever words (Walnut keeps it as one ask, and tells no one it changed); "new" when you now ask the user a different decision. Otherwise none.\n`
    + 'FOR_USER_ASK_NEW: needs-you with the same decision only: what is really new about it since you last asked, in one line: a new fact, a new option or a new deadline. Other words, added detail or a time estimate are not new. Otherwise none.';
}

/**
 * A report as a writer hands it in, its `ask_id` and `ask_new` being what the session (or the
 * task_report_set caller) said, resolved against the report before it into the stored decision.
 * Every writer of task.status_report runs this (status-question.ts, report-set.ts).
 */
export function stampSaidDecision(report: StatusReport, prev: StatusReport | null | undefined, opts: { mint?: () => string; nowMs?: number } = {}): StatusReport {
  return stampAskDecision(report, prev, readDeclared(report.ask_id, report.ask_new), opts);
}
