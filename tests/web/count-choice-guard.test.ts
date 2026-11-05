/**
 * A choice that stands for a number shows the number (2026-11-04, the user, on the
 * session menu's Panels switch, whose options were drawn as 1 to 5 little bars:
 * "anti pattern, just show numbers, people having to count is not reasonable").
 * This scans every component that renders a choice control (aria-pressed, a radio,
 * a tab, a listbox option) for the pattern that drew it: an empty element repeated
 * by a count, `Array.from({ length: n }, () => <i />)`. A new switch drawn that way
 * fails here; a component with a real reason to repeat shapes (a skeleton loader,
 * a tree's indent guides) is listed with why.
 */
import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(__dirname, '../../web/src');
function tsx(dir: string): string[] {
  const out: string[] = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...tsx(full));
    else if (e.name.endsWith('.tsx')) out.push(full);
  }
  return out;
}

/** Repeating shapes that are not a count to read, with why. */
const ALLOWED: Record<string, string> = {
  'components/sessions/ThreadTreeRow.tsx': 'indent guides of a tree row, one per depth level; not a choice',
};

const CHOICE = /aria-pressed|role="(radio|tab|option)"|aria-checked/;
// `Array.from({ length: ... }, (...) => <tag ... />)`: an EMPTY element, repeated by a count.
const DRAWN_COUNT = /Array\.from\(\{\s*length:[^}]+\}\s*,\s*\([^)]*\)\s*=>\s*\(?\s*<(\w+)[^>]*\/>/g;

describe('a choice that stands for a number shows the number', () => {
  it('the scan finds the pattern it is meant to find', () => {
    const sample = 'aria-pressed={x}>{Array.from({ length: Number(value) }, (_, i) => <i key={i} />)}';
    expect(CHOICE.test(sample)).toBe(true);
    expect([...sample.matchAll(DRAWN_COUNT)]).toHaveLength(1);
  });

  it('no choice control draws its count as repeated shapes', () => {
    const offenders: string[] = [];
    for (const file of tsx(ROOT)) {
      const rel = path.relative(ROOT, file).split(path.sep).join('/');
      if (rel in ALLOWED) continue;
      const text = fs.readFileSync(file, 'utf8');
      if (!CHOICE.test(text)) continue;
      for (const m of text.matchAll(DRAWN_COUNT)) {
        const line = text.slice(0, m.index).split('\n').length;
        offenders.push(`${rel}:${line} <${m[1]} /> repeated by a count`);
      }
    }
    expect(offenders, 'label the choice with its number or a word instead').toEqual([]);
  });
});
