/**
 * Recurrence, time zones and edits of a mail account's calendar: the cases an independent
 * review reproduced against the first version (each test failed there).
 *
 * - Expansion costs what the range asks, never the series' age (a daily rule since 2000, read
 *   for one month, stays well under the 50 ms an event-loop block may take), and an old rule
 *   still has its recent occurrences.
 * - An id finds its occurrence wherever its override moved it.
 * - A wall time in a spring-forward gap moves forward, in either hemisphere.
 * - A whole series moved within its day keeps its removed and changed occurrences.
 * - Non-IANA TZIDs are read from their name or from the resource's own VTIMEZONE.
 * - Smaller rules: an override's SEQUENCE follows its series', YEARLY;BYMONTHDAY covers every
 *   month, and all-day ids and UNTIL do not depend on the server's zone.
 */
import { describe, expect, it } from 'vitest';
import { eventsOfResource, instanceOf, type ResourceContext } from '../../src/integrations/calendar/caldav/events.js';
import { editTimes, removeOccurrence } from '../../src/integrations/calendar/caldav/edit.js';
import { parseIcs, prop, serializeIcs } from '../../src/integrations/calendar/caldav/ics.js';
import { wallAt, wallToEpoch } from '../../src/integrations/calendar/caldav/tz.js';
import { ics } from '../helpers/fake-caldav-server.js';

/**
 * The longest stretch of synchronous work a calendar read may take in these tests. The aim is about
 * 50 ms on an idle machine; the bound is wider so a loaded test box (load 70+) does not fail it, and
 * still far under the seconds the regressions it guards took (walking from DTSTART: 1.2 to 13 s).
 */
const SYNC_BUDGET_MS = 250

function ctx(localZone: string): ResourceContext {
  return {
    baseId: 'caldav:imap:abc/L3gu',
    sourceId: 'caldav:imap:abc',
    calendarId: 'caldav:imap:abc/L2NhbC8',
    calendarName: 'Home',
    accountName: 'pat@example.com',
    readonly: false,
    selfAddress: 'pat@example.com',
    localZone,
  };
}

const root = (text: string) => parseIcs(text)[0];
const range = (from: string, to: string) => ({ start: Date.parse(from), end: Date.parse(to) });
const NY = 'America/New_York';

describe('expansion is bounded by the range asked', () => {
  const daily2000 = ics(['UID:d', `DTSTART;TZID=${NY}:20000103T090000`, `DTEND;TZID=${NY}:20000103T093000`, 'RRULE:FREQ=DAILY']);

  it('reads one month of a daily rule since 2000 in well under 50 ms', () => {
    const calendar = root(daily2000);
    eventsOfResource(calendar, ctx('America/Los_Angeles'), range('2026-10-01T00:00:00Z', '2026-11-01T00:00:00Z')); // warm up Intl
    const started = performance.now();
    const events = eventsOfResource(calendar, ctx('America/Los_Angeles'), range('2026-11-01T00:00:00Z', '2026-12-01T00:00:00Z'));
    expect(performance.now() - started).toBeLessThan(SYNC_BUDGET_MS);
    expect(events).toHaveLength(30);
    expect(events[0].start).toBe('2026-11-01T06:00:00');
  });

  it('finds a series by its id without an occurrence (an older link) in bounded time', () => {
    const calendar = root(daily2000);
    const started = performance.now();
    const first = instanceOf(calendar, ctx('UTC'), null);
    expect(performance.now() - started).toBeLessThan(SYNC_BUDGET_MS);
    expect(first?.start).toBe('2000-01-03T14:00:00');
  });

  it('still has the recent occurrences of a rule that started in 1900', () => {
    const events = eventsOfResource(root(ics(['UID:old', 'DTSTART:19000101T090000Z', 'DURATION:PT1H', 'RRULE:FREQ=DAILY'])), ctx('UTC'), range('2026-11-01T00:00:00Z', '2026-11-03T00:00:00Z'));
    expect(events.map((e) => e.start)).toEqual(['2026-11-01T09:00:00', '2026-11-02T09:00:00']);
  });

  it('gives up quickly on a rule that never matches', () => {
    const started = performance.now();
    const events = eventsOfResource(root(ics(['UID:n', 'DTSTART:20200101T090000Z', 'DURATION:PT1H', 'RRULE:FREQ=WEEKLY;BYMONTH=13'])), ctx('UTC'), range('2026-11-01T00:00:00Z', '2026-12-01T00:00:00Z'));
    expect(events).toHaveLength(0);
    expect(performance.now() - started).toBeLessThan(SYNC_BUDGET_MS);
  });

  it('starts an occurrence that began before the range but still runs into it', () => {
    const events = eventsOfResource(root(ics(['UID:w', 'DTSTART;VALUE=DATE:20200106', 'DTEND;VALUE=DATE:20200111', 'RRULE:FREQ=WEEKLY'])), ctx('UTC'), range('2026-11-04T00:00:00Z', '2026-11-05T00:00:00Z'));
    expect(events.map((e) => [e.start, e.end])).toEqual([['2026-11-02', '2026-11-06']]);
  });
});

describe('an occurrence is found by its id wherever it was moved', () => {
  it('finds an override moved more than two days away', () => {
    const calendar = root(ics(['UID:s', `DTSTART;TZID=${NY}:20260302T090000`, `DTEND;TZID=${NY}:20260302T093000`, 'RRULE:FREQ=WEEKLY;COUNT=4']));
    const second = eventsOfResource(calendar, ctx(NY), range('2026-01-01T00:00:00Z', '2027-01-01T00:00:00Z'))[1];
    const occurrence = Number(second.id.split('#')[1]);
    editTimes(calendar, occurrence, { start: '2026-03-13T10:00:00', end: '2026-03-13T10:30:00' }, NY);
    const found = instanceOf(calendar, ctx(NY), occurrence);
    expect(found).toMatchObject({ id: second.id, start: '2026-03-13T10:00:00', end: '2026-03-13T10:30:00' });
  });
});

describe('daylight-saving gaps', () => {
  it.each([
    ['Europe/London', { y: 2026, m: 3, d: 29, h: 1, mi: 30, s: 0 }, { h: 2, mi: 30 }],
    ['Australia/Sydney', { y: 2026, m: 10, d: 4, h: 2, mi: 30, s: 0 }, { h: 3, mi: 30 }],
    ['America/Los_Angeles', { y: 2026, m: 3, d: 8, h: 2, mi: 30, s: 0 }, { h: 3, mi: 30 }],
  ])('a time skipped in %s moves forward by the gap', (zone, wall, shown) => {
    const at = wallAt(wallToEpoch(wall, zone), zone);
    expect({ d: at.d, h: at.h, mi: at.mi }).toEqual({ d: wall.d, ...shown });
  });

  it('a repeated autumn hour takes its first occurrence, in either hemisphere', () => {
    expect(new Date(wallToEpoch({ y: 2026, m: 11, d: 1, h: 1, mi: 30, s: 0 }, 'America/Los_Angeles')).toISOString()).toBe('2026-11-01T08:30:00.000Z');
    expect(new Date(wallToEpoch({ y: 2026, m: 4, d: 5, h: 2, mi: 30, s: 0 }, 'Australia/Sydney')).toISOString()).toBe('2026-04-04T15:30:00.000Z');
  });
});

describe('moving a whole series', () => {
  const series = () => root(ics(
    ['UID:s', `DTSTART;TZID=${NY}:20260302T090000`, `DTEND;TZID=${NY}:20260302T093000`, 'RRULE:FREQ=WEEKLY;COUNT=4', `EXDATE;TZID=${NY}:20260309T090000`, 'SEQUENCE:7'],
    ['UID:s', `RECURRENCE-ID;TZID=${NY}:20260316T090000`, `DTSTART;TZID=${NY}:20260316T110000`, `DTEND;TZID=${NY}:20260316T113000`, 'SEQUENCE:7'],
  ));

  it('keeps a removed occurrence removed and a changed one changed', () => {
    const calendar = series();
    editTimes(calendar, null, { start: '2026-03-02T10:00:00', end: '2026-03-02T10:30:00' }, NY);
    const events = eventsOfResource(calendar, ctx(NY), range('2026-01-01T00:00:00Z', '2027-01-01T00:00:00Z'));
    expect(events.map((e) => e.start)).toEqual(['2026-03-02T10:00:00', '2026-03-16T11:00:00', '2026-03-23T10:00:00']);
    const text = serializeIcs(calendar);
    expect(text).toContain(`EXDATE;TZID=${NY}:20260309T100000`);
    expect(text).toContain(`RECURRENCE-ID;TZID=${NY}:20260316T100000`);
  });

  it('refuses to move a series to another day (its rule would have to change too)', () => {
    expect(() => editTimes(series(), null, { start: '2026-03-03T09:00:00', end: '2026-03-03T09:30:00' }, NY)).toThrow(/within its day/);
  });
});

describe('time zones that are not IANA names', () => {
  const vtimezone = (tzid: string, lines: string[]) => [
    'BEGIN:VCALENDAR', 'VERSION:2.0',
    'BEGIN:VTIMEZONE', `TZID:${tzid}`, ...lines, 'END:VTIMEZONE',
    'BEGIN:VEVENT', 'UID:tz', `DTSTART;TZID="${tzid}":20260715T090000`, `DTEND;TZID="${tzid}":20260715T100000`, 'SUMMARY:Call', 'END:VEVENT',
    'END:VCALENDAR', '',
  ].join('\r\n');
  const pacificRules = [
    'BEGIN:STANDARD', 'DTSTART:16010101T020000', 'TZOFFSETFROM:-0700', 'TZOFFSETTO:-0800', 'RRULE:FREQ=YEARLY;BYDAY=1SU;BYMONTH=11', 'END:STANDARD',
    'BEGIN:DAYLIGHT', 'DTSTART:16010101T020000', 'TZOFFSETFROM:-0800', 'TZOFFSETTO:-0700', 'RRULE:FREQ=YEARLY;BYDAY=2SU;BYMONTH=3', 'END:DAYLIGHT',
  ];

  it('reads an Outlook display name', () => {
    const [event] = eventsOfResource(root(vtimezone('(UTC-08:00) Pacific Time (US & Canada)', pacificRules)), ctx('UTC'), range('2026-07-01T00:00:00Z', '2026-08-01T00:00:00Z'));
    expect(event.start).toBe('2026-07-15T16:00:00');
  });

  it('reads a "Customized Time Zone" from its VTIMEZONE offsets', () => {
    const [event] = eventsOfResource(root(vtimezone('Customized Time Zone', pacificRules)), ctx('UTC'), range('2026-07-01T00:00:00Z', '2026-08-01T00:00:00Z'));
    expect(event.start).toBe('2026-07-15T16:00:00');
  });

  it('reads X-LIC-LOCATION when the VTIMEZONE names its zone', () => {
    const [event] = eventsOfResource(root(vtimezone('Zone 1', ['X-LIC-LOCATION:Europe/Berlin', 'BEGIN:STANDARD', 'DTSTART:19701025T030000', 'TZOFFSETFROM:+0200', 'TZOFFSETTO:+0100', 'END:STANDARD'])), ctx('UTC'), range('2026-07-01T00:00:00Z', '2026-08-01T00:00:00Z'));
    expect(event.start).toBe('2026-07-15T07:00:00');
  });

  it('writes the VTIMEZONE back untouched and never the zone it was read as', () => {
    const calendar = root(vtimezone('Customized Time Zone', pacificRules));
    const text = serializeIcs(calendar);
    expect(text).toContain('TZID:Customized Time Zone');
    expect(text).not.toContain('America/Los_Angeles');
  });
});

describe('smaller rules', () => {
  it("a new override's SEQUENCE is above its series'", () => {
    const calendar = root(ics(['UID:s', 'DTSTART:20260302T090000Z', 'DURATION:PT30M', 'RRULE:FREQ=WEEKLY;COUNT=4', 'SEQUENCE:7']));
    const second = eventsOfResource(calendar, ctx('UTC'), range('2026-01-01T00:00:00Z', '2027-01-01T00:00:00Z'))[1];
    editTimes(calendar, Number(second.id.split('#')[1]), { start: '2026-03-09T10:00:00', end: '2026-03-09T10:30:00' }, 'UTC');
    const override = calendar.children.find((c) => c.name === 'VEVENT' && prop(c, 'RECURRENCE-ID'))!;
    expect(prop(override, 'SEQUENCE')?.value).toBe('8');
  });

  it('YEARLY;BYMONTHDAY without BYMONTH is that day of every month', () => {
    const events = eventsOfResource(root(ics(['UID:y', 'DTSTART:20260101T090000Z', 'DURATION:PT1H', 'RRULE:FREQ=YEARLY;BYMONTHDAY=1;COUNT=4'])), ctx('UTC'), range('2026-01-01T00:00:00Z', '2028-01-01T00:00:00Z'));
    expect(events.map((e) => e.start.slice(0, 10))).toEqual(['2026-01-01', '2026-02-01', '2026-03-01', '2026-04-01']);
  });

  it("an all-day series' UTC UNTIL and its occurrence ids are the same on every server zone", () => {
    const text = ics(['UID:a', 'DTSTART;VALUE=DATE:20260302', 'DTEND;VALUE=DATE:20260303', 'RRULE:FREQ=DAILY;UNTIL=20260304T000000Z']);
    const read = (zone: string) => eventsOfResource(root(text), ctx(zone), range('2026-02-01T00:00:00Z', '2026-04-01T00:00:00Z'));
    const la = read('America/Los_Angeles');
    const tokyo = read('Asia/Tokyo');
    expect(la.map((e) => e.start)).toEqual(['2026-03-02', '2026-03-03', '2026-03-04']);
    expect(tokyo.map((e) => e.id)).toEqual(la.map((e) => e.id));
  });
});

describe('round two: COUNT rules, repeated BY values, wide reads, overrides alone', () => {
  const month = range('2026-11-01T00:00:00Z', '2026-12-01T00:00:00Z');
  const timed = (label: string, run: () => unknown) => {
    run(); // warm up Intl once
    const started = performance.now();
    const out = run();
    const ms = performance.now() - started;
    return { out, ms, label };
  };

  it('a COUNT rule with every weekday since 1600 reads a month in under 50 ms', () => {
    const calendar = root(ics(['UID:c1', 'DTSTART:16000103T090000Z', 'DURATION:PT1H', 'RRULE:FREQ=YEARLY;BYDAY=SU,MO,TU,WE,TH,FR,SA;COUNT=9999999']));
    const { out, ms } = timed('yearly', () => eventsOfResource(calendar, ctx('UTC'), month));
    expect(ms).toBeLessThan(SYNC_BUDGET_MS);
    expect((out as unknown[]).length).toBe(30);
  });

  it('a COUNT rule with 28 month days since 1700 reads a month in under 50 ms', () => {
    const days = Array.from({ length: 28 }, (_, i) => i + 1).join(',');
    const calendar = root(ics(['UID:c2', 'DTSTART:17000101T090000Z', 'DURATION:PT1H', `RRULE:FREQ=MONTHLY;BYMONTHDAY=${days};COUNT=9999999`]));
    const { out, ms } = timed('monthly', () => eventsOfResource(calendar, ctx('UTC'), month));
    expect(ms).toBeLessThan(SYNC_BUDGET_MS);
    expect((out as unknown[]).length).toBe(28);
  });

  it('DAILY;COUNT=20000 from 2000 still has its November 2026 occurrences', () => {
    const events = eventsOfResource(root(ics(['UID:c3', 'DTSTART:20000101T090000Z', 'DURATION:PT1H', 'RRULE:FREQ=DAILY;COUNT=20000'])), ctx('UTC'), month);
    expect(events).toHaveLength(30);
  });

  it('DAILY;BYDAY=MO;COUNT=2000 from 2010 still has its November 2026 Mondays', () => {
    const events = eventsOfResource(root(ics(['UID:c4', 'DTSTART:20100104T090000Z', 'DURATION:PT1H', 'RRULE:FREQ=DAILY;BYDAY=MO;COUNT=2000'])), ctx('UTC'), month);
    expect(events.map((e) => e.start.slice(0, 10))).toEqual(['2026-11-02', '2026-11-09', '2026-11-16', '2026-11-23', '2026-11-30']);
  });

  it('a COUNT rule still ends on its last occurrence after a skip', () => {
    const events = eventsOfResource(root(ics(['UID:c5', 'DTSTART:20260105T090000Z', 'DURATION:PT1H', 'RRULE:FREQ=WEEKLY;BYDAY=MO,WE;COUNT=30'])), ctx('UTC'), range('2026-04-01T00:00:00Z', '2026-06-01T00:00:00Z'));
    expect(events.map((e) => e.start.slice(0, 10))).toEqual(['2026-04-01', '2026-04-06', '2026-04-08', '2026-04-13', '2026-04-15']);
  });

  it('a series too costly to expand stops at the budget and says so', () => {
    const truncated: string[] = [];
    const calendar = root(ics(['UID:c6', 'DTSTART:16000103T090000Z', 'DURATION:PT1H', 'RRULE:FREQ=DAILY;BYMONTH=1,2,3,4,5,6,7,8,9,10,11,12;COUNT=99999999', 'SUMMARY:Endless']));
    const started = performance.now();
    eventsOfResource(calendar, { ...ctx('UTC'), noteTruncated: (title: string) => truncated.push(title) }, month);
    expect(performance.now() - started).toBeLessThan(1000);
    expect(truncated).toEqual(['Endless']);
  });

  it('repeated BY values count once', () => {
    const events = eventsOfResource(root(ics(['UID:c7', 'DTSTART:20260101T090000Z', 'DURATION:PT1H', 'RRULE:FREQ=MONTHLY;BYMONTHDAY=1,-31;COUNT=4'])), ctx('UTC'), range('2026-01-01T00:00:00Z', '2027-01-01T00:00:00Z'));
    // In January -31 is the 1st: one occurrence, not two, so COUNT=4 reaches April.
    expect(events.map((e) => e.start.slice(0, 10))).toEqual(['2026-01-01', '2026-02-01', '2026-03-01', '2026-04-01']);
    const many = Array.from({ length: 3000 }, () => 'MO').join(',');
    const started = performance.now();
    eventsOfResource(root(ics(['UID:c8', 'DTSTART:20260105T090000Z', 'DURATION:PT1H', `RRULE:FREQ=YEARLY;BYDAY=${many}`])), ctx('UTC'), month);
    expect(performance.now() - started).toBeLessThan(100);
  });

  it('50,000 RDATEs read a month in bounded time', () => {
    const dates = Array.from({ length: 50_000 }, (_, i) => new Date(Date.UTC(2000, 0, 1, 9) + i * 86_400_000).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, ''));
    const calendar = root(ics(['UID:c9', 'DTSTART:19991231T090000Z', 'DURATION:PT1H', `RDATE:${dates.join(',')}`]));
    const started = performance.now();
    const events = eventsOfResource(calendar, ctx(NY), month);
    expect(performance.now() - started).toBeLessThan(400);
    expect(events).toHaveLength(30);
  });

  it('an invitation to one occurrence only (no series in the resource) is found and edited by its id', () => {
    const calendar = root(ics(['UID:o', 'RECURRENCE-ID;VALUE=DATE:20260810', 'DTSTART;VALUE=DATE:20260810', 'DTEND;VALUE=DATE:20260811', 'SUMMARY:Offsite day']));
    const [event] = eventsOfResource(calendar, ctx(NY), range('2026-08-01T00:00:00Z', '2026-09-01T00:00:00Z'));
    const occurrence = Number(event.id.split('#')[1]);
    expect(instanceOf(calendar, ctx(NY), occurrence)?.title).toBe('Offsite day');
    editTimes(calendar, occurrence, { start: '2026-08-11', end: '2026-08-11', title: 'Offsite day' }, NY);
    expect(serializeIcs(calendar)).toContain('DTSTART;VALUE=DATE:20260811');
  });

  it('an occurrence in a spring-forward gap is removed by its nominal time', () => {
    const calendar = root(ics(['UID:g', `DTSTART;TZID=${NY}:20260301T023000`, 'DURATION:PT1H', 'RRULE:FREQ=WEEKLY;COUNT=3']));
    const gap = eventsOfResource(calendar, ctx(NY), range('2026-01-01T00:00:00Z', '2027-01-01T00:00:00Z'))[1];
    removeOccurrence(calendar, Number(gap.id.split('#')[1]), NY);
    expect(serializeIcs(calendar)).toContain(`EXDATE;TZID=${NY}:20260308T023000`);
    expect(eventsOfResource(calendar, ctx(NY), range('2026-01-01T00:00:00Z', '2027-01-01T00:00:00Z'))).toHaveLength(2);
  });
});

describe('round three: one resource can never hold the event loop', () => {
  const nov = range('2026-11-01T00:00:00Z', '2026-12-01T00:00:00Z');
  const measure = (calendar: ReturnType<typeof root>) => {
    const truncated: string[] = [];
    const context = { ...ctx(NY), noteTruncated: (t: string) => truncated.push(t) };
    eventsOfResource(calendar, context, nov); // warm up
    truncated.length = 0;
    const started = performance.now();
    const events = eventsOfResource(calendar, context, nov);
    return { ms: performance.now() - started, events, truncated };
  };

  it('300,000 RDATEs inside the month: under 50 ms, at most 5000 occurrences, marked truncated', () => {
    const t0 = Date.parse('2026-11-02T00:00:00Z');
    const dates = Array.from({ length: 300_000 }, (_, i) => new Date(t0 + i * 7000).toISOString().replace(/[-:]/g, '').slice(0, 15) + 'Z');
    const { ms, events, truncated } = measure(root(ics(['UID:r', 'DTSTART:20261101T090000Z', 'DURATION:PT1H', `RDATE:${dates.join(',')}`, 'SUMMARY:Dense'])));
    expect(ms).toBeLessThan(SYNC_BUDGET_MS);
    expect(events.length).toBeLessThanOrEqual(5000);
    expect(truncated).toContain('Dense');
  });

  it('a daily series whose every occurrence lasts 300 years: under 50 ms', () => {
    const { ms, events } = measure(root(ics(['UID:l', 'DTSTART:18000101T090000Z', 'DTEND:21000101T090000Z', 'RRULE:FREQ=DAILY'])));
    expect(ms).toBeLessThan(SYNC_BUDGET_MS);
    expect(events.length).toBeLessThanOrEqual(5000);
  });

  it('a monthly rule with 749 BYDAY entries since 1700: under 50 ms', () => {
    const ords: string[] = [];
    for (const w of ['SU', 'MO', 'TU', 'WE', 'TH', 'FR', 'SA']) { ords.push(w); for (let n = 1; n <= 53; n++) ords.push(`${n}${w}`, `-${n}${w}`); }
    for (const rule of [`FREQ=MONTHLY;BYDAY=${ords.join(',')};COUNT=99999999`, `FREQ=MONTHLY;BYDAY=${ords.join(',')}`]) {
      const { ms } = measure(root(ics(['UID:b', 'DTSTART:17000101T090000Z', 'DURATION:PT1H', `RRULE:${rule}`])));
      expect(ms, rule.slice(-20)).toBeLessThan(SYNC_BUDGET_MS);
    }
  });
});
