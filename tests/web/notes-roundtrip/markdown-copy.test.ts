/**
 * ⌘C plain-text flavour: what `markdownForCopiedSlice` writes for a selection.
 *
 * Pins the 2026-09-10 report: words selected inside a table cell in the Files
 * panel copied as a one-cell table (`| words |` + `| --- |`), because the
 * shipped tiptap-markdown serializer wrote the slice's open ancestors too. The
 * rule under test: a selection inside ONE textblock copies its inline run only;
 * a selection across blocks still copies as markdown blocks.
 *
 * Slices are built the way ProseMirror builds them for the clipboard
 * (`doc.slice(from, to)` on a real parsed doc), so open depths match the live
 * editor exactly.
 */
import { describe, it, expect } from 'vitest';
import type { Node as PMNode } from '@tiptap/pm/model';
import { createNotesMarkdownHarness } from './editor-harness';
import { markdownForCopiedSlice } from '@/components/notes/extensions/markdown-copy';

const h = createNotesMarkdownHarness();

/** Absolute doc position of the first occurrence of `needle` in the doc's text. */
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

/**
 * Copy text for the selection from the start of `from` to the end of `to`.
 * `includeParents = true` is what `TextSelection.content()` hands the clipboard.
 */
function copy(md: string, from: string, to: string = from): string {
  const doc = h.mdToDoc(md);
  const a = posOf(doc, from);
  const b = posOf(doc, to) + to.length;
  return markdownForCopiedSlice(doc.slice(a, b, true), h.schema, h.serializer);
}

const TABLE = '| What | EKS |\n| --- | --- |\n| Summary | Isolation between plugins is ours to build and prove. |';

describe('copy as markdown: selection inside one block copies its text only', () => {
  it('words inside a table cell (the reported bug)', () => {
    expect(copy(TABLE, 'ours to build')).toBe('ours to build');
  });
  it('a whole table cell', () => {
    expect(copy(TABLE, 'Isolation between plugins is ours to build and prove.'))
      .toBe('Isolation between plugins is ours to build and prove.');
  });
  it('a header cell', () => {
    expect(copy(TABLE, 'EKS')).toBe('EKS');
  });
  it('inline marks inside a cell survive', () => {
    const md = '| a |\n| --- |\n| run `evaluate(ctx)` on **our** SDK |';
    expect(copy(md, 'run', 'SDK')).toBe('run `evaluate(ctx)` on **our** SDK');
  });
  it('words inside a heading carry no #', () => {
    expect(copy('# Plugin isolation model', 'isolation')).toBe('isolation');
  });
  it('words inside a list item carry no bullet', () => {
    expect(copy('- first item\n- second item', 'second')).toBe('second');
  });
  it('words inside a blockquote carry no >', () => {
    expect(copy('> quoted words here', 'words')).toBe('words');
  });
  it('words inside a code block copy as plain text, unfenced and unescaped', () => {
    expect(copy('```js\nconst x = a * b;\n```', 'a * b')).toBe('a * b');
  });
  it('words inside a paragraph', () => {
    expect(copy('Para one.\n\nPara two.', 'one')).toBe('one');
  });
  it('a parent-less inline slice (transformCopied output) keeps its marks', () => {
    const doc = h.mdToDoc('| a |\n| --- |\n| run **our** SDK |');
    const a = posOf(doc, 'run');
    const b = posOf(doc, 'SDK') + 3;
    const slice = doc.slice(a, b);
    expect(slice.openStart).toBe(0);
    expect(markdownForCopiedSlice(slice, h.schema, h.serializer)).toBe('run **our** SDK');
  });
});

describe('copy as markdown: selection across blocks keeps block markdown', () => {
  it('two paragraphs', () => {
    expect(copy('Para one.\n\nPara two.', 'one', 'two')).toBe('one.\n\nPara two');
  });
  it('two list items', () => {
    expect(copy('- first\n- second\n- third', 'first', 'second')).toBe('- first\n- second');
  });
  it('two cells of a row copy as a table', () => {
    expect(copy('| a | b |\n| --- | --- |\n| c | d |', 'c', 'd')).toBe('| c | d |\n| --- | --- |\n');
  });
  it('a whole table', () => {
    const doc = h.mdToDoc(TABLE);
    expect(markdownForCopiedSlice(doc.slice(0, doc.content.size), h.schema, h.serializer)).toBe(`${TABLE}\n`);
  });
});
