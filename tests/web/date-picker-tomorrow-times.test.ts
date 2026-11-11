/**
 * "Snooze until" offers tomorrow at 8 AM, 12 PM and 6 PM (2026-11-11, the user: "snooze until
 * should have more options, like tomorrow 8am, 12pm, 6pm"). The times are local wall-clock hours
 * of the next calendar day, so a DST change tonight and a click just before or after midnight
 * still land on tomorrow's 8:00 / 12:00 / 18:00. A source ratchet keeps every snooze picker on it.
 */
import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { tomorrowTimePills } from '../../web/src/components/common/DatePicker';

const ORIGINAL_TZ = process.env.TZ;
afterEach(() => { process.env.TZ = ORIGINAL_TZ; });

/** The pills' instants for a wall-clock "now" in a zone. */
function pillsAt(tz: string, nowIso: string): { label: string; date: string }[] {
  process.env.TZ = tz;
  return tomorrowTimePills(Date.parse(nowIso));
}

describe('tomorrowTimePills', () => {
  it('gives tomorrow 8:00, 12:00 and 18:00 local, labeled short', () => {
    // 2026-11-11 10:00 PST (UTC-8).
    expect(pillsAt('America/Los_Angeles', '2026-11-11T18:00:00Z')).toEqual([
      { label: '8 AM', date: '2026-11-12T16:00:00.000Z' },
      { label: '12 PM', date: '2026-11-12T20:00:00.000Z' },
      { label: '6 PM', date: '2026-11-13T02:00:00.000Z' },
    ]);
  });

  it('just before midnight means the next day, just after midnight the day after that', () => {
    // 23:59 PST on Nov 11 -> Nov 12.
    expect(pillsAt('America/Los_Angeles', '2026-11-12T07:59:00Z')[0].date).toBe('2026-11-12T16:00:00.000Z');
    // 00:01 PST on Nov 12 -> Nov 13.
    expect(pillsAt('America/Los_Angeles', '2026-11-12T08:01:00Z')[0].date).toBe('2026-11-13T16:00:00.000Z');
  });

  it('keeps the wall-clock hour across a DST change tonight', () => {
    // Fall back: 2026-11-01 02:00 PDT -> 01:00 PST. Now Oct 31 23:30 PDT; tomorrow 8:00 is PST.
    expect(pillsAt('America/Los_Angeles', '2026-11-01T06:30:00Z').map(p => p.date)).toEqual([
      '2026-11-01T16:00:00.000Z', '2026-11-01T20:00:00.000Z', '2026-11-02T02:00:00.000Z',
    ]);
    // Spring forward: 2027-03-14 02:00 PST -> 03:00 PDT. Now Mar 13 22:00 PST; tomorrow 8:00 is PDT.
    expect(pillsAt('America/Los_Angeles', '2027-03-14T06:00:00Z').map(p => p.date)).toEqual([
      '2027-03-14T15:00:00.000Z', '2027-03-14T19:00:00.000Z', '2027-03-15T01:00:00.000Z',
    ]);
  });

  it('rolls over a month and a year end', () => {
    expect(pillsAt('UTC', '2026-12-31T15:00:00Z')[0].date).toBe('2027-01-01T08:00:00.000Z');
    expect(pillsAt('Asia/Shanghai', '2027-02-28T12:00:00Z')[2].date).toBe('2027-03-01T10:00:00.000Z');
  });
});

describe('every snooze picker offers the tomorrow times', () => {
  const read = (rel: string) => fs.readFileSync(path.resolve(import.meta.dirname, '../../web/src', rel), 'utf8');
  it('the task menu snooze rows, the board snooze calendar and the Org snoozes pass tomorrowTimes', () => {
    const kebab = read('components/tasks/TaskKebabMenu.tsx');
    // Every KebabDateRow that writes a start date (the snooze) asks for the row.
    const startRows = kebab.split('<KebabDateRow').slice(1).filter(b => /start_date/.test(b.slice(0, 600)));
    expect(startRows.length).toBeGreaterThanOrEqual(2);
    for (const b of startRows) expect(b.slice(0, 600)).toContain('tomorrowTimes');
    expect(kebab).toContain('<DatePicker date={date} onChange={onChange} inline tomorrowTimes={tomorrowTimes} />');
    for (const f of ['components/tasks/SnoozeChoices.tsx', 'components/org/OrgThreadSnooze.tsx', 'components/org/OrgAlertSnooze.tsx']) {
      const src = read(f);
      const pickers = src.split('<DatePicker').slice(1);
      expect(pickers.length, f).toBeGreaterThan(0);
      for (const b of pickers) expect(b.slice(0, 200), f).toContain('tomorrowTimes');
    }
  });
});
