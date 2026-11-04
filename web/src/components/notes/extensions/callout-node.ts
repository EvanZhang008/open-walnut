/**
 * Callout — block Node serialized as a `> [!kind]` admonition blockquote
 * (§3.3 of IMPL-CONTRACT). FROZEN kinds: note · tip · warning · danger · info.
 *
 * Disk form (plain callout, unchanged since it shipped):
 *   > [!warning]
 *   > body line one
 *   > body line two
 *
 * Disk form (foldable callout, Obsidian syntax):
 *   > [!note]- Title shown while folded     (`-` folded by default)
 *   > body
 *
 *   > [!note]+ Title                        (`+` open by default)
 *   > body
 *
 * A foldable callout keeps the text after the marker as its FIRST paragraph
 * (the title, still visible and editable while folded); the other children are
 * the body. The fold state is a view state only: toggling it never changes the
 * document, so the bytes on disk keep the `-`/`+` the file was written with.
 *
 * Serialize: a plain callout writes `> [!kind]` then wrapBlock('> ', …) over
 * the body. A foldable one writes `> [!kind]- ` + the title's inline markdown,
 * then the rest of the body under the same `> ` prefix (no blank line between
 * them unless the file had one: `bodyGap`).
 *
 * Parse: a markdown-it core rule turns a blockquote whose first line starts
 * with `[!kind]-` / `[!kind]+` into the callout <div> at the token level (so
 * marks and links in the title survive) and splits the title line off the
 * first paragraph at its first soft break. `parse.updateDOM` keeps re-tagging
 * the plain `[!kind]` blockquotes as before. A plain blockquote (no `[!…]`)
 * stays a blockquote.
 *
 * Rendering: a NodeView adds a non-editable chevron button to foldable
 * callouts; collapsed hides every child but the title. The fold state is kept
 * by `calloutFoldPlugin` (view state, mapped through edits).
 */

import { Node, mergeAttributes } from '@tiptap/core';
import type { MarkdownSerializerState } from 'prosemirror-markdown';
import type { Node as PMNode } from '@tiptap/pm/model';
import { Plugin, PluginKey, TextSelection } from '@tiptap/pm/state';
import type { EditorState, Transaction } from '@tiptap/pm/state';
import { Decoration, DecorationSet } from '@tiptap/pm/view';
import type { EditorView, NodeView, ViewMutationRecord } from '@tiptap/pm/view';
import { CALLOUT_KINDS } from '../block-transforms';
import type { CalloutKind } from '../block-transforms';

declare module '@tiptap/core' {
  interface Commands<ReturnType> {
    callout: {
      setCallout: (attrs?: { kind?: CalloutKind }) => ReturnType;
      toggleCallout: (attrs?: { kind?: CalloutKind }) => ReturnType;
    };
  }
}

/** '' = plain callout, '-' = foldable and folded by default, '+' = foldable and open by default. */
export type CalloutFold = '' | '-' | '+';

const KIND_SET = new Set<string>(CALLOUT_KINDS);

function normalizeKind(raw: string | null | undefined): CalloutKind {
  const k = (raw || '').toLowerCase();
  return (KIND_SET.has(k) ? k : 'note') as CalloutKind;
}

function normalizeFold(raw: string | null | undefined): CalloutFold {
  return raw === '-' || raw === '+' ? raw : '';
}

// ─── Parse: markdown-it core rule for `[!kind]-` / `[!kind]+` ───────────────

/** `[!kind]` then `-` or `+`, then spaces or the end of the line (matched on the paragraph's raw source). */
const FOLD_MARKER = /^\[!([A-Za-z]+)\]([-+])(?:[ \t]+|(?=\n)|$)/;
const RULE_NAME = 'walnut_callout_fold';
const LITERAL_MARKER_ATTR = 'data-callout-literal';

/** Minimal shape of the markdown-it Token we touch (avoids a types dependency). */
interface MdToken {
  type: string;
  tag: string;
  nesting: number;
  level: number;
  content: string;
  markup: string;
  block: boolean;
  hidden: boolean;
  map: [number, number] | null;
  children: MdToken[] | null;
  attrSet(name: string, value: string): void;
}
type MdTokenCtor = new (type: string, tag: string, nesting: number) => MdToken;

/** Drop `count` leading characters across the leading text tokens. */
function stripLeadingText(children: MdToken[], count: number): MdToken[] {
  let left = count;
  const out = [...children];
  while (left > 0 && out.length && out[0].type === 'text') {
    const t = out[0];
    if (t.content.length <= left) {
      left -= t.content.length;
      out.shift();
    } else {
      t.content = t.content.slice(left);
      left = 0;
    }
  }
  return out;
}

/**
 * Split inline children at index `at` (a softbreak, dropped). Marks still open
 * at the break are closed at the end of the title and reopened at the start of
 * the body, so `**bold\ntext**` stays bold on both sides.
 */
function splitInline(children: MdToken[], at: number, Token: MdTokenCtor): [MdToken[], MdToken[]] {
  const open: MdToken[] = [];
  for (let i = 0; i < at; i++) {
    const c = children[i];
    if (c.nesting === 1) open.push(c);
    else if (c.nesting === -1) open.pop();
  }
  const closes = [...open].reverse().map(o => {
    const close = new Token(o.type.replace(/_open$/, '_close'), o.tag, -1);
    close.markup = o.markup;
    close.level = o.level;
    return close;
  });
  return [
    [...children.slice(0, at), ...closes],
    [...open, ...children.slice(at + 1)],
  ];
}

/**
 * The core rule. Runs after inline parsing, so the first paragraph's inline
 * children (text, marks, links) are already there.
 */
export function calloutFoldCoreRule(state: { tokens: MdToken[]; Token: MdTokenCtor }): void {
  const { tokens, Token } = state;
  for (let i = 0; i < tokens.length; i++) {
    const open = tokens[i];
    if (open.type !== 'blockquote_open' || open.tag !== 'blockquote') continue;
    const pOpen = tokens[i + 1];
    const inline = tokens[i + 2];
    const pClose = tokens[i + 3];
    if (pOpen?.type !== 'paragraph_open' || inline?.type !== 'inline' || pClose?.type !== 'paragraph_close') continue;

    // `> \[!note\] x` is text the user typed in a quote, not a marker: tell
    // updateDOM (which only sees the unescaped text) to leave it a blockquote.
    if (/^\\\[!/.test(inline.content)) {
      open.attrSet(LITERAL_MARKER_ATTR, '1');
      continue;
    }
    const children = inline.children ?? [];
    // Match on the raw source: `\[!note\]- x` (escaped) and `[!note]-**x**`
    // (no space) are not markers. The leading text must then hold it verbatim.
    const m = FOLD_MARKER.exec(inline.content);
    if (!m) continue;
    let lead = '';
    for (const c of children) {
      if (c.type !== 'text') break;
      lead += c.content;
    }
    const leadMarker = /^\[![A-Za-z]+\][-+][ \t]*/.exec(lead);
    if (!leadMarker || !leadMarker[0].startsWith(m[0].trimEnd())) continue;
    const kind = m[1].toLowerCase();
    if (!KIND_SET.has(kind)) continue; // unknown kind stays a blockquote

    // Find the matching close before splicing anything in.
    let depth = 0;
    let close = -1;
    for (let j = i; j < tokens.length; j++) {
      if (tokens[j].type === 'blockquote_open') depth++;
      else if (tokens[j].type === 'blockquote_close' && --depth === 0) { close = j; break; }
    }
    if (close < 0) continue;

    open.tag = 'div';
    tokens[close].tag = 'div';
    open.attrSet('data-callout', kind);
    open.attrSet('data-callout-fold', m[2]);

    const rest = stripLeadingText(children, leadMarker[0].length);
    const br = rest.findIndex(c => c.type === 'softbreak');
    if (br >= 0) {
      // `> [!note]- Title\n> body`: markdown-it folded both lines into one
      // paragraph; the title is the first line, the body paragraph the rest.
      const [title, body] = splitInline(rest, br, Token);
      inline.children = title;
      const bOpen = new Token('paragraph_open', 'p', 1);
      const bInline = new Token('inline', '', 0);
      const bClose = new Token('paragraph_close', 'p', -1);
      for (const t of [bOpen, bClose]) { t.level = pOpen.level; t.block = true; t.hidden = pOpen.hidden; }
      bInline.level = inline.level;
      bInline.children = body;
      tokens.splice(i + 4, 0, bOpen, bInline, bClose);
    } else {
      inline.children = rest;
      // A blank `>` line between the title and the next block: keep it on save.
      const next = tokens[i + 4];
      if (next && next !== tokens[close] && next.map && pOpen.map && next.map[0] > pOpen.map[1]) {
        open.attrSet('data-callout-gap', '1');
      }
    }
  }
}

/** Remove the first `count` characters of `el`'s text, across its text nodes. */
function stripLeadingChars(el: Element, count: number): void {
  let left = count;
  const visit = (n: ChildNode): void => {
    for (const c of Array.from(n.childNodes)) {
      if (left <= 0) return;
      if (c.nodeType === 3) {
        const t = c as Text;
        if (t.data.length <= left) {
          left -= t.data.length;
          t.remove();
        } else {
          t.data = t.data.slice(left);
          left = 0;
        }
      } else {
        visit(c);
      }
    }
  };
  visit(el as unknown as ChildNode);
}

/** markdown-it instances that already carry the rule (setup runs on every parse). */
const rulePatched = new WeakSet<object>();

// ─── Fold state: a plugin, never the document ───────────────────────────────
//
// The fold state lives in plugin state as "overrides" (node decorations that
// map through edits): a callout without one shows its file default (`-`
// folded, `+` open). Keeping it in the plugin, not the NodeView, lets a
// transaction that moves the selection into a folded body unfold it BEFORE the
// DOM renders, so the caret never lands in hidden content (Enter at the end of
// a folded title, arrow keys, search jumps, undo).

interface FoldMeta { pos: number; collapsed: boolean }
interface FoldState { overrides: DecorationSet }

export const calloutFoldKey = new PluginKey<FoldState>('calloutFold');

function foldableAt(doc: PMNode, pos: number): PMNode | null {
  const node = doc.nodeAt(pos);
  return node && node.type.name === 'callout' && normalizeFold(node.attrs.fold) ? node : null;
}

function overrideAt(overrides: DecorationSet, pos: number, size: number): Decoration | undefined {
  // (find's predicate gets the spec, not the decoration: filter afterwards)
  return overrides.find(pos, pos + size).find(d => d.from === pos && d.to === pos + size);
}

function withOverride(overrides: DecorationSet, doc: PMNode, pos: number, collapsed: boolean): DecorationSet {
  const node = doc.nodeAt(pos);
  if (!node) return overrides;
  const old = overrideAt(overrides, pos, node.nodeSize);
  const removed = old ? overrides.remove([old]) : overrides;
  return removed.add(doc, [Decoration.node(pos, pos + node.nodeSize, {}, { calloutFold: collapsed })]);
}

function collapsedIn(overrides: DecorationSet, node: PMNode, pos: number): boolean {
  const o = overrideAt(overrides, pos, node.nodeSize);
  return o ? !!(o.spec as { calloutFold?: boolean }).calloutFold : normalizeFold(node.attrs.fold) === '-';
}

/** Is the foldable callout at `pos` folded in this state? */
export function isCalloutCollapsed(state: EditorState, pos: number): boolean {
  const node = foldableAt(state.doc, pos);
  const ps = calloutFoldKey.getState(state);
  return !!node && !!ps && collapsedIn(ps.overrides, node, pos);
}

/**
 * Positions of the foldable callouts whose BODY (any child after the title)
 * holds the selection head, innermost first.
 */
export function calloutsWithSelectionInBody(state: EditorState): number[] {
  const out: number[] = [];
  const $pos = state.selection.$head;
  for (let d = $pos.depth; d > 0; d--) {
    const node = $pos.node(d);
    if (node.type.name !== 'callout' || !normalizeFold(node.attrs.fold)) continue;
    if ($pos.index(d) > 0) out.push($pos.before(d));
  }
  return out;
}

/**
 * The transaction that folds / unfolds the callout at `pos`: plugin meta plus,
 * when folding with the selection in the body, a caret move to the title's end.
 * It never changes the document. Null when `pos` is not a foldable callout.
 */
export function calloutFoldTransaction(state: EditorState, pos: number, collapsed: boolean): Transaction | null {
  const node = foldableAt(state.doc, pos);
  if (!node) return null;
  const tr = state.tr;
  if (collapsed && node.childCount > 1) {
    const titleEnd = pos + 1 + node.child(0).nodeSize - 1;
    const bodyFrom = titleEnd + 1;
    const { from, to } = state.selection;
    if (to > bodyFrom && from < pos + node.nodeSize - 1) {
      tr.setSelection(TextSelection.near(tr.doc.resolve(titleEnd), -1));
    }
  }
  tr.setMeta(calloutFoldKey, { pos, collapsed } satisfies FoldMeta);
  tr.setMeta('addToHistory', false);
  return tr;
}

export function calloutFoldPlugin(): Plugin<FoldState> {
  let memo: { doc: PMNode; overrides: DecorationSet; set: DecorationSet } | null = null;
  return new Plugin<FoldState>({
    key: calloutFoldKey,
    state: {
      init: () => ({ overrides: DecorationSet.empty }),
      apply(tr, value, _old, next) {
        let overrides = tr.docChanged ? value.overrides.map(tr.mapping, tr.doc) : value.overrides;
        const meta = tr.getMeta(calloutFoldKey) as FoldMeta | undefined;
        if (meta && foldableAt(next.doc, meta.pos)) {
          overrides = withOverride(overrides, next.doc, meta.pos, meta.collapsed);
        }
        if (tr.docChanged || tr.selectionSet) {
          for (const pos of calloutsWithSelectionInBody(next)) {
            const node = next.doc.nodeAt(pos)!;
            if (collapsedIn(overrides, node, pos)) overrides = withOverride(overrides, next.doc, pos, false);
          }
        }
        return overrides === value.overrides ? value : { overrides };
      },
    },
    props: {
      // Spec-only node decorations: the NodeView reads them, the DOM gets no attrs.
      decorations(state) {
        const { overrides } = calloutFoldKey.getState(state)!;
        if (memo && memo.doc === state.doc && memo.overrides === overrides) return memo.set;
        const decos: Decoration[] = [];
        state.doc.descendants((node, pos) => {
          if (node.type.name === 'callout' && normalizeFold(node.attrs.fold) && collapsedIn(overrides, node, pos)) {
            decos.push(Decoration.node(pos, pos + node.nodeSize, {}, { calloutCollapsed: true }));
          }
          return node.isBlock && !node.isTextblock;
        });
        const set = DecorationSet.create(state.doc, decos);
        memo = { doc: state.doc, overrides, set };
        return set;
      },
    },
  });
}

function collapsedFromDecorations(decorations: readonly Decoration[]): boolean {
  return decorations.some(d => (d.spec as { calloutCollapsed?: boolean }).calloutCollapsed);
}

// ─── NodeView: the chevron ──────────────────────────────────────────────────

export class CalloutView implements NodeView {
  dom: HTMLElement;
  contentDOM: HTMLElement;
  private toggle: HTMLButtonElement | null = null;
  private node: PMNode;
  private collapsed: boolean;

  constructor(
    node: PMNode,
    private view: EditorView,
    private getPos: () => number | undefined,
    decorations: readonly Decoration[] = [],
  ) {
    this.node = node;
    const doc = (view.dom?.ownerDocument ?? document) as Document;
    const fold = normalizeFold(node.attrs.fold);
    this.collapsed = !!fold && collapsedFromDecorations(decorations);
    this.dom = doc.createElement('div');
    if (fold) {
      const btn = doc.createElement('button');
      btn.type = 'button';
      btn.className = 'notes-callout-fold-toggle';
      btn.setAttribute('contenteditable', 'false');
      btn.addEventListener('mousedown', e => e.preventDefault()); // keep the editor's focus + selection
      btn.addEventListener('click', e => {
        e.preventDefault();
        this.requestToggle();
      });
      this.toggle = btn;
      this.dom.appendChild(btn);
      this.contentDOM = doc.createElement('div');
      this.contentDOM.className = 'notes-callout-content';
      this.dom.appendChild(this.contentDOM);
    } else {
      this.contentDOM = this.dom;
    }
    this.render();
  }

  get isCollapsed(): boolean {
    return this.collapsed;
  }

  /** Ask the plugin to flip the fold; the decorations come back through update(). */
  private requestToggle(): void {
    const pos = this.getPos();
    if (typeof pos !== 'number') return;
    const tr = calloutFoldTransaction(this.view.state, pos, !this.collapsed);
    if (tr) this.view.dispatch(tr);
  }

  private render(): void {
    const kind = normalizeKind(this.node.attrs.kind);
    const fold = normalizeFold(this.node.attrs.fold);
    // classList, not className: keep ProseMirror's own classes (selectednode).
    const cl = this.dom.classList;
    cl.add('notes-callout');
    for (const k of CALLOUT_KINDS) cl.toggle(`notes-callout-${k}`, k === kind);
    cl.toggle('notes-callout-foldable', !!fold);
    cl.toggle('is-collapsed', !!fold && this.collapsed);
    this.dom.setAttribute('data-callout', kind);
    if (fold) this.dom.setAttribute('data-callout-fold', fold);
    else this.dom.removeAttribute('data-callout-fold');
    if (this.toggle) {
      this.toggle.setAttribute('aria-expanded', String(!this.collapsed));
      this.toggle.setAttribute('aria-label', this.collapsed ? 'Expand callout' : 'Collapse callout');
      this.toggle.title = this.collapsed ? 'Expand' : 'Collapse';
    }
  }

  update(node: PMNode, decorations: readonly Decoration[] = []): boolean {
    if (node.type !== this.node.type) return false;
    // Plain <-> foldable needs a different DOM shape: let ProseMirror rebuild.
    if (!normalizeFold(this.node.attrs.fold) !== !normalizeFold(node.attrs.fold)) return false;
    this.node = node;
    this.collapsed = !!normalizeFold(node.attrs.fold) && collapsedFromDecorations(decorations);
    this.render();
    return true;
  }

  stopEvent(event: Event): boolean {
    return !!this.toggle && event.target instanceof Element && this.toggle.contains(event.target);
  }

  ignoreMutation(mutation: ViewMutationRecord): boolean {
    if (mutation.type === 'selection') return false;
    if (this.toggle && this.toggle.contains(mutation.target)) return true;
    // Our own class / data attribute changes on the wrapper.
    return mutation.type === 'attributes' && mutation.target === this.dom;
  }
}

// ─── Serialize ──────────────────────────────────────────────────────────────

/**
 * Can `block`, written on the line right under a marker/title line (no blank
 * `>` line between), be read back as the same block? A block that cannot
 * interrupt a paragraph would merge into the title, and `---` / `===` would
 * turn the title line into a setext heading: those get a blank line.
 */
function canFollowTitleLine(block: PMNode): boolean {
  const nonEmptyItem = (list: PMNode) => !!list.firstChild && list.firstChild.textContent.trim() !== '';
  switch (block.type.name) {
    case 'paragraph': {
      if (block.content.size === 0) return true; // writes nothing
      let firstLine = '';
      for (let i = 0; i < block.childCount; i++) {
        const c = block.child(i);
        if (!c.isText) break;
        firstLine += c.text;
      }
      return !/^\s/.test(firstLine) && !/^[=-]+\s*$/.test(firstLine);
    }
    case 'heading':
    case 'codeBlock':
    case 'blockquote':
    case 'callout':
    case 'table':
      return true;
    case 'bulletList':
    case 'taskList':
      return nonEmptyItem(block);
    case 'orderedList':
      return (block.attrs.start ?? 1) === 1 && nonEmptyItem(block);
    default:
      return false;
  }
}

function serializeFoldable(state: MarkdownSerializerState, node: PMNode, kind: CalloutKind, fold: CalloutFold): void {
  const s = state as any;
  const first = node.firstChild;
  const hasTitle = first?.type.name === 'paragraph';
  s.wrapBlock('> ', null, node, () => {
    const marker = `[!${kind}]${fold}`;
    if (hasTitle && first!.content.size > 0) {
      state.write(`${marker} `);
      // Not at a line start: a title like `1. x` or `- x` needs no escape.
      state.renderInline(first!, false);
      // Trailing spaces would make a hard break that pulls the body into the title.
      s.out = s.out.replace(/[ \t]+$/, '');
    } else {
      state.write(marker);
    }
    const start = hasTitle ? 1 : 0;
    if (start >= node.childCount) return;
    state.closeBlock(hasTitle ? first! : node);
    // One newline (body right under the title) unless the file had a blank line
    // or the body could not be read back from there.
    const endsWithBreak = hasTitle && first!.lastChild?.type.name === 'hardBreak';
    const gap = node.attrs.bodyGap || endsWithBreak || !canFollowTitleLine(node.child(start));
    s.flushClose(gap ? 2 : 1);
    for (let i = start; i < node.childCount; i++) state.render(node.child(i), node, i);
  });
}

export const Callout = Node.create({
  name: 'callout',
  group: 'block',
  content: 'block+',
  defining: true,

  addAttributes() {
    return {
      kind: {
        default: 'note',
        parseHTML: el => normalizeKind((el as HTMLElement).getAttribute('data-callout')),
        renderHTML: attrs => ({ 'data-callout': attrs.kind }),
      },
      fold: {
        default: '',
        parseHTML: el => normalizeFold((el as HTMLElement).getAttribute('data-callout-fold')),
        renderHTML: attrs => (attrs.fold ? { 'data-callout-fold': attrs.fold } : {}),
      },
      // A foldable callout's file had a blank `>` line between title and body.
      bodyGap: {
        default: false,
        parseHTML: el => (el as HTMLElement).getAttribute('data-callout-gap') === '1',
        renderHTML: attrs => (attrs.bodyGap ? { 'data-callout-gap': '1' } : {}),
      },
    };
  },

  parseHTML() {
    return [{ tag: 'div[data-callout]' }];
  },

  renderHTML({ node, HTMLAttributes }) {
    const kind = node.attrs.kind;
    return [
      'div',
      mergeAttributes(HTMLAttributes, { class: `notes-callout notes-callout-${kind}` }),
      0,
    ];
  },

  addNodeView() {
    return ({ node, view, getPos, decorations }) =>
      new CalloutView(node, view, getPos as () => number | undefined, decorations as readonly Decoration[]);
  },

  addProseMirrorPlugins() {
    return [calloutFoldPlugin()];
  },

  addKeyboardShortcuts() {
    // Delete at the end of a folded title would join the HIDDEN first body
    // block into the title: unfold instead, so the user sees what goes.
    const unfoldBeforeJoin = () => {
      const { state, view } = this.editor;
      const { selection } = state;
      if (!selection.empty) return false;
      const $h = selection.$head;
      if ($h.depth < 2 || $h.parentOffset !== $h.parent.content.size) return false;
      const d = $h.depth - 1;
      const callout = $h.node(d);
      if (callout.type.name !== 'callout' || $h.index(d) !== 0 || callout.childCount < 2) return false;
      const pos = $h.before(d);
      if (!isCalloutCollapsed(state, pos)) return false;
      const tr = calloutFoldTransaction(state, pos, false);
      if (tr) view.dispatch(tr);
      return true;
    };
    return { Delete: unfoldBeforeJoin, 'Mod-Delete': unfoldBeforeJoin, 'Ctrl-d': unfoldBeforeJoin };
  },

  addCommands() {
    return {
      setCallout: (attrs) => ({ commands }) =>
        commands.wrapIn(this.name, { kind: normalizeKind(attrs?.kind) }),
      toggleCallout: (attrs) => ({ commands }) =>
        commands.toggleWrap(this.name, { kind: normalizeKind(attrs?.kind) }),
    };
  },

  addStorage() {
    return {
      markdown: {
        serialize(state: MarkdownSerializerState, node: PMNode) {
          const kind = normalizeKind((node.attrs as { kind?: string }).kind);
          const fold = normalizeFold((node.attrs as { fold?: string }).fold);
          if (fold) {
            serializeFoldable(state, node, kind, fold);
            return;
          }
          // Marker line, then the body wrapped with the blockquote prefix.
          state.write(`> [!${kind}]`);
          state.ensureNewLine();
          // A first block that cannot sit right under the marker line (`---`,
          // `3. x`, `===`) gets a blank `>` line, or it would not read back.
          if (node.firstChild && !canFollowTitleLine(node.firstChild)) {
            state.write('>');
            state.ensureNewLine();
          }
          (state as any).wrapBlock('> ', null, node, () => state.renderContent(node));
        },
        parse: {
          setup(md: any) {
            if (rulePatched.has(md)) return;
            rulePatched.add(md);
            md.core.ruler.push(RULE_NAME, calloutFoldCoreRule);
          },
          // markdown-it produces a <blockquote>; re-tag the admonition ones.
          updateDOM(element: HTMLElement) {
            element.querySelectorAll('blockquote').forEach(bq => {
              if (bq.hasAttribute(LITERAL_MARKER_ATTR)) {
                bq.removeAttribute(LITERAL_MARKER_ATTR);
                return;
              }
              const firstP = bq.querySelector('p');
              if (!firstP) return;
              const text = firstP.textContent ?? '';
              // markdown-it folds all blockquote lines into one <p> joined by
              // '\n', so the marker is the FIRST line and the body is everything
              // after it. `[\s\S]*` (not `.*`) keeps every subsequent line — a
              // bare `.*` both fails to match a 3+ line callout (no `s` flag → it
              // can't reach `$`) and silently drops body lines past the first.
              const m = /^\s*\[!([A-Za-z]+)\][ \t]*\n?([\s\S]*)$/.exec(text);
              if (!m) return;
              const kind = m[1].toLowerCase();
              if (!KIND_SET.has(kind)) return; // unknown kind → stays a blockquote

              const div = element.ownerDocument.createElement('div');
              div.setAttribute('data-callout', kind);

              // Drop the marker from the first paragraph; keep any trailing text
              // that shared the marker line (e.g. `> [!tip] inline body`) with
              // its markup: only the marker's characters are cut, so inline
              // code, marks and links in the body's first line survive.
              stripLeadingChars(firstP, text.length - m[2].length);
              if (!firstP.textContent && !firstP.firstElementChild) firstP.remove();
              while (bq.firstChild) div.appendChild(bq.firstChild);
              // If everything got removed, give the callout an empty paragraph.
              if (!div.querySelector('p')) {
                div.appendChild(element.ownerDocument.createElement('p'));
              }
              bq.replaceWith(div);
            });
          },
        },
      },
    };
  },
});
