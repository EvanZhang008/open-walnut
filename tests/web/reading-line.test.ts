/**
 * The reading place carries between Preview and Source as a source line, and a pixel offset
 * is only ever put back into the view it was measured in (utils/reading-line.ts,
 * utils/file-view-state.ts; 2026-11-11 WebKit review: Preview at Section 7, about line 281,
 * switched to Source showed line 1; Source left near line 10, closed and reopened, showed
 * line 237, a Preview pixel offset read as Source pixels).
 *
 * The node tier has no DOM: Preview is modelled by its text (the source's words without the
 * markup), which is all the matching reads. Source guards then list every writer and reader
 * of the stored place and every way the view switches.
 */
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  foldText, lineCount, nearestOccurrence, renderedIndexOfLine, sourceLineOfText, wordsFromLine,
} from '../../web/src/utils/reading-line';

const WEB = path.join(path.dirname(new URL(import.meta.url).pathname), '../../web/src');
const src = (p: string) => readFileSync(path.join(WEB, p), 'utf8');

/** A long markdown document: sections of headings, prose with markup, lists, code and repeats. */
function document(sections = 12): string {
  const out: string[] = ['# Field guide', '', 'An introduction to the guide, with a [link](https://example.test/a/b?c=1) in it.', ''];
  for (let n = 1; n <= sections; n++) {
    out.push(`## Section ${n}`, '');
    out.push(`The **${n}th** part explains how the _port of ${n}_ keeps its boats ${n * 7} days, and why.`);
    out.push(`It goes on across a second line of prose for section ${n}, with \`code ${n}\` inside.`, '');
    out.push(`- first point of section ${n}`, `- second point, see [notes ${n}](./notes-${n}.md)`, '');
    out.push('```ts', `const value${n} = compute(${n});`, '```', '');
    // The same words in every section: only the place in the document tells them apart.
    out.push('TODO: fill in the details later.', '');
    out.push(...Array.from({ length: 6 }, (_, i) => `Paragraph ${i + 1} of section ${n} reads on about meadows, rivers and stone walls.`), '');
  }
  return out.join('\n');
}

/** What Preview shows of the source: its words, the markup and link addresses gone. */
function rendered(source: string): string {
  return source.split('\n').map((l) => l
    .replace(/^#+\s*/, '').replace(/^```\w*$/, '').replace(/^- /, '')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1').replace(/[*_`]/g, '')).join(' ');
}

describe('a source line found again in Preview, and back', () => {
  const source = document();
  const view = foldText(rendered(source)).text;
  const total = lineCount(source);

  it('every line with words round-trips: its words in Preview name the same line', () => {
    let checked = 0;
    for (let line = 1; line <= total; line++) {
      const text = source.split('\n')[line - 1]!;
      // A line of markup alone (a fence) shows nothing of itself in Preview.
      if (!foldText(text).text || text.startsWith('```')) continue;
      const share = (line - 1) / (total - 1);
      const at = renderedIndexOfLine(source, line, view, share);
      expect(at, `line ${line}`).toBeGreaterThanOrEqual(0);
      // What Preview shows from there on, as its top would read it.
      const back = sourceLineOfText(source, view.slice(at, at + 120), share);
      expect(back, `line ${line}`).toBe(line);
      checked++;
    }
    expect(checked).toBeGreaterThan(150);
  });

  it('the reported case: Preview at Section 7 names the line of its heading, never line 1', () => {
    const heading = source.split('\n').indexOf('## Section 7') + 1;
    expect(heading).toBeGreaterThan(100);
    const text = 'Section 7 The 7th part explains how the port of 7 keeps its boats 49 days';
    expect(sourceLineOfText(source, text, heading / total)).toBe(heading);
  });

  it('a passage repeated in every section is placed by where in the document it is', () => {
    const lines = source.split('\n');
    const repeats = lines.flatMap((l, i) => (l === 'TODO: fill in the details later.' ? [i + 1] : []));
    expect(repeats.length).toBe(12);
    for (const line of repeats) {
      const share = (line - 1) / (total - 1);
      expect(sourceLineOfText(source, 'TODO: fill in the details later. Paragraph 1 of', share)).toBe(line);
    }
  });

  it('markup and link addresses do not break the match', () => {
    // The intro line carries a URL Preview does not show.
    expect(sourceLineOfText(source, 'An introduction to the guide, with a link in it.', 0)).toBe(3);
    // A line of markup alone (a closing fence) has no words: its words are the next ones.
    const fence = source.split('\n').indexOf('```') + 1;
    expect(wordsFromLine(source, fence).startsWith(foldText('TODO: fill in').text)).toBe(true);
  });

  it('text that is in no line names none (the view falls back to the same share of the document)', () => {
    expect(sourceLineOfText(source, 'zzzz qqqq xxxx wwww', 0.5)).toBeNull();
    expect(renderedIndexOfLine('a\nb', 1, 'nothing here', 0)).toBe(-1);
  });

  it('nearestOccurrence picks the closest repeat to where the place should be', () => {
    expect(nearestOccurrence('abcXabcXabc', 'abc', 0)).toBe(0);
    expect(nearestOccurrence('abcXabcXabc', 'abc', 5)).toBe(4);
    expect(nearestOccurrence('abcXabcXabc', 'abc', 99)).toBe(8);
    expect(nearestOccurrence('abc', '', 0)).toBe(-1);
  });
});

describe('the stored place, view by view', () => {
  const store = new Map<string, string>();
  beforeEach(() => {
    store.clear();
    vi.stubGlobal('localStorage', {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => { store.set(k, v); },
      removeItem: (k: string) => { store.delete(k); },
    });
  });
  afterEach(() => { vi.unstubAllGlobals(); });
  const load = () => import('../../web/src/utils/file-view-state');

  it('a line goes to every view that can find lines; pixels only to the view they came from', async () => {
    const { placeForView } = await load();
    const fromPreview = { top: 5400, line: 281, topIn: 'wys' as const };
    for (const kind of ['cm', 'pre', 'md', 'wys'] as const) expect(placeForView(fromPreview, kind)).toEqual({ line: 281 });
    // The HTML page cannot find a line: only its own pixels.
    expect(placeForView(fromPreview, 'html')).toBeNull();
    expect(placeForView({ top: 900, topIn: 'html' }, 'html')).toEqual({ top: 900 });
    // No line: pixels only in their own view (the reported 237).
    expect(placeForView({ top: 5400, topIn: 'wys' }, 'cm')).toBeNull();
    expect(placeForView({ top: 5400, topIn: 'cm' }, 'cm')).toEqual({ top: 5400 });
    // An entry from before (no view named) keeps working where it was.
    expect(placeForView({ top: 700 }, 'md')).toEqual({ top: 700 });
    expect(placeForView(null, 'cm')).toBeNull();
  });

  it('the reported sequence: Preview at line 281, switch, Source near line 10, close, reopen', async () => {
    const { loadFileScroll, placeForView, saveFileScroll } = await load();
    // Reading Preview: its scroll notes the line at its top.
    saveFileScroll(undefined, '/d/guide.md', { top: 5400, line: 281, topIn: 'wys' });
    // The switch carries the line into Source.
    saveFileScroll(undefined, '/d/guide.md', { top: 5400, line: 281, topIn: 'wys', source: true });
    expect(placeForView(loadFileScroll(undefined, '/d/guide.md'), 'cm')).toEqual({ line: 281 });
    // Source scrolled back near line 10, then the panel closed (the flush).
    saveFileScroll(undefined, '/d/guide.md', { top: 190, line: 10, topIn: 'cm', source: true });
    const saved = loadFileScroll(undefined, '/d/guide.md');
    expect(saved).toEqual({ top: 190, line: 10, topIn: 'cm', source: true });
    expect(placeForView(saved, 'cm')).toEqual({ line: 10 });
  });

  it('a place kept by its line alone is stored; back at the top in the default view it is dropped', async () => {
    const { loadFileScroll, saveFileScroll } = await load();
    saveFileScroll(undefined, '/d/a.md', { top: 0, line: 40, topIn: 'cm' });
    expect(loadFileScroll(undefined, '/d/a.md')).toEqual({ top: 0, line: 40, topIn: 'cm' });
    saveFileScroll(undefined, '/d/a.md', { top: 0, line: 1, topIn: 'cm' });
    expect(loadFileScroll(undefined, '/d/a.md')).toBeNull();
  });
});

describe('every path that stores or restores the place goes through the view rule', () => {
  const files = (dir: string): string[] => readdirSync(path.join(WEB, dir), { withFileTypes: true }).flatMap((d) => (
    d.isDirectory() ? files(path.join(dir, d.name)) : /\.tsx?$/.test(d.name) ? [path.join(dir, d.name)] : []));
  const all = files('.').map((f) => f.replace(/^\.\//, ''));

  it('every saveFileScroll names the view its pixels were measured in (a new writer is listed here)', () => {
    const writers = all.filter((f) => /\bsaveFileScroll\(/.test(src(f)) && !f.endsWith('utils/file-view-state.ts'));
    expect(writers.sort()).toEqual(['components/common/preview-frame.ts', 'components/common/use-file-reading-place.ts']);
    for (const f of writers) {
      for (const call of src(f).matchAll(/saveFileScroll\(([^;]*?)\);/g)) expect(call[1], `${f}: ${call[0]}`).toMatch(/\btopIn\b/);
    }
  });

  it('every restore reads the place for its own view (placeForView); the file view only reads the Source choice', () => {
    const readers = all.filter((f) => /\bloadFileScroll\(/.test(src(f)) && !f.endsWith('utils/file-view-state.ts'));
    expect(readers.sort()).toEqual([
      'components/common/FileContentView.tsx', 'components/common/preview-frame.ts', 'components/common/use-file-reading-place.ts',
    ]);
    expect(src('components/common/preview-frame.ts')).toMatch(/placeForView\(loadFileScroll\(host, filePath\), 'html'\)/);
    const hook = src('components/common/use-file-reading-place.ts');
    expect(hook).toMatch(/const place = placeForView\(c, s\.kind\)/);
    for (const m of src('components/common/FileContentView.tsx').matchAll(/loadFileScroll\([^)]*\)([^;\n]*)/g)) expect(m[1]).toMatch(/^\?\.source/);
  });

  it('every Preview/Source switch carries the line (a new way to change the view is listed here)', () => {
    const view = src('components/common/FileContentView.tsx');
    // setShowSource: the file's own choice when it opens, and switchTab.
    const sets = [...view.matchAll(/setShowSource\(([^)]*)\)/g)].map((m) => m[1]);
    expect(sets).toEqual(['source', 'toSource']);
    const switchTab = view.slice(view.indexOf('const switchTab = useCallback'), view.indexOf('setShowSource(toSource)'));
    expect(switchTab).toMatch(/noteSwitch\(toSource\);\s*$/);
    // The draft is carried before the line is read (the incoming view shows that text).
    expect(switchTab.indexOf('draftRef.current = ')).toBeLessThan(switchTab.indexOf('noteSwitch('));
    // The hook restores on every first show of a file, a deep link aside, and chases into the incoming view.
    const hook = src('components/common/use-file-reading-place.ts');
    expect(hook).toMatch(/const saved = line \? null : loadFileScroll\(host, filePath\);/);
    expect(hook).toMatch(/if \(s && s\.kind !== c\.from\)/);
    // The unmount flush keeps the last place (closing Files, a reload).
    expect(hook).toMatch(/persist\(\);\s*\};\s*\}, \[active, key/);
  });
});
