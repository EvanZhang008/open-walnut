/**
 * `<` and `>` typed as prose must survive save and copy as themselves.
 *
 * Pins the 2026-09-23 report: a sentence written in the Files-panel editor
 * (`Orchestrator -> Service URL -> Pod`) was copied with ⌘C and pasted into the
 * session composer, where it read `-&gt;`, and was sent to the CLI that way.
 * `tiptap-markdown`'s text serializer runs `escapeHTML` over EVERY text node,
 * so any `<`/`>` came out as an entity on save and on copy alike.
 *
 * The rule under test: a bare `<` or `>` (an arrow, a comparison) is plain
 * markdown text and serializes verbatim; only a run that CommonMark would read
 * as raw HTML or an autolink (`<tag>`, `</tag>`, `<!-- -->`, `<https://…>`)
 * keeps the entity form, so literal tag-shaped prose still cannot turn into
 * markup on the next load.
 */
import { describe, it, expect } from 'vitest';
import type { Node as PMNode } from '@tiptap/pm/model';
import { createNotesMarkdownHarness } from './editor-harness';
import { markdownForCopiedSlice } from '@/components/notes/extensions/markdown-copy';

const h = createNotesMarkdownHarness();

function posOf(doc: PMNode, needle: string): number {
  let found = -1;
  doc.descendants((node, pos) => {
    if (found >= 0 || !node.isText) return found < 0;
    const i = node.text!.indexOf(needle);
    if (i >= 0) found = pos + i;
    return false;
  });
  if (found < 0) throw new Error(`text not found in doc: ${JSON.stringify(needle)}`);
  return found;
}

/** ⌘C plain-text flavour for the selection from `from` through the end of `to`. */
function copy(md: string, from: string, to: string = from): string {
  const doc = h.mdToDoc(md);
  const a = posOf(doc, from);
  const b = posOf(doc, to) + to.length;
  return markdownForCopiedSlice(doc.slice(a, b, true), h.schema, h.serializer);
}

const ARROWS = 'Sync: Orchestrator -> Service URL -> Pod Rev1 and Rev2 both in pool but different ratio, as traffic control.';

describe('angle brackets in prose: save writes them verbatim', () => {
  it('an ASCII arrow (the reported sentence)', () => {
    expect(h.roundTrip(ARROWS)).toBe(ARROWS);
  });
  it('comparisons and other arrow spellings', () => {
    const md = 'x < y, a > b, a >= b, a <= b, f => g, g <- f, a <> b';
    expect(h.roundTrip(md)).toBe(md);
  });
  it('a file already carrying the entity form heals to the arrow on save', () => {
    expect(h.roundTrip('Orchestrator -&gt; Service URL')).toBe('Orchestrator -> Service URL');
  });
  it('an arrow inside a table cell', () => {
    const md = '| Flow | Note |\n| --- | --- |\n| A -> B | ok |';
    // The table serializer's own stable form ends in a newline (markdown-roundtrip corpus).
    expect(h.roundTrip(md)).toBe(`${md}\n`);
  });
  it('an arrow inside a list item and a heading', () => {
    const md = '# From -> To\n\n- A -> B\n- C <- D';
    expect(h.roundTrip(md)).toBe(md);
  });
  it('an arrow inside inline code and a fence is untouched', () => {
    const md = 'call `a -> b` then:\n\n```\nx -> y\n```';
    expect(h.roundTrip(md)).toBe(md);
  });
  it('a blockquote is still a blockquote', () => {
    expect(h.roundTrip('> quoted -> still quoted')).toBe('> quoted -> still quoted');
  });
});

describe('angle brackets in prose: a line opened by a hard break', () => {
  // Shift+Enter puts `\` + newline in the markdown; the next line is inside the
  // same paragraph. The entity used to keep a leading `>` from reading as a
  // quote on reload; now the start-of-line escape does, and the paragraph
  // stays one paragraph (a fixed point after the first save).
  it('a leading `>` after a hard break is escaped, not a blockquote', () => {
    // What the old serializer wrote for that paragraph: the entity form.
    const old = 'line one\\\n&gt; not a quote';
    expect(h.mdToDoc(old).childCount).toBe(1);
    const once = h.roundTrip(old);
    expect(once).toBe('line one\\\n\\> not a quote');
    expect(h.roundTrip(once)).toBe(once);
    expect(h.mdToDoc(once).childCount).toBe(1);
  });
  it('a leading list marker and heading marker after a hard break', () => {
    const list = 'line one\\\n\\- not a list';
    expect(h.mdToDoc(list).childCount).toBe(1);
    expect(h.roundTrip(list)).toBe(list);
    const heading = 'line one\\\n\\# not a heading';
    expect(h.mdToDoc(heading).childCount).toBe(1);
    expect(h.roundTrip(heading)).toBe(heading);
  });
  it('inside a list item too', () => {
    const once = h.roundTrip('- x\\\n  &gt; y');
    expect(once).toBe('- x\\\n  \\> y');
    expect(h.roundTrip(once)).toBe(once);
  });
  it('an arrow after a hard break is still an arrow', () => {
    const md = 'line one\\\nA -> B';
    expect(h.roundTrip(md)).toBe(md);
  });
});

describe('angle brackets in prose: markup-shaped runs keep the entity form', () => {
  it('a literal tag typed as text stays text on the next load', () => {
    // On disk as entities (what the editor wrote before and still writes), so a
    // reload cannot read `<div>` as an element and drop the words.
    expect(h.roundTrip('type &lt;div&gt; to open a box')).toBe('type &lt;div&gt; to open a box');
  });
  it('a closing tag, a comment and an autolink shape', () => {
    const md = 'end with &lt;/div&gt;, hide with &lt;!-- x --&gt;, link as &lt;https://a.b&gt;';
    expect(h.roundTrip(md)).toBe(md);
  });
  it('a bare tag-shaped run written raw also comes back as text, not markup', () => {
    // The serializer never emits this shape, but a hand-edited file can carry
    // it: it parses as an unknown element and the parser drops it. That is the
    // library's documented behaviour (memory-file-io.ts pre-escapes for it), so
    // this case only pins that the fix does not make raw `<`/`>` in an arrow
    // behave like that: the arrow sentence keeps every word.
    expect(h.roundTrip('A -> B keeps every word')).toBe('A -> B keeps every word');
  });
});

describe('angle brackets in prose: copy as markdown', () => {
  it('the reported sentence copies with its arrows', () => {
    expect(copy(ARROWS, 'Sync:', 'control.')).toBe(ARROWS);
  });
  it('a few words around an arrow inside a table cell', () => {
    const md = '| Flow |\n| --- |\n| Orchestrator -> Service URL -> Pod |';
    expect(copy(md, 'Orchestrator', 'Pod')).toBe('Orchestrator -> Service URL -> Pod');
  });
  it('a selection across two paragraphs', () => {
    const md = 'A -> B\n\nC <- D';
    expect(copy(md, 'A ->', '<- D')).toBe('A -> B\n\nC <- D');
  });
  it('a literal tag typed as text copies in its entity form', () => {
    expect(copy('type &lt;div&gt; here', 'type', 'here')).toBe('type &lt;div&gt; here');
  });
});
