/**
 * Every item of a session's tool row says on its own element whether the fit sent it to "..."
 * (`data-hidden`, which CSS reads: session-header-fit.css). The fit's first decision reaches the
 * row only through React (useSessionHeaderFit.ts paints the DOM on later observer passes alone),
 * so an item drawn without `data-hidden` stayed on the row while "..." listed it too
 * (2026-11-24: a 200 px column showed Locate on the row and in the menu).
 *
 * This reads every .tsx file under web/src and fails when a JSX element carries
 * `data-header-id` (or `headerId`, which WatchButton passes on) without `data-hidden` (or
 * `headerHidden`) on the same element. A new row item is caught without being listed here.
 */
import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const WEB_SRC = path.resolve(__dirname, '../../web/src');

function tsxFiles(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) return tsxFiles(p);
    return e.name.endsWith('.tsx') ? [p] : [];
  });
}

/** The opening tag around `at`: from its `<` to the `>` that ends it, skipping `{...}` and quotes. */
function openingTag(src: string, at: number): string {
  let start = at;
  while (start > 0 && !/<[A-Za-z]/.test(src.slice(start, start + 2))) start--;
  let depth = 0;
  let quote: string | null = null;
  for (let i = start + 1; i < src.length; i++) {
    const c = src[i]!;
    if (quote) { if (c === quote) quote = null; continue; }
    if (c === '"' || c === "'" || c === '`') quote = c;
    else if (c === '{') depth++;
    else if (c === '}') depth--;
    else if (c === '>' && depth === 0) return src.slice(start, i + 1);
  }
  return src.slice(start);
}

/** Each element that names a tool-row item, with whether it also carries its hidden state. */
function rowItems(): Array<{ where: string; tag: string; carriesHidden: boolean }> {
  const out: Array<{ where: string; tag: string; carriesHidden: boolean }> = [];
  for (const file of tsxFiles(WEB_SRC)) {
    const src = fs.readFileSync(file, 'utf8');
    for (const m of src.matchAll(/\s(?:data-header-id|headerId)=/g)) {
      const tag = openingTag(src, m.index!);
      // A type or parameter list naming `headerId` is not an element.
      if (!tag.startsWith('<')) continue;
      const line = src.slice(0, m.index!).split('\n').length;
      out.push({
        where: `${path.relative(WEB_SRC, file)}:${line}`,
        tag: tag.replace(/\s+/g, ' ').slice(0, 160),
        carriesHidden: /\s(?:data-hidden|headerHidden)=/.test(tag),
      });
    }
  }
  return out;
}

describe('session tool row items carry their own hidden state', () => {
  it('finds the row items (the scan reads the real source)', () => {
    const ids = rowItems().map((i) => i.tag).join('\n');
    for (const id of ['fork', 'locate', 'watch', 'lock', 'expand', 'close']) expect(ids).toContain(`"${id}"`);
  });

  it('every element with data-header-id (or headerId) also sets data-hidden (or headerHidden)', () => {
    const missing = rowItems().filter((i) => !i.carriesHidden).map((i) => `${i.where}: ${i.tag}`);
    expect(missing, missing.join('\n')).toEqual([]);
  });
});
