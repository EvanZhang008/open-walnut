/**
 * Guard: a browser spec that seeds a routine's past runs and reads its missed runs schedules it
 * at an hour away from the run, not at a fixed one.
 *
 * The server judges a slot missed 15 minutes after it came due (src/core/cron/run-log.ts
 * MISSED_GRACE_MS). routine-missed-runs.spec.ts scheduled `0 8 * * *` and seeded the slots over
 * an hour old, so between 08:15 and 09:00 UTC today's slot was a third missed row it never made:
 * CI at 08:20 UTC failed it (2026-11-13) while every other hour passed.
 *
 * The class: a spec that names the missed-run rows (`routine-missed-row`) and writes a cron
 * schedule. Each member builds its hour from the clock (a template `expr`), so a literal hour
 * in its schedule fails here.
 */
import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const SPECS = join(__dirname, '../e2e/browser');
const LITERAL_DAILY_HOUR = /expr:\s*['"]\d+\s+\d+\s+\*\s+\*\s+\*['"]/;

describe('missed-run specs keep their slots away from the clock', () => {
  const members = readdirSync(SPECS).filter((f) => f.endsWith('.spec.ts'))
    .filter((f) => { const src = readFileSync(join(SPECS, f), 'utf8'); return src.includes('routine-missed-row') && /kind:\s*'cron'/.test(src); });

  it('finds the known member (the scan still reads the specs)', () => {
    expect(members).toContain('routine-missed-runs.spec.ts');
  });

  it('no member schedules a literal hour', () => {
    const fixed = members.filter((f) => LITERAL_DAILY_HOUR.test(readFileSync(join(SPECS, f), 'utf8')));
    expect(fixed, 'schedule the slot twelve hours from now: `0 ${(new Date().getUTCHours() + 12) % 24} * * *`').toEqual([]);
  });
});
