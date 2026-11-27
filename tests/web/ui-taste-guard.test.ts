/**
 * The user's taste rules (.claude/skills/walnut-ui-requirements/SKILL.md, "Taste: round, quiet,
 * consistent", rules 14 to 20) where a file can hold them: the one input box's keys are circles,
 * its box is rounded and never square, and a one-line box is never an oval pill.
 *
 * 2026-11-22: a task unifying the input boxes turned every round key square and every box to 8 px;
 * the user: "It should be round instead of square for our UI". On 2026-11-21 he had called the oval
 * Threads reply box ugly. These numbers are his, so a change that moves them fails here first.
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(__dirname, '../../web/src/styles');
const read = (f: string) => fs.readFileSync(path.join(ROOT, f), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');

/** The value a custom property gets in the first rule of `sel` that sets it. */
function prop(css: string, sel: RegExp, name: string): string | undefined {
  for (const m of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    if (!sel.test(m[1].trim())) continue;
    const d = new RegExp(`(?:^|;)\\s*${name.replace(/[-]/g, '\\-')}\\s*:\\s*([^;]+)`).exec(m[2]);
    if (d) return d[1].trim();
  }
  return undefined;
}
const px = (v: string | undefined, tokens: Record<string, number>) => {
  if (!v) return NaN;
  const t = /^var\((--[\w-]+)\)$/.exec(v);
  if (t) return tokens[t[1]] ?? NaN;
  const n = /^(\d+(?:\.\d+)?)px$/.exec(v);
  return n ? Number(n[1]) : NaN;
};

describe('the user\'s taste: round, not square, never a pill', () => {
  const box = read('input-box.css');
  const globals = read('globals.css');
  const tokens: Record<string, number> = {};
  for (const t of ['--radius-xs', '--radius-sm', '--radius-md', '--radius-lg']) tokens[t] = px(prop(globals, /^:root$/, t), {});
  tokens['--radius-sm'] ??= 8;

  it('every key of the input box is a circle', () => {
    expect(prop(box, /^:root$/, '--input-key-radius')).toBe('50%');
    expect(prop(box, /^:root$/, '--input-key-hit-radius')).toBe('50%');
  });

  it('a message box is rounded, not square: at least 16 px', () => {
    expect(px(prop(box, /^:root$/, '--input-radius'), tokens)).toBeGreaterThanOrEqual(16);
  });

  it('a one-line box is a rounded rectangle, never an oval pill: under half its line', () => {
    const line = px(prop(box, /^:root$/, '--input-line'), tokens);
    const oneLine = px(prop(box, /^\.wn-input\.is-line$/, '--input-radius'), tokens);
    const field = px(prop(box, /^:root$/, '--field-radius'), tokens);
    expect(oneLine, 'is-line sets its own corner').toBeGreaterThanOrEqual(8);
    expect(oneLine).toBeLessThan(line / 2);
    expect(field).toBeGreaterThanOrEqual(8);
    expect(field).toBeLessThan(line / 2);
  });

  it('the quick bar\'s mic is a circle too', () => {
    const qb = read('quickbar.css');
    const rule = /\.qb-mic\s*\{([^}]*)\}/.exec(qb)?.[1] ?? '';
    expect(/border-radius:\s*50%/.test(rule), '.qb-mic { border-radius: 50% }').toBe(true);
  });
});

/**
 * SKILL.md rule 20: an empty message box stays empty. 2026-11-23, the user, of the session box's
 * "Send a message to this session... (/ for commands)": "remove this too ugly", "clean simple".
 * Three more boxes still said "(/ for commands)" four days later (UI audit, 2026-11-27).
 */
describe('an empty message box carries no long hint text', () => {
  const SRC = path.resolve(__dirname, '../../web/src');
  const files = (dir: string): string[] => fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? files(path.join(dir, e.name)) : /\.tsx?$/.test(e.name) ? [path.join(dir, e.name)] : []);

  it('no placeholder explains the slash commands or the keys', () => {
    const hits = files(SRC).flatMap((f) => [...fs.readFileSync(f, 'utf8').matchAll(/[^\n]*(?:\(\s*\/\s*for commands\s*\)|for commands\)|Shift\+Enter for)[^\n]*/g)]
      .filter((m) => /placeholder/i.test(m[0]))
      .map((m) => `${path.relative(SRC, f)}: ${m[0].trim().slice(0, 120)}`));
    expect(hits, 'leave the box empty and put its name in aria-label (ChatInput `label`)').toEqual([]);
  });
});
