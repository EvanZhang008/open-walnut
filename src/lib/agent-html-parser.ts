/** parse5's Parser over the bounded tokenizer and tree, with the read-only text and tag callbacks. */

import { Parser, type Token } from 'parse5';
import { BoundedTokenizer, type TokenizerHooks } from './agent-html-tokenizer.js';
import type { BoundedAdapter, NodeMap, PNode } from './agent-html-tree.js';

type TagToken = Token.TagToken;
type CharacterToken = Token.CharacterToken;

/** Text under one of these is not linked (see onTextSegment). */
const NO_LINK_TEXT = [
  'head', 'title', 'style', 'script', 'textarea', 'xmp', 'iframe', 'noembed', 'noframes', 'plaintext',
  'svg', 'math', 'template', 'a', 'button', 'select', 'option', 'optgroup', 'datalist', 'object', 'audio', 'video', 'canvas',
];

interface ParserObservers {
  onText?: (rawStart: number, rawEnd: number, linkable: boolean) => void;
  onTag?: (tagName: string, rawStart: number, rawEnd: number, closing: boolean, linkable: boolean) => void;
}

export class SecurityParser extends Parser<NodeMap> {
  readonly bounded: BoundedTokenizer;
  private readonly observers: ParserObservers;
  private readonly noLinkTags: Set<string>;
  /** Open elements under which text is not linked. */
  private noLink = 0;
  private lastPushed: PNode | null = null;
  private lastHeld: CharacterToken | null = null;
  private heldLinkable = false;
  /** onEndTag is called again for a reprocessed token; only the outer call reports it. */
  private tagDepth = 0;

  constructor(scriptingEnabled: boolean, adapter: BoundedAdapter, hooks: Omit<TokenizerHooks, 'adapter'>, observers: ParserObservers) {
    super({ treeAdapter: adapter, scriptingEnabled, sourceCodeLocationInfo: false, onParseError: null });
    adapter.parser = this;
    this.observers = observers;
    this.noLinkTags = new Set(scriptingEnabled ? [...NO_LINK_TEXT, 'noscript'] : NO_LINK_TEXT);
    this.bounded = new BoundedTokenizer(this.options, this, { ...hooks, adapter });
    this.tokenizer = this.bounded;
  }

  override onCharacter(token: CharacterToken): void {
    const list = this.pendingCharacterTokens;
    const n = list.length;
    super.onCharacter(token);
    this.afterText(list, n, token);
  }

  override onWhitespaceCharacter(token: CharacterToken): void {
    const list = this.pendingCharacterTokens;
    const n = list.length;
    super.onWhitespaceCharacter(token);
    this.afterText(list, n, token);
  }

  /** Where text enters the tree, after any formatting element was reopened for it. */
  override _insertCharacters(token: CharacterToken): void {
    const b = this.bounded;
    if (this.observers.onText && token === b.emitToken) {
      b.emitToken = null;
      if (b.emitEnd > b.emitStart) this.observers.onText(b.emitStart, b.emitEnd, this.noLink === 0);
    }
    super._insertCharacters(token);
  }

  override onItemPush(node: PNode, tid: number, isTop: boolean): void {
    super.onItemPush(node, tid, isTop);
    // insertAfter (the adoption agency) names the stack's current element, not the one it inserted.
    if (!isTop) this.recount();
    else if (this.noLinkTags.has(node.tagName)) this.noLink++;
    this.lastPushed = node;
  }

  override onItemPop(node: PNode, isTop: boolean): void {
    super.onItemPop(node, isTop);
    if (this.noLinkTags.has(node.tagName)) this.noLink--;
  }

  override onStartTag(token: TagToken): void {
    const onTag = this.observers.onTag;
    if (!onTag) { super.onStartTag(token); return; }
    const start = this.bounded.markupStart;
    const end = this.bounded.tagEnd;
    this.lastPushed = null;
    super.onStartTag(token);
    const own = this.lastPushed as PNode | null;
    const self = own && own === this.openElements.current && own.tagName === token.tagName && this.noLinkTags.has(own.tagName) ? 1 : 0;
    onTag(token.tagName, start, end, false, this.noLink - self === 0);
  }

  override onEndTag(token: TagToken): void {
    const onTag = this.observers.onTag;
    if (!onTag || this.tagDepth > 0) { super.onEndTag(token); return; }
    const start = this.bounded.markupStart;
    const end = this.bounded.tagEnd;
    this.tagDepth++;
    try {
      super.onEndTag(token);
    } finally {
      this.tagDepth--;
    }
    onTag(token.tagName, start, end, true, this.noLink === 0);
  }

  private recount(): void {
    const { items, stackTop } = this.openElements;
    let n = 0;
    for (let i = 0; i <= stackTop; i++) if (this.noLinkTags.has((items[i] as PNode).tagName)) n++;
    this.noLink = n;
  }

  /**
   * Table text is held and inserted when the next other token comes, but nothing between can
   * change where: the open elements and the formatting list stay as they are. So it is reported
   * now, in source order, judged as the tree will insert it (foster parented after reopening the
   * formatting elements the list holds past the last open one or marker).
   */
  private afterText(list: CharacterToken[], n: number, token: CharacterToken): void {
    const onText = this.observers.onText;
    if (onText && list.length > 0 && list[list.length - 1] === token && token !== this.lastHeld) {
      if (list.length === 1) this.heldLinkable = this.linkableWhenReplayed();
      this.lastHeld = token;
      const b = this.bounded;
      if (b.emitToken === token) {
        b.emitToken = null;
        if (b.emitEnd > b.emitStart) onText(b.emitStart, b.emitEnd, this.heldLinkable);
      }
    }
    collapsePending(list, n, token);
  }

  private linkableWhenReplayed(): boolean {
    if (this.noLink !== 0) return false;
    for (const entry of this.activeFormattingElements.entries) {
      if (!('element' in entry) || this.openElements.contains(entry.element)) break;
      if (this.noLinkTags.has((entry.element as PNode).tagName)) return false;
    }
    return true;
  }
}

/**
 * Table text: the held tokens are replayed one by one, and after the first of a
 * type a replay changes nothing (formatting elements are reconstructed once, text
 * is not kept), so one of each type is all the tree needs.
 */
function collapsePending(list: CharacterToken[], n: number, token: CharacterToken): void {
  if (n === 0 || list.length !== n + 1 || list[n] !== token) return;
  for (let i = 0; i < n; i++) {
    if (list[i]!.type === token.type) { list.pop(); return; }
  }
}

// Fail at load, not with a wrong answer, if parse5 no longer has the hooks this relies on.
for (const name of ['onCharacter', 'onWhitespaceCharacter', '_insertCharacters', 'onItemPush', 'onItemPop', 'onStartTag', 'onEndTag'] as const) {
  if (typeof Reflect.get(Parser.prototype, name) !== 'function') throw new Error(`agent-html-security: parse5 Parser has no ${name}`);
}
