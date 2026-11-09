/**
 * Who wrote each part of a Board page: spans of UTF-16 offsets into `html`,
 * contiguous from 0 to `html.length`, each with its writer (and the writing
 * session when the server knew it). A clicked path opens for the writer of the
 * text it sits in, not for whoever wrote the page last. Pure: the store keeps
 * the spans, the web reads them (board-model.ts).
 */

import { DecodingMode, EntityDecoder, htmlDecodeTree } from 'entities/decode';

export type HtmlSourceWriter = 'human' | 'agent' | `task:${string}`;

export interface BoardHtmlSource {
  start: number;
  end: number;
  by: HtmlSourceWriter;
  sessionId?: string;
}

const TASK_WRITER_RE = /^task:[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const SESSION_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/;

function validWriter(by: unknown): by is HtmlSourceWriter {
  return by === 'human' || by === 'agent' || (typeof by === 'string' && TASK_WRITER_RE.test(by));
}

function sameWriter(a: BoardHtmlSource, b: BoardHtmlSource): boolean {
  return a.by === b.by && a.sessionId === b.sessionId;
}

function span(start: number, end: number, by: HtmlSourceWriter, sessionId?: string): BoardHtmlSource {
  return sessionId ? { start, end, by, sessionId } : { start, end, by };
}

/** One writer for the whole page (a full write, or a record with no spans). Empty html: no spans. */
export function wholeHtmlSource(length: number, by: HtmlSourceWriter, sessionId?: string): BoardHtmlSource[] {
  return length > 0 ? [span(0, length, by, validSessionId(sessionId))] : [];
}

function validSessionId(sid: unknown): string | undefined {
  return typeof sid === 'string' && SESSION_ID_RE.test(sid) ? sid : undefined;
}

/**
 * The stored spans when they are exactly a cover of `length` (integers, in order,
 * no gap, no empty span, known writers), else null: a hand-edited or partial
 * list is not trusted in any part.
 */
export function validHtmlSources(raw: unknown, length: number): BoardHtmlSource[] | null {
  if (!Array.isArray(raw)) return null;
  const out: BoardHtmlSource[] = [];
  let at = 0;
  for (const s of raw) {
    if (!s || typeof s !== 'object' || Array.isArray(s)) return null;
    const { start, end, by, sessionId } = s as Record<string, unknown>;
    if (!Number.isInteger(start) || !Number.isInteger(end)) return null;
    if (start !== at || (end as number) <= at || (end as number) > length) return null;
    if (!validWriter(by)) return null;
    if (sessionId !== undefined && validSessionId(sessionId) === undefined) return null;
    out.push(span(start as number, end as number, by, sessionId as string | undefined));
    at = end as number;
  }
  return at === length ? mergeHtmlSources(out) : null;
}

/** Neighbours with the same writer and session become one span. */
export function mergeHtmlSources(spans: BoardHtmlSource[]): BoardHtmlSource[] {
  const out: BoardHtmlSource[] = [];
  for (const s of spans) {
    const last = out[out.length - 1];
    if (last && last.end === s.start && sameWriter(last, s)) out[out.length - 1] = { ...last, end: s.end };
    else out.push({ ...s });
  }
  return out;
}

/**
 * The spans after `removed` characters at `at` were replaced by `inserted` ones
 * written by `writer`: text before stays as it was, the new text is the writer's,
 * text after keeps its writer at its shifted offset. An empty replacement adds no span.
 */
export function spliceHtmlSources(
  spans: BoardHtmlSource[],
  at: number,
  removed: number,
  inserted: number,
  writer: { by: HtmlSourceWriter; sessionId?: string },
): BoardHtmlSource[] {
  const cut = at + removed;
  const delta = inserted - removed;
  const before: BoardHtmlSource[] = [];
  const after: BoardHtmlSource[] = [];
  for (const s of spans) {
    if (s.start < at) before.push({ ...s, end: Math.min(s.end, at) });
    if (s.end > cut) after.push({ ...s, start: Math.max(s.start, cut) + delta, end: s.end + delta });
  }
  const added = inserted > 0 ? [span(at, at + inserted, writer.by, validSessionId(writer.sessionId))] : [];
  return mergeHtmlSources([...before, ...added, ...after]);
}

type SourceWriter = { by: HtmlSourceWriter; sessionId?: string };

const isHigh = (c: number): boolean => c >= 0xd800 && c <= 0xdbff;
const isLow = (c: number): boolean => c >= 0xdc00 && c <= 0xdfff;

/** How far a change may slide, and a spaced path be read back, in UTF-16 units each way. */
const SEAM_SCAN_LIMIT = 512;

/** Whitespace, quotes and tag brackets end a word, a path or an attribute value. */
function isBreak(code: number): boolean {
  return code === 0x22 || code === 0x27 || code === 0x3c || code === 0x3e || /\s/.test(String.fromCharCode(code));
}
const isSpace = (c: number): boolean => c === 0x20 || c === 0xa0;
const startsPath = (c: number): boolean => c === 0x2f || c === 0x5c || c === 0x7e;

// A space inside a path, or past the bounded lookback, cannot give a changed path solely to its old writer.
function spaceInPath(text: string, p: number): boolean {
  if (p <= 0 || p + 1 >= text.length || !isSpace(text.charCodeAt(p))) return false;
  let after = p + 1;
  while (after < text.length && isSpace(text.charCodeAt(after))) {
    if (after - p >= SEAM_SCAN_LIMIT) return true;
    after += 1;
  }
  if (after === text.length || isBreak(text.charCodeAt(after))) return false;
  const nextPath = startsPath(text.charCodeAt(after));
  let separator = false;
  let i = p - 1;
  for (; i >= 0 && p - i <= SEAM_SCAN_LIMIT; i -= 1) {
    const c = text.charCodeAt(i);
    if (c === 0x2f || c === 0x5c) {
      separator = true;
      if (!nextPath) return true;
    }
    if (isBreak(c) && !isSpace(c)) return separator && (c === 0x22 || c === 0x27 || c === 0x3c);
  }
  return i >= 0;
}
const unresolvedEntity = Symbol('unresolved entity');
type EntityBounds = Map<string, Array<[number, number]>>;

function longEntityAt(text: string, at: number, bounds: EntityBounds): boolean {
  let ranges = bounds.get(text);
  if (!ranges) {
    ranges = [];
    // Scan once only when the bounded window cannot distinguish an entity from plain hex text.
    for (const match of text.matchAll(/&#(?:[xX][0-9a-f]+|[0-9]+)/gi)) {
      if (match[0].length > SEAM_SCAN_LIMIT) ranges.push([match.index, match.index + match[0].length]);
    }
    bounds.set(text, ranges);
  }
  let lo = 0;
  let hi = ranges.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (ranges[mid]![0] <= at) lo = mid + 1; else hi = mid;
  }
  return lo > 0 && at < ranges[lo - 1]![1];
}

function encodedBreak(text: string, at: number, bounds: EntityBounds): [number, number] | null {
  if (at < 0 || at >= text.length) return null;
  const floor = Math.max(0, at - SEAM_SCAN_LIMIT);
  const window = text.slice(floor, at + 1);
  const found = window.lastIndexOf('&');
  if (found < 0) {
    if (floor > 0 && /^[0-9a-f]+$/i.test(window) && longEntityAt(text, at, bounds)) throw unresolvedEntity;
    return null;
  }
  const start = floor + found;
  let decoded = '';
  const decoder = new EntityDecoder(htmlDecodeTree, (cp) => { decoded += String.fromCodePoint(cp); });
  decoder.startEntity(DecodingMode.Legacy);
  const input = text.slice(start, Math.min(text.length, start + SEAM_SCAN_LIMIT));
  let consumed = decoder.write(input, 1);
  if (consumed < 0) {
    if (start + input.length < text.length && /^&#(?:[xX][0-9a-f]*|[0-9]*)$/i.test(input)) throw unresolvedEntity;
    consumed = decoder.end();
  }
  if (consumed <= 0 || at >= start + consumed || !decoded || ![...decoded].every((c) => isBreak(c.charCodeAt(0)))) return null;
  return [start, start + consumed];
}

const inToken = (text: string, i: number, bounds: EntityBounds): boolean =>
  i >= 0 && i < text.length && !encodedBreak(text, i, bounds) && (!isBreak(text.charCodeAt(i)) || spaceInPath(text, i));

function semanticSeam(text: string, start: number, length: number, bounds: EntityBounds): [number, number] {
  // A changed entity digit can end a path before the entity's raw spelling starts.
  const left = encodedBreak(text, start, bounds);
  const right = encodedBreak(text, start + length - 1, bounds);
  return [left?.[0] ?? start, right?.[1] ?? start + length];
}

/**
 * Which neighbours of a change (its new text at [s, s + inserted) of `next`, its removed text at
 * [r, r + removed) of `prev`) stand in a token the change made: joined, cut at its head or tail,
 * or split by an inserted break.
 */
function seamRanges(next: string, prev: string, s: number, inserted: number, r: number, removed: number, bounds: EntityBounds): [number, number, number, number] {
  let [start, end] = semanticSeam(next, s, inserted, bounds);
  let [oldStart, oldEnd] = semanticSeam(prev, r, removed, bounds);
  const changed = (a: [number, number], b: [number, number] | null): boolean =>
    !b || next.slice(a[0], a[1]) !== prev.slice(b[0], b[1]);
  const left = encodedBreak(next, start - 1, bounds);
  const oldLeft = encodedBreak(prev, oldStart - 1, bounds);
  if (left && changed(left, oldLeft)) {
    start = left[0];
    if (oldLeft) oldStart = oldLeft[0];
  }
  const right = encodedBreak(next, end, bounds);
  const oldRight = encodedBreak(prev, oldEnd, bounds);
  if (right && changed(right, oldRight)) {
    end = right[1];
    if (oldRight) oldEnd = oldRight[1];
  }
  return [start, end, oldStart, oldEnd];
}

function seamMarks(next: string, prev: string, s: number, inserted: number, r: number, removed: number, bounds: EntityBounds): { left: boolean; right: boolean } {
  const [start, e, oldStart, oldEnd] = seamRanges(next, prev, s, inserted, r, removed, bounds);
  const a = inToken(next, start - 1, bounds);
  const b = inToken(next, e, bounds);
  const rFirst = removed > 0 && inToken(prev, oldStart, bounds);
  const rLast = removed > 0 && inToken(prev, oldEnd - 1, bounds);
  if (inserted === 0) {
    if (removed === 0) return { left: false, right: false };
    const joined = a && b;
    return { left: a && (joined || rFirst), right: b && (joined || rLast) };
  }
  // New text that runs into the token beside it already names the writer there.
  const leftCont = removed > 0 ? rFirst : b;
  const rightCont = removed > 0 ? rLast : a;
  return { left: a && !inToken(next, start, bounds) && leftCont, right: b && !inToken(next, e - 1, bounds) && rightCont };
}

/** The whole code point holding the UTF-16 unit before (`before`) or at offset `at`. */
function codePointRange(text: string, at: number, before: boolean): [number, number] {
  if (before) {
    const start = at - 1;
    return start > 0 && isLow(text.charCodeAt(start)) && isHigh(text.charCodeAt(start - 1)) ? [start - 1, at] : [start, at];
  }
  return at + 1 < text.length && isHigh(text.charCodeAt(at)) && isLow(text.charCodeAt(at + 1)) ? [at, at + 2] : [at, at + 1];
}

/** Index of the first span start greater than `i` (spans are a sorted cover). */
function startsAbove(spans: readonly BoardHtmlSource[], i: number): number {
  let lo = 0;
  let hi = spans.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (spans[mid]!.start <= i) lo = mid + 1; else hi = mid;
  }
  return lo;
}

/**
 * The spans of `prev` after `removed` units at `at` were replaced by `inserted`, written by
 * `writer`: kept text keeps its writer, new text is the writer's, and a token the change joined,
 * cut or split names the writer on the whole code points at its seam. A pure deletion or insertion
 * the same text allows elsewhere (a deleted line whose neighbour ends alike) slides at most
 * SEAM_SCAN_LIMIT units each way to the place that marks least and keeps writers whole; past that
 * limit it stays where the edit put it and both seam sides are marked.
 */
export function spliceHtmlChange(
  prev: string, spans: BoardHtmlSource[], at: number, removed: number, inserted: string, writer: SourceWriter,
): BoardHtmlSource[] {
  try {
    return spliceKnownHtmlChange(prev, spans, at, removed, inserted, writer);
  } catch (error) {
    if (error !== unresolvedEntity) throw error;
    return wholeHtmlSource(prev.length - removed + inserted.length, 'agent');
  }
}

function spliceKnownHtmlChange(
  prev: string, spans: BoardHtmlSource[], at: number, removed: number, inserted: string, writer: SourceWriter,
): BoardHtmlSource[] {
  const ins = inserted.length;
  if (removed === 0 && ins === 0) return spans;
  const next = prev.slice(0, at) + inserted + prev.slice(at + removed);
  const bounds: EntityBounds = new Map();
  let q = at;
  let forced = false;
  if (ins === 0 || removed === 0) {
    const len = ins === 0 ? removed : ins;
    // A deletion slides over `prev`, an insertion over `next`: both leave the same text.
    const text = ins === 0 ? prev : next;
    let lo = at;
    let hi = at;
    while (lo > 0 && text.charCodeAt(lo - 1) === text.charCodeAt(lo - 1 + len)) {
      if (at - lo >= SEAM_SCAN_LIMIT) { forced = true; break; }
      lo -= 1;
    }
    while (hi + len < text.length && text.charCodeAt(hi) === text.charCodeAt(hi + len)) {
      if (hi - at >= SEAM_SCAN_LIMIT) { forced = true; break; }
      hi += 1;
    }
    if (!forced) q = bestPlace(prev, next, text, spans, at, lo, hi, len, ins === 0, writer, bounds);
  }
  let out = spliceHtmlSources(spans, q, removed, ins, writer);
  const marks = forced
    ? { left: q > 0, right: q + ins < next.length }
    : seamMarks(next, prev, q, ins, q, removed, bounds);
  const mark = (range: [number, number]): void => {
    out = spliceHtmlSources(out, range[0], range[1] - range[0], range[1] - range[0], writer);
  };
  const [markStart, markEnd] = seamRanges(next, prev, q, ins, q, removed, bounds);
  if (marks.left) mark(codePointRange(next, markStart, true));
  if (marks.right) mark(codePointRange(next, markEnd, false));
  return out;
}

/** The place in [lo, hi] for a pure deletion (or insertion) of `len` units: fewest marks, then fewest writer changes, whole lines, nearest. */
function bestPlace(
  prev: string, next: string, text: string, spans: readonly BoardHtmlSource[],
  at: number, lo: number, hi: number, len: number, deletion: boolean, writer: SourceWriter, bounds: EntityBounds,
): number {
  const keyOf = (w: SourceWriter): string => `${w.by}|${validSessionId(w.sessionId) ?? ''}`;
  // The writer of prev unit i, '' past either end.
  const key = (i: number): string => {
    if (i < 0 || i >= prev.length) return '';
    const s = spans[startsAbove(spans, i) - 1];
    return s ? keyOf(s) : '';
  };
  // Writer changes at unit boundaries t in [from, to] (between t - 1 and t): span starts, and the end.
  const changes = (from: number, to: number): number =>
    startsAbove(spans, to) - startsAbove(spans, from - 1) + Number(from <= prev.length && prev.length <= to);
  const mine = keyOf(writer);
  const nl = 0x0a;
  const splits = (c: number): boolean =>
    (c > 0 && isHigh(text.charCodeAt(c - 1)) && isLow(text.charCodeAt(c)))
    || (c + len < text.length && isHigh(text.charCodeAt(c + len - 1)) && isLow(text.charCodeAt(c + len)));
  const score = (c: number): number[] => {
    const m = deletion ? seamMarks(next, prev, c, 0, c, len, bounds) : seamMarks(next, prev, c, len, c, 0, bounds);
    const mixed = deletion ? 0 : Number(inToken(next, c - 1, bounds) && inToken(next, c, bounds)) + Number(inToken(next, c + len, bounds) && inToken(next, c + len - 1, bounds));
    const split = deletion
      ? Number(key(c - 1) !== key(c + len)) - changes(c, c + len)
      : Number(key(c - 1) !== mine) + Number(mine !== key(c)) - Number(key(c - 1) !== key(c));
    const wholeLines = ((c === 0 || text.charCodeAt(c - 1) === nl) && text.charCodeAt(c + len - 1) === nl)
      || (text.charCodeAt(c) === nl && (c + len === text.length || text.charCodeAt(c + len) === nl));
    return [Number(m.left) + Number(m.right) + mixed, split, wholeLines ? 0 : 1, Math.abs(c - at)];
  };
  const less = (x: number[], y: number[]): boolean => {
    for (let i = 0; i < x.length; i += 1) if (x[i] !== y[i]) return x[i]! < y[i]!;
    return false;
  };
  let q = at;
  let best = score(at);
  for (let c = lo; c <= hi; c += 1) {
    if (c === at || splits(c)) continue;
    const sc = score(c);
    if (less(sc, best)) { best = sc; q = c; }
  }
  return q;
}

/**
 * The span holding UTF-16 offset `offset` of a page of `length` characters, or
 * null when the offset is not an integer inside the page or the spans are not
 * an exact cover of it.
 */
export function htmlSourceAt(raw: unknown, length: number, offset: unknown): BoardHtmlSource | null {
  if (!Number.isInteger(offset) || (offset as number) < 0 || (offset as number) >= length) return null;
  const spans = validHtmlSources(raw, length);
  if (!spans) return null;
  return spans.find((s) => s.start <= (offset as number) && (offset as number) < s.end) ?? null;
}
