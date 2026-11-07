/**
 * Guard: a browser spec that turns the wheel and moves the page clock waits for the page to see the wheel.
 *
 * `page.mouse.wheel` resolves before the page's (passive) wheel listeners run, so a
 * `page.clock.fastForward` right after it can run first and the page stamps the wheel at the
 * forwarded time. section-auto-fold.spec.ts read "wheel 62 s ago" as 22 s and the fold stayed
 * open (CI, 2026-11-07; flaky before). `wheelSeenByPage` in tests/e2e/browser/page-clock.ts turns
 * the wheel and waits until the page counted it.
 *
 * The class: a `test(...)` block that calls `page.mouse.wheel(` and moves the clock
 * (`clock.fastForward(` or `clock.runFor(`). A new member fails here until it uses
 * `wheelSeenByPage`.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const SPECS = join(__dirname, '../e2e/browser');

function testBlocks(src: string): { title: string; body: string }[] {
  const starts = [...src.matchAll(/^\s*test(?:\.only)?\(\s*(['"`])(.*?)\1/gm)];
  return starts.map((m, i) => ({
    title: m[2]!,
    body: src.slice(m.index!, i + 1 < starts.length ? starts[i + 1]!.index : src.length),
  }));
}

describe('a wheel the page clock follows is seen by the page first', () => {
  const offenders: string[] = [];
  let usesHelper = false;
  for (const file of readdirSync(SPECS).filter((f) => f.endsWith('.spec.ts'))) {
    const src = readFileSync(join(SPECS, file), 'utf8');
    if (src.includes('wheelSeenByPage(')) usesHelper = true;
    for (const block of testBlocks(src)) {
      if (!/\.mouse\.wheel\(/.test(block.body)) continue;
      if (!/\.clock\.(fastForward|runFor)\(/.test(block.body)) continue;
      offenders.push(`${file} :: ${block.title}`);
    }
  }

  it('the helper is in use (the scan still reads the specs)', () => {
    expect(usesHelper).toBe(true);
  });

  it('no test wheels with page.mouse.wheel and then moves the clock', () => {
    expect(offenders, 'use wheelSeenByPage(page, dx, dy) from ./page-clock').toEqual([]);
  });
});
