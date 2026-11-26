/**
 * How old the user's words in a correction are, and whether what they asked was done since.
 *
 * 2026-11-26 (Walnut VP): corrections replayed his words of days before without their date, and the
 * session took them as a new ask. One lead's correction carried his 11-23 01:16 words about a page
 * header, and another lead got one about "why is go-live slow" of 11-23 03:11; both asks were done
 * and answered days before. So every correction says when he said what it quotes, and one about a
 * moment older than STALE_MOMENT_MS is first checked against what happened since (the thread's
 * state, its later answers and messages, the tasks it went to, the session's later turns): one
 * already done or answered is not sent.
 */
import type { Task } from '../../types.js';
import type { CallModel } from './judge.js';
import { quoteHolds } from './judge.js';
import type { Candidate, ReflectionThread } from './candidates.js';
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

/** When he wrote the words a quote is from: the message of his that holds it, else the moment's end. Pure. */
export function quoteTimeOf(c: Pick<Candidate, 'messages' | 'to'>, quote: string): string {
  if (quote) for (let i = c.messages.length - 1; i >= 0; i--) if (quoteHolds(quote, c.messages[i].text)) return c.messages[i].at;
  return c.to;
}

/** His words as a correction quotes them: with when he wrote them (and how long ago, for one sent now). Pure. */
export function userSaidLine(quote: string, at: string, nowMs?: number): string {
  return `The user said this at ${utcMinute(at)}${nowMs === undefined ? '' : ` (${ageWords(at, nowMs)})`}: "${quote}"`;
}

/** The line a correction about an old moment carries: what it is about is not new. Pure. */
export function oldMomentLine(at: string, nowMs: number): string {
  return `This is about his words of ${utcMinute(at)} (${ageWords(at, nowMs)}), not a new ask: if it was done or answered since, it needs nothing more.`;
}

/** What one of the thread's tasks shows now: its phase and its latest summary. */
export type TaskOutcome = (taskId: string) => Promise<Pick<Task, 'id' | 'title' | 'phase' | 'summary'> | null>;

export interface HandledDeps {
  readThreads: (taskId: string) => Promise<ReflectionThread[]>;
  readTranscript: ReadTranscript;
  callModel: CallModel;
  taskOutcome?: TaskOutcome;
}

export const TAKEN_UP_SYSTEM = [
  'An automated reviewer wrote corrections for an AI agent session about what the user said, and is about to send them. LATER is what happened since the user said it: the session\'s answers, the user\'s own later messages, the state of the thread, and the tasks the work was handed to.',
  'Name the corrections LATER shows were already taken up in full: the session (or the task it handed the work to) did the right way or answered what was missing, or the user settled it himself (picked, answered, closed, moved on). A correction LATER does not touch is still needed.',
  'Answer only JSON: {"done": [the numbers of the corrections already taken up]}',
].join('\n');

/** One call: the 1-based numbers of the corrections LATER shows were taken up, or null when it cannot tell. */
export async function takenUp(corrections: readonly string[], later: readonly TurnText[], callModel: CallModel, nodeId: string): Promise<number[] | null> {
  if (!corrections.length || !later.length) return null;
  let raw = '';
  try {
    raw = await callModel(TAKEN_UP_SYSTEM, ['CORRECTIONS:', ...corrections.map((t, i) => `${i + 1}. ${t}`), '', 'LATER:', renderTurns(later)].join('\n'), nodeId);
  } catch { return null; }
  try {
    const a = JSON.parse(raw.slice(raw.indexOf('{'), raw.lastIndexOf('}') + 1)) as { done?: unknown };
    return Array.isArray(a.done) ? a.done.filter((n): n is number => Number.isInteger(n)) : null;
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

/**
 * Whether a correction about an old moment was taken up since: 'handled' (the thread is closed, or
 * LATER shows it done), 'open', or 'unknown' (the check could not tell: it goes, marked as old).
 * A moment younger than STALE_MOMENT_MS is 'open' with no call.
 */
export async function handledSince(c: Candidate, correction: string, nowMs: number, deps: HandledDeps, nodeId: string): Promise<'handled' | 'open' | 'unknown'> {
  // Only his words can be done since: an ask he has not answered, or an answer's language, is about now.
  if (!c.messages.length || c.signal === 'wrong_language' || nowMs - Date.parse(c.to) < STALE_MOMENT_MS) return 'open';
  let later: TurnText[] = [];
  if (c.thread) {
    const th = (await deps.readThreads(c.task.id).catch(() => [])).find((t) => t.id === c.thread!.id);
    if (!th) return 'unknown';
    if (th.closed) return 'handled';
    const msgs = [...th.messages].sort((a, b) => a.at.localeCompare(b.at));
    const lastId = c.messages[c.messages.length - 1]?.id;
    const byId = lastId ? msgs.findIndex((m) => m.id === lastId) : -1;
    const idx = byId >= 0 ? byId : msgs.filter((m) => m.at <= c.to).length - 1;
    later = await threadSince(th, idx, deps);
  } else if (c.sessionId) {
    later = await turnsSince(c.sessionId, c.to, deps.readTranscript, 4).catch(() => []);
  }
  if (!later.length) return 'open';
  const done = await takenUp([correction], later, deps.callModel, nodeId);
  return done === null ? 'unknown' : done.includes(1) ? 'handled' : 'open';
}
