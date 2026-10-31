/**
 * A task pill shows the task's title, so a title the model ALSO wrote beside
 * the mention would read twice: `**"Home task panel: Flat layout"**(mvu0ubnq-a02d)`
 * became "Home task panel: Flat layout(Home task panel: Flat layout and status
 * sections)". This pass runs on the markdown SOURCE, before rendering, and drops
 * the written title when it names the same task, so the pill alone carries it
 * (2026-10-31, the user's lead: "the pill should absorb the written title so it
 * shows once").
 *
 * One rule for every renderer that makes task pills from text; each finds its
 * mentions its own way and hands them here, or mirrors this file:
 *  - web: markdown.ts absorbWrittenTaskTitles (renderMarkdownWithRefs, ChatMessage);
 *  - the Board frame: board-markdown.frame.js absorbTaskTitles (plain ES2017, a mirror);
 *  - the phone: ios-native/Walnut/Markdown/TaskTitleAbsorb.swift (a mirror).
 * The cases all three must agree on: tests/fixtures/task-title-absorb.json.
 *
 * Shapes, the mention M being an id, a backticked id, a `<task-ref/>` or `[id|title]`:
 *   Title (M)  "Title" (M)  **Title** (M)  Title(M)  Title - M  Title (M, more)
 *   M (Title)  M("Title")  M "Title"  M - Title
 * "Title" matches when it is the task's title (case and spacing aside), or its
 * start cut at a word: ending in an ellipsis, two words and 10 characters or
 * more, or at least
 * 60% of it ("Home task panel" for "Home task panel: Flat layout ..."). Anything
 * else stays (one word, an older name, a description, another table cell).
 *
 * Zero imports on purpose: the markdown test tier runs in a bare node env.
 */

/** A mention in the text and the names its pill may show (the first is what it shows). */
export interface WrittenMention {
  start: number;
  end: number;
  titles: readonly string[];
}

const PAIRS: readonly [string, string][] = [
  ['**', '**'], ['__', '__'], ['*', '*'], ['_', '_'],
  ['"', '"'], ['\u201c', '\u201d'], ['\u300c', '\u300d'], ['\u300e', '\u300f'], ['\u2018', '\u2019'], ["'", "'"],
];
/** The longest written title considered, so a scan stays local. */
const MAX_WRITTEN = 240;
const ELLIPSIS_END_RE = /[ \t]*(?:\u2026|\.\.\.)$/;
const PAREN_BEFORE_RE = /([ \t]*)([(\uff08])[ \t]*$/;
const CLOSE_AFTER_RE = /^[ \t]*[)\uff09]/;
const LIST_SEP_AFTER_RE = /^[ \t]*[,\uff0c\u3001;\uff1b][ \t]*/;
const DASH_BEFORE_RE = /(?:[ \t]*[\u2014\u2013][ \t]*|[ \t]+-{1,2}[ \t]+)$/;
const DASH_AFTER_RE = /^(?:[ \t]*[\u2014\u2013][ \t]*|[ \t]+-{1,2}[ \t]+)/;
const PAREN_AFTER_RE = /^[ \t]*[(\uff08]([^\n()\uff08\uff09]{1,240})[)\uff09]/;
const SPACE_AFTER_RE = /^[ \t]+/;
const ASCII_WORD_RE = /[A-Za-z0-9]/;

function norm(s: string): string {
  return s.normalize('NFKC').toLowerCase().replace(/\s+/g, ' ').trim();
}

/** Strip matching wrappers and quotes, outermost first (`**"T"**` -> `T`). */
function unwrap(s: string): string {
  let t = s.trim();
  for (let round = 0; round < 4; round++) {
    const pair = PAIRS.find(([o, c]) => t.length > o.length + c.length && t.startsWith(o) && t.endsWith(c));
    if (!pair) break;
    t = t.slice(pair[0].length, t.length - pair[1].length).trim();
  }
  return t;
}

/** Does a written phrase name this title? */
export function writtenTitleMatches(written: string, title: string): boolean {
  let w = unwrap(written);
  const cut = ELLIPSIS_END_RE.test(w);
  if (cut) w = unwrap(w.replace(ELLIPSIS_END_RE, ''));
  const nw = norm(w);
  const nt = norm(title);
  if (nw.length < 3 || !nt) return false;
  if (nw === nt) return true;
  if (!nt.startsWith(nw)) return false;
  // Cut at a word, never inside one ("Home task pa" is not a name).
  if (ASCII_WORD_RE.test(nt.charAt(nw.length)) && ASCII_WORD_RE.test(nw.charAt(nw.length - 1))) return false;
  return isNameCut(nw, nt.length, cut);
}

/** May a start of the title this long (`head`, of a title `full` long) stand for it? */
function isNameCut(head: string, full: number, cut: boolean): boolean {
  const h = head.trim();
  return cut || h.length >= 0.6 * full || (h.length >= 10 && h.split(/\s+/).length >= 2);
}

/** A wrapped or quoted unit ending `head` (its start), or -1. */
function unitBefore(head: string): number {
  for (const [open, close] of PAIRS) {
    if (!head.endsWith(close)) continue;
    // `**` ends with `*` too: the single marker only when the double is not there.
    if (close.length === 1 && head.endsWith(close + close) && (close === '*' || close === '_')) continue;
    const from = head.length - close.length - 1;
    const start = head.lastIndexOf(open, from);
    if (start < 0 || head.length - start > MAX_WRITTEN || head.slice(start, head.length).includes('\n')) continue;
    if (head.length - start <= open.length + close.length) continue;
    return start;
  }
  return -1;
}

/** A wrapped or quoted unit starting `tail` (its length), or 0. */
function unitAfter(tail: string): number {
  for (const [open, close] of PAIRS) {
    if (!tail.startsWith(open)) continue;
    if (open.length === 1 && tail.startsWith(open + open) && (open === '*' || open === '_')) continue;
    const end = tail.indexOf(close, open.length + 1);
    if (end < 0 || end + close.length > MAX_WRITTEN || tail.slice(0, end).includes('\n')) continue;
    return end + close.length;
  }
  return 0;
}

/** Lengths of the title's word-cut starts, longest first, that may stand for it. */
function cutLengths(title: string, cut: boolean): number[] {
  const out: number[] = [];
  for (let k = title.length; k >= 3; k--) {
    if (k < title.length && ASCII_WORD_RE.test(title.charAt(k)) && ASCII_WORD_RE.test(title.charAt(k - 1))) continue;
    if (k === title.length || isNameCut(title.slice(0, k), title.length, cut)) out.push(k);
  }
  return out;
}

/** Start of an unquoted title written at the end of `head`, or -1. */
function plainBefore(head: string, title: string): number {
  const ell = ELLIPSIS_END_RE.exec(head);
  const core = ell ? head.slice(0, ell.index) : head;
  const lower = core.toLowerCase();
  // Offsets are taken on `core`: a case fold that changes the length cannot be mapped back.
  if (lower.length !== core.length) return -1;
  const t = title.trim().toLowerCase();
  for (const k of cutLengths(t, !!ell)) {
    const cand = t.slice(0, k).trimEnd();
    if (cand.length < 3 || !lower.endsWith(cand)) continue;
    const start = core.length - cand.length;
    if (start > 0 && ASCII_WORD_RE.test(cand.charAt(0)) && ASCII_WORD_RE.test(core.charAt(start - 1))) continue;
    return start;
  }
  return -1;
}

/** Length of an unquoted title written at the start of `tail`, or 0. */
function plainAfter(tail: string, title: string): number {
  const lower = tail.toLowerCase();
  const t = title.trim().toLowerCase();
  for (const k of cutLengths(t, true)) {
    const cand = t.slice(0, k).trimEnd();
    if (cand.length < 3 || !lower.startsWith(cand)) continue;
    let end = cand.length;
    const rest = tail.slice(end);
    const ell = /^[ \t]*(?:\u2026|\.\.\.)/.exec(rest);
    if (ell) end += ell[0].length;
    else if (k < t.length && !isNameCut(cand, t.length, false)) continue;
    if (!ell && ASCII_WORD_RE.test(cand.charAt(cand.length - 1)) && ASCII_WORD_RE.test(tail.charAt(end))) continue;
    return end;
  }
  return 0;
}

/** Start of the title written at the end of `head` (wrapped, quoted or plain), or -1. */
function writtenBefore(head: string, titles: readonly string[]): number {
  const u = unitBefore(head);
  if (u >= 0) return titles.some((t) => writtenTitleMatches(head.slice(u), t)) ? u : -1;
  for (const t of titles) {
    const p = plainBefore(head, t);
    if (p >= 0) return p;
  }
  return -1;
}

type Edit = { from: number; to: number; text: string };

function editFor(text: string, m: WrittenMention, lo: number, hi: number): Edit | null {
  const mention = text.slice(m.start, m.end);
  const before = text.slice(lo, m.start);
  const after = text.slice(m.end, hi);

  // Title (M) / Title (M, more)
  const paren = PAREN_BEFORE_RE.exec(before);
  if (paren) {
    const close = CLOSE_AFTER_RE.exec(after);
    const sep = close ? null : LIST_SEP_AFTER_RE.exec(after);
    if (close || sep) {
      const at = writtenBefore(before.slice(0, paren.index), m.titles);
      if (at >= 0) {
        return close
          ? { from: lo + at, to: m.end + close[0].length, text: mention }
          : { from: lo + at, to: m.end + sep![0].length, text: mention + paren[1] + paren[2] };
      }
    }
  }
  // Title - M
  const dashBefore = DASH_BEFORE_RE.exec(before);
  if (dashBefore) {
    const at = writtenBefore(before.slice(0, dashBefore.index), m.titles);
    if (at >= 0) return { from: lo + at, to: m.start, text: '' };
  }
  // M (Title)
  const parenAfter = PAREN_AFTER_RE.exec(after);
  if (parenAfter && m.titles.some((t) => writtenTitleMatches(parenAfter[1]!, t))) {
    return { from: m.end, to: m.end + parenAfter[0].length, text: '' };
  }
  // M - Title
  const dashAfter = DASH_AFTER_RE.exec(after);
  if (dashAfter) {
    const tail = after.slice(dashAfter[0].length);
    const u = unitAfter(tail);
    let len = u > 0 && m.titles.some((t) => writtenTitleMatches(tail.slice(0, u), t)) ? u : 0;
    if (!len && u === 0) for (const t of m.titles) { len = plainAfter(tail, t); if (len) break; }
    if (len) return { from: m.end, to: m.end + dashAfter[0].length + len, text: '' };
  }
  // M "Title" / M **Title**
  const space = SPACE_AFTER_RE.exec(after);
  if (space) {
    const tail = after.slice(space[0].length);
    const u = unitAfter(tail);
    if (u > 0 && m.titles.some((t) => writtenTitleMatches(tail.slice(0, u), t))) {
      return { from: m.end, to: m.end + space[0].length + u, text: '' };
    }
  }
  return null;
}

/**
 * Drop each title written beside a mention of the same task. `mentions` are the
 * pills the renderer will make, in any order, non-overlapping; every other
 * character of the text is kept.
 */
export function absorbWrittenTitles(text: string, mentions: readonly WrittenMention[]): string {
  if (mentions.length === 0) return text;
  const sorted = [...mentions].sort((a, b) => a.start - b.start);
  const edits: Edit[] = [];
  for (let i = 0; i < sorted.length; i++) {
    const m = sorted[i]!;
    if (m.titles.every((t) => !t.trim())) continue;
    const lineStart = text.lastIndexOf('\n', m.start - 1) + 1;
    const nl = text.indexOf('\n', m.end);
    const lo = Math.max(lineStart, i > 0 ? sorted[i - 1]!.end : 0);
    const hi = Math.min(nl < 0 ? text.length : nl, i + 1 < sorted.length ? sorted[i + 1]!.start : text.length);
    const e = editFor(text, m, lo, hi);
    if (e && !edits.some((x) => x.from < e.to && e.from < x.to)) edits.push(e);
  }
  if (edits.length === 0) return text;
  edits.sort((a, b) => b.from - a.from);
  let out = text;
  for (const e of edits) out = out.slice(0, e.from) + e.text + out.slice(e.to);
  return out;
}

/**
 * The names a writer may use for the task a pill shows as `shown`: the shown
 * title, and the stored one where the pill renames it (a lead's "X lead" shows
 * as "X VP", Main shows as "CEO"; entity-label-store.ts shownTaskTitle).
 */
export function pillNames(shown: string): string[] {
  const out = [shown];
  if (/ VP$/i.test(shown)) out.push(shown.replace(/ VP$/i, ' lead'));
  if (shown === 'CEO') out.push('Main');
  return out;
}
