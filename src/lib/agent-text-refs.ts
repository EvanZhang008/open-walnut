/**
 * URLs, absolute file paths (with a line or range), task ids and letter ids in
 * literal text, found with the shapes the browser already uses (url-text,
 * path-ref-patterns, path-ref-parse, task-id-shape, letter-id-shape), no markdown.
 * File, task and letter links go to the console's `/open-ref` hand-off page:
 * `#token=<t>&kind=…` with a reader token, `?kind=…` without one.
 */

import { parsePathRef } from '../providers/path-ref-parse.js';
import { ABS_FILE_RE_SRC } from './path-ref-patterns.js';
import { LETTER_ID_SRC } from './letter-id-shape.js';
import { isFullTaskId, TASK_TOKEN_SRC } from './task-id-shape.js';
import { trimTrailingPunctuation, trimUrlCjkTail, URL_RUN_SRC } from './url-text.js';

export type RefKind = 'url' | 'file' | 'task' | 'letter';

export const ALL_REF_KINDS: readonly RefKind[] = ['url', 'file', 'task', 'letter'];

export interface RefLinkOptions {
  /** A per-reader secret (32 lowercase hex). Anything else is ignored: the link
   *  then uses the query form and the hand-off page asks before opening. */
  token?: string;
  /** Where `/open-ref` lives. Default the relative `/open-ref`; pass an absolute
   *  URL for a document with no usable base (a file URL on the phone). */
  refBase?: string;
  /** Which references to link. Default all four. */
  kinds?: readonly RefKind[];
}

export interface AgentRef {
  kind: RefKind;
  /** Offsets in the scanned text, end exclusive. */
  start: number;
  end: number;
  /** The text as written (the anchor's visible text). */
  text: string;
  /** Where the anchor points: the URL itself, or the `/open-ref` hand-off. */
  href: string;
  /** file: the path without its position suffix. */
  path?: string;
  line?: number;
  endLine?: number;
  /** task / letter: the id. */
  id?: string;
}

export type OpenRefTarget =
  | { kind: 'file'; path: string; line?: number; endLine?: number }
  | { kind: 'task'; id: string }
  | { kind: 'letter'; id: string };

/** A run this long with no break but plain spaces is scanned word by word. */
export const REF_SEGMENT_MAX = 32 * 1024;
/** A word (no whitespace, no `<`) longer than this is never linked. */
export const REF_WORD_MAX = 4096;

const REF_TOKEN_RE = /^[0-9a-f]{32}$/;

export function isRefToken(token: unknown): token is string {
  return typeof token === 'string' && REF_TOKEN_RE.test(token);
}

/** The hand-off href for a file, task or letter reference. */
export function openRefHref(target: OpenRefTarget, opts: RefLinkOptions = {}): string {
  const base = opts.refBase || '/open-ref';
  const params: Array<[string, string]> = [['kind', target.kind]];
  if (target.kind === 'file') {
    params.push(['path', target.path]);
    if (target.line) {
      params.push(['line', String(target.line)]);
      if (target.endLine && target.endLine > target.line) params.push(['endLine', String(target.endLine)]);
    }
  } else {
    params.push(['id', target.id]);
  }
  const q = params.map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join('&');
  return isRefToken(opts.token) ? `${base}#token=${opts.token}&${q}` : `${base}?${q}`;
}

export function escapeHtmlText(s: string): string {
  return s.replace(/[&<>"']/g, (c) =>
    c === '&' ? '&amp;' : c === '<' ? '&lt;' : c === '>' ? '&gt;' : c === '"' ? '&quot;' : '&#39;');
}

/** `<a …>` for a reference; the caller writes the visible text and `</a>`. */
export function refAnchorOpen(kind: RefKind, href: string): string {
  return `<a href="${escapeHtmlText(href)}" target="_blank" rel="noopener noreferrer" data-walnut-ref="${kind}">`;
}

const KIND_ORDER: Record<RefKind, number> = { url: 0, letter: 1, file: 2, task: 3 };
// Compiled once: refsInUnit runs per unit (millions on a big body) and never re-enters.
const URL_G = new RegExp(URL_RUN_SRC, 'g');
const LETTER_G = new RegExp(LETTER_ID_SRC, 'g');
const FILE_G = new RegExp(ABS_FILE_RE_SRC, 'g');
const TASK_G = new RegExp(TASK_TOKEN_SRC, 'g');

function* matches(re: RegExp, text: string): Generator<RegExpExecArray> {
  re.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    if (m[0].length === 0) re.lastIndex++;
    yield m;
  }
}

/** References inside one unit, offsets relative to it, non-overlapping. */
export function refsInUnit(unit: string, opts: RefLinkOptions = {}): AgentRef[] {
  const kinds = opts.kinds ?? ALL_REF_KINDS;
  const found: AgentRef[] = [];
  if (kinds.includes('url') && unit.includes('://')) {
    for (const m of matches(URL_G, unit)) {
      const href = trimTrailingPunctuation(trimUrlCjkTail(m[0]));
      if (!href) continue;
      found.push({ kind: 'url', start: m.index, end: m.index + href.length, text: href, href });
    }
  }
  if (kinds.includes('letter') && unit.includes('lt-')) {
    for (const m of matches(LETTER_G, unit)) {
      const id = m[0];
      found.push({ kind: 'letter', start: m.index, end: m.index + id.length, text: id, id, href: openRefHref({ kind: 'letter', id }, opts) });
    }
  }
  if (kinds.includes('file') && unit.includes('/')) {
    for (const m of matches(FILE_G, unit)) {
      const path = m[1]!;
      // `/api/...` is this server's own route (an image, a download), not a file.
      if (path.startsWith('/api/')) continue;
      const pos = m[2] ? parsePathRef(`x${m[2]}`) : undefined;
      const line = pos?.line;
      const endLine = line && pos?.endLine && pos.endLine > line ? pos.endLine : undefined;
      found.push({
        kind: 'file', start: m.index, end: m.index + m[0].length, text: m[0], path,
        ...(line ? { line } : {}), ...(endLine ? { endLine } : {}),
        href: openRefHref({ kind: 'file', path, ...(line ? { line } : {}), ...(endLine ? { endLine } : {}) }, opts),
      });
    }
  }
  if (kinds.includes('task') && unit.includes('-')) {
    for (const m of matches(TASK_G, unit)) {
      const id = m[0];
      // A whole id only, never a prefix: only the label store can say which task a
      // prefix names.
      if (!isFullTaskId(id)) continue;
      found.push({ kind: 'task', start: m.index, end: m.index + id.length, text: id, id, href: openRefHref({ kind: 'task', id }, opts) });
    }
  }
  if (found.length < 2) return found;
  found.sort((a, b) => a.start - b.start || KIND_ORDER[a.kind] - KIND_ORDER[b.kind] || b.end - a.end);
  const out: AgentRef[] = [];
  let reach = 0;
  for (const r of found) {
    if (r.start < reach) continue;
    out.push(r);
    reach = r.end;
  }
  return out;
}

/** Ends a unit and goes back to whole-run scanning: whitespace but a plain space, or `<`. */
const HARD_BREAK_RE = /[^\S ]|</g;
/** Ends a word: any whitespace or `<`. */
const WORD_BREAK_RE = /[\s<]/g;

type SplitMode = 'run' | 'word' | 'drop';

/**
 * Cuts literal text into scan units: after any whitespace but a plain space, or
 * after `<` (no reference holds one). A run with no such break in REF_SEGMENT_MAX
 * characters is scanned word by word; a word over REF_WORD_MAX is passed through
 * unlinked. Every cut depends on the text only, so chunking never changes the
 * result. `onUnit(text, start, scan)`: `start` counts across pushes.
 */
export class RefUnitSplitter {
  private buf = '';
  private bufStart = 0;
  private searched = 0;
  private mode: SplitMode = 'run';

  constructor(private readonly onUnit: (text: string, start: number, scan: boolean) => void) {}

  /** Offset of the first character not yet handed out, or null when none is held. */
  pendingStart(): number | null {
    return this.buf.length > 0 ? this.bufStart : null;
  }

  push(text: string): void {
    if (!text) return;
    this.buf += text;
    this.drain();
  }

  /** The run ended (a tag, the end of the text): hand out what is held. */
  finish(): void {
    if (this.buf) this.take(this.buf.length, this.mode !== 'drop');
    this.mode = 'run';
  }

  private take(len: number, scan: boolean): void {
    const text = this.buf.slice(0, len);
    const start = this.bufStart;
    this.buf = this.buf.slice(len);
    this.bufStart += len;
    this.searched = 0;
    this.onUnit(text, start, scan);
  }

  /** First break at or after `searched` within the first `limit + 1` characters. */
  private findBreak(re: RegExp, limit: number): number {
    const window = Math.min(this.buf.length, limit + 1);
    re.lastIndex = this.searched;
    const m = re.exec(this.buf);
    if (m && m.index < window) return m.index;
    this.searched = window;
    return -1;
  }

  private drain(): void {
    for (;;) {
      if (this.mode === 'run') {
        const k = this.findBreak(HARD_BREAK_RE, REF_SEGMENT_MAX);
        if (k >= 0) { this.take(k + 1, true); continue; }
        if (this.buf.length > REF_SEGMENT_MAX) { this.mode = 'word'; this.searched = 0; continue; }
        return;
      }
      const k = this.findBreak(WORD_BREAK_RE, this.mode === 'word' ? REF_WORD_MAX : Number.MAX_SAFE_INTEGER);
      if (k >= 0) {
        const hard = this.buf[k] !== ' ';
        this.take(k + 1, this.mode === 'word');
        if (hard) this.mode = 'run';
        else if (this.mode === 'drop') this.mode = 'word';
        continue;
      }
      if (this.mode === 'word' && this.buf.length > REF_WORD_MAX) { this.mode = 'drop'; continue; }
      if (this.mode === 'drop' && this.buf) this.take(this.buf.length, false);
      return;
    }
  }
}

export interface ScanOptions extends RefLinkOptions {
  /** Start here (a unit boundary works best: a line start, a space). */
  from?: number;
  to?: number;
  /** Read at most about this many characters, then stop where a unit ends
   *  (default: all of it). `end` in the answer says where it stopped. */
  limit?: number;
}

/**
 * References in `text[from, to)`, offsets in `text`. Memory stays bounded
 * whatever the length (the text is fed in slices, one unit held at a time).
 * With `limit`, reads about that many characters and stops where a unit ends;
 * `end` says where, so a caller can continue from there in a later tick.
 */
export function scanAgentTextRefs(text: string, opts: ScanOptions = {}): { refs: AgentRef[]; end: number } {
  const from = Math.max(0, Math.min(opts.from ?? 0, text.length));
  const to = Math.max(from, Math.min(opts.to ?? text.length, text.length));
  const limit = opts.limit ?? Number.POSITIVE_INFINITY;
  const refs: AgentRef[] = [];
  let end = from;
  const splitter = new RefUnitSplitter((unit, start, scan) => {
    if (scan) {
      for (const r of refsInUnit(unit, opts)) {
        refs.push({ ...r, start: from + start + r.start, end: from + start + r.end });
      }
    }
    end = from + start + unit.length;
  });
  const STEP = Math.max(1, Math.min(64 * 1024, limit));
  let pos = from;
  while (pos < to && end - from < limit) {
    const next = Math.min(to, pos + STEP);
    splitter.push(text.slice(pos, next));
    pos = next;
  }
  if (pos >= to) splitter.finish();
  return { refs, end };
}

/** Every reference in a text. */
export function findAgentTextRefs(text: string, opts: ScanOptions = {}): AgentRef[] {
  return scanAgentTextRefs(text, opts).refs;
}

/**
 * Literal text to safe HTML: every character escaped, each reference wrapped in
 * its anchor. No markdown: `*`, `#` and backticks stay what they are.
 */
export function linkAgentText(text: string, opts: RefLinkOptions = {}): string {
  const { refs } = scanAgentTextRefs(text, { ...opts, from: 0, to: text.length, limit: Number.POSITIVE_INFINITY });
  let out = '';
  let cursor = 0;
  for (const r of refs) {
    out += escapeHtmlText(text.slice(cursor, r.start));
    out += refAnchorOpen(r.kind, r.href) + escapeHtmlText(r.text) + '</a>';
    cursor = r.end;
  }
  return out + escapeHtmlText(text.slice(cursor));
}
