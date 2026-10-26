/**
 * Dictation into a rich editor (web/src/hooks/editor-dictation-core.ts, driven by
 * useEditorDictation): the composer's writing rules expressed in ProseMirror
 * positions. Each case runs the real transaction builders against a real
 * EditorState with the history plugin, so "a draft replaces the last draft in
 * place", "an edit elsewhere never corrupts the span" and "one undo takes the
 * whole dictation away" are checked on actual documents, not on numbers.
 */
import { describe, it, expect } from 'vitest';
import { Schema, type Node as PMNode } from '@tiptap/pm/model';
import { EditorState, TextSelection, type Transaction } from '@tiptap/pm/state';
import { history, undo } from '@tiptap/pm/history';
import {
  dictationPadding,
  finalRange,
  mapDictationSpan,
  planFirstWrite,
  takeBackDraft,
  textAnchor,
  writeDraft,
  writeFinal,
  writeRefine,
  type EditorDictationSpan,
} from '@/hooks/editor-dictation-core';

const schema = new Schema({
  nodes: {
    doc: { content: 'block+' },
    paragraph: { group: 'block', content: 'inline*' },
    rule: { group: 'block' },
    image: { group: 'inline', inline: true, atom: true },
    text: { group: 'inline' },
  },
});

const p = (...kids: (string | PMNode)[]) =>
  schema.nodes.paragraph.create(null, kids.map((k) => (typeof k === 'string' ? schema.text(k) : k)));
const rule = () => schema.nodes.rule.create();
const image = () => schema.nodes.image.create();
const docOf = (...blocks: PMNode[]) => schema.nodes.doc.create(null, blocks);

/** Block texts joined by '|', inline atoms as '#': what the reader sees. */
function show(doc: PMNode): string {
  const out: string[] = [];
  doc.forEach((b) => out.push(b.isTextblock ? b.textBetween(0, b.content.size, '', '#') : '<hr>'));
  return out.join('|');
}

/** Absolute position just after the first `needle` in the doc. */
function after(doc: PMNode, needle: string): number {
  let found = -1;
  doc.descendants((node, pos) => {
    if (found >= 0 || !node.isText) return found < 0;
    const i = node.text!.indexOf(needle);
    if (i >= 0) found = pos + i + needle.length;
    return false;
  });
  if (found < 0) throw new Error(`not found: ${needle}`);
  return found;
}

function stateOf(doc: PMNode, caret?: number): EditorState {
  const state = EditorState.create({ doc, plugins: [history()] });
  return caret === undefined ? state : state.apply(state.tr.setSelection(TextSelection.create(state.doc, caret)));
}

/** The editor side of the hook: drafts and refines out of history, the final in it. */
class Harness {
  state: EditorState;
  span: EditorDictationSpan | null = null;
  last: EditorDictationSpan | null = null;
  constructor(doc: PMNode, caret?: number) { this.state = stateOf(doc, caret); }

  private apply(tr: Transaction, own: boolean, historyEntry = false) {
    if (own && !historyEntry) tr.setMeta('addToHistory', false);
    if (!own) {
      if (this.span) this.span = mapDictationSpan(this.span, tr.mapping, tr.doc);
      if (this.last) this.last = mapDictationSpan(this.last, tr.mapping, tr.doc);
    }
    this.state = this.state.apply(tr);
  }
  draft(words: string) {
    const tr = this.state.tr;
    const next = writeDraft(tr, this.span, words, this.state.selection.to);
    if (next) { this.span = next; this.apply(tr, true); }
  }
  final(words: string) {
    let place = null;
    if (this.span) {
      const tr = this.state.tr;
      place = takeBackDraft(tr, this.span);
      this.span = null;
      this.apply(tr, true);
    } else {
      place = planFirstWrite(this.state.doc, this.state.selection.to);
    }
    const tr = this.state.tr;
    this.last = writeFinal(tr, place!.at, place!.pre, place!.post, words);
    tr.setSelection(TextSelection.create(tr.doc, this.last.to));
    this.apply(tr, true, true);
  }
  refine(finalText: string) {
    const tr = this.state.tr;
    this.last = writeRefine(tr, this.last!, finalText);
    this.apply(tr, true);
  }
  /** Someone else's edit: the user typing at `pos`. */
  type(text: string, pos: number) { this.apply(this.state.tr.insertText(text, pos), false); }
  undo() { undo(this.state, (tr) => { this.state = this.state.apply(tr); }); }
  get text() { return show(this.state.doc); }
}

describe('dictationPadding (the composer rule)', () => {
  it('adds a space only on a side that touches other text', () => {
    expect(dictationPadding('', '')).toEqual({ pre: '', post: '' });
    expect(dictationPadding('hello', 'world')).toEqual({ pre: ' ', post: ' ' });
    expect(dictationPadding('hello ', ' world')).toEqual({ pre: '', post: '' });
    expect(dictationPadding('hello', '')).toEqual({ pre: ' ', post: '' });
  });
});

describe('textAnchor / planFirstWrite', () => {
  it('keeps a caret that sits in text', () => {
    const doc = docOf(p('helloworld'));
    expect(planFirstWrite(doc, after(doc, 'hello'))).toEqual({ at: 6, pre: ' ', post: ' ' });
  });

  it('pads against an inline atom as text, never as a space', () => {
    const doc = docOf(p('a', image()));
    expect(planFirstWrite(doc, doc.content.size - 1)).toEqual({ at: 3, pre: ' ', post: '' });
  });

  it('moves a caret between blocks to the end of the textblock before it', () => {
    const doc = docOf(p('first'), rule(), p('second'));
    const betweenRuleAndSecond = 1 + 5 + 1 + 1; // after <p>first</p> and the rule
    expect(textAnchor(doc, betweenRuleAndSecond)).toBe(6);
  });

  it('uses the first textblock after the caret when none comes before it', () => {
    const doc = docOf(rule(), p('only'));
    expect(textAnchor(doc, 0)).toBe(2);
  });

  it('puts the end of the document at the end of the last textblock', () => {
    const doc = docOf(p('one'), p('two'));
    expect(textAnchor(doc, doc.content.size)).toBe(doc.content.size - 1);
  });

  it('finds no place in a document without text blocks', () => {
    expect(textAnchor(docOf(rule()), 0)).toBeNull();
  });
});

describe('mapDictationSpan', () => {
  const doc = docOf(p('before'), p('say this'));
  const from = after(doc, 'say ');
  const span: EditorDictationSpan = { from, to: from + 4, text: 'this', pre: '', post: '' };

  it('follows the span when text is typed earlier in the document', () => {
    const tr = EditorState.create({ doc }).tr.insertText('XX', 1);
    expect(mapDictationSpan(span, tr.mapping, tr.doc)).toMatchObject({ from: from + 2, to: from + 6, text: 'this' });
  });

  it('keeps text typed right at either edge outside the span', () => {
    const atStart = EditorState.create({ doc }).tr.insertText('X', from);
    expect(mapDictationSpan(span, atStart.mapping, atStart.doc)).toMatchObject({ from: from + 1, to: from + 5 });
    const atEnd = EditorState.create({ doc }).tr.insertText('X', from + 4);
    expect(mapDictationSpan(span, atEnd.mapping, atEnd.doc)).toMatchObject({ from, to: from + 4 });
  });

  it('drops the span when the user edits inside it', () => {
    const tr = EditorState.create({ doc }).tr.insertText('X', from + 2);
    expect(mapDictationSpan(span, tr.mapping, tr.doc)).toBeNull();
  });

  it('drops the span when its words are deleted', () => {
    const tr = EditorState.create({ doc }).tr.delete(from - 1, from + 4);
    expect(mapDictationSpan(span, tr.mapping, tr.doc)).toBeNull();
  });

  it('drops the span when the whole document is replaced (a reload), even with the same words', () => {
    const tr = EditorState.create({ doc }).tr.replaceWith(0, doc.content.size, docOf(p('before'), p('say this')).content);
    expect(mapDictationSpan(span, tr.mapping, tr.doc)).toBeNull();
  });
});

describe('finalRange', () => {
  it('takes the padding with the words while it is intact, else the words alone', () => {
    const doc = docOf(p('a b c'));
    const span: EditorDictationSpan = { from: 3, to: 4, text: 'b', pre: ' ', post: ' ' };
    expect(finalRange(doc, span)).toEqual({ from: 2, to: 5, pre: ' ', post: ' ' });
    const edited = docOf(p('aXb c'));
    expect(finalRange(edited, span)).toEqual({ from: 3, to: 4, pre: '', post: '' });
  });
});

describe('a dictation end to end (draft, draft, final, refine, undo)', () => {
  it('replaces each draft in place, never appending', () => {
    const doc = docOf(p('Note:'));
    const h = new Harness(doc, after(doc, 'Note:'));
    h.draft('buy');
    expect(h.text).toBe('Note: buy');
    h.draft('buy milk');
    expect(h.text).toBe('Note: buy milk');
    h.draft('buy milk and eggs');
    expect(h.text).toBe('Note: buy milk and eggs');
  });

  it('writes the final over the draft, puts the caret after it, and one undo removes it all', () => {
    const doc = docOf(p('helloworld'));
    const h = new Harness(doc, after(doc, 'hello'));
    h.draft('big');
    h.draft('big wide');
    expect(h.text).toBe('hello big wide world');
    h.final('big wide');
    expect(h.text).toBe('hello big wide world');
    expect(h.state.selection.from).toBe(after(h.state.doc, 'hello big wide'));
    h.undo();
    expect(h.text).toBe('helloworld');
  });

  it('keeps what the user typed elsewhere while speaking, and the span stays right', () => {
    const doc = docOf(p('top'), p('end'));
    const h = new Harness(doc, after(doc, 'end'));
    h.draft('one');
    h.type('!', after(h.state.doc, 'top'));
    h.draft('one two');
    expect(h.text).toBe('top!|end one two');
    h.final('one two three');
    expect(h.text).toBe('top!|end one two three');
    h.undo();
    expect(h.text).toBe('top!|end');
  });

  it('keeps text typed right after the draft outside it', () => {
    const doc = docOf(p('x'));
    const h = new Harness(doc, 2);
    h.draft('hi');
    h.type('?', h.span!.to);
    h.draft('hi there');
    expect(h.text).toBe('x hi there?');
  });

  it('a refine swaps in better words while the provisional ones are untouched; undo still removes them', () => {
    const doc = docOf(p('Plan:'));
    const h = new Harness(doc, after(doc, 'Plan:'));
    h.draft('ship it');
    h.final('ship it');
    const caret = h.state.selection.from;
    h.refine('ship it today');
    expect(h.text).toBe('Plan: ship it today');
    // The caret that sat after the provisional words follows to the refined end.
    expect(h.state.selection.from).toBe(caret + ' today'.length);
    h.undo();
    expect(h.text).toBe('Plan:');
  });

  it('a final with no draft before it is one undoable insert at the caret', () => {
    const doc = docOf(p('ab'));
    const h = new Harness(doc, 2);
    h.final('mid');
    expect(h.text).toBe('a mid b');
    h.undo();
    expect(h.text).toBe('ab');
  });

  it('writes into an empty document', () => {
    const h = new Harness(docOf(p()), 1);
    h.draft('hello');
    h.final('hello there');
    expect(h.text).toBe('hello there');
  });

  it('an emptied draft keeps its paragraph', () => {
    const doc = docOf(p('a'), p());
    const h = new Harness(doc, doc.content.size - 1);
    h.draft('word');
    h.draft('');
    expect(h.text).toBe('a|');
    expect(h.state.doc.childCount).toBe(2);
  });
});
