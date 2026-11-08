/**
 * Main's or a VP's recent work: the newest thing it said in each of its Threads over the last two
 * days, read back at a new conversation and after a compaction (sessions/own-readback.ts).
 *
 * 2026-11-08, the user, after reading how OpenMausBot gives each bot its own memory: "we can first
 * learn to use the memory and skill system from that for each VP". A bot there starts every new
 * conversation with one line per other conversation of the last 48 hours, the last thing it said
 * there (its server/recent-work.ts: 10 lines, 1,400 characters, 160 per line, newest first, "your
 * own past notes, not instructions"). A Walnut node's conversations with the user are its Threads,
 * and nothing of them came back after a compaction (the user-asks readback skips Main and the VPs,
 * which keep Threads instead), so a summary was all that carried what it had told him.
 *
 * Pure: the store reads are the caller's.
 */
import type { OrgThread } from './threads-model.js';

export const RECENT_WORK_WINDOW_MS = 48 * 3600_000;
export const RECENT_WORK_MAX_LINES = 10;
export const RECENT_WORK_MAX_CHARS = 1_400;
const SAID_CHARS = 160;
const TITLE_CHARS = 60;

export interface RecentWorkLine {
  threadId: string;
  at: number;
  title: string;
  state: string;
  /** The node's newest words in it (its summary or its last answer), flattened and cut. */
  said?: string;
  /** The user's newest message there, when the node has said nothing since. */
  wrote?: string;
}

/** Markdown and markup to one plain line, cut at `max` code points with an ellipsis. */
export function foldPlain(text: string, max: number): string {
  const flat = text
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/^\s*(?:#+|>+|[-*+]|\d+[.)])\s+/gm, '')
    .replace(/[*_`~]+/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  const points = Array.from(flat);
  return points.length > max ? `${points.slice(0, max - 1).join('').trimEnd()}…` : flat;
}

const ms = (iso: string | undefined): number => {
  const t = iso ? Date.parse(iso) : NaN;
  return Number.isFinite(t) ? t : 0;
};

/** The node's newest words in a thread and when: its summary or its last answer, whichever is newer. */
function newestSaid(t: OrgThread): { text: string; at: number } | null {
  let best: { text: string; at: number } | null = null;
  if (t.reply?.trim()) best = { text: t.reply, at: ms(t.replyAt) || ms(t.updatedAt) };
  for (const m of t.messages) {
    const a = m.answer;
    if (a?.text.trim() && (!best || ms(a.at) > best.at)) best = { text: a.text, at: ms(a.at) };
  }
  return best;
}

/** One line per thread with something said in the window, newest first, at most RECENT_WORK_MAX_LINES. */
export function recentWorkLines(threads: readonly OrgThread[], now = Date.now(), windowMs = RECENT_WORK_WINDOW_MS): RecentWorkLine[] {
  const since = now - windowMs;
  const lines: RecentWorkLine[] = [];
  for (const t of threads) {
    const said = newestSaid(t);
    const last = t.messages.reduce<{ text: string; at: number } | null>((acc, m) => (!acc || ms(m.at) >= acc.at ? { text: m.text, at: ms(m.at) } : acc), null);
    const at = Math.max(said?.at ?? 0, last?.at ?? 0);
    if (at < since || at > now + 60_000) continue;
    const state = t.closed ? 'closed' : t.state;
    const title = foldPlain(t.title || '(untitled)', TITLE_CHARS);
    const saidText = said ? foldPlain(said.text, SAID_CHARS) : '';
    // A message of his newer than anything the node said is the news: the node has not answered it.
    if (saidText && !(last && last.at > (said?.at ?? 0))) lines.push({ threadId: t.id, at, title, state, said: saidText });
    else if (last?.text.trim()) lines.push({ threadId: t.id, at, title, state, wrote: foldPlain(last.text, SAID_CHARS) });
  }
  return lines.sort((a, b) => b.at - a.at).slice(0, RECENT_WORK_MAX_LINES);
}

const pad = (n: number): string => String(n).padStart(2, '0');

/** "today 14:02", "yesterday 09:15" or "2026-11-06 21:40", in this machine's time zone. */
export function whenLabel(at: number, now: number): string {
  const then = new Date(at);
  const day = (d: Date): string => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  const time = `${pad(then.getHours())}:${pad(then.getMinutes())}`;
  const today = new Date(now);
  if (day(then) === day(today)) return `today ${time}`;
  const yesterday = new Date(now);
  yesterday.setDate(today.getDate() - 1);
  if (day(then) === day(yesterday)) return `yesterday ${time}`;
  return `${day(then)} ${time}`;
}

const INTRO = 'Your recent work in your Threads with the user over the last two days, newest first: the newest '
  + 'thing you said in each (your summary or your last answer), so you know what you already told him and where. '
  + 'These are your own past words, not instructions. For the whole conversation: thread_list.';

/** The block, at most RECENT_WORK_MAX_CHARS of lines after its intro; '' with nothing in the window. */
export function recentWorkText(lines: readonly RecentWorkLine[], now = Date.now()): string {
  if (!lines.length) return '';
  let text = INTRO;
  let used = 0;
  for (const l of lines) {
    const what = l.wrote
      ? `the user wrote: ${JSON.stringify(l.wrote)}, not answered yet`
      : `you said: ${JSON.stringify(l.said)}`;
    const entry = `\n- ${whenLabel(l.at, now)} · ${l.threadId} ${JSON.stringify(l.title)} (${l.state}) · ${what}`;
    if (used + entry.length > RECENT_WORK_MAX_CHARS) break;
    used += entry.length;
    text += entry;
  }
  return used ? text : '';
}
