/**
 * How old the user's words in a correction are, and whether what they asked was done since.
 *
 * 2026-11-26 (Walnut VP): corrections replayed his words of days before without their date, and the
 * session took them as a new ask. One lead's correction carried his 11-23 01:16 words about a page
 * header, and another lead got one about "why is go-live slow" of 11-23 03:11; both asks were done
 * and answered days before. So every correction says when he said what it quotes, and one about a
 * moment older than STALE_MOMENT_MS is first checked against what happened since (the thread's
 * state, its later answers and messages, the tasks it went to, the session's later turns): one
 * already done or answered is not sent. A correction of an ask is checked against the card as he
 * reads it now, and the letters it names (2026-11-26 audit: most wrong "not done" findings said a card
 * lacked what it had): a card that waits on him no more, or that has it now, gets none.
 */
import type { Task } from '../../types.js';
import type { CallModel } from './judge.js';
import { PRODUCT_DEFECT_KINDS, quoteHolds, type FindingKind } from './judge.js';
import { statusAskText, threadCardText, type Candidate, type ReflectionThread } from './candidates.js';
import { clip, renderTurns, threadLater, turnsSince, type ReadTranscript, type TurnText } from './context.js';

/** A correction about words older than this is checked against what happened since before it goes. */
export const STALE_MOMENT_MS = 2 * 3600_000;
const LATER_ANSWERS = 6;
const LATER_MESSAGES = 6;
const OUTCOME_TEXT_MAX = 600;

/** "2026-11-23 01:16 UTC". Pure. */
export const utcMinute = (iso: string): string => `${iso.slice(0, 16).replace('T', ' ')} UTC`;

/** "3 hours ago", "2 days ago". Pure. */
export function ageWords(iso: string, nowMs: number): string {
  const h = Math.max(0, Math.round((nowMs - Date.parse(iso)) / 3600_000));
  if (h < 1) return 'less than an hour ago';
  if (h < 48) return `${h} hour${h === 1 ? '' : 's'} ago`;
  return `${Math.round(h / 24)} days ago`;
}

/** Words of his the judge read, with when he wrote them: the moment's messages, its context turns, its evidence. */
export type SaidSource = { at: string; text: string };

/**
 * When he wrote the words a quote is from: the moment's message that holds it, else the context or evidence
 * message that does (a thread's earlier messages have no time limit), else '' (not on record). Pure.
 */
export function quoteTimeOf(c: Pick<Candidate, 'messages'>, quote: string, sources: readonly SaidSource[] = []): string {
  if (!quote) return '';
  for (const list of [c.messages, sources]) {
    const hit = [...list].sort((a, b) => b.at.localeCompare(a.at)).find((m) => m.at && quoteHolds(quote, m.text));
    if (hit) return hit.at;
  }
  return '';
}

/** His words as a correction quotes them: with when he wrote them (and how long ago, for one sent now). Pure. */
export function datedQuoteLine(quote: string, at: string, nowMs?: number): string {
  if (!at) return `The user said (when is not on record, so not necessarily now): "${quote}"`;
  return `The user said this at ${utcMinute(at)}${nowMs === undefined ? '' : ` (${ageWords(at, nowMs)})`}: "${quote}"`;
}

/** The line a correction about an old moment carries: what it is about is not new. Pure. */
export function oldMomentLine(at: string, nowMs: number): string {
  return `This is about his words of ${utcMinute(at)} (${ageWords(at, nowMs)}), not a new ask: if it was done or answered since, it needs nothing more.`;
}

/** What one of the thread's tasks shows now: its phase and its latest summary. */
export type TaskOutcome = (taskId: string) => Promise<Pick<Task, 'id' | 'title' | 'phase' | 'summary'> | null>;

/** A task's ask in Needs you now (its user_status), for the card check. */
export type AskNow = (taskId: string) => Promise<Task['user_status'] | null>;
/** A letter he reads (lt-...), as text: its subject, body and buttons; null when it cannot be read. */
export type LetterText = (id: string) => Promise<string | null>;

export interface HandledDeps {
  readThreads: (taskId: string) => Promise<ReflectionThread[]>;
  /** His messages to a task (user-asks.ts): what he said since, for a moment outside a thread. */
  readMessages?: (taskId: string) => Promise<Array<{ id: string; at: string; text: string }>>;
  readTranscript: ReadTranscript;
  callModel: CallModel;
  taskOutcome?: TaskOutcome;
  askNow?: AskNow;
  letterText?: LetterText;
}

export const TAKEN_UP_SYSTEM = [
  'An automated reviewer wrote corrections for an AI agent session about what the user said, and is about to send them. LATER is what happened since the user said it: the session\'s answers, the user\'s own later messages, the state of the thread, and the tasks the work was handed to.',
  'Name the corrections LATER shows were already taken up in full: the session (or the task it handed the work to) did the right way or answered what was missing, the card or letter he reads now already has what the correction says it lacks, or the user settled it himself (picked, answered or closed that very matter). A correction LATER does not touch, or touches only in part, is still needed.',
  'For each one taken up, copy the words of LATER that show it, exactly: they are checked word for word, and one without them counts as still needed.',
  'Answer only JSON: {"done": [{"n": the correction\'s number, "quote": "the words of LATER that show it"}]}',
].join('\n');

/**
 * One call: the 1-based numbers of the corrections LATER shows were taken up, each with the words of LATER
 * that show it, checked word for word (one without them is still needed); null when it cannot tell.
 */
export async function takenUp(corrections: readonly string[], later: readonly TurnText[], callModel: CallModel, nodeId: string): Promise<number[] | null> {
  if (!corrections.length || !later.length) return null;
  const laterText = renderTurns(later);
  let raw = '';
  try {
    raw = await callModel(TAKEN_UP_SYSTEM, ['CORRECTIONS:', ...corrections.map((t, i) => `${i + 1}. ${t}`), '', 'LATER:', laterText].join('\n'), nodeId);
  } catch { return null; }
  try {
    const a = JSON.parse(raw.slice(raw.indexOf('{'), raw.lastIndexOf('}') + 1)) as { done?: unknown };
    if (!Array.isArray(a.done)) return null;
    return a.done.flatMap((d) => {
      const n = (d as { n?: unknown })?.n;
      const quote = String((d as { quote?: unknown })?.quote ?? '').trim();
      return Number.isInteger(n) && quote.length >= 8 && quoteHolds(quote, laterText) ? [n as number] : [];
    });
  } catch { return null; }
}

/** What happened in a thread after his message at `idx`: his later messages, its answers, its card now and its tasks. */
async function threadSince(th: ReflectionThread, idx: number, deps: Pick<HandledDeps, 'taskOutcome'>): Promise<TurnText[]> {
  const msgs = [...th.messages].sort((a, b) => a.at.localeCompare(b.at));
  const his = msgs.slice(idx + 1).slice(-LATER_MESSAGES).map((m) => ({ role: 'user' as const, at: m.at, text: clip(m.text, 400) }));
  const answers = threadLater(msgs, idx, LATER_ANSWERS);
  const card: TurnText[] = th.reply ? [{ role: 'agent', at: th.replyAt ?? th.updatedAt ?? msgs[msgs.length - 1]?.at ?? '', text: `The thread's card now (state ${th.state ?? 'unknown'}): ${clip(th.reply, OUTCOME_TEXT_MAX)}` }] : [];
  const outcomes: TurnText[] = [];
  for (const id of (th.tasks ?? []).slice(-4)) {
    const t = await deps.taskOutcome?.(id).catch(() => null);
    if (t) outcomes.push({ role: 'agent', at: 'now', text: `The task "${t.title}" (${t.id}) the thread went to is ${t.phase}${t.summary ? `: ${clip(t.summary, OUTCOME_TEXT_MAX)}` : ''}` });
  }
  return [...[...his, ...answers].sort((a, b) => a.at.localeCompare(b.at)), ...card, ...outcomes];
}

const LETTER_RE = /\blt-[a-z0-9]+-[a-z0-9]+\b/g;
const LETTERS_MAX = 2;

/**
 * The card he reads now for an ask's correction, and the letters it points to: null when the card waits
 * on him no more (answered, closed, moved off Needs you). 2026-11-26 audit: 6 of 7 wrong "not done"
 * findings said a card lacked buttons, a link or a draft that the card, or the letter it named, had.
 */
async function cardNow(c: Candidate, deps: HandledDeps): Promise<TurnText[] | null | 'unknown'> {
  let text: string | null;
  if (c.thread) {
    const th = (await deps.readThreads(c.task.id).catch(() => [])).find((t) => t.id === c.thread!.id);
    if (!th) return 'unknown';
    text = threadCardText(th);
  } else {
    if (!deps.askNow) return 'unknown';
    const r = await deps.askNow(c.task.id).catch(() => undefined);
    if (r === undefined) return 'unknown';
    text = statusAskText(r ?? undefined);
  }
  if (text === null) return null;
  const out: TurnText[] = [{ role: 'agent', at: 'now', text: `The card as he reads it now:\n${clip(text, 3000)}` }];
  for (const id of [...new Set(text.match(LETTER_RE) ?? [])].slice(0, LETTERS_MAX)) {
    const l = await deps.letterText?.(id).catch(() => null);
    if (l) out.push({ role: 'agent', at: 'now', text: `The letter ${id} the card names:\n${clip(l, 2500)}` });
  }
  return out;
}

/**
 * Whether a correction about an old moment was taken up since: 'handled' (the thread is closed, or
 * LATER shows it done), 'open', or 'unknown' (the check could not tell: it goes, marked as old).
 * A moment younger than STALE_MOMENT_MS is 'open' with no call.
 */
export async function handledSince(
  c: Candidate, f: { correction: string; kind: FindingKind }, momentAt: string, nowMs: number, deps: HandledDeps, nodeId: string,
): Promise<'handled' | 'open' | 'unknown'> {
  const correction = f.correction;
  // An ask's correction is checked against the card as he reads it now, whatever its age.
  if (c.signal === 'needs_ask') {
    const now = await cardNow(c, deps);
    if (now === 'unknown') return 'unknown';
    if (now === null) return 'handled';
    const done = await takenUp([correction], now, deps.callModel, nodeId);
    return done === null ? 'unknown' : done.includes(1) ? 'handled' : 'open';
  }
  // Only his words can be done since: an answer's language is about now.
  if (!c.messages.length || c.signal === 'wrong_language' || nowMs - Date.parse(momentAt) < STALE_MOMENT_MS) return 'open';
  // A defect of the product is not settled by a closed thread: he often says it once the work is done.
  const defect = PRODUCT_DEFECT_KINDS.has(f.kind);
  let later: TurnText[] = [];
  if (c.thread) {
    const th = (await deps.readThreads(c.task.id).catch(() => [])).find((t) => t.id === c.thread!.id);
    if (!th) return 'unknown';
    if (th.closed && !defect) return 'handled';
    const msgs = [...th.messages].sort((a, b) => a.at.localeCompare(b.at));
    const lastId = c.messages[c.messages.length - 1]?.id;
    const byId = lastId ? msgs.findIndex((m) => m.id === lastId) : -1;
    const idx = byId >= 0 ? byId : msgs.filter((m) => m.at <= c.to).length - 1;
    later = await threadSince(th, idx, deps);
  } else {
    // His own later words in the task (the judge read none after the moment), and the session's later turns.
    const his = (await deps.readMessages?.(c.task.id).catch(() => []) ?? []).filter((m) => m.at > c.to).slice(-LATER_MESSAGES)
      .map((m) => ({ role: 'user' as const, at: m.at, text: clip(m.text, 400) }));
    const turns = c.sessionId ? await turnsSince(c.sessionId, c.to, deps.readTranscript, 4).catch(() => []) : [];
    later = [...his, ...turns].sort((a, b) => a.at.localeCompare(b.at));
  }
  if (!later.length) return 'open';
  const done = await takenUp([correction], later, deps.callModel, nodeId);
  return done === null ? 'unknown' : done.includes(1) ? 'handled' : 'open';
}
