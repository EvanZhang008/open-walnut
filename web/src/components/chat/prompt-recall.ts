/**
 * ArrowUp in an empty session composer brings back the last message the person
 * sent in that session; ArrowUp again goes further back, ArrowDown comes
 * forward, and past the newest the box is empty again.
 *
 * Where the messages come from: the session's own timeline (SessionChatHistory
 * publishes the rows it holds) plus what this browser sent a moment ago and the
 * transcript does not show yet. Only words a person typed count: a delivery from
 * another task, a Walnut notice or a line the CLI wrote is not a prompt anyone
 * wants back (transcript-sent-by.ts decides, the same rule the phone uses).
 *
 * When it takes over: from an empty box (no text, no image), or while the box
 * still holds a recalled message untouched, with the caret on its first visual
 * line for ArrowUp or its last for ArrowDown. Anywhere else the arrows move the
 * caret as always; editing a recalled message makes it an ordinary draft.
 */
import { transcriptSentBy, personTextOf } from '@open-walnut/transcript-sent-by';
import { typedUserText } from '@open-walnut/history-injected-banner';

interface RecallRow { role: string; text: string; injected?: boolean; agentOrigin?: boolean }

/** The words a person typed in this row, or '' when it is not theirs. */
export function sentPromptOf(row: RecallRow): string {
  if (row.role !== 'user' || transcriptSentBy(row) !== 'person') return '';
  return (personTextOf(row.text) ?? typedUserText(row.text)).trim();
}

/** Prompts in the order they were sent, every send its own stop, except that
 *  the same prompt sent twice in a row is one ("continue, continue" is one stop;
 *  "continue, fix it, continue" is three), as a shell's history keeps them. */
export function promptsOfRows(rows: ReadonlyArray<RecallRow>): string[] {
  const out: string[] = [];
  for (const row of rows) {
    const p = sentPromptOf(row);
    if (p) out.push(p);
  }
  return withoutRepeats(out);
}

function withoutRepeats(prompts: readonly string[]): string[] {
  return prompts.filter((p, i) => i === 0 || prompts[i - 1] !== p);
}

/**
 * The history rows' prompts, then what this browser sent that the rows do not
 * show yet (a send reaches the transcript a few seconds later). A send counts as
 * shown once its text is among the rows' newest prompts; a mistaken match (the
 * same words sent again) leaves out one stop that recalls the same text.
 */
export function mergeRecentSends(fromRows: readonly string[], recent: readonly string[]): string[] {
  const pending = pendingSends(fromRows, recent);
  return pending.length ? withoutRepeats([...fromRows, ...pending]) : [...fromRows];
}

function pendingSends(fromRows: readonly string[], recent: readonly string[]): string[] {
  if (!recent.length) return [];
  const shown = new Set(fromRows.slice(Math.max(0, fromRows.length - recent.length - 10)));
  return recent.filter((p) => !shown.has(p));
}

// ── Sources, per session ────────────────────────────────────────────────────

type RowsSource = () => ReadonlyArray<RecallRow>;
/** Every mounted timeline of the session (a split shows it twice); the newest answers. */
const sources = new Map<string, RowsSource[]>();
const recentSends = new Map<string, Array<{ text: string; at: number }>>();
const memo = new Map<string, { rows: ReadonlyArray<RecallRow>; prompts: string[] }>();
/** Sends remembered per session until the transcript shows them, at most. */
const MAX_RECENT = 20;
/** A send the transcript never shows (it was rewritten, or the session moved) is forgotten after this. */
const RECENT_TTL_MS = 10 * 60_000;

/** A timeline publishes the rows it holds; returns the unregister. */
export function publishRecallRows(sessionId: string, source: RowsSource): () => void {
  sources.set(sessionId, [...(sources.get(sessionId) ?? []), source]);
  return () => {
    const left = (sources.get(sessionId) ?? []).filter((s) => s !== source);
    if (left.length) sources.set(sessionId, left); else sources.delete(sessionId);
  };
}

/** The composer's send was accepted (composed text, tags included). */
export function noteSentPrompt(sessionId: string, text: string, now = Date.now()): void {
  const t = text.trim();
  if (!t) return;
  const list = recentSends.get(sessionId) ?? [];
  list.push({ text: t, at: now });
  if (list.length > MAX_RECENT) list.splice(0, list.length - MAX_RECENT);
  recentSends.set(sessionId, list);
}

/** Every prompt the person sent in this session that this page knows of, oldest first. */
export function recallPrompts(sessionId: string, now = Date.now()): string[] {
  const rows = sources.get(sessionId)?.at(-1)?.() ?? [];
  let hit = memo.get(sessionId);
  if (hit?.rows !== rows) {
    hit = { rows, prompts: promptsOfRows(rows) };
    memo.set(sessionId, hit);
  }
  const fresh = (recentSends.get(sessionId) ?? []).filter((r) => now - r.at < RECENT_TTL_MS);
  if (!fresh.length) { recentSends.delete(sessionId); return hit.prompts; }
  const recent = fresh.map((r) => r.text);
  // Forget the sends the rows caught up with, so the list stays short.
  const pending = new Set(pendingSends(hit.prompts, recent));
  recentSends.set(sessionId, fresh.filter((r) => pending.has(r.text)));
  return mergeRecentSends(hit.prompts, recent);
}

/** Test seam. */
export function _resetPromptRecallForTests(): void {
  sources.clear();
  recentSends.clear();
  memo.clear();
}

// ── Stepping ────────────────────────────────────────────────────────────────

/** A recalled prompt on screen: which entry, its text in the list, and what the
 *  box was given for it (its references shown as tokens). `total`: how long the
 *  list was then. */
export interface RecallPos { index: number; entry: string; text: string; total?: number }

/**
 * One ArrowUp (-1) or ArrowDown (1). null = not a recall key press here, the
 * arrow does what it always does. `atEdge`: the caret is on the first visual
 * line (ArrowUp) or the last (ArrowDown) and nothing is selected; asked only
 * when it decides (it lays the text out).
 */
export function stepRecall(input: {
  dir: -1 | 1;
  entries: readonly string[];
  pos: RecallPos | null;
  /** What the box shows now. */
  current: string;
  /** No text and nothing attached. */
  empty: boolean;
  atEdge: () => boolean;
}): { index: number; entry: string } | { index: -1; entry: '' } | null {
  const { dir, entries } = input;
  const at = liveIndex(input.pos, input.current, entries);
  if (dir === -1) {
    if (at >= 0) {
      if (at === 0 || !input.atEdge()) return null;
      return { index: at - 1, entry: entries[at - 1]! };
    }
    if (!input.empty || !entries.length) return null;
    return { index: entries.length - 1, entry: entries[entries.length - 1]! };
  }
  if (at < 0 || !input.atEdge()) return null;
  if (at + 1 >= entries.length) return { index: -1, entry: '' };
  return { index: at + 1, entry: entries[at + 1]! };
}

/** Where the recalled prompt on screen sits in `entries` now, or -1 when the box
 *  no longer holds it untouched. The list can grow under it (older turns load,
 *  a send lands), so it is found again by its text. */
function liveIndex(pos: RecallPos | null, current: string, entries: readonly string[]): number {
  if (!pos || pos.text !== current) return -1;
  if (entries[pos.index] === pos.entry) return pos.index;
  // Older turns loaded in front of it: the same place from the end. The same
  // words are sent more than once, so the text alone may name another stop.
  const moved = pos.total === undefined ? -1 : pos.index + entries.length - pos.total;
  if (entries[moved] === pos.entry) return moved;
  return entries.lastIndexOf(pos.entry);
}

// ── Caret geometry ──────────────────────────────────────────────────────────

/**
 * Is the caret on the textarea's first (edge 'first') or last visual line,
 * wrapped lines counted? A mirror with the textarea's text metrics lays the
 * text out the same way; the caret's line is the line of the character after
 * it (at a soft wrap the caret shows at the start of the next line, and so does
 * that character).
 */
export function caretOnEdgeLine(ta: HTMLTextAreaElement, edge: 'first' | 'last'): boolean {
  if (ta.selectionStart !== ta.selectionEnd) return false;
  const caret = ta.selectionStart;
  const text = ta.value;
  // No line break on the way: decided without layout when the text cannot wrap
  // that far (the common one-line prompt).
  const before = text.slice(0, caret);
  const after = text.slice(caret);
  if (edge === 'first' && before.includes('\n')) return false;
  if (edge === 'last' && after.includes('\n')) return false;
  if (ta.scrollHeight <= ta.clientHeight && ta.clientHeight > 0 && !/\n/.test(text)) {
    const style = getComputedStyle(ta);
    const line = parseFloat(style.lineHeight) || parseFloat(style.fontSize) * 1.2;
    const pad = parseFloat(style.paddingTop) + parseFloat(style.paddingBottom);
    // One line tall: the caret is on the first line and on the last.
    if (ta.scrollHeight - pad < line * 1.5) return true;
  }
  const top = (offset: number) => markerTop(ta, offset);
  return edge === 'first' ? top(caret) <= top(0) : top(caret) >= top(text.length);
}

function markerTop(ta: HTMLTextAreaElement, offset: number): number {
  const style = getComputedStyle(ta);
  const mirror = document.createElement('div');
  for (const prop of [
    'boxSizing', 'width', 'paddingTop', 'paddingRight', 'paddingBottom', 'paddingLeft',
    'borderTopWidth', 'borderRightWidth', 'borderBottomWidth', 'borderLeftWidth',
    'fontFamily', 'fontSize', 'fontWeight', 'fontStyle', 'letterSpacing', 'lineHeight',
    'textTransform', 'wordSpacing', 'textIndent', 'tabSize',
  ] as const) {
    mirror.style[prop] = style[prop];
  }
  mirror.style.position = 'absolute';
  mirror.style.visibility = 'hidden';
  mirror.style.top = '0';
  mirror.style.left = '-9999px';
  mirror.style.whiteSpace = 'pre-wrap';
  mirror.style.overflowWrap = 'break-word';
  // The marker is the character at `offset` itself, with the rest of the text
  // after it, so its word wraps exactly as in the box. At the end, or on a line
  // break, a zero-width space stands in.
  const next = ta.value[offset];
  const atBreak = next === undefined || next === '\n';
  mirror.appendChild(document.createTextNode(ta.value.slice(0, offset)));
  const marker = document.createElement('span');
  marker.textContent = atBreak ? '\u200b' : next;
  mirror.appendChild(marker);
  mirror.appendChild(document.createTextNode(ta.value.slice(offset + (atBreak ? 0 : 1))));
  document.body.appendChild(mirror);
  const y = marker.offsetTop;
  mirror.remove();
  return y;
}
