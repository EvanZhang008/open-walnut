/**
 * The snooze pickers' times (2026-11-11, the user: "snooze until should have more options, like
 * tomorrow 8am, 12pm, 6pm", then a custom date AND hour, "现在只有date 没有hours").
 * Tomorrow 8 AM / 12 PM / 6 PM and a picked day at a picked hour are local wall-clock times, so a
 * DST change and a click just before or after midnight still land on the hour picked. A source
 * ratchet keeps every snooze picker on them.
 */
import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { tomorrowTimePills } from '../../web/src/components/common/DatePicker';
import { dateTimeWords, hourPickerMin, localDateTimeIso, parseClock, snoozeWhenWords, timeTarget } from '../../web/src/components/common/date-time-pick';

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

describe('a typed time', () => {
  it('reads the ways a person types an hour', () => {
    const cases: [string, string | null][] = [
      ['15:30', '15:30'], ['3:30 pm', '15:30'], ['3:30PM', '15:30'], ['3pm', '15:00'], ['330p', '15:30'],
      ['1530', '15:30'], ['9', '09:00'], ['9am', '09:00'], ['09:05', '09:05'], ['12am', '00:00'], ['12 pm', '12:00'],
      ['12:15 a.m.', '00:15'], ['0:00', '00:00'], [' 7:45 ', '07:45'],
      ['', null], ['soon', null], ['24:00', null], ['13pm', null], ['0am', null], ['3:60', null], ['12345', null], ['123:45', null],
    ];
    for (const [text, want] of cases) expect(parseClock(text), text).toBe(want);
  });
});

describe('a picked day at a picked hour', () => {
  it('is that local day and time, across DST and for a bad value', () => {
    process.env.TZ = 'America/Los_Angeles';
    expect(localDateTimeIso('2026-11-13', '15:30')).toBe('2026-11-13T23:30:00.000Z');
    // The fall-back day (PDT -> PST at 02:00): 09:00 is PST, the day before it PDT.
    expect(localDateTimeIso('2026-11-01', '09:00')).toBe('2026-11-01T17:00:00.000Z');
    expect(localDateTimeIso('2026-10-31', '09:00')).toBe('2026-10-31T16:00:00.000Z');
    // Spring forward (02:00 -> 03:00): 08:00 is PDT.
    expect(localDateTimeIso('2027-03-14', '08:00')).toBe('2027-03-14T15:00:00.000Z');
    expect(localDateTimeIso('2026-11-13', '')).toBeNull();
    expect(localDateTimeIso('2026-11-13', '25:00')).toBeNull();
    expect(localDateTimeIso('nope', '10:00')).toBeNull();
  });

  it('Set goes to the selected day, else today, else tomorrow once the time has gone by', () => {
    process.env.TZ = 'America/Los_Angeles';
    const now = Date.parse('2026-11-11T18:00:00Z'); // Wed Nov 11, 10:00 PST
    // A selected day (the snooze set now): that day at that time.
    expect(timeTarget('2026-11-14', '07:15', undefined, now)).toEqual({ iso: '2026-11-14T15:15:00.000Z', past: false });
    // No day: today while the time is still ahead...
    expect(timeTarget('', '15:00', undefined, now)).toEqual({ iso: '2026-11-11T23:00:00.000Z', past: false });
    // ...tomorrow once it has gone by today.
    expect(timeTarget('', '09:00', undefined, now)).toEqual({ iso: '2026-11-12T17:00:00.000Z', past: false });
    // Just before and after midnight: 23:59 picking 23:30 means tomorrow; 00:01 picking 00:30 is tonight.
    expect(timeTarget('', '23:30', undefined, Date.parse('2026-11-12T07:59:00Z'))?.iso).toBe('2026-11-13T07:30:00.000Z');
    expect(timeTarget('', '00:30', undefined, Date.parse('2026-11-12T08:01:00Z'))?.iso).toBe('2026-11-12T08:30:00.000Z');
    // A picker whose first day is tomorrow (the Org snoozes) starts there.
    expect(timeTarget('', '15:00', '2026-11-12', now)?.iso).toBe('2026-11-12T23:00:00.000Z');
    // A selected day whose time has gone by is refused, never moved.
    expect(timeTarget('2026-11-11', '09:00', undefined, now)).toEqual({ iso: '2026-11-11T17:00:00.000Z', past: true });
    expect(timeTarget('', '', undefined, now)).toBeNull();
  });

  it('with an hour, a picker whose first day is tomorrow offers today again (the Org snoozes)', () => {
    process.env.TZ = 'America/Los_Angeles';
    const now = Date.parse('2026-11-11T18:00:00Z'); // Wed Nov 11, 10:00 PST
    expect(hourPickerMin('2026-11-12', now)).toBe('2026-11-11');
    expect(hourPickerMin('2026-11-11', now)).toBe('2026-11-11');
    expect(hourPickerMin(undefined, now)).toBeUndefined();
    // A snooze set for today 15:00, its hour moved to 16:00: still today (review r1: it went to tomorrow).
    expect(timeTarget('2026-11-11', '16:00', hourPickerMin('2026-11-12', now), now)).toEqual({ iso: '2026-11-12T00:00:00.000Z', past: false });
  });

  it('reads as a person says it', () => {
    process.env.TZ = 'America/Los_Angeles';
    const now = Date.parse('2026-11-11T18:00:00Z');
    expect(dateTimeWords('2026-11-11T23:00:00.000Z', now)).toBe('Today 3:00 PM');
    expect(dateTimeWords('2026-11-12T17:00:00.000Z', now)).toBe('Tomorrow 9:00 AM');
    expect(dateTimeWords('2026-11-13T08:05:00.000Z', now)).toBe('Fri Nov 13, 12:05 AM');
    expect(dateTimeWords('2027-01-04T20:00:00.000Z', now)).toBe('Mon Jan 4 2027, 12:00 PM');
  });
});

describe('a timed snooze, closed', () => {
  it('says its hour: today, tomorrow, a weekday within the week, else the date', () => {
    process.env.TZ = 'America/Los_Angeles';
    const now = Date.parse('2026-11-11T18:00:00Z'); // Wed Nov 11, 10:00 PST
    expect(snoozeWhenWords('2026-11-11T23:30:00.000Z', now)).toBe('Today 3:30 PM');
    expect(snoozeWhenWords('2026-11-12T16:00:00.000Z', now)).toBe('Tomorrow 8:00 AM');
    expect(snoozeWhenWords('2026-11-15T23:30:00.000Z', now)).toBe('Sun 3:30 PM');
    expect(snoozeWhenWords('2026-11-17T23:30:00.000Z', now)).toBe('Tue 3:30 PM');
    expect(snoozeWhenWords('2026-11-18T23:30:00.000Z', now)).toBe('Nov 18, 3:30 PM');
    expect(snoozeWhenWords('2027-01-04T20:00:00.000Z', now)).toBe('Jan 4, 2027, 12:00 PM');
    // 23:30 PST on Nov 11 is still today; 00:30 PST is tomorrow.
    expect(snoozeWhenWords('2026-11-12T07:30:00.000Z', now)).toBe('Today 11:30 PM');
    expect(snoozeWhenWords('2026-11-12T08:30:00.000Z', now)).toBe('Tomorrow 12:30 AM');
    expect(snoozeWhenWords('2026-11-15', now)).toBeNull();
    expect(snoozeWhenWords('nope T', now)).toBeNull();
  });

  it('every closed snooze label reads it (the kebab row and the Waiting row pill)', () => {
    const read = (rel: string) => fs.readFileSync(path.resolve(import.meta.dirname, '../../web/src', rel), 'utf8');
    expect(read('components/tasks/TaskKebabMenu.tsx')).toMatch(/snoozeWhenWords\(task\.start_date!\)/);
    expect(read('components/tasks/StatusSections.tsx')).toMatch(/snoozeWhenWords\(snoozeDate\)/);
  });
});

describe('every snooze picker offers the tomorrow times', () => {
  const read = (rel: string) => fs.readFileSync(path.resolve(import.meta.dirname, '../../web/src', rel), 'utf8');
  it('the task menu snooze rows, the board snooze calendar and the Org snoozes pass withTime', () => {
    const kebab = read('components/tasks/TaskKebabMenu.tsx');
    // Every KebabDateRow that writes a start date (the snooze) asks for the row.
    const startRows = kebab.split('<KebabDateRow').slice(1).filter(b => /start_date/.test(b.slice(0, 600)));
    expect(startRows.length).toBeGreaterThanOrEqual(2);
    for (const b of startRows) expect(b.slice(0, 600)).toContain('withTime');
    expect(kebab).toContain('<DatePicker date={date} onChange={onChange} inline withTime={withTime} />');
    for (const f of ['components/tasks/SnoozeChoices.tsx', 'components/org/OrgThreadSnooze.tsx', 'components/org/OrgAlertSnooze.tsx']) {
      const src = read(f);
      const pickers = src.split('<DatePicker').slice(1);
      expect(pickers.length, f).toBeGreaterThan(0);
      for (const b of pickers) expect(b.slice(0, 200), f).toContain('withTime');
    }
  });
});

describe('the picker draws with theme colors that exist', () => {
  // 2026-11-11: the hour box read var(--fg-primary), which no theme defines, so its typed text
  // fell back to the label's muted grey and looked like a placeholder.
  it('every var() without a fallback in a .dp- rule is a defined custom property', () => {
    const css = fs.readFileSync(path.resolve(import.meta.dirname, '../../web/src/styles/globals.css'), 'utf8');
    const defined = new Set([...css.matchAll(/(--[\w-]+)\s*:/g)].map(m => m[1]));
    const rules = [...css.matchAll(/(^|\n)(\.dp-[^{]*)\{([^}]*)\}/g)];
    expect(rules.length).toBeGreaterThan(10);
    const missing: string[] = [];
    for (const r of rules) {
      for (const v of r[3].matchAll(/var\((--[\w-]+)\s*\)/g)) if (!defined.has(v[1])) missing.push(`${r[2].trim()} ${v[1]}`);
    }
    expect(missing).toEqual([]);
  });
});

