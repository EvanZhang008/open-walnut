/**
 * Every stylesheet under web/src has its braces balanced.
 *
 * 2026-11-22: a merge left a stray `}` in trigger-picker.css. The browser read everything after it,
 * to the end of the bundled file, as one invalid rule and dropped 246 rules of the session panel
 * (the trigger picker's header, the thread split, the header labels flyout), and neither the build
 * nor any test noticed.
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const WEB_SRC = path.join(__dirname, '../../web/src');

function cssFiles(dir: string, out: string[] = []): string[] {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) { if (e.name !== 'node_modules' && e.name !== 'dist') cssFiles(p, out); }
    else if (p.endsWith('.css')) out.push(p);
  }
  return out;
}

/** The first place the braces go wrong, or null: comments and strings are skipped. */
export function braceError(css: string): string | null {
  const text = css.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' ')).replace(/"[^"\n]*"|'[^'\n]*'/g, '""');
  let depth = 0;
  let line = 1;
  for (const c of text) {
    if (c === '\n') line += 1;
    else if (c === '{') depth += 1;
    else if (c === '}' && --depth < 0) return `an extra } on line ${line}`;
  }
  return depth > 0 ? `${depth} { never closed` : null;
}

describe('stylesheets keep their braces balanced', () => {
  it('finds the broken brace it guards against', () => {
    expect(braceError('.a { color: red; }\n}\n.b { color: blue; }')).toBe('an extra } on line 2');
    expect(braceError('@media (x) {\n  .a { color: red; }\n')).toBe('1 { never closed');
    expect(braceError('/* } */ .a { content: "}"; }')).toBeNull();
  });

  it('every CSS file under web/src has balanced braces', () => {
    const bad: string[] = [];
    for (const file of cssFiles(WEB_SRC)) {
      const css = fs.readFileSync(file, 'utf8');
      const rel = path.relative(WEB_SRC, file);
      const braces = braceError(css);
      if (braces) bad.push(`${rel}: ${braces}`);
    }
    expect(bad).toEqual([]);
  });
});
