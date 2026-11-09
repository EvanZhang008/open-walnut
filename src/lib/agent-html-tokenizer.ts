/** parse5's Tokenizer with its strings kept short, the security attributes added, and source spans tracked. */

import { Tokenizer, Token, TokenizerMode, type TokenizerOptions, type TokenHandler } from 'parse5';
import { Folder } from './agent-html-token-fold.js';
import type { BoundedAdapter } from './agent-html-tree.js';

type CharacterToken = Token.CharacterToken;
const TT = Token.TokenType;

/** Added after the name of every `<a>` and `<area>` (the same text as the linker's NO_REFERRER_ATTRS). */
export const LINK_SAFE_ATTRS = ' rel="noopener noreferrer" referrerpolicy="no-referrer"';
/** Added after the name of every `<meta>`: its charset stays, a pragma or a named policy cannot act. */
export const META_OFF_ATTRS = ' name="" http-equiv=""';
/** Added after the name of every `<iframe>`: the frame shows an empty document. */
export const IFRAME_EMPTY_ATTRS = ' srcdoc=""';

const INSERTS = new Map<string, { text: string; attrs: Array<[string, string]> }>([
  ['a', { text: LINK_SAFE_ATTRS, attrs: [['rel', 'noopener noreferrer'], ['referrerpolicy', 'no-referrer']] }],
  ['area', { text: LINK_SAFE_ATTRS, attrs: [['rel', 'noopener noreferrer'], ['referrerpolicy', 'no-referrer']] }],
  ['meta', { text: META_OFF_ATTRS, attrs: [['name', ''], ['http-equiv', '']] }],
  ['iframe', { text: IFRAME_EMPTY_ATTRS, attrs: [['srcdoc', '']] }],
]);

/** Formatting elements: the Noah's Ark clause compares ALL their attributes, so all are kept. */
const FORMATTING = new Set(['a', 'b', 'big', 'code', 'em', 'font', 'i', 'nobr', 's', 'small', 'strike', 'strong', 'tt', 'u']);
/** The only attributes tree construction reads on any other element. */
const RELEVANT = new Set(['type', 'encoding', 'color', 'face', 'size']);

/** A name or value longer than this is folded into a hash as it grows. */
const FOLD_AT = 256;
/** Text and comment strings only matter by type, first character and length 1 vs more. */
const TEXT_KEEP = 64;
/** Doctype strings are compared to known ids and prefixes, all shorter than this. */
const DOCTYPE_KEEP = 256;
/** A named reference is shorter than this, so a reference past it is numeric and can no longer rewind. */
const ENTITY_REWIND_MAX = 64;

/** Past the last code point: the decoder's replaceCodePoint turns it into U+FFFD, as the spec does for an out-of-range reference. */
const CODE_POINT_CAP = 0x110000;

/** The parts of entities 6's EntityDecoder (parse5 8's) that a numeric reference adds its digits through. */
interface NumericAccumulator {
  result: number;
  consumed: number;
  addToNumericResult(input: string, start: number, end: number, base: number): void;
}

// entities 6 multiplies zero by an overflowing power for long leading-zero references, producing NaN.
function boundNumericReferences(decoder: unknown): void {
  const d = decoder as Partial<NumericAccumulator> | null;
  if (!d || typeof d.addToNumericResult !== 'function' || typeof d.result !== 'number' || typeof d.consumed !== 'number') {
    throw new Error('agent-html-security: parse5 EntityDecoder has no addToNumericResult, result and consumed');
  }
  d.addToNumericResult = function (this: NumericAccumulator, input: string, start: number, end: number, base: number): void {
    if (start === end) return;
    let r = this.result;
    for (let i = start; i < end && r < CODE_POINT_CAP; i++) r = r * base + Number.parseInt(input[i]!, base);
    this.result = Math.min(r, CODE_POINT_CAP);
    this.consumed += end - start;
  };
}

function clip(s: string | null): string | null {
  return s !== null && s.length > DOCTYPE_KEEP + TEXT_KEEP ? `${s.slice(0, DOCTYPE_KEEP)}\u0000` : s;
}

export interface TokenizerHooks {
  readonly prefixLen: number;
  readonly adapter: BoundedAdapter;
  /** Source spans of text and markup are tracked (an observer callback is set). */
  readonly observe: boolean;
  insert(offset: number, text: string): void;
  boundary(): void;
  linkTagName?: (tagName: 'a' | 'area', rawNameEnd: number) => void;
}

const NAME_END = new Set([0x20, 0x0a, 0x09, 0x0c, 0x2f, 0x3e]); // whitespace (CR arrives as LF), "/", ">"

export class BoundedTokenizer extends Tokenizer {
  private readonly hooks: TokenizerHooks;
  /** The tokenizer's character reference state, learned from the tokenizer itself. */
  private entityState: number | null = null;
  private readonly nameFold = new Folder();
  private readonly attrNameFold = new Folder();
  private readonly valueFold = new Folder();
  private nameOpen = false;
  private attrNameOpen = false;
  /** The current attribute's value: 0 not started, 1 kept (folded), 2 not kept (cleared). */
  private valueMode: 0 | 1 | 2 = 0;
  private keepAll = false;
  private readonly seen = new Set<string>();

  // Source spans, kept only when observed. Text tokens are contiguous source runs: a token
  // starts where its first character's source does and ends where the next token starts.
  private segStart = 0;
  private lastEnd = 0;
  private endAt = 0;
  /** The span of the character about to be appended, when its caller knows better than the read position. */
  private spanS = -1;
  private spanE = -1;
  private declStart = 0;
  /** The text token being emitted now, with its source span (read by the parser while it processes it). */
  emitToken: CharacterToken | null = null;
  emitStart = 0;
  emitEnd = 0;
  /** `<` of the markup token being read, and the end of the last tag emitted. */
  markupStart = 0;
  tagEnd = 0;
  /** Source before this is text already appended, or markup already emitted or dropped. */
  private resolvedTo = 0;
  /** A tag, comment or doctype is being read: none of its source can become text. */
  private markupOpen = false;
  /** Inside handleSpecialEndTag, whose end tag is only a candidate until it returns. */
  private special = false;
  private tentative = false;
  /** An LF after CR the preprocessor skipped, which belongs to the next span. */
  private lfSkippedAt = -1;
  /** The tokenizer's CDATA section end state (after `]]`), learned from the tokenizer itself. */
  private cdataEndState: number | null = null;

  constructor(options: TokenizerOptions, handler: TokenHandler, hooks: TokenizerHooks) {
    super(options, handler);
    this.hooks = hooks;
    boundNumericReferences(this.entityDecoder);
  }

  /** End of the source fully read: nothing before it can be read again or get an attribute. */
  processedEnd(): number {
    const pp = this.preprocessor;
    const end = pp.droppedBufferSize + pp.pos + 1;
    // A short reference may still turn out not to be one and be read again from its "&".
    return this.inShortEntity() ? Math.min(end, pp.droppedBufferSize + this.entityStartPos) : end;
  }

  longestHeld(): number {
    let n = Math.max(this.currentCharacterToken?.chars.length ?? 0, this.currentAttr.name.length, this.currentAttr.value.length);
    const t = this.currentToken;
    if (t?.type === TT.COMMENT) n = Math.max(n, t.data.length);
    else if (t?.type === TT.DOCTYPE) n = Math.max(n, t.name?.length ?? 0, t.publicId?.length ?? 0, t.systemId?.length ?? 0);
    else if (t?.type === TT.START_TAG || t?.type === TT.END_TAG) n = Math.max(n, t.tagName.length);
    return n;
  }

  private inShortEntity(): boolean {
    return this.entityState !== null && this.state === this.entityState
      && this.preprocessor.pos - this.entityStartPos <= ENTITY_REWIND_MAX;
  }

  // Between two loop iterations nothing is half done: drop read input and sweep the tree.
  protected override _consume(): number {
    if (this.consumedAfterSnapshot === 0) {
      const pp = this.preprocessor;
      if (pp.willDropParsedChunk() && !this.inShortEntity()) {
        const dropped = pp.pos;
        pp.dropParsedChunk();
        this.entityStartPos -= dropped;
      }
      this.hooks.adapter.maybeSweep();
    }
    const pp = this.preprocessor;
    const before = pp.pos;
    const cp = super._consume();
    if (pp.pos - before === 2 && pp.html.charCodeAt(pp.pos - 1) === 0x0a) this.lfSkippedAt = this.abs() - 1;
    return cp;
  }

  /** Source before this is never reported as text later (see AgentHtmlSecurity.processedEnd). */
  textFloor(): number {
    const end = this.processedEnd();
    if (this.markupOpen) return end;
    // A long reference reports no source, so its digits need not be kept.
    if (this.entityState !== null && this.state === this.entityState && !this.inShortEntity()) return end;
    return Math.min(end, this.resolvedTo);
  }

  protected override _callState(cp: number): void {
    super._callState(cp);
    this.bound();
  }

  protected override _startCharacterReference(): void {
    super._startCharacterReference();
    this.entityState = this.state;
  }

  protected override _createStartTagToken(): void {
    super._createStartTagToken();
    this.newTag();
    this.markup(this.abs() - 1);
  }

  protected override _createEndTagToken(): void {
    super._createEndTagToken();
    this.newTag();
    this.markup(this.abs() - 2, !this.special);
    if (this.special) this.tentative = true;
  }

  /** Raw text's `</name`: an end tag only when this returns false having moved on, else it is text again. */
  protected override handleSpecialEndTag(cp: number): boolean {
    const before = this.state;
    this.special = true;
    let text: boolean;
    try {
      text = super.handleSpecialEndTag(cp);
    } finally {
      this.special = false;
    }
    if (this.tentative) {
      this.tentative = false;
      if (!text && this.state !== before) this.markupOpen = true;
    }
    return text;
  }

  protected override _createCommentToken(offset: number): void {
    super._createCommentToken(offset);
    this.markup(this.abs() - offset);
  }

  protected override _stateMarkupDeclarationOpen(cp: number): void {
    this.declStart = this.abs() - 2;
    const before = this.state;
    super._stateMarkupDeclarationOpen(cp);
    // `<!DOCTYPE` matched: a doctype follows (its token is created later), never text.
    if ((cp === 0x44 || cp === 0x64) && this.state !== before) this.markupOpen = true;
    // `<![CDATA[` in foreign content: the opener is markup, so the run before it ends at its `<`.
    else if (cp === 0x5b && this.state !== before && this.state === TokenizerMode.CDATA_SECTION) {
      this.markup(this.declStart, false);
      this.markupDone(this.abs() + 1); // the read position is on the opener's last "["
    }
  }

  /** `]]>` closes a CDATA section: markup, so the run before it ends at its first `]`. Every other path is parse5's own. */
  protected override _stateCdataSectionEnd(cp: number): void {
    const at = this.abs();
    this.cdataEndState = this.state;
    super._stateCdataSectionEnd(cp);
    if (cp !== 0x3e) return;
    this.markup(at - 2, false);
    this.markupDone(at + 1);
  }

  protected override emitCurrentComment(ct: Token.CommentToken): void {
    this.markupDone(this.abs() + 1);
    super.emitCurrentComment(ct);
  }

  protected override emitCurrentDoctype(ct: Token.DoctypeToken): void {
    this.markupDone(this.abs() + 1);
    super.emitCurrentDoctype(ct);
  }

  protected override _createDoctypeToken(initialName: string | null): void {
    super._createDoctypeToken(initialName);
    this.markup(this.declStart);
  }

  /** `</>` is dropped by every reader: its source is no text, so the run around it is cut there. */
  protected override _stateEndTagOpen(cp: number): void {
    const at = this.abs();
    super._stateEndTagOpen(cp);
    if (cp !== 0x3e) return;
    if (this.hooks.observe) this.flushText(at - 2);
    this.markupDone(at + 1);
  }

  protected override _flushCodePointConsumedAsCharacterReference(cp: number): void {
    if (this.hooks.observe && !this._isCharacterReferenceInAttribute()) {
      // A reference's source runs from its "&" (in a numeric or named reference) to the read position.
      const at = this.abs();
      const amp = this.state === this.entityState ? this.preprocessor.droppedBufferSize + this.entityStartPos : at;
      if (at + 1 - amp > ENTITY_REWIND_MAX) {
        // Its digits were let go already: it reports no source, and the run is cut there.
        this.flushText(this.lastEnd);
        this.spanS = this.spanE = at + 1;
      } else {
        this.spanS = amp;
        this.spanE = at + 1;
      }
    }
    super._flushCodePointConsumedAsCharacterReference(cp);
  }

  /** Characters the tokenizer gives back after looking ahead (`<`, `</`, `<!`): they sit behind the read position. */
  protected override _emitChars(ch: string): void {
    if (this.hooks.observe) {
      const at = this.abs();
      // A `]` given back in the CDATA end state (a third `]`) is the first of the two held, two behind.
      const bracket = this.cdataEndState !== null && this.state === this.cdataEndState ? 2 : 1;
      const back = ch === '<!' || ch === '<' ? 1 : ch === ']' ? bracket : ch === '</' || ch === ']]' ? 2 : 0;
      this.spanS = at - back;
      this.spanE = at - back + ch.length;
    }
    super._emitChars(ch);
  }

  protected override _emitCurrentCharacterToken(nextLocation: Token.Location | null): void {
    const t = this.currentCharacterToken;
    if (t && this.hooks.observe) {
      this.emitToken = t;
      this.emitStart = this.segStart;
      this.emitEnd = Math.max(this.endAt, this.segStart);
    }
    super._emitCurrentCharacterToken(nextLocation);
    this.emitToken = null;
  }

  protected override prepareToken(ct: Token.Token): void {
    if (this.hooks.observe && this.currentCharacterToken) this.endAt = this.markupStart;
    super.prepareToken(ct);
  }

  protected override _emitEOFToken(): void {
    if (this.hooks.observe) this.endAt = this.beforeSkippedLf(this.preprocessor.droppedBufferSize + this.preprocessor.html.length);
    super._emitEOFToken();
  }

  /** A run never ends on the LF of a CRLF: a cut between the two would leave it out, so it is always left out. */
  private beforeSkippedLf(end: number): number {
    return this.lfSkippedAt === end - 1 && this.lastEnd === end - 1 ? end - 1 : end;
  }

  /** Emit the text token read so far, ending at `end` (spec-equivalent: the spec has one token per character). */
  flushText(end: number): void {
    if (!this.currentCharacterToken) return;
    this.endAt = this.beforeSkippedLf(end);
    this._emitCurrentCharacterToken(null);
  }

  /** After each write: the text read so far goes out, so an observer never waits on a long run. */
  flushPendingText(): void {
    if (this.hooks.observe) this.flushText(this.lastEnd);
  }

  private abs(): number {
    return this.preprocessor.droppedBufferSize + this.preprocessor.pos;
  }

  /** A markup token starts at `start`: the text before it is processed now, and its run is over. */
  private markup(start: number, open = true): void {
    this.markupStart = start;
    if (open) this.markupOpen = true;
    if (!this.hooks.observe) return;
    this.flushText(start);
    this.hooks.boundary();
  }

  private markupDone(end: number): void {
    this.markupOpen = false;
    if (end > this.resolvedTo) this.resolvedTo = end;
  }

  protected override _stateTagName(cp: number): void {
    if (NAME_END.has(cp)) this.endTagName();
    super._stateTagName(cp);
  }

  protected override _createAttr(attrNameFirstCh: string): void {
    this.endAttrValue();
    super._createAttr(attrNameFirstCh);
    this.attrNameOpen = true;
    this.attrNameFold.reset();
  }

  /** parse5's duplicate check scans the list per attribute; this keeps only what the tree reads, first one wins. */
  protected override _leaveAttrName(): void {
    const tok = this.currentToken;
    const attr = this.currentAttr;
    this.attrNameOpen = false;
    attr.name = this.attrNameFold.finish(attr.name);
    if (tok?.type === TT.START_TAG && (this.keepAll || RELEVANT.has(attr.name)) && !this.seen.has(attr.name)) {
      this.seen.add(attr.name);
      tok.attrs.push(attr);
      this.valueMode = 1;
    } else {
      this.valueMode = 2;
      attr.value = '';
    }
  }

  protected override emitCurrentTagToken(): void {
    this.endAttrValue();
    this.nameOpen = false;
    this.tagEnd = this.abs() + 1; // the read position is on its ">"
    this.tentative = false;
    this.markupDone(this.tagEnd);
    super.emitCurrentTagToken();
  }

  protected override _appendCharToCurrentCharacterToken(type: CharacterToken['type'], ch: string): void {
    if (this.hooks.observe) {
      let s = this.spanS;
      let e = this.spanE;
      if (s < 0) {
        const at = this.abs();
        s = ch.length === 2 ? at - 1 : at; // an astral character: the read position is on its low surrogate
        e = at + 1;
      }
      // The LF of a CRLF goes with the character after it, however the input was cut.
      if (this.lfSkippedAt === s - 1 && this.lastEnd === s - 1) s--;
      this.spanS = this.spanE = -1;
      this.markupOpen = false;
      if (e > this.resolvedTo) this.resolvedTo = e;
      if (s < this.lastEnd) s = this.lastEnd;
      if (e < s) e = s;
      const prev = this.currentCharacterToken;
      const fresh = !prev || prev.type !== type;
      if (prev && fresh) this.endAt = s; // the previous token is emitted inside this call
      super._appendCharToCurrentCharacterToken(type, ch);
      if (fresh) this.segStart = s;
      this.lastEnd = e;
    } else {
      super._appendCharToCurrentCharacterToken(type, ch);
    }
    const t = this.currentCharacterToken;
    // Tree construction reads a text token's type, its first character and whether it has more than one.
    if (t && t.chars.length > TEXT_KEEP) t.chars = t.chars.slice(0, 2);
  }

  private newTag(): void {
    this.nameOpen = true;
    this.nameFold.reset();
    this.attrNameOpen = false;
    this.valueMode = 0;
    this.valueFold.reset();
    this.keepAll = false;
    this.seen.clear();
  }

  private endTagName(): void {
    if (!this.nameOpen) return;
    const tok = this.currentToken;
    if (!tok || (tok.type !== TT.START_TAG && tok.type !== TT.END_TAG)) return;
    this.nameOpen = false;
    tok.tagName = this.nameFold.finish(tok.tagName);
    if (tok.type !== TT.START_TAG) return;
    this.keepAll = FORMATTING.has(tok.tagName);
    const add = INSERTS.get(tok.tagName);
    const at = this.preprocessor.droppedBufferSize + this.preprocessor.pos;
    if (!add || at < this.hooks.prefixLen) return;
    this.hooks.insert(at, add.text);
    if (tok.tagName === 'a' || tok.tagName === 'area') this.hooks.linkTagName?.(tok.tagName, at);
    // The reader sees these first, so the model does too (the formatting list compares them).
    if (this.keepAll) {
      for (const [name, value] of add.attrs) {
        this.seen.add(name);
        tok.attrs.push({ name, value });
      }
    }
  }

  private endAttrValue(): void {
    if (this.valueMode === 1) this.currentAttr.value = this.valueFold.finish(this.currentAttr.value);
    this.valueMode = 0;
    this.valueFold.reset();
  }

  /** After every character: no string a token holds grows past a small bound. */
  private bound(): void {
    const t = this.currentToken;
    if (!t) return;
    if (t.type === TT.START_TAG || t.type === TT.END_TAG) {
      if (this.nameOpen && t.tagName.length > FOLD_AT) t.tagName = this.nameFold.fold(t.tagName);
      const a = this.currentAttr;
      if (this.attrNameOpen) {
        if (a.name.length > FOLD_AT) a.name = this.attrNameFold.fold(a.name);
      } else if (this.valueMode === 2) {
        if (a.value) a.value = '';
      } else if (this.valueMode === 1 && a.value.length > FOLD_AT) {
        a.value = this.valueFold.fold(a.value);
      }
    } else if (t.type === TT.COMMENT) {
      if (t.data.length > TEXT_KEEP) t.data = '';
    } else if (t.type === TT.DOCTYPE) {
      t.name = clip(t.name);
      t.publicId = clip(t.publicId);
      t.systemId = clip(t.systemId);
    }
  }
}

// Fail at load, not with a wrong answer, if parse5 no longer has the hooks this relies on.
for (const name of ['_consume', '_callState', '_startCharacterReference', '_createStartTagToken', '_createEndTagToken',
  '_stateTagName', '_createAttr', '_leaveAttrName', 'emitCurrentTagToken', '_appendCharToCurrentCharacterToken',
  'handleSpecialEndTag', '_createCommentToken', '_stateMarkupDeclarationOpen', '_createDoctypeToken', 'emitCurrentComment',
  'emitCurrentDoctype', '_stateEndTagOpen', '_flushCodePointConsumedAsCharacterReference', '_isCharacterReferenceInAttribute',
  '_emitChars', '_emitCurrentCharacterToken', 'prepareToken', '_emitEOFToken', '_stateCdataSectionEnd'] as const) {
  if (typeof Reflect.get(Tokenizer.prototype, name) !== 'function') throw new Error(`agent-html-security: parse5 Tokenizer has no ${name}`);
}
