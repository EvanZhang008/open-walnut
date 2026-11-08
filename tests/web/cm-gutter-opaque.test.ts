/**
 * A CodeMirror line-number gutter is sticky: when a long line is scrolled sideways, the line
 * slides underneath it. A transparent gutter, or one dimmed with `opacity`, lets that text paint
 * through the numbers (2026-11-08, Mac WebKit: line 1's text covered its own number). Every
 * editor in web/src that turns on `lineNumbers()` is found from the source, and its theme must
 * give `.cm-gutters` a solid background and no opacity of its own.
 */
import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const WEB = path.resolve(__dirname, '../../web/src');

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...sourceFiles(full));
    else if (/\.(ts|tsx)$/.test(e.name)) out.push(full);
  }
  return out;
}

function gutterRule(text: string): string | null {
  const start = text.search(/'\.cm-gutters'\s*:\s*\{/);
  if (start < 0) return null;
  return text.slice(start, text.indexOf('}', start) + 1);
}

describe('line-number gutters are solid', () => {
  const editors = sourceFiles(WEB).filter((file) => /\blineNumbers\(\)/.test(fs.readFileSync(file, 'utf8')));

  it('finds the editors that show line numbers', () => {
    expect(editors.length).toBeGreaterThanOrEqual(2);
  });

  for (const file of editors) {
    it(path.relative(WEB, file), () => {
      const rule = gutterRule(fs.readFileSync(file, 'utf8'));
      expect(rule, 'the theme styles .cm-gutters').not.toBeNull();
      const background = /backgroundColor:\s*'([^']+)'/.exec(rule!)?.[1];
      expect(background, 'the gutter paints a background').toBeTruthy();
      expect(background).not.toMatch(/transparent|rgba\([^)]*,\s*0(\.\d+)?\)/);
      expect(rule).not.toMatch(/\bopacity\s*:/);
    });
  }
});
