/**
 * Guard: a spec or e2e test that seeds a routine's past runs and reads its missed runs schedules
 * it at an hour away from the run, not at a fixed one.
 *
 * The server judges a slot missed 15 minutes after it came due (src/core/cron/run-log.ts
 * MISSED_GRACE_MS). routine-missed-runs.spec.ts scheduled `0 8 * * *` and seeded the slots over
 * an hour old, so between 08:15 and 09:00 UTC today's slot was a third missed row it never made:
 * CI at 08:20 UTC failed it (2026-11-13) while every other hour passed. Its route-level twin,
 * tests/e2e/routine-missed-runs.test.ts, kept the same fixed hour and failed CI at 08:30 UTC the
 * next day.
 *
 * The class: a browser spec that names the missed-run rows (`routine-missed-row`), or an e2e test
 * that reads a routine's missed runs (`.missed`, `noticeMissedRunsOnce`), and writes a cron
 * schedule. Each member builds its hour from the clock (a template `expr`), so a literal hour
 * in its schedule fails here.
 */
import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const SPECS = join(__dirname, '../e2e/browser');
const E2E = join(__dirname, '../e2e');
const LITERAL_DAILY_HOUR = /expr:\s*['"]\d+\s+\d+\s+\*\s+\*\s+\*['"]/;

describe('missed-run specs keep their slots away from the clock', () => {
  const cron = (src: string) => /kind:\s*'cron'/.test(src);
  const specs = readdirSync(SPECS).filter((f) => f.endsWith('.spec.ts')).map((f) => join(SPECS, f))
    .filter((f) => { const src = readFileSync(f, 'utf8'); return src.includes('routine-missed-row') && cron(src); });
  const e2e = readdirSync(E2E).filter((f) => f.endsWith('.test.ts')).map((f) => join(E2E, f))
    .filter((f) => { const src = readFileSync(f, 'utf8'); return /\.missed\b|noticeMissedRunsOnce/.test(src) && cron(src); });
  const members = [...specs, ...e2e];
  const name = (f: string) => f.slice(E2E.length + 1);

  it('finds the known members (the scan still reads the specs and the e2e tests)', () => {
    expect(members.map(name)).toEqual(expect.arrayContaining(['browser/routine-missed-runs.spec.ts', 'routine-missed-runs.test.ts']));
  });

  it('no member schedules a literal hour', () => {
    const fixed = members.filter((f) => LITERAL_DAILY_HOUR.test(readFileSync(f, 'utf8'))).map(name);
    expect(fixed, 'schedule the slot twelve hours from now: `0 ${(new Date().getUTCHours() + 12) % 24} * * *`').toEqual([]);
  });
});
