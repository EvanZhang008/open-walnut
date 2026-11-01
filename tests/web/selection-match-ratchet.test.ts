/**
 * Selection-match paint goes with the selection the user can see (2026-11-01,
 * the user: "after I deselect, the highlight stays there, very annoying").
 *
 * A click on blank space outside a doc's editor left its selection in the page,
 * unpainted, and the DOM painter kept every match of it tinted. The rule, read off
 * the source so a new surface cannot skip it:
 *   - the DOM surfaces paint `walnut-selmatch` only through
 *     hooks/useSelectionMatches.ts (it drops the paint when the selection collapses
 *     and when the editor holding it loses focus);
 *   - every CodeMirror surface with highlightSelectionMatches hides the matches
 *     while the editor is not focused;
 *   - the page-wide echo (components/common/PageFind.tsx) never paints for a
 *     selection in an editor, nor in the surfaces above.
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
/** The name's definition (and the iframe style rule beside it), and its one painter. */
const ALLOWED = new Set(['utils/dom-text-search.ts', 'hooks/useSelectionMatches.ts']);

describe('selection-match paint', () => {
  const files = sources(ROOT).map((f) => ({ file: rel(f), text: fs.readFileSync(f, 'utf8') }));

  it('is painted on DOM surfaces only by useSelectionMatches', () => {
    const painters = files
      .filter(({ file, text }) => !ALLOWED.has(file) && /HL_SELMATCH|['"`]walnut-selmatch['"`]/.test(text))
      .map(({ file }) => file);
    expect(painters, 'paint selection matches with useSelectionMatches(), which clears them with the selection').toEqual([]);
  });

  it('has its users, so the scan above is reading real files', () => {
    const users = files.filter(({ text }) => text.includes("from '@/hooks/useSelectionMatches'")).map(({ file }) => file).sort();
    expect(users).toEqual(['components/common/FileContentView.tsx', 'components/sessions/SessionDiffView.tsx']);
  });

  it('the page-wide echo (PageFind) leaves editors and these surfaces to their own painters', () => {
    const pageFind = files.find(({ file }) => file === 'utils/page-find.ts')!.text;
    const needle = pageFind.slice(pageFind.indexOf('export function selectionNeedle'), pageFind.indexOf('export function paintSelectionMatches'));
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
