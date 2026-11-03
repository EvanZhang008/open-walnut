/**
 * An Ask here question the session has not answered inside its tag is named before the turn
 * closes, through the same Stop hook as an unanswered request (src/providers/stop-unanswered-hook.ts).
 *
 * 2026-11-03, the user: "we must make it strict ... the thread-id and thread name in a html tag
 * format, in the first send ... otherwise we keep getting this no answered". A question's send
 * names it `<walnut-ask thread="6" name="...">` and asks for the answer inside
 * `<walnut-ask-answer thread="6">` (hints/hint-registry.ts askHintText); the web files a
 * question's answer from that tag alone (web/src/utils/ask-answer.ts). A question taken while a
 * turn ran, then a compaction, lost the instruction, and the model answered outside any tag:
 * the card read "No answer". The Stop hook makes the CLI go on in the same turn with the
 * question and the rule restated, so the answer is filed after all.
 *
 * Which questions count is read from the transcript itself, by the hook on the session's own
 * host (the transcript is the record; Walnut keeps no bookkeeping of its own over it): `asked`
 * are the thread ids a user line carries a `<walnut-ask thread=` for, `answered` those an
 * assistant line carries a `<walnut-ask-answer thread=` for. The server adds what only it has:
 * which of them Walnut sent recently (`SessionRecord.asksSent`), their names and words. A hook
 * from before this (no lists) names none. Named at most MAX_ASK_NUDGES turns each; never throws.
 */
import type { SessionAskSent, SessionRecord } from '../types.js';
import { ASK_THREAD_RE } from './ask-thread.js';

/** Turns one question is named in before Walnut stops naming it. */
export const MAX_ASK_NUDGES = 2;
/** A question sent longer ago than this is not named any more. */
export const ASK_NAG_WINDOW_MS = 24 * 3600_000;
/** Questions kept on the record: enough that a long conversation's follow-up still finds the
 *  name its thread was first sent with (an evicted one would be asked by another name). */
export const ASKS_SENT_MAX = 120;
/** Nudge counts kept in memory. */
const NUDGED_MAX = 2000;
const PREVIEW_CHARS = 200;

const nudged = new Map<string, number>();

/** For tests. */
export function resetAskNudges(): void { nudged.clear(); }

/** The record's list with one more question sent (the same number replaces its older entry). Pure. */
export function withAskSent(list: readonly SessionAskSent[] | undefined, ask: { thread: string; name: string; words: string; at: number }): SessionAskSent[] {
  const preview = ask.words.replace(/\s+/g, ' ').trim().slice(0, PREVIEW_CHARS);
  const prev = (list ?? []).find((a) => a.thread === ask.thread);
  const next = (list ?? []).filter((a) => a.thread !== ask.thread);
  // A follow-up keeps the name the first send gave the thread: the answer must repeat it.
  next.push({ thread: ask.thread, name: prev?.name ?? ask.name, preview, at: new Date(ask.at).toISOString() });
  return next.slice(-ASKS_SENT_MAX);
}

/** `"1,4,6.1"` (the hook's list) as thread ids; anything else is no list. */
export function parseThreadList(raw: unknown): Set<string> | null {
  if (typeof raw !== 'string') return null;
  const out = new Set<string>();
  for (const part of raw.split(',')) {
    const id = part.trim();
    if (ASK_THREAD_RE.test(id)) out.add(id);
  }
  return out;
}

/** The questions to name: sent recently, reached the session, no answer in a tag. Pure. */
export function asksToName(
  sent: readonly SessionAskSent[] | undefined,
  asked: ReadonlySet<string>,
  answered: ReadonlySet<string>,
  now: number,
): SessionAskSent[] {
  return (sent ?? []).filter((a) => asked.has(a.thread) && !answered.has(a.thread)
    && now - Date.parse(a.at) < ASK_NAG_WINDOW_MS);
}

const attrs = (a: SessionAskSent) => `thread="${a.thread}"${a.name ? ` name="${a.name}"` : ''}`;

/** The words the session reads before its turn closes. Pure. */
export function askStopReason(open: readonly SessionAskSent[], now = Date.now()): string {
  const ago = (iso: string) => {
    const mins = Math.max(1, Math.round((now - Date.parse(iso)) / 60_000));
    return mins < 90 ? `${mins} min ago` : `${Math.round(mins / 60)} h ago`;
  };
  const first = open[0];
  return [
    `Walnut: before this turn ends, ${open.length === 1 ? 'an Ask here question has' : `${open.length} Ask here questions have`} no answer filed yet. `
      + 'An answer is filed under its question only from inside its tag; text outside the tag stays in the main conversation:',
    ...open.map((a) => `- <walnut-ask ${attrs(a)}>, asked ${ago(a.at)}: "${a.preview}"`),
    `Answer ${open.length === 1 ? 'it' : 'each'} now inside <walnut-ask-answer ${first ? attrs(first) : 'thread="..." name="..."'}> and </walnut-ask-answer>`
      + (open.length === 1 ? '' : ' (each with its own thread id and name)')
      + ', each tag on a line of its own. If you already answered outside the tag, give that answer again inside it. '
      + 'If you cannot answer yet, say so in one line inside the tag.',
  ].join('\n');
}

/** The Stop hook's reason for `callerSid`'s questions, or null when none should hold the turn. */
export async function askUnansweredAtStop(
  callerSid: string | undefined,
  lists: { asked: unknown; answered: unknown },
  now = Date.now(),
): Promise<{ reason: string; asks: string[] } | null> {
  const sid = (callerSid ?? '').trim();
  const asked = parseThreadList(lists.asked);
  const answered = parseThreadList(lists.answered);
  if (!sid || !asked || !answered || asked.size === 0) return null;
  try {
    const { getSessionByClaudeId } = await import('../session-tracker.js');
    const record: SessionRecord | null | undefined = await getSessionByClaudeId(sid);
    // Counted per send: a follow-up in the thread (a new `at`) may be named again.
    const keyOf = (a: SessionAskSent) => `${sid}#${a.thread}#${a.at}`;
    const open = asksToName(record?.asksSent, asked, answered, now)
      .filter((a) => (nudged.get(keyOf(a)) ?? 0) < MAX_ASK_NUDGES);
    if (open.length === 0) return null;
    for (const a of open) {
      const k = keyOf(a);
      const count = (nudged.get(k) ?? 0) + 1;
      nudged.delete(k); // re-inserted last, so the trim below drops the oldest first
      nudged.set(k, count);
    }
    for (const k of nudged.keys()) { if (nudged.size <= NUDGED_MAX) break; nudged.delete(k); }
    return { reason: askStopReason(open, now), asks: open.map((a) => a.thread) };
  } catch {
    return null;
  }
}
