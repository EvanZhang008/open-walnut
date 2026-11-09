/**
 * Every Home row that draws the usage-limit pill (TaskLimitPill, limit-row.tsx) draws the
 * fallback-engine tag too (TaskFallbackTag, fallback-row.tsx): the two say why a task runs where it
 * runs, and a row view that showed one without the other hid the fallback in the default By project
 * view (2026-11-09 review). A new row view that draws the pill fails here until it draws the tag.
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const WEB = path.resolve(import.meta.dirname, '../../web/src');

function sources(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) return sources(p);
    return /\.tsx$/.test(e.name) ? [p] : [];
  });
}

/** The source without comments: a tag named in a comment draws nothing. */
function code(s: string): string {
  return s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}

describe('the Fallback tag is on every row that wears the Limited pill', () => {
  it('each file that renders <TaskLimitPill renders <TaskFallbackTag as often', () => {
    const rows = sources(WEB)
      .map((f) => ({ f: path.relative(WEB, f), s: code(fs.readFileSync(f, 'utf8')) }))
      .filter(({ s }) => s.includes('<TaskLimitPill'));
    // The three Home row views of today: a guard that finds none would pass on nothing.
    expect(rows.map((r) => r.f).sort()).toEqual(expect.arrayContaining([
      'components/tasks/FocusSatelliteCards.tsx', 'components/tasks/StatusSections.tsx', 'components/tasks/TodoPanel.tsx',
    ]));
    const count = (s: string, tag: string) => s.split(tag).length - 1;
    const missing = rows.filter(({ s }) => count(s, '<TaskFallbackTag') < count(s, '<TaskLimitPill')).map((r) => r.f);
    expect(missing, 'rows that draw the Limited pill but not the Fallback tag').toEqual([]);
  });
});
