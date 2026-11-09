/**
 * The security pass over an agent's HTML. It reads the WHOLE document the reader
 * parses (the trusted frame head included) with parse5's standard Tokenizer and
 * Parser, so every tokenizer state (comments, `--!>`, CDATA in foreign content,
 * raw text, `<plaintext>`, `<noscript>` per the scripting flag) is the one a
 * browser's tree construction picks. The source is copied out byte for byte; the
 * only change is attributes added right after the tag name of start tags:
 *
 *   a, area   rel="noopener noreferrer" referrerpolicy="no-referrer"
 *   meta      name="" http-equiv=""     (no refresh, no referrer policy can act)
 *   iframe    srcdoc=""                  (no nested document this pass never saw)
 *
 * The first of a repeated attribute wins in HTML, so these hold whatever the tag
 * says after them. They go into every such start tag token, also one the tree
 * then ignores (harmless there). An added attribute changes no tree construction
 * rule, and the model below includes it, so the output parses into the same tree
 * this pass reasoned about; a tag is never removed (a `<meta>` leaves foreign
 * content, so deleting one would change how everything after it is read).
 *
 * Memory does not grow with a long attribute value, comment, text run, tag name,
 * character reference or many closed elements: the token strings the tree needs
 * are kept short (a long one becomes its head plus a SHA-256 of the rest, so equal
 * stays equal), text and comments are not kept, and the tree keeps only the
 * elements still open or in the active formatting list. What remains grows only
 * with the open element depth, the active formatting elements and the attribute
 * count of one formatting start tag, all of which the reader's DOM holds too.
 *
 * parse5 is pinned to 8.0.0; required Parser and Tokenizer hooks are checked at load.
 */

import { SecurityParser } from './agent-html-parser.js';
import { BoundedAdapter } from './agent-html-tree.js';

export { IFRAME_EMPTY_ATTRS, LINK_SAFE_ATTRS, META_OFF_ATTRS } from './agent-html-tokenizer.js';
export { sha256Utf16Hex } from './agent-html-token-fold.js';

/** Input is fed to the tokenizer in pieces this long, which bounds its buffer and each output chunk. */
const SLICE = 16 * 1024;

export interface AgentHtmlSecurityOptions {
  /** Receives the output, in order: at most one bounded chunk per 16K of input, and one at end(). */
  onOutput: (html: string) => void;
  /** The reader's scripting flag: false for a sandbox without scripts, where `<noscript>` holds markup. */
  scriptingEnabled: boolean;
  /**
   * The input begins with exactly these characters (the frame head Walnut wrote). They are parsed
   * like the rest, so the tree context is the reader's, and copied out with no attribute added.
   */
  trustedPrefix?: string;
  /**
   * Text the tree inserted, in order, as source spans [rawStart, rawEnd) of the input (prefix
   * included; decode them yourself). linkable = not under an open head, title, raw-text element,
   * svg, math, template, a, button, form control, object or media element (noscript only when
   * scripting). A run is cut between whitespace and other text, at every 16K of input and at a
   * character reference never (a reference's span starts at its `&`; one longer than 64
   * characters reports no source and cuts the run). Text the tree ignores is never reported.
   */
  onTextSegment?: (rawStart: number, rawEnd: number, linkable: boolean) => void;
  /**
   * The text run reported since the last call is over: a tag, comment or doctype starts, or the
   * next span does not start where the last one ended (source the reader drops, e.g. `</>`).
   */
  onMarkupBoundary?: () => void;
  /** A tag the tree processed: `<` to after `>`, and whether its place is outside the elements above (itself excluded). */
  onTag?: (tagName: string, rawStart: number, rawEnd: number, closing: boolean, linkable: boolean) => void;
  /** An `<a>`/`<area>` start tag's name ends at rawNameEnd, where LINK_SAFE_ATTRS go (never inside trustedPrefix). */
  onLinkTagName?: (tagName: 'a' | 'area', rawNameEnd: number) => void;
}

export interface AgentHtmlSecurityStats {
  /** Longest source span held back from the output. */
  maxHeldChars: number;
  /** Longest tokenizer buffer. */
  maxBufferChars: number;
  /** Longest string a token, attribute or pending character token held. */
  maxTokenChars: number;
  /** Most elements the tree held. */
  maxTreeNodes: number;
  /** Most character tokens held for a table. */
  maxPendingTableText: number;
  /** Longest single onOutput chunk. */
  maxOutputChunk: number;
}

export interface AgentHtmlSecurity {
  write(chunk: string): void;
  end(): void;
  /**
   * Source before this offset is final: no later callback reports a text span starting before it
   * (pending `<`, `</`, `]]` and short references hold it back). A tag still being read may have
   * started before it (onTag's rawStart). Monotonic; the input length after end().
   */
  processedEnd(): number;
  /** High-water marks of the memory this pass held, for tests and diagnostics. */
  stats(): AgentHtmlSecurityStats;
}

// ---------------------------------------------------------------------------

class SecurityPass implements AgentHtmlSecurity {
  private readonly onOutput: (html: string) => void;
  private readonly prefix: string;
  private readonly adapter = new BoundedAdapter();
  private readonly parser: SecurityParser;
  private out: string[] = [];
  /** Source not yet copied out: raw covers [rawBase, total). */
  private raw = '';
  private rawBase = 0;
  private total = 0;
  private emitted = 0;
  private released = 0;
  private ended = false;
  private readonly observe: boolean;
  private readonly onTextSegment: AgentHtmlSecurityOptions['onTextSegment'];
  private readonly onMarkupBoundary: AgentHtmlSecurityOptions['onMarkupBoundary'];
  /** Text was reported since the last boundary, ending here. */
  private textSince = false;
  private textEnd = -1;
  private readonly st: AgentHtmlSecurityStats = {
    maxHeldChars: 0, maxBufferChars: 0, maxTokenChars: 0, maxTreeNodes: 0, maxPendingTableText: 0, maxOutputChunk: 0,
  };

  constructor(opts: AgentHtmlSecurityOptions) {
    this.onOutput = opts.onOutput;
    this.prefix = opts.trustedPrefix ?? '';
    this.onTextSegment = opts.onTextSegment;
    this.onMarkupBoundary = opts.onMarkupBoundary;
    this.observe = !!(opts.onTextSegment || opts.onMarkupBoundary || opts.onTag);
    this.parser = new SecurityParser(opts.scriptingEnabled, this.adapter, {
      prefixLen: this.prefix.length,
      observe: this.observe,
      insert: (at, text) => this.insert(at, text),
      boundary: () => this.boundary(),
      linkTagName: opts.onLinkTagName,
    }, {
      onText: this.observe ? (s, e, linkable) => this.text(s, e, linkable) : undefined,
      onTag: opts.onTag,
    });
  }

  write(chunk: string): void {
    if (this.ended) throw new Error('agent-html-security: write() after end()');
    for (let i = 0; i < chunk.length; i += SLICE) this.feed(chunk.slice(i, i + SLICE));
  }

  end(): void {
    if (this.ended) return;
    this.ended = true;
    if (this.total < this.prefix.length) throw new Error('agent-html-security: input ended inside trustedPrefix');
    this.parser.bounded.write('', true);
    this.boundary();
    this.settle(this.total);
  }

  processedEnd(): number {
    return this.released;
  }

  stats(): AgentHtmlSecurityStats {
    return { ...this.st, maxTreeNodes: Math.max(this.st.maxTreeNodes, this.adapter.maxNodes) };
  }

  private feed(s: string): void {
    if (this.total < this.prefix.length && !s.startsWith(this.prefix.slice(this.total, this.total + s.length))) {
      this.ended = true;
      throw new Error('agent-html-security: input does not start with trustedPrefix');
    }
    this.raw += s;
    this.total += s.length;
    const tok = this.parser.bounded;
    tok.write(s, false);
    tok.flushPendingText();
    this.settle(tok.processedEnd());
  }

  private text(s: number, e: number, linkable: boolean): void {
    if (this.textSince && s !== this.textEnd) this.boundary();
    this.textSince = true;
    this.textEnd = e;
    this.onTextSegment?.(s, e, linkable);
  }

  private boundary(): void {
    if (!this.textSince) return;
    this.textSince = false;
    this.onMarkupBoundary?.();
  }

  private insert(at: number, text: string): void {
    // Cannot happen: an attribute goes where the tokenizer reads now, and only what it has read is out.
    if (at < this.emitted) throw new Error('agent-html-security: an attribute would land in output already sent');
    this.copyTo(at);
    this.out.push(text);
  }

  private copyTo(to: number): void {
    if (to <= this.emitted) return;
    this.out.push(this.raw.slice(this.emitted - this.rawBase, to - this.rawBase));
    this.emitted = to;
  }

  private settle(safe: number): void {
    const st = this.st;
    st.maxHeldChars = Math.max(st.maxHeldChars, this.raw.length);
    st.maxBufferChars = Math.max(st.maxBufferChars, this.parser.bounded.preprocessor.html.length);
    st.maxTokenChars = Math.max(st.maxTokenChars, this.parser.bounded.longestHeld());
    st.maxPendingTableText = Math.max(st.maxPendingTableText, this.parser.pendingCharacterTokens.length);
    this.copyTo(safe);
    const floor = this.ended ? this.total : this.observe ? Math.min(this.emitted, this.parser.bounded.textFloor()) : this.emitted;
    if (floor > this.released) this.released = floor;
    this.raw = this.raw.slice(this.emitted - this.rawBase);
    this.rawBase = this.emitted;
    if (this.out.length === 0) return;
    const chunk = this.out.join('');
    this.out = [];
    st.maxOutputChunk = Math.max(st.maxOutputChunk, chunk.length);
    if (chunk) this.onOutput(chunk);
  }
}

/** A streaming security pass: write() chunks in order, then end(). */
export function createAgentHtmlSecurity(opts: AgentHtmlSecurityOptions): AgentHtmlSecurity {
  return new SecurityPass(opts);
}

/** The same pass over a whole document, synchronously. */
export function secureAgentHtml(source: string, opts: Omit<AgentHtmlSecurityOptions, 'onOutput'>): string {
  const parts: string[] = [];
  const pass = createAgentHtmlSecurity({ ...opts, onOutput: (s) => parts.push(s) });
  pass.write(source);
  pass.end();
  return parts.join('');
}