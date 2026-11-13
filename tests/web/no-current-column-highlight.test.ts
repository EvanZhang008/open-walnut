/**
 * The column the keys act on (`.main-page-session-column.is-current`) is not drawn differently:
 * no tinted header, no accent line, no composer ring (2026-11-10, the user, after clicking a
 * column: "who add this active when i clcik? so ugly why u add so many feature without ask").
 * The class stays for the keyboard; only the held modifier's number badge may wear the accent.
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const STYLES = path.resolve(__dirname, '../../web/src/styles');

function cssFiles(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? cssFiles(path.join(dir, e.name)) : e.name.endsWith('.css') ? [path.join(dir, e.name)] : []);
}

describe('the current column wears no highlight', () => {
  it('no stylesheet styles the panel, header or composer of the current column', () => {
    const hits: string[] = [];
    for (const file of cssFiles(STYLES)) {
      const css = fs.readFileSync(file, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
      for (const m of css.matchAll(/([^{}]+)\{/g)) {
        for (const sel of m[1]!.split(',')) {
          const s = sel.trim();
          if (!/\.main-page-session-column[^\s]*\.is-current|\.is-current[^\s]*\.main-page-session-column/.test(s)) continue;
          // The held modifier's number badge is the one allowed mark.
          if (/\.session-jump-badge\b/.test(s)) continue;
          // So is the close button's key while the modifier is held (only the current column's shows).
          if (/\.shortcut-hint\b/.test(s)) continue;
          hits.push(`${path.relative(STYLES, file)}: ${s}`);
        }
      }
    }
    expect(hits).toEqual([]);
  });
});
