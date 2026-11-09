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
import { askKey, askShape, sameAskReworded, sameDirections, SAME_ASK_MIN_WORDS } from './same-ask.js';
import { normalizeText } from './human-inbox/duplicate-letter.js';
import type { AskKind, StatusReport, UserStatus } from './user-status.js';

/** How a decision id looks: `ask-` and a few base-36 characters. */
export const ASK_ID_RE = /\bask-[a-z0-9]{4,12}\b/i;

/** A decision a task stopped asking (a re-check turn that ran, a wait) is the same one when it asks
 *  it again within this long. */
export const ASK_MEMORY_MS = 7 * 24 * 60 * 60_000;

/** Under this share of shared content words, an ask the session did not say was the same is a new
 *  decision: the rewordings of 2026-11-08 shared 38% to 100%. */
const DISJOINT_SHARE = 0.15;

/** The decision a report carries, as the next report reads it back. */
export interface AskMemory {
  id: string;
  rev?: number;
  ask: string;
  /** The last thing the session named as new about it (FOR_USER_ASK_NEW). */
  new?: string;
  at: string;
  /** How the user answers it and the options it offered: other options are news. */
  kind?: AskKind;
  options?: string[];
  /** The key of its words when an older Walnut asked it with no id (a watch armed then keeps it). */
  legacy?: string;
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

/** The facts of an ask beside its words: its revision (a new fact named, other options: counted at
 *  stamping, stampAskDecision), its deadline, its links. */
export function askFactsOf(
  r: Pick<StatusReport, 'ask' | 'ask_more' | 'ask_rev'>, dueDate?: string | null,
): string {
  return [`r${r.ask_rev ?? 0}`, `d${(dueDate ?? '').trim().slice(0, 10)}`, askEvidence(`${r.ask ?? ''} ${r.ask_more ?? ''}`).join(' ')].join('|');
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
    return {
      id: r.ask_id, ...(r.ask_rev ? { rev: r.ask_rev } : {}), ask: r.ask, ...(r.ask_new ? { new: r.ask_new } : {}), at: r.at,
      ...(r.ask_kind ? { kind: r.ask_kind } : {}), ...(r.ask_options?.length ? { options: r.ask_options.map((o) => o.label) } : {}),
      ...(r.ask_legacy_key ? { legacy: r.ask_legacy_key } : {}),
    };
  }
  return r.last_ask ?? null;
}

const CJK_WORD = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u;

/**
 * Whether `b` asks the user what `a` asks, in other words: added detail, clauses moved, a question
 * tacked on. Not when it turned around (a "not" one has and the other lacks), points elsewhere
 * ("from staging" against "from production"), names other numbers ("$20" against "$200"), shares
 * almost no word, or swaps a word or two for others and changes nothing else ("the staging
 * database" against "the production database": swapsTarget). Pure.
 */
export function sameDecisionWords(a: string | undefined | null, b: string | undefined | null): boolean {
  if (askKey(a) === askKey(b)) return true;
  const sa = askShape(a);
  const sb = askShape(b);
  if (sa.neg !== sb.neg) return false;
  if (sa.words.length < SAME_ASK_MIN_WORDS || sb.words.length < SAME_ASK_MIN_WORDS) return sameAskReworded(a, b);
  const nums = (w: readonly string[]) => w.filter((x) => x.startsWith('#'));
  const na = nums(sa.words);
  const nb = nums(sb.words);
  // A number replaced by another; one only added (a time estimate) or only dropped is detail.
  if (na.some((n) => !nb.includes(n)) && nb.some((n) => !na.includes(n))) return false;
  if (sa.links && sb.links && !sameDirections(sa.links, sb.links)) return false;
  const inB = new Set(sb.words);
  const shared = sa.words.filter((w) => inB.has(w)).length;
  if (shared / Math.min(sa.words.length, sb.words.length) < DISJOINT_SHARE) return false;
  return !swapsTarget(a ?? '', b ?? '');
}

/**
 * Whether `b` is `a` with a word or two in the middle swapped for others, and the rest as it was
 * ("Delete the staging database?" and "Delete the production database?"): another target. A word
 * only added or only dropped is not (a time estimate, "this"). Read on the text itself, so CJK and
 * Latin alike.
 */
function swapsTarget(a: string, b: string): boolean {
  // Punctuation aside: a comma added beside an inserted word is no swap.
  const plain = (t: string) => [...normalizeText(t).replace(/\p{P}+/gu, ' ').replace(/\s+/g, ' ').trim()];
  const x = plain(a);
  const y = plain(b);
  let p = 0;
  while (p < x.length && p < y.length && x[p] === y[p]) p++;
  let q = 0;
  while (q < x.length - p && q < y.length - p && x[x.length - 1 - q] === y[y.length - 1 - q]) q++;
  // Whole Latin words: a common prefix may end inside a word ("the s|taging", "the s|ample").
  const widen = (t: string[], from: number, to: number) => {
    let i = from;
    let j = to;
    while (i > 0 && /[\p{L}\p{N}]/u.test(t[i - 1]!) && !CJK_WORD.test(t[i - 1]!)) i--;
    while (j < t.length && /[\p{L}\p{N}]/u.test(t[j]!) && !CJK_WORD.test(t[j]!)) j++;
    return t.slice(i, j).join('').trim();
  };
  const ma = widen(x, p, x.length - q);
  const mb = widen(y, p, y.length - q);
  // Only added or only dropped (one middle holds the other) is detail, not another target.
  if (!ma || !mb || ma.includes(mb) || mb.includes(ma)) return false;
  const short = (m: string) => m.split(/\s+/).filter(Boolean).length <= 2 && [...m].filter((c) => CJK_WORD.test(c)).length <= 4 && m.length <= 24;
  return short(ma) && short(mb) && p + q >= Math.min(x.length, y.length) / 2;
}

/** How the user answers: a choice (single or multi) with its options, or freely (yes or no, text). */
function choiceOf(kind: AskKind | undefined, options: readonly string[] | undefined): { kind: 'free' | 'single' | 'multi'; options: string[] } {
  return kind === 'single' || kind === 'multi' ? { kind, options: [...(options ?? [])] } : { kind: 'free', options: [] };
}

/** Two option labels name one option: the words of one all in the other ("Standard" and "the
 *  Standard plan"), or the same in other words. */
function sameLabel(a: string, b: string): boolean {
  const wa = askShape(a).words;
  const wb = askShape(b).words;
  const within = (x: readonly string[], y: readonly string[]) => x.length > 0 && x.every((w) => y.includes(w));
  const nums = (w: readonly string[]) => w.filter((v) => v.startsWith('#')).sort().join(' ');
  if (nums(wa) === nums(wb) && (within(wa, wb) || within(wb, wa))) return true;
  return sameDecisionWords(a, b);
}

/** The options the user picks from now differ from those of before: another way to answer, or
 *  another option (its words compared by sameDecisionWords, so a label reworded is the same one). */
export function optionsChanged(was: Pick<AskMemory, 'kind' | 'options'>, now: Pick<StatusReport, 'ask_kind' | 'ask_options'>): boolean {
  const a = choiceOf(was.kind, was.options);
  const b = choiceOf(now.ask_kind, now.ask_options?.map((o) => o.label));
  if (a.kind !== b.kind) return true;
  if (a.options.length !== b.options.length) return true;
  const used = new Set<number>();
  return !b.options.every((label) => {
    const i = a.options.findIndex((x, j) => !used.has(j) && sameLabel(x, label));
    if (i < 0) return false;
    used.add(i);
    return true;
  });
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
  const { ask_id: _id, ask_rev: _rev, ask_new: _new, last_ask: _last, ask_legacy_key: _legacy, ...rest } = report;
  const mint = opts.mint ?? mintAskId;
  // An ask an older Walnut stored with no id is the decision it was: it gets one now, the key of its
  // words kept so a watch armed on them still counts.
  const legacy = prev?.state === 'needs' && prev.ask && !prev.ask_id;
  const memory: AskMemory | null = legacy
    ? { id: mint(), ask: prev!.ask!, at: prev!.at, ...(prev!.ask_kind ? { kind: prev!.ask_kind } : {}), ...(prev!.ask_options?.length ? { options: prev!.ask_options.map((o) => o.label) } : {}), legacy: askKey(prev!.ask) }
    : memoryOf(prev);
  const nowMs = opts.nowMs ?? Date.parse(report.at);
  const recent = !!memory && (prev?.state === 'needs' || nowMs - Date.parse(memory.at) <= ASK_MEMORY_MS);
  if (report.state !== 'needs' || !report.ask) {
    return recent ? { ...rest, last_ask: memory! } : rest;
  }
  const asked = prev?.state === 'needs' && !!prev.ask;
  let keep = false;
  if (memory && recent && !declared.isNew) {
    if (declared.id && declared.id.toLowerCase() === memory.id.toLowerCase()) keep = true;
    // Said nothing: the same decision while it kept asking when the words still ask it (sameDecisionWords:
    // never another target, sign, direction or number); after a break only word for word in other words.
    else if (asked) keep = sameDecisionWords(memory.ask, report.ask);
    else keep = sameAskReworded(memory.ask, report.ask);
  }
  if (!keep) return { ...rest, ask_id: mint() };
  // Other options, or another way to answer, are news without a word from the session.
  const options = optionsChanged(memory!, report)
    ? `new options: ${(report.ask_options ?? []).map((o) => o.label).join(' | ') || 'none, answered freely'}`.slice(0, 240) : undefined;
  const fact = declared.newFact?.replace(/\s+/g, ' ').trim() || options;
  // A new fact named again in other words is the same fact: one revision.
  const fresh = !!options || (!!fact && !(memory!.new && (memory!.new === fact || sameAskReworded(memory!.new, fact))));
  const rev = (memory!.rev ?? 0) + (fresh ? 1 : 0);
  return {
    ...rest, ask_id: memory!.id, ...(rev ? { ask_rev: rev } : {}),
    ...(fresh ? { ask_new: fact } : memory!.new ? { ask_new: memory!.new } : {}),
    ...(memory!.legacy ? { ask_legacy_key: memory!.legacy } : {}),
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
