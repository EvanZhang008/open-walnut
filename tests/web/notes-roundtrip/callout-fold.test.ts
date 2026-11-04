/**
 * Foldable callouts (Obsidian syntax): `> [!note]- Title` is folded by default,
 * `> [!note]+ Title` open by default, and the lines after it are the body.
 *
 * Drives the production serializer/parser (editor-harness) for the disk form, and
 * the real fold plugin + `CalloutView` NodeView over a real EditorState for the
 * chevron: folding is a view state only, so the document (and the bytes on disk)
 * never change.
 */
import { describe, it, expect } from 'vitest';
import { EditorState, TextSelection } from '@tiptap/pm/state';
import type { Transaction } from '@tiptap/pm/state';
import type { DecorationSet } from '@tiptap/pm/view';
import type { Node as PMNode } from '@tiptap/pm/model';
import { createNotesMarkdownHarness } from './editor-harness';
import {
  CalloutView,
  calloutFoldPlugin,
  calloutFoldTransaction,
  calloutsWithSelectionInBody,
  isCalloutCollapsed,
} from '@/components/notes/extensions/callout-node';

const h = createNotesMarkdownHarness();

function expectByteClean(md: string): void {
  const once = h.roundTrip(md);
  expect(once, 'round-trip must be byte-clean').toBe(md);
  expect(h.roundTrip(once), 'round-trip must be idempotent').toBe(once);
}

function firstCallout(doc: PMNode): PMNode {
  let found: PMNode | null = null;
  doc.descendants(n => {
    if (!found && n.type.name === 'callout') found = n;
    return !found;
  });
  if (!found) throw new Error('no callout in doc');
  return found;
}

describe('foldable callout: parse', () => {
  it('`-` marks a folded callout whose title is the first paragraph', () => {
    const doc = h.mdToDoc('> [!note]- My title\n> body text');
    const c = firstCallout(doc);
    expect(c.attrs).toMatchObject({ kind: 'note', fold: '-' });
    expect(c.childCount).toBe(2);
    expect(c.child(0).type.name).toBe('paragraph');
    expect(c.child(0).textContent).toBe('My title');
    expect(c.child(1).textContent).toBe('body text');
  });

  it('`+` marks an open-by-default callout', () => {
    const c = firstCallout(h.mdToDoc('> [!tip]+ Open one\n> body'));
    expect(c.attrs).toMatchObject({ kind: 'tip', fold: '+' });
    expect(c.child(0).textContent).toBe('Open one');
  });

  it('keeps bold and links in the title as marks', () => {
    const c = firstCallout(h.mdToDoc('> [!info]- A **bold** [link](https://e.com) title\n> body'));
    const title = c.child(0);
    expect(title.textContent).toBe('A bold link title');
    const marks: string[] = [];
    title.forEach(n => n.marks.forEach(m => marks.push(m.type.name)));
    expect(marks).toEqual(expect.arrayContaining(['bold', 'link']));
  });

  it('a mark spanning the title line break stays on both sides', () => {
    const c = firstCallout(h.mdToDoc('> [!note]- **bold\n> still bold**'));
    expect(c.child(0).textContent).toBe('bold');
    expect(c.child(1).textContent).toBe('still bold');
    expect(c.child(0).firstChild!.marks.map(m => m.type.name)).toEqual(['bold']);
    expect(c.child(1).firstChild!.marks.map(m => m.type.name)).toEqual(['bold']);
  });

  it('an empty title is an empty first paragraph', () => {
    const c = firstCallout(h.mdToDoc('> [!warning]-\n> body'));
    expect(c.attrs.fold).toBe('-');
    expect(c.child(0).content.size).toBe(0);
    expect(c.child(1).textContent).toBe('body');
  });

  it('an unknown kind with a fold marker stays a plain blockquote', () => {
    const doc = h.mdToDoc('> [!abstract]- Title\n> body');
    expect(doc.firstChild!.type.name).toBe('blockquote');
  });

  it('a plain `[!kind]` callout gets no fold', () => {
    expect(firstCallout(h.mdToDoc('> [!note]\n> body')).attrs.fold).toBe('');
  });
});

describe('foldable callout: byte-clean round-trip', () => {
  it('folded, title + one body line', () => expectByteClean('> [!note]- Title\n> body'));
  it('open by default', () => expectByteClean('> [!tip]+ Title\n> body'));
  it('each kind', () => {
    for (const kind of ['note', 'tip', 'warning', 'danger', 'info']) {
      expectByteClean(`> [!${kind}]- ${kind} title\n> ${kind} body`);
    }
  });
  it('title only', () => expectByteClean('> [!note]- Just a title'));
  it('empty title with a body', () => expectByteClean('> [!note]-\n> body'));
  it('empty title, nothing else', () => expectByteClean('> [!danger]-'));
  it('bold and link in the title', () =>
    expectByteClean('> [!info]- A **bold** [link](https://e.com) and *em* title\n> body'));
  it('a title that looks like a list or heading needs no escape', () => {
    expectByteClean('> [!note]- 1. not a list\n> body');
    expectByteClean('> [!note]- - not a bullet\n> body');
    expectByteClean('> [!note]- # not a heading\n> body');
  });
  it('several body paragraphs', () =>
    expectByteClean('> [!note]- Title\n> para one\n>\n> para two\n>\n> para three'));
  it('a blank line between title and body is kept', () =>
    expectByteClean('> [!note]- Title\n>\n> body after a gap'));
  it('a nested list in the body', () =>
    expectByteClean('> [!note]- Title\n> - one\n>   - nested a\n>   - nested b\n> - two'));
  it('a list right after a gap', () => expectByteClean('> [!note]+ Title\n>\n> - one\n> - two'));
  it('a code block and a heading in the body', () =>
    expectByteClean('> [!warning]- Title\n> ```js\n> const x = 1;\n> ```\n>\n> ## Heading\n>\n> after'));
  it('a foldable callout nested in a foldable callout', () =>
    expectByteClean('> [!note]- Outer\n> > [!tip]- Inner\n> > inner body\n>\n> outer body'));
  it('surrounded by other blocks', () =>
    expectByteClean('# Doc\n\nBefore.\n\n> [!note]- Title\n> body\n\nAfter.'));
  it('a hard break inside the title stays in the title', () => {
    const md = '> [!note]- line one\\\n> line two\n>\n> body';
    expectByteClean(md);
    const c = firstCallout(h.mdToDoc(md));
    expect(c.child(0).textContent).toBe('line oneline two');
    expect(c.child(1).textContent).toBe('body');
  });
  it('Unicode in title and body', () =>
    expectByteClean('> [!note]- café 中文 😀\n> 日本語 body'));
});

describe('foldable callout: documented normalization', () => {
  // Soft-wrapped body lines reflow to one paragraph, exactly as a plain callout's do.
  it('soft-wrapped body lines join (CommonMark), title untouched', () => {
    const once = h.roundTrip('> [!note]- Title\n> line one\n> line two');
    expect(once).toBe('> [!note]- Title\n> line one line two');
    expect(h.roundTrip(once)).toBe(once);
  });
  it('an upper-case kind is written lower-case', () => {
    const once = h.roundTrip('> [!NOTE]- Title\n> body');
    expect(once).toBe('> [!note]- Title\n> body');
    expect(h.roundTrip(once)).toBe(once);
  });
});

describe('plain callout bytes are unchanged', () => {
  it('the existing forms are byte-clean as before', () => {
    expectByteClean('> [!note]\n> a note body');
    expectByteClean('> [!warning]\n> para one\n>\n> para two');
    expectByteClean('> [!tip]\n> - one\n> - two');
  });
  it('the existing normalizations are unchanged', () => {
    expect(h.roundTrip('> [!tip] inline body on marker line')).toBe('> [!tip]\n> inline body on marker line');
    expect(h.roundTrip('> [!warning]\n> body line one\n> body line two')).toBe('> [!warning]\n> body line one body line two');
    expect(h.roundTrip('> [!xxx]\n> stays a blockquote')).toBe('> \\[!xxx\\] stays a blockquote');
  });
  it('`[!note] - x` (space before the dash) is not a fold marker', () => {
    const c = firstCallout(h.mdToDoc('> [!note] - x\n> body'));
    expect(c.attrs.fold).toBe('');
  });
});

describe('inline markup on the first body line survives', () => {
  // A plain callout's body line right under `> [!kind]` used to lose its inline
  // markup on load (the marker strip rewrote the paragraph as plain text).
  it('plain callout: inline code, bold, link, math-style code on the first line', () => {
    expectByteClean('> [!note]\n> Inside `x` here');
    expectByteClean('> [!tip]\n> **bold** and [link](https://e.com) and *em*');
    expectByteClean('> [!info]\n> math $`a^2`$ inline');
    expectByteClean('> [!warning]\n> first `code`\n>\n> second `code`');
  });
  it('plain callout: the inline-body-on-marker-line normalization keeps markup', () => {
    const once = h.roundTrip('> [!tip] inline `code` body');
    expect(once).toBe('> [!tip]\n> inline `code` body');
    expect(h.roundTrip(once)).toBe(once);
  });
  it('foldable callout: inline code and math in title and body', () => {
    expectByteClean('> [!note]- Title with `code`\n> Body with `x` and $`y`$');
    expectByteClean('> [!note]+ $`e=mc^2`$ title\n> body `z`');
  });
});

describe('blocks that cannot sit right under the title line get a blank line', () => {
  const stable = (md: string, want: string) => {
    const once = h.roundTrip(md);
    expect(once).toBe(want);
    expect(h.roundTrip(once)).toBe(once);
  };
  it('a thematic break (would make the title a setext heading)', () => {
    stable('> [!note]- Title\n>\n> ***', '> [!note]- Title\n>\n> ---');
    stable('> [!note]-\n>\n> ---', '> [!note]-\n>\n> ---');
    // Plain callouts had the same loss (`> [!note]\n> ***` became a heading).
    stable('> [!note]\n>\n> ***', '> [!note]\n>\n> ---');
  });
  it('a paragraph of `=` only', () => {
    stable('> [!note]- Title\n>\n> \\===', '> [!note]- Title\n>\n> ===');
    const c = firstCallout(h.mdToDoc('> [!note]- Title\n>\n> ==='));
    expect(c.child(1).textContent).toBe('===');
  });
  it('an ordered list that does not start at 1', () => {
    stable('> [!note]- Title\n>\n> 3. x\n> 4. y', '> [!note]- Title\n>\n> 3. x\n> 4. y');
    stable('> [!note]\n>\n> 3. x', '> [!note]\n>\n> 3. x');
    const c = firstCallout(h.mdToDoc('> [!note]- Title\n>\n> 3. x'));
    expect(c.child(1).type.name).toBe('orderedList');
  });
  it('an ordered list from 1, a task list, a table and a quote need none', () => {
    expectByteClean('> [!note]- Title\n> 1. x\n> 2. y');
    expectByteClean('> [!note]- Title\n> - [ ] todo\n> - [x] done');
    expectByteClean('> [!note]- Title\n> > quoted');
  });
  it('title trailing spaces are dropped instead of becoming a hard break', () => {
    const doc = h.mdToDoc('> [!note]- Title\n> body');
    const c = firstCallout(doc);
    const title = h.schema.nodes.paragraph.create(null, h.schema.text('Title  '));
    const edited = doc.copy(doc.content.replaceChild(0, c.copy(c.content.replaceChild(0, title))));
    const md = h.docToMd(edited);
    expect(md).toBe('> [!note]- Title\n> body');
    expect(firstCallout(h.mdToDoc(md)).childCount).toBe(2);
  });
  it('a title ending in a hard break keeps its body separate', () => {
    const doc = h.mdToDoc('> [!note]- Title\n> body');
    const c = firstCallout(doc);
    const title = h.schema.nodes.paragraph.create(null, [h.schema.text('Title'), h.schema.nodes.hardBreak.create()]);
    const edited = doc.copy(doc.content.replaceChild(0, c.copy(c.content.replaceChild(0, title))));
    const md = h.docToMd(edited);
    const back = firstCallout(h.mdToDoc(md));
    expect(back.childCount).toBe(2);
    expect(back.child(1).textContent).toBe('body');
    expect(h.roundTrip(md)).toBe(md);
  });
});

describe('what is not a fold marker', () => {
  it('an escaped marker stays a blockquote (typed text, both forms)', () => {
    expect(h.mdToDoc('> \\[!note\\]- x').firstChild!.type.name).toBe('blockquote');
    expect(h.mdToDoc('> \\[!note\\] x').firstChild!.type.name).toBe('blockquote');
    expect(h.roundTrip('> \\[!note\\]- x')).toBe('> \\[!note\\]- x');
  });
  it('a marker glued to markup (`[!note]-**x**`) is not foldable', () => {
    const doc = h.mdToDoc('> [!note]-**x**\n> body');
    const top = doc.firstChild!;
    expect(top.type.name === 'callout' ? top.attrs.fold : '').toBe('');
  });
  it('a trailing space after the marker still makes an empty title', () => {
    const c = firstCallout(h.mdToDoc('> [!note]- \n> body'));
    expect(c.attrs.fold).toBe('-');
    expect(c.child(0).content.size).toBe(0);
    expect(c.child(1).textContent).toBe('body');
  });
});

describe('editing a foldable callout', () => {
  it('a new body block typed under the title is saved under the marker line', () => {
    const doc = h.mdToDoc('> [!note]- Title');
    const c = firstCallout(doc);
    const para = h.schema.nodes.paragraph.create(null, h.schema.text('new body'));
    const edited = doc.copy(doc.content.replaceChild(0, c.copy(c.content.addToEnd(para))));
    expect(h.docToMd(edited)).toBe('> [!note]- Title\n> new body');
  });
  it('a callout whose first block is no longer a paragraph writes an empty title', () => {
    const doc = h.mdToDoc('> [!note]- Title\n> body');
    const c = firstCallout(doc);
    const list = h.mdToDoc('- item').firstChild!;
    const edited = doc.copy(doc.content.replaceChild(0, c.copy(c.content.replaceChild(0, list))));
    const md = h.docToMd(edited);
    expect(md).toBe('> [!note]-\n> - item\n>\n> body');
    expect(h.roundTrip(md)).toBe(md);
  });
});

// ─── Fold state + NodeView: the chevron toggles the view, never the document ─

function firstCalloutPos(doc: PMNode): number {
  let at = -1;
  doc.descendants((n, pos) => {
    if (at < 0 && n.type.name === 'callout') at = pos;
    return at < 0;
  });
  return at;
}

/** A real EditorState with the fold plugin, plus a view stub that re-renders the NodeView like ProseMirror does. */
function mount(md: string, selectionAt?: (calloutPos: number, c: PMNode) => number) {
  const plugin = calloutFoldPlugin();
  let state = EditorState.create({ doc: h.mdToDoc(md), plugins: [plugin] });
  const pos = firstCalloutPos(state.doc);
  if (selectionAt) {
    const at = selectionAt(pos, state.doc.nodeAt(pos)!);
    state = state.apply(state.tr.setSelection(TextSelection.create(state.doc, at)));
  }
  const decosAt = (s: EditorState) => {
    const node = s.doc.nodeAt(pos)!;
    return (plugin.props.decorations!.call(plugin, s) as DecorationSet).find(pos, pos + node.nodeSize).filter(d => d.from === pos);
  };
  const dispatched: { docChanged: boolean }[] = [];
  let nv: CalloutView;
  const view = {
    dom: document.createElement('div'),
    get state() { return state; },
    dispatch(tr: Transaction) {
      dispatched.push({ docChanged: tr.docChanged });
      state = state.apply(tr);
      nv.update(state.doc.nodeAt(pos)!, decosAt(state));
    },
  };
  nv = new CalloutView(state.doc.nodeAt(pos)!, view as any, () => pos, decosAt(state));
  const button = nv.dom.querySelector('button.notes-callout-fold-toggle') as HTMLButtonElement | null;
  const click = () => button!.dispatchEvent(new (globalThis as any).window.Event('click', { bubbles: true, cancelable: true }));
  return { nv, view, pos, button, click, dispatched, get state() { return state; } };
}

describe('fold state (plugin)', () => {
  it('defaults come from the file: `-` folded, `+` open, plain never', () => {
    expect(isCalloutCollapsed(mount('> [!note]- T\n> b').state, 0)).toBe(true);
    expect(isCalloutCollapsed(mount('> [!note]+ T\n> b').state, 0)).toBe(false);
    expect(isCalloutCollapsed(mount('> [!note]\n> b').state, 0)).toBe(false);
  });

  it('a fold transaction changes no document and is kept out of undo history', () => {
    const v = mount('> [!note]+ Title\n> body');
    const tr = calloutFoldTransaction(v.state, v.pos, true)!;
    expect(tr.docChanged).toBe(false);
    expect(tr.getMeta('addToHistory')).toBe(false);
    v.view.dispatch(tr);
    expect(isCalloutCollapsed(v.state, v.pos)).toBe(true);
  });

  it('the fold state survives typing inside the callout (mapped through edits)', () => {
    const v = mount('> [!note]+ Title\n> body');
    v.view.dispatch(calloutFoldTransaction(v.state, v.pos, true)!);
    v.view.dispatch(v.state.tr.insertText('XY', v.pos + 3));
    expect(v.state.doc.nodeAt(v.pos)!.child(0).textContent).toBe('TXYitle');
    expect(isCalloutCollapsed(v.state, v.pos)).toBe(true);
  });

  it('a selection that lands in a folded body unfolds it in the same transaction', () => {
    const v = mount('> [!note]- Title\n> body');
    const c = v.state.doc.nodeAt(v.pos)!;
    const inBody = v.pos + 1 + c.child(0).nodeSize + 2;
    v.view.dispatch(v.state.tr.setSelection(TextSelection.create(v.state.doc, inBody)));
    expect(isCalloutCollapsed(v.state, v.pos)).toBe(false);
    expect(v.nv.isCollapsed).toBe(false);
  });

  it('Enter at the end of a folded title (a new body paragraph) unfolds it', () => {
    const v = mount('> [!note]- Title', (pos, c) => pos + 1 + c.child(0).nodeSize - 1);
    expect(isCalloutCollapsed(v.state, v.pos)).toBe(true);
    const tr = v.state.tr.split(v.state.selection.from);
    v.view.dispatch(tr);
    expect(v.state.selection.$head.parent.textContent).toBe('');
    expect(isCalloutCollapsed(v.state, v.pos)).toBe(false);
    // An empty paragraph writes nothing (as everywhere in the editor): the title line is kept.
    expect(h.docToMd(v.state.doc).trimEnd()).toBe('> [!note]- Title');
    expect(h.roundTrip(h.docToMd(v.state.doc)).trimEnd()).toBe('> [!note]- Title');
  });
});

describe('CalloutView', () => {
  it('a `-` callout starts collapsed and the chevron expands it without touching the doc', () => {
    const md = '> [!note]- Title\n> body one\n>\n> body two';
    const v = mount(md);
    const before = v.state.doc;
    expect(v.button).not.toBeNull();
    expect(v.button!.getAttribute('contenteditable')).toBe('false');
    expect(v.button!.getAttribute('aria-expanded')).toBe('false');
    expect(v.nv.dom.classList.contains('is-collapsed')).toBe(true);
    expect(v.nv.contentDOM).not.toBe(v.nv.dom);

    v.click();
    expect(v.button!.getAttribute('aria-expanded')).toBe('true');
    expect(v.nv.dom.classList.contains('is-collapsed')).toBe(false);
    v.click();
    expect(v.nv.dom.classList.contains('is-collapsed')).toBe(true);

    expect(v.dispatched).toEqual([{ docChanged: false }, { docChanged: false }]);
    expect(v.state.doc.eq(before)).toBe(true);
    expect(h.docToMd(v.state.doc)).toBe(md);
  });

  it('a `+` callout starts expanded', () => {
    const v = mount('> [!tip]+ Title\n> body');
    expect(v.button!.getAttribute('aria-expanded')).toBe('true');
    expect(v.nv.dom.classList.contains('is-collapsed')).toBe(false);
  });

  it('a plain callout has no chevron and keeps its old DOM shape', () => {
    const v = mount('> [!note]\n> body');
    expect(v.button).toBeNull();
    expect(v.nv.contentDOM).toBe(v.nv.dom);
    expect(v.nv.dom.className).toBe('notes-callout notes-callout-note');
  });

  it('folding with the caret in the body moves it to the title end (selection only)', () => {
    const v = mount('> [!note]+ Title\n> body', (pos, c) => pos + 1 + c.child(0).nodeSize + 2);
    expect(calloutsWithSelectionInBody(v.state)).toHaveLength(1);
    v.click();
    expect(v.nv.isCollapsed).toBe(true);
    expect(v.dispatched).toEqual([{ docChanged: false }]);
    expect(calloutsWithSelectionInBody(v.state)).toHaveLength(0);
    expect(v.state.selection.$head.parent.textContent).toBe('Title');
  });

  it('the chevron stops editor events; its own mutations are ignored', () => {
    const v = mount('> [!note]- Title\n> body');
    expect(v.nv.stopEvent({ target: v.button } as unknown as Event)).toBe(true);
    expect(v.nv.stopEvent({ target: v.nv.contentDOM } as unknown as Event)).toBe(false);
    expect(v.nv.ignoreMutation({ type: 'attributes', target: v.button } as any)).toBe(true);
    expect(v.nv.ignoreMutation({ type: 'childList', target: v.nv.contentDOM } as any)).toBe(false);
    expect(v.nv.ignoreMutation({ type: 'childList', target: v.nv.dom } as any)).toBe(false);
    expect(v.nv.ignoreMutation({ type: 'attributes', target: v.nv.dom } as any)).toBe(true);
  });

  it('update keeps classes ProseMirror put on the wrapper', () => {
    const v = mount('> [!note]- Title\n> body');
    v.nv.dom.classList.add('ProseMirror-selectednode');
    v.click();
    expect(v.nv.dom.classList.contains('ProseMirror-selectednode')).toBe(true);
    expect(v.nv.dom.classList.contains('notes-callout-note')).toBe(true);
  });

  it('update rebuilds on plain <-> foldable', () => {
    const v = mount('> [!note]- Title\n> body');
    const c = v.state.doc.nodeAt(v.pos)!;
    expect(v.nv.update(c.type.create({ ...c.attrs }, c.content))).toBe(true);
    expect(v.nv.update(c.type.create({ ...c.attrs, fold: '' }, c.content))).toBe(false);
  });
});
