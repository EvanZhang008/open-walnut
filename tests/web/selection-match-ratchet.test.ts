/**
 * The selected-word echo goes with the selection the user can see (2026-11-01,
 * the user: "after I deselect, the highlight stays there, very annoying", then
 * again on a plugin's problem page: "it never removes the highlight").
 *
 * The second report was a second painter: the page's echo (PageFind) had its own
 * rule for "deselected" and kept tinting after a click into a code editor. Now
 * one module, web/src/utils/selection-echo.ts, owns the rule and the paint, and
 * this file reads the source so a new painter cannot go around it:
 *   - an echo highlight name (`walnut-selmatch`, `walnut-page-selmatch`, or the
 *     constants naming them) appears only where it is defined, in the iframe style
 *     rule, in selection-echo.ts, and as the name handed to `paintEcho(...)`;
 *     any other use (applyHighlights, paintRanges, CSS.highlights.set) is a painter
 *     that skips the rule;
 *   - every CodeMirror surface with highlightSelectionMatches hides the matches
 *     while the editor is not focused;
 *   - the page-wide echo leaves editors and the doc views to their own surfaces.
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(__dirname, '../../web/src');

function sources(dir: string): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...sources(full));
    else if (/\.(ts|tsx)$/.test(entry.name)) out.push(full);
  }
  return out;
}

const rel = (f: string) => path.relative(ROOT, f).split(path.sep).join('/');
const ECHO_NAMES = ['HL_SELMATCH', 'HL_PAGE_SELMATCH', 'ECHO_HIGHLIGHTS', 'walnut-selmatch', 'walnut-page-selmatch'];
const esc = (w: string) => w.replace(/[.*+?^${}()|[\]\\-]/g, '\\$&');

/** The text with its comments blanked out (same length, so offsets keep their lines). */
function withoutComments(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\/|(^|[^:'"`\\])\/\/[^\n]*/g, (m, pre = '') => pre + m.slice(pre.length).replace(/[^\n]/g, ' '));
}

/** Every use of an echo name (an alias of one included) other than its definition,
 *  an import, the iframe's style rule, or the name handed to paintEcho. Reads the
 *  whole file, so a call split over lines is judged as one. */
export function echoPainters(file: string, text: string): string[] {
  if (file === 'utils/selection-echo.ts') return [];
  const code = withoutComments(text);
  const imports: Array<[number, number]> = [];
  const names = [...ECHO_NAMES];
  for (const m of code.matchAll(/^\s*import\b[\s\S]*?from\s*['"][^'"]+['"]/gm)) {
    imports.push([m.index!, m.index! + m[0].length]);
    for (const al of m[0].matchAll(/\b(\w+)\s+as\s+(\w+)/g)) if (ECHO_NAMES.includes(al[1])) names.push(al[2]);
  }
  const found: string[] = [];
  const re = new RegExp(names.map((n) => (/^\w+$/.test(n) ? `\\b${esc(n)}\\b` : esc(n))).join('|'), 'g');
  for (const m of code.matchAll(re)) {
    const at = m.index!;
    if (imports.some(([s, e]) => at >= s && at < e)) continue;
    const before = code.slice(Math.max(0, at - 200), at);
    if (/export const (HL_(PAGE_)?SELMATCH = ['"])?$/.test(before)) continue;
    if (/::highlight\(\$\{$/.test(before)) continue;
    if (m[0] !== 'ECHO_HIGHLIGHTS' && /\bpaintEcho\(\s*[^,()]+,\s*$/.test(before)) continue;
    const line = code.slice(0, at).split('\n').length;
    found.push(`${file}:${line}  ${text.split('\n')[line - 1].trim()}`);
  }
  return found;
}

describe('the selected-word echo', () => {
  const files = sources(ROOT).map((f) => ({ file: rel(f), text: fs.readFileSync(f, 'utf8') }));

  it('is painted only through selection-echo (paintEcho), never by a painter of its own', () => {
    const painters = files.flatMap(({ file, text }) => echoPainters(file, text));
    expect(painters, 'paint the echo with paintEcho() from utils/selection-echo.ts, which holds the rule for when it may show').toEqual([]);
  });

  it('the scan catches a painter that goes around it', () => {
    expect(echoPainters('x.ts', 'const undo = applyHighlights(window, HL_SELMATCH, ranges);')).toHaveLength(1);
    expect(echoPainters('x.ts', "paintRanges('walnut-page-selmatch', ranges, 0);")).toHaveLength(1);
    expect(echoPainters('x.ts', "CSS.highlights.set(HL_PAGE_SELMATCH, new Highlight(r));")).toHaveLength(1);
    expect(echoPainters('x.ts', 'clearRef.current = paintEcho(window, HL_SELMATCH, found);')).toHaveLength(0);
    expect(echoPainters('x.ts', 'undo = paintEcho(\n  window,\n  HL_SELMATCH,\n  found,\n);')).toHaveLength(0);
    expect(echoPainters('x.ts', 'paintEcho(window, HL_SELMATCH, r); applyHighlights(window, HL_SELMATCH, r);')).toHaveLength(1);
    // An alias, a loop over the names, a comment.
    expect(echoPainters('x.ts', "import { HL_SELMATCH as N } from './dom-text-search';\napplyHighlights(window, N, r);")).toHaveLength(1);
    expect(echoPainters('x.ts', 'for (const n of ECHO_HIGHLIGHTS) CSS.highlights.set(n, h);')).toHaveLength(1);
    expect(echoPainters('x.ts', 'const a = 1; // HL_SELMATCH is painted elsewhere\n/* walnut-page-selmatch */')).toHaveLength(0);
  });

  it('has its users, so the scan above is reading real files', () => {
    const users = files.filter(({ text }) => text.includes("from '@/utils/selection-echo'")).map(({ file }) => file).sort();
    expect(users).toEqual(['components/common/PageFind.tsx', 'hooks/useSelectionMatches.ts']);
    const surfaces = files.filter(({ text }) => text.includes("from '@/hooks/useSelectionMatches'")).map(({ file }) => file).sort();
    expect(surfaces).toEqual(['components/common/FileContentView.tsx', 'components/sessions/SessionDiffView.tsx']);
  });

  it('the page-wide echo (PageFind) leaves editors and these surfaces to their own painters', () => {
    const pageFind = files.find(({ file }) => file === 'utils/page-find.ts')!.text;
    const needle = pageFind.slice(pageFind.indexOf('export function selectionNeedle'), pageFind.indexOf('export function', pageFind.indexOf('export function selectionNeedle') + 10));
    for (const part of ['[contenteditable="true"]', '.file-content-view', '.session-diff-view']) expect(needle).toContain(part);
  });

  it('is hidden in every CodeMirror editor that is not focused', () => {
    const missing = files
      .filter(({ text }) => /highlightSelectionMatches\(/.test(text))
      .filter(({ text }) => !/:not\(\.cm-focused\) \.cm-selectionMatch/.test(text))
      .map(({ file }) => file);
    expect(missing).toEqual([]);
  });
});
