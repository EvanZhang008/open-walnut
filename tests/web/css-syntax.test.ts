/**
 * Every stylesheet under web/src parses with no syntax warning.
 *
 * 2026-11-23: an edit removed the last selector of a list together with its block, leaving
 * `:is(...),\n}` behind. The production build only warned ("Unexpected }"), dropped the whole rule
 * and shipped; a phone's session labels lost their font size with nothing failing. esbuild (the
 * minifier the build itself uses) reads each file here, so a stray brace, a selector list left
 * open or an unclosed block fails the test that finds it, in whichever file it appears.
 */
import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { transformSync } from 'esbuild';

const WEB_SRC = path.resolve(__dirname, '../../web/src');

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(p, out);
    else if (entry.name.endsWith('.css')) out.push(p);
  }
  return out;
}

describe('web stylesheets', () => {
  const files = walk(WEB_SRC);

  it('finds the stylesheets it guards', () => {
    expect(files.length).toBeGreaterThan(20);
  });

  it('every stylesheet parses with no syntax warning', () => {
    const problems: string[] = [];
    for (const file of files) {
      const { warnings } = transformSync(fs.readFileSync(file, 'utf8'), { loader: 'css', minify: true, logLevel: 'silent' });
      for (const w of warnings) {
        if (!/css-syntax|syntax/i.test(`${w.id} ${w.text}`)) continue;
        problems.push(`${path.relative(WEB_SRC, file)}:${w.location?.line ?? '?'} ${w.text}`);
      }
    }
    expect(problems).toEqual([]);
  });

  it('the check catches what it guards', () => {
    const { warnings } = transformSync('.a { color: red; }\n  .b :is(.c),\n}\n', { loader: 'css', minify: true, logLevel: 'silent' });
    expect(warnings.length).toBeGreaterThan(0);
  });
});
