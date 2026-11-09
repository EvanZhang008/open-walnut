/**
 * Streams an agent's HTML through standard tree construction and copies the source
 * out byte for byte, adding links: references in visible text are wrapped in an
 * anchor (their own bytes kept inside), `<task-ref>` becomes a task anchor, and an
 * `<a href>` to a local file or `letter:` gets the `/open-ref` href. Every `<a>` and
 * `<area>` the agent wrote gets NO_REFERRER_ATTRS right after its name, ahead of its
 * own attributes (the first of a repeated attribute wins), whatever its length.
 * Meta tags keep their shape; the standard HTML security pass handles them.
 * Memory stays bounded and the output does not depend on how the input is chunked.
 */

import { Tokenizer } from 'htmlparser2';
import { DecodingMode, EntityDecoder, htmlDecodeTree } from 'entities/decode';
import { createAgentHtmlSecurity, type AgentHtmlSecurity } from './agent-html-security.js';
import {
  escapeHtmlText,
  openRefHref,
  refAnchorOpen,
  RefUnitSplitter,
  refsInUnit,
  ALL_REF_KINDS,
  type RefLinkOptions,
} from './agent-text-refs.js';
import { isFullTaskId } from './task-id-shape.js';
import { LETTER_HREF_SRC } from './letter-id-shape.js';
import { absoluteDestinationPath, localDestination } from './path-destination.js';

export interface AgentHtmlLinker {
  write(chunk: string): void;
  end(): void;
}

export interface AgentHtmlLinkerOptions extends RefLinkOptions {
  scriptingEnabled?: boolean;
  onFileReference?: (offset: number, path: string, end: number) => void;
  /** Receives the output, in order: at most once per write() and once at end(). */
  onOutput: (html: string) => void;
}

/** A `<task-ref>` or `<a>` tag longer than this is left as written (NO_REFERRER_ATTRS still go in). */
export const REF_TAG_MAX = 2048;
/**
 * Put first in every agent link, so a click never sends the document's URL (a
 * deferred body's carries the reader token) as Referer, whatever `<meta
 * name="referrer">` the agent wrote, and the opened page gets no opener.
 */
export const NO_REFERRER_ATTRS = ' rel="noopener noreferrer" referrerpolicy="no-referrer"';
/** Tag names longer than this are not read (none of the ones that matter is). */
const NAME_MAX = 32;

const INPUT_SLICE = 16 * 1024;

interface Piece {
  /** Decoded offset (splitter coordinates) and length. */
  dec: number;
  decLen: number;
  /** Absolute source offsets. */
  raw: number;
  rawEnd: number;
  entity: boolean;
}

interface TagAttr {
  value: string;
  nameEnd: number;
  /** Source span of the value with its quotes; absent for a bare `target`. */
  valueStart?: number;
  valueEnd?: number;
}

/** A completed reference start tag. */
interface PendingTag {
  name: 'task-ref' | 'a';
  start: number;
  /** Output is held from here until the tag's `>`: the `<` for a task-ref, past the inserted attributes for an `<a>`. */
  hold: number;
  nameEnd: number;
  attrs: Map<string, TagAttr>;
  cur: { name: string; nameEnd: number; value: string } | null;
}

class Linker implements AgentHtmlLinker {
  private readonly parser: AgentHtmlSecurity;
  private readonly opts: RefLinkOptions;
  private readonly onFileReference?: (offset: number, path: string, end: number) => void;
  private readonly linkTasks: boolean;
  private readonly fixAnchors: boolean;
  private readonly onOutput: (html: string) => void;
  private out: string[] = [];

  /** Source not yet copied out: raw covers [rawBase, total). */
  private raw = '';
  private rawBase = 0;
  private total = 0;
  private emitted = 0;
  private pendingRef: PendingTag | null = null;
  private lastNameEnd = 0;
  private textEnd = 0;

  private readonly splitter: RefUnitSplitter;
  private pieces: Piece[] = [];
  private dec = 0;
  private ended = false;

  constructor(opts: AgentHtmlLinkerOptions) {
    const { onOutput, onFileReference, scriptingEnabled, ...rest } = opts;
    this.onFileReference = onFileReference;
    this.opts = rest;
    this.onOutput = onOutput;
    const kinds = rest.kinds ?? ALL_REF_KINDS;
    this.linkTasks = kinds.includes('task');
    this.fixAnchors = kinds.includes('file') || kinds.includes('letter');
    this.splitter = new RefUnitSplitter((text, start, scan) => this.unit(text, start, scan));
    this.parser = createAgentHtmlSecurity({
      scriptingEnabled: scriptingEnabled ?? true,
      onOutput: () => {},
      onTextSegment: (s, e, linkable) => this.text(s, e, linkable),
      onMarkupBoundary: () => this.endRun(),
      onTag: (name, s, e, closing, linkable) => { if (!closing && linkable) this.tag(name, s, e); },
      onLinkTagName: (_name, end) => {
        this.endRun();
        this.copyTo(end);
        this.out.push(NO_REFERRER_ATTRS);
        this.lastNameEnd = end;
      },
    });
  }

  write(chunk: string): void {
    if (this.ended || !chunk) return;
    for (let at = 0; at < chunk.length; at += INPUT_SLICE) {
      const part = chunk.slice(at, at + INPUT_SLICE);
      this.raw += part;
      this.total += part.length;
      this.parser.write(part);
      this.settle();
    }
    this.flushOut();
  }

  end(): void {
    if (this.ended) return;
    this.ended = true;
    this.parser.end();
    this.endRun();
    this.pendingRef = null;
    this.copyTo(this.total);
    this.raw = '';
    this.rawBase = this.total;
    this.flushOut();
  }

  private flushOut(): void {
    if (this.out.length === 0) return;
    const html = this.out.join('');
    this.out = [];
    if (html) this.onOutput(html);
  }

  /** Copy the source out up to `to` (never backwards). */
  private copyTo(to: number): void {
    if (to <= this.emitted) return;
    this.out.push(this.raw.slice(this.emitted - this.rawBase, to - this.rawBase));
    this.emitted = to;
  }

  private slice(s: number, e: number): string {
    const from = Math.max(s, this.rawBase);
    return e > from ? this.raw.slice(from - this.rawBase, e - this.rawBase) : '';
  }

  private settle(): void {
    let safe = Math.min(this.parser.processedEnd(), Math.max(this.emitted, this.total - REF_TAG_MAX));
    const held = this.splitter.pendingStart();
    if (held !== null) safe = Math.min(safe, this.mapStart(held));
    const before = this.raw.charCodeAt(safe - this.rawBase - 1);
    const after = this.raw.charCodeAt(safe - this.rawBase);
    if (before >= 0xd800 && before <= 0xdbff && after >= 0xdc00 && after <= 0xdfff) safe--;
    this.copyTo(safe);
    const keep = Math.min(this.emitted, Math.max(0, this.total - REF_TAG_MAX));
    if (keep > this.rawBase) {
      this.raw = this.raw.slice(keep - this.rawBase);
      this.rawBase = keep;
    }
  }

  private tag(name: string, start: number, end: number): void {
    const refTag = (name === 'task-ref' && this.linkTasks) || (name === 'a' && this.fixAnchors);
    if (!refTag || end - start > REF_TAG_MAX || start < this.rawBase) return;
    const markup = this.slice(start, end);
    const ref: PendingTag = {
      name: name as PendingTag['name'], start, hold: name === 'a' ? this.lastNameEnd : start,
      nameEnd: start + 1 + name.length, attrs: new Map(), cur: null,
    };
    if (ref.hold < this.emitted) return;
    this.pendingRef = ref;
    const tokenizer = new Tokenizer({ xmlMode: false, decodeEntities: true }, {
      ontext: () => {}, ontextentity: () => {}, onopentagname: () => {},
      onattribname: (s, e) => this.attrName(start + s, start + e),
      onattribdata: (s, e) => this.attrData(markup.slice(s, e)),
      onattribentity: (cp) => this.attrData(String.fromCodePoint(cp)),
      onattribend: (_q, e) => this.attrEnd(start + e),
      onopentagend: () => {}, onselfclosingtag: () => {}, onclosetag: () => {},
      oncomment: () => {}, oncdata: () => {}, ondeclaration: () => {}, onprocessinginstruction: () => {}, onend: () => {},
    });
    tokenizer.write(markup);
    tokenizer.end();
    this.pendingRef = null;
    if (name === 'task-ref') this.replaceTaskRef(ref, end);
    else this.retargetAnchor(ref, end);
  }

  private attrName(s: number, e: number): void {
    const ref = this.pendingRef;
    if (!ref) return;
    ref.cur = e - s <= NAME_MAX ? { name: this.slice(s, e).toLowerCase(), nameEnd: e, value: '' } : null;
  }

  private attrData(data: string): void {
    const cur = this.pendingRef?.cur;
    if (cur && cur.value.length <= REF_TAG_MAX) cur.value += data;
  }

  /** `end`: after the closing quote, at the end of an unquoted value, or the
   *  name's end for a bare attribute. The first of a repeated name counts. */
  private attrEnd(end: number): void {
    const ref = this.pendingRef;
    const cur = ref?.cur;
    if (!ref || !cur) return;
    ref.cur = null;
    if (ref.attrs.has(cur.name)) return;
    const attr: TagAttr = { value: cur.value, nameEnd: cur.nameEnd };
    const lead = /^\s*=\s*/.exec(this.slice(cur.nameEnd, end));
    if (lead && end > cur.nameEnd + lead[0].length) {
      attr.valueStart = cur.nameEnd + lead[0].length;
      attr.valueEnd = end;
    }
    ref.attrs.set(cur.name, attr);
  }

  private replaceTaskRef(ref: PendingTag, end: number): void {
    if (end - ref.start > REF_TAG_MAX || ref.hold < this.emitted) return;
    const id = (ref.attrs.get('id')?.value ?? '').trim();
    if (!isFullTaskId(id)) return; // a prefix or unknown id stays as written; only a full id opens
    const label = (ref.attrs.get('label')?.value ?? '').trim() || id;
    this.copyTo(ref.start);
    this.out.push(refAnchorOpen('task', openRefHref({ kind: 'task', id }, this.opts)) + escapeHtmlText(label) + '</a>');
    this.emitted = end;
  }

  /** A local-file or letter href would navigate to a server path; only href and target change. */
  private retargetAnchor(ref: PendingTag, end: number): void {
    if (end - ref.start > REF_TAG_MAX || ref.hold < this.emitted) return;
    const href = ref.attrs.get('href');
    if (!href || href.valueStart === undefined || href.valueEnd === undefined) return;
    const next = this.anchorTarget(href.value);
    if (!next) return;
    if (next.path) this.onFileReference?.(href.valueStart, next.path, href.valueEnd);
    const edits: Array<{ at: number; to: number; text: string }> = [
      { at: href.valueStart, to: href.valueEnd, text: `"${escapeHtmlText(next.href)}"` },
    ];
    // Set (or add) an attribute to a fixed value, keeping its place when it exists.
    const setAttr = (name: string, value: string): void => {
      const a = ref.attrs.get(name);
      if (!a) edits.push({ at: ref.nameEnd, to: ref.nameEnd, text: ` ${name}="${value}"` });
      else if (a.valueStart !== undefined && a.valueEnd !== undefined) edits.push({ at: a.valueStart, to: a.valueEnd, text: `"${value}"` });
      else edits.push({ at: a.nameEnd, to: a.nameEnd, text: `="${value}"` });
    };
    setAttr('target', '_blank');
    // Surfaces that open a reference in place find it by this marker.
    setAttr('data-walnut-ref', next.kind);
    edits.sort((a, b) => a.at - b.at);
    for (const ed of edits) {
      this.copyTo(ed.at);
      this.out.push(ed.text);
      this.emitted = ed.to;
    }
  }

  /** The hand-off href an anchor destination maps to, or null to leave it. */
  private anchorTarget(raw: string): { href: string; kind: 'file' | 'letter'; path?: string } | null {
    let dest = raw.trim();
    const kinds = this.opts.kinds ?? ALL_REF_KINDS;
    const letter = new RegExp(LETTER_HREF_SRC).exec(dest);
    if (letter) return kinds.includes('letter') ? { kind: 'letter', href: openRefHref({ kind: 'letter', id: letter[1]! }, this.opts) } : null;
    if (!kinds.includes('file') || dest.startsWith('/api/')) return null;
    // An HTML href is percent-encoded (`My%20Notes.md`); the file name is not.
    if (/%[0-9A-Fa-f]{2}/.test(dest)) {
      try { dest = decodeURI(dest); } catch { return null; }
    }
    const d = localDestination(dest);
    const path = d && absoluteDestinationPath(d);
    if (!d || !path) return null;
    const line = d.line;
    const endLine = line && d.endLine && d.endLine > line ? d.endLine : undefined;
    return { kind: 'file', path, href: openRefHref({ kind: 'file', path, ...(line ? { line } : {}), ...(endLine ? { endLine } : {}) }, this.opts) };
  }

  private text(s: number, e: number, linkable: boolean): void {
    if (!linkable) { this.endRun(); return; }
    if (s !== this.textEnd) this.endRun();
    this.textEnd = e;
    const from = Math.max(s, this.emitted);
    if (e <= from) return;
    const raw = this.slice(from, e);
    let cursor = 0;
    let at = 0;
    let decoded = '';
    const decoder = new EntityDecoder(htmlDecodeTree, (cp) => { decoded += String.fromCodePoint(cp); });
    while ((at = raw.indexOf('&', at)) >= 0) {
      decoder.startEntity(DecodingMode.Legacy);
      decoded = '';
      let consumed = decoder.write(raw, at + 1);
      if (consumed < 0) consumed = decoder.end();
      if (consumed > 0) {
        if (at > cursor) this.addPiece(raw.slice(cursor, at), from + cursor, from + at, false);
        this.addPiece(decoded, from + at, from + at + consumed, true);
        cursor = at + consumed;
        at = cursor;
      } else at++;
    }
    if (cursor < raw.length) this.addPiece(raw.slice(cursor), from + cursor, e, false);
  }

  private addPiece(decoded: string, raw: number, rawEnd: number, entity: boolean): void {
    const last = this.pieces[this.pieces.length - 1];
    if (!entity && last && !last.entity && last.rawEnd === raw) {
      last.decLen += decoded.length;
      last.rawEnd = rawEnd;
    } else {
      this.pieces.push({ dec: this.dec, decLen: decoded.length, raw, rawEnd, entity });
    }
    this.dec += decoded.length;
    this.splitter.push(decoded);
  }

  private endRun(): void {
    this.splitter.finish();
    this.pieces = [];
  }

  /** The piece holding decoded offset `d` (`d` may equal the very end). */
  private pieceAt(d: number, endSide: boolean): Piece | undefined {
    let lo = 0;
    let hi = this.pieces.length - 1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      const p = this.pieces[mid]!;
      const pEnd = p.dec + p.decLen;
      if (endSide ? d <= p.dec : d < p.dec) hi = mid - 1;
      else if (endSide ? d > pEnd : d >= pEnd) lo = mid + 1;
      else return p;
    }
    return undefined;
  }

  /** Source offset where decoded offset `d` starts; NaN inside an entity. */
  private mapStart(d: number): number {
    const p = this.pieceAt(d, false);
    if (!p) {
      const last = this.pieces[this.pieces.length - 1];
      return last && d === last.dec + last.decLen ? last.rawEnd : Number.NaN;
    }
    if (p.entity) return d === p.dec ? p.raw : Number.NaN;
    return p.raw + (d - p.dec);
  }

  /** Source offset where decoded offset `d` ends; NaN inside an entity. */
  private mapEnd(d: number): number {
    const p = this.pieceAt(d, true);
    if (!p) return Number.NaN;
    if (p.entity) return d === p.dec + p.decLen ? p.rawEnd : Number.NaN;
    return p.raw + (d - p.dec);
  }

  private unit(text: string, start: number, scan: boolean): void {
    const rawEnd = this.mapEnd(start + text.length);
    if (scan) {
      for (const r of refsInUnit(text, this.opts)) {
        const rs = this.mapStart(start + r.start);
        const re = this.mapEnd(start + r.end);
        if (!(rs >= this.emitted) || !(re > rs)) continue;
        this.copyTo(rs);
        if (r.path) this.onFileReference?.(rs, r.path, re);
        const anchor = refAnchorOpen(r.kind, r.href);
        this.out.push(anchor);
        this.copyTo(re);
        this.out.push('</a>');
      }
    }
    if (rawEnd >= 0) this.copyTo(rawEnd);
    const keepFrom = start + text.length;
    let i = 0;
    while (i < this.pieces.length && this.pieces[i]!.dec + this.pieces[i]!.decLen <= keepFrom) i++;
    if (i > 0) this.pieces.splice(0, i);
  }
}

/** A streaming linker: write() chunks in order, then end(). */
export function createAgentHtmlLinker(opts: AgentHtmlLinkerOptions): AgentHtmlLinker {
  return new Linker(opts);
}

/** The same linker over a whole document, synchronously. */
export function linkAgentHtml(html: string, opts: Omit<AgentHtmlLinkerOptions, 'onOutput'> = {}): string {
  const parts: string[] = [];
  const linker = createAgentHtmlLinker({ ...opts, onOutput: (s) => parts.push(s) });
  linker.write(html);
  linker.end();
  return parts.join('');
}
