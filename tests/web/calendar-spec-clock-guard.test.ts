/**
 * Guard: a browser spec that probes what is on screen over a calendar chip pins the page clock.
 *
 * The day grid opens at the current hour (TimeGrid's phoneLandingMinute on a phone, the focus
 * window on a desktop), so where a chip sits in the viewport hangs on the wall clock.
 * `document.elementFromPoint` only sees what is on screen: R3-06 in phone-pages-r4.spec.ts
 * probed a 2 PM chip that was below the fold whenever the run started between about 6 and 8
 * in the morning, and failed on CI at 06:33 (2026-11-07) while passing every other hour.
 *
 * The class: a `test(...)` block that reads a `.cal-chip` and calls `elementFromPoint`. Each
 * member installs a fixed start time (`page.clock.install({ time })` or `setFixedTime`), so the
 * layout it probes is the same at any hour, or is listed below with why its probe does not hang
 * on the hour. A new member fails here until someone decides which it is.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const SPECS = join(__dirname, '../e2e/browser');

/** Split a spec into its top-level test blocks (text from one `test(` to the next). */
function testBlocks(src: string): { title: string; body: string }[] {
  const starts = [...src.matchAll(/^\s*test(?:\.only)?\(\s*(['"`])(.*?)\1/gm)];
  return starts.map((m, i) => ({
    title: m[2]!,
    body: src.slice(m.index!, i + 1 < starts.length ? starts[i + 1]!.index : src.length),
  }));
}

/** Members whose probe is on screen at any hour, by `file :: title`, and why. */
const HOUR_FREE: Record<string, string> = {
  'calendar.spec.ts :: event popover keeps Save reachable while editing times (no overflow)':
    'probes the popover Save of a chip it scrolled into view and clicked; the popover opens on screen',
};

const PINNED = /page\.clock\.(install\(\s*\{[^}]*\btime\b|setFixedTime\()/;

describe('calendar chip probes pin the clock', () => {
  const members: string[] = [];
  const unpinned: string[] = [];
  for (const file of readdirSync(SPECS).filter((f) => f.endsWith('.spec.ts'))) {
    const src = readFileSync(join(SPECS, file), 'utf8');
    for (const block of testBlocks(src)) {
      if (!block.body.includes('.cal-chip') || !block.body.includes('elementFromPoint')) continue;
      const key = `${file} :: ${block.title}`;
      members.push(key);
      if (!PINNED.test(block.body) && !HOUR_FREE[key]) unpinned.push(key);
    }
  }

  it('finds the known member (the scan still reads the specs)', () => {
    expect(members.some((m) => m.startsWith('phone-pages-r4.spec.ts :: R3-06'))).toBe(true);
  });

  it('lists only tests that are still members', () => {
    expect(Object.keys(HOUR_FREE).filter((k) => !members.includes(k))).toEqual([]);
  });

  it('every test that probes a chip on screen starts the page at a fixed time', () => {
    expect(unpinned, 'pin the clock: await page.clock.install({ time: new Date(`${day}T06:33:00`) })').toEqual([]);
  });
});
