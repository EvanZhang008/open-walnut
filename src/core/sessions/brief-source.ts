/**
 * Who wrote each part of a Brief (TaskBrief.text_sources): contiguous UTF-16 spans over its text,
 * the same shape as a Board page's (boards/board-html-source.ts, whose pure span functions work on
 * any text). A path in the letter opens on the machine of the writer of the words it sits in, never
 * on the owner's current session, which may not have written them. Pure: the server stores the
 * spans, the web and the phone read them.
 */
import { diffChars } from 'diff';
import {
  mergeHtmlSources, spliceHtmlChange, validHtmlSources, wholeHtmlSource,
  type BoardHtmlSource, type HtmlSourceWriter,
} from '../boards/board-html-source.js';
import type { BriefSectionTask } from '../user-status.js';

export type BriefTextSource = BoardHtmlSource;
export interface BriefWriter { by: HtmlSourceWriter; sessionId?: string }

/** A writer Walnut cannot name: its words open nowhere. */
export const UNKNOWN_WRITER: BriefWriter = { by: 'agent' };

/** The stored spans when they cover `text` exactly, else the whole letter as unknown (an older
 *  letter, or spans that no longer match): never the owner guessed as its writer. */
export function briefSourcesOf(brief: { text: string; text_sources?: unknown } | null | undefined): BriefTextSource[] {
  const text = brief?.text ?? '';
  return validHtmlSources(brief?.text_sources, text.length) ?? wholeHtmlSource(text.length, UNKNOWN_WRITER.by);
}

const isHighSurrogate = (c: number): boolean => c >= 0xd800 && c <= 0xdbff;
const isLowSurrogate = (c: number): boolean => c >= 0xdc00 && c <= 0xdfff;

/**
 * The UTF-16 units `prev` and `next` share at their start and end, never splitting a surrogate
 * pair. The same rule as board-store.ts sharedEnds, which a store module keeps out of the web bundle.
 */
export function sharedEnds(prev: string, next: string): { prefix: number; suffix: number } {
  const min = Math.min(prev.length, next.length);
  let prefix = 0;
  while (prefix < min && prev.charCodeAt(prefix) === next.charCodeAt(prefix)) prefix += 1;
  if (prefix > 0 && isHighSurrogate(prev.charCodeAt(prefix - 1))) prefix -= 1;
  let suffix = 0;
  const limit = min - prefix;
  while (suffix < limit && prev.charCodeAt(prev.length - 1 - suffix) === next.charCodeAt(next.length - 1 - suffix)) suffix += 1;
  if (suffix > 0 && isLowSurrogate(prev.charCodeAt(prev.length - suffix))) suffix -= 1;
  return { prefix, suffix };
}

/**
 * The spans after one exact edit at `at` of `text` (the whole letter before it) replaced `old` with
 * `next`: only the part that changed is the writer's, and a token a deletion joined or cut names
 * the writer at its seam (board-html-source.ts spliceHtmlChange).
 */
export function spliceBriefEdit(spans: BriefTextSource[], at: number, old: string, next: string, writer: BriefWriter, text: string): BriefTextSource[] {
  const { prefix, suffix } = sharedEnds(old, next);
  const cut = old.length - prefix - suffix;
  const added = next.length - prefix - suffix;
  if (cut === 0 && added === 0) return spans;
  return spliceHtmlChange(text, spans, at + prefix, cut, next.slice(prefix, next.length - suffix), writer);
}

/**
 * The spans of `next`, made from `prev` by insertions only (a ref's short id completed): each
 * kept character keeps its writer, an inserted one takes the writer before it. Null when `next`
 * is not such a text.
 */
export function sourcesAfterInsertions(prev: string, next: string, spans: readonly BriefTextSource[]): BriefTextSource[] | null {
  const valid = validHtmlSources(spans, prev.length);
  if (!valid || next.length < prev.length) return null;
  const writerAt = (i: number): BriefWriter => valid.find((s) => s.start <= i && i < s.end) ?? UNKNOWN_WRITER;
  const out: BriefTextSource[] = [];
  let i = 0;
  for (let j = 0; j < next.length; j++) {
    const matched = i < prev.length && prev.charCodeAt(i) === next.charCodeAt(j);
    const w = writerAt(matched ? i : Math.max(0, i - 1));
    if (matched) i++;
    out.push(w.sessionId ? { start: j, end: j + 1, by: w.by, sessionId: w.sessionId } : { start: j, end: j + 1, by: w.by });
  }
  return i === prev.length ? mergeHtmlSources(out) : null;
}

/**
 * The spans of `next`, a whole rewrite of `prev` by `writer`: diffChars' kept parts keep their old
 * writers at their new offsets, only inserted parts are the writer's, removed parts drop out, and
 * each change is placed and its seams marked as one exact edit is (spliceHtmlChange), so a deletion
 * that joins or cuts a path names the writer in it while a deleted line leaves its neighbours'
 * paths alone. The diff runs on code points, so no part splits a surrogate pair. Spans that do not cover `prev`
 * read as unknown, never as `writer`. The diff runs on the server's event loop, so it has a small
 * budget; a rewrite too different to diff within it reads as unknown, never as `writer`.
 */
export const REWRITE_DIFF_TIMEOUT_MS = 25;

export function sourcesAfterRewrite(prev: string, next: string, spans: readonly BriefTextSource[], writer: BriefWriter): BriefTextSource[] {
  const valid = validHtmlSources(spans, prev.length) ?? wholeHtmlSource(prev.length, UNKNOWN_WRITER.by);
  if (prev === next) return valid;
  const started = performance.now();
  const parts = diffChars(prev, next, { timeout: REWRITE_DIFF_TIMEOUT_MS });
  if (!parts) return wholeHtmlSource(next.length, UNKNOWN_WRITER.by);
  // Each run of removed and added parts is one change, applied in order to the text so far.
  let sources = valid;
  let current = prev;
  let to = 0;
  let removed = '';
  let added = '';
  const flush = (): void => {
    if (!removed && !added) return;
    sources = spliceHtmlChange(current, sources, to, removed.length, added, writer);
    current = current.slice(0, to) + added + current.slice(to + removed.length);
    to += added.length;
    removed = '';
    added = '';
  };
  for (const part of parts) {
    if (performance.now() - started >= REWRITE_DIFF_TIMEOUT_MS) return wholeHtmlSource(next.length, UNKNOWN_WRITER.by);
    if (part.removed) removed += part.value;
    else if (part.added) added += part.value;
    else { flush(); to += part.value.length; }
  }
  flush();
  // A diff that does not rebuild `next` is not trusted in any part.
  return current === next && performance.now() - started < REWRITE_DIFF_TIMEOUT_MS
    ? mergeHtmlSources(sources)
    : wholeHtmlSource(next.length, UNKNOWN_WRITER.by);
}

/**
 * One piece of a shaped letter: a slice of the input text (`src` is its start there), a line
 * Walnut wrote for a known writer (an added ask), or Walnut's layout (a heading, a "- ", a line
 * break, a "None"), which holds no reference and so takes its neighbour's writer rather than
 * adding a writer of its own to the block around it.
 */
export type BriefPiece =
  | { text: string; src: number }
  | { text: string; writer: BriefWriter }
  | { text: string; layout: true };

/**
 * The spans of a letter built from `pieces` over an input whose spans are `input`, the final text
 * being the pieces joined and then cut to [cutStart, cutEnd). A slice keeps its input writers; a
 * slice that does not match the input (a shaping bug) is unknown rather than mis-attributed.
 */
export function sourcesOfPieces(
  inputText: string, input: readonly BriefTextSource[], pieces: readonly BriefPiece[], cutStart: number, cutEnd: number,
): BriefTextSource[] {
  const segs: Array<{ start: number; end: number; w: BriefWriter | null }> = [];
  let at = 0;
  for (const p of pieces) {
    const len = p.text.length;
    if (!len) continue;
    if ('layout' in p) {
      segs.push({ start: at, end: at + len, w: null });
    } else if ('writer' in p) {
      segs.push({ start: at, end: at + len, w: p.writer });
    } else if (inputText.slice(p.src, p.src + len) !== p.text) {
      segs.push({ start: at, end: at + len, w: UNKNOWN_WRITER });
    } else {
      let covered = 0;
      for (const s of input) {
        const a = Math.max(s.start, p.src); const b = Math.min(s.end, p.src + len);
        if (b > a) { segs.push({ start: at + (a - p.src), end: at + (b - p.src), w: s }); covered += b - a; }
      }
      if (covered !== len) segs.push({ start: at, end: at + len, w: UNKNOWN_WRITER });
    }
    at += len;
  }
  // Layout takes the writer before it (the first one after it at the very start).
  const firstKnown = segs.find((s) => s.w)?.w ?? UNKNOWN_WRITER;
  let prev: BriefWriter = firstKnown;
  const out: BriefTextSource[] = [];
  for (const seg of segs.sort((x, y) => x.start - y.start)) {
    const w = seg.w ?? prev;
    if (seg.w) prev = seg.w;
    const s = Math.max(seg.start, cutStart); const e = Math.min(seg.end, cutEnd);
    if (e <= s) continue;
    out.push(w.sessionId ? { start: s - cutStart, end: e - cutStart, by: w.by, sessionId: w.sessionId } : { start: s - cutStart, end: e - cutStart, by: w.by });
  }
  return mergeHtmlSources(out);
}

/** The fields a task's recorded writer is read from. */
type AskWriterTask = BriefSectionTask & { last_words?: { text?: string; session_id?: string } | null };

/**
 * Who wrote the words of the line Walnut adds for a task asking the user: its session's report for
 * a session's own ask, the session whose last words a turn to read quotes; anything else (a
 * letter, a choice, a prompt, an error, no recorded session) is unknown, never the Brief's owner.
 */
export function askLineWriter(task: AskWriterTask): BriefWriter {
  const s = task.user_status;
  if (!s) return UNKNOWN_WRITER;
  // A person's report has no session: they wrote it on the primary.
  // The ask's own writer (askBy), never now/next's (reportBy): a held ask may predate the report.
  if (s.state === 'needs' && s.source === 'session' && s.askBy === 'human') return { by: 'human' };
  if (s.state === 'needs' && s.source === 'session' && s.askSessionId) {
    const by: HtmlSourceWriter = s.askBy?.startsWith('task:') ? s.askBy as HtmlSourceWriter : s.askBy === 'unknown' ? 'agent' : `task:${task.id}`;
    return { by, sessionId: s.askSessionId };
  }
  if (s.toRead === 'answer' && s.waitingBy === 'human') return { by: 'human' };
  if (s.toRead === 'answer' && s.waitingSessionId) {
    const by: HtmlSourceWriter = s.waitingBy?.startsWith('task:') ? s.waitingBy as HtmlSourceWriter : `task:${task.id}`;
    return { by, sessionId: s.waitingSessionId };
  }
  const words = task.last_words;
  if (s.toRead === 'turn' && words?.session_id && words.text) {
    return { by: `task:${task.id}`, sessionId: words.session_id };
  }
  return UNKNOWN_WRITER;
}

const PATH_CHAR = /[\w.\/~@+-]/;

/** Every place `path` stands on its own in `text` (not inside a longer path). */
function pathOccurrences(text: string, path: string): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  if (!path) return out;
  for (const needle of new Set([path, encodeURI(path)])) {
    for (let i = text.indexOf(needle); i !== -1; i = text.indexOf(needle, i + 1)) {
      const before = i > 0 ? text[i - 1]! : '';
      const after = text[i + needle.length] ?? '';
      const next = text[i + needle.length + 1] ?? '';
      // A trailing "." ends a sentence; ".bak" continues the name.
      const continues = after === '.' ? /\w/.test(next) : /[\w\/-]/.test(after);
      if ((before && PATH_CHAR.test(before)) || continues) continue;
      out.push([i, i + needle.length]);
    }
  }
  return out;
}

/**
 * Every writer of `path` in the letter, once each in text order. With `block` (the raw range of
 * one Markdown block the shared renderer linked the path in) every writer of that whole block;
 * without it, the writers of the places the path stands on its own. Null when nothing is found or
 * the spans do not cover the text. The rendered link's path is only the key: the writers come from here.
 */
export function briefPathWriters(text: string, raw: unknown, path: string, block?: readonly [number, number]): BriefWriter[] | null {
  const spans = validHtmlSources(raw, text.length);
  if (!spans) return null;
  let places: Array<readonly [number, number]>;
  if (block) {
    const [from, to] = block;
    if (!Number.isInteger(from) || !Number.isInteger(to) || from < 0 || to > text.length || to <= from) return null;
    // Every writer of the block: a literal copy of the path may not be the one the link was rendered from.
    places = [[from, to]];
  } else {
    places = pathOccurrences(text, path);
  }
  if (!places.length) return null;
  const out = new Map<string, BriefWriter>();
  for (const [start, end] of places) {
    for (const s of spans) {
      if (s.end <= start || s.start >= end) continue;
      const key = `${s.by}|${s.sessionId ?? ''}`;
      if (!out.has(key)) out.set(key, s.sessionId ? { by: s.by, sessionId: s.sessionId } : { by: s.by });
    }
  }
  return out.size ? [...out.values()] : null;
}
