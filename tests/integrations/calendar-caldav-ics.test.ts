/**
 * A mail account's calendar, read over CalDAV: iCalendar text into the calendar's events.
 *
 * What has to hold, because the calendar views trust it as they trust EventKit's answers:
 * recurring series expand on the event's own wall clock (09:00 stays 09:00 across a DST
 * change), EXDATEs leave occurrences out, RECURRENCE-ID overrides replace theirs, all-day
 * events end on their last day inclusive (EventKit's shape), and the write-safety fields say
 * the same thing EventKit's would for the same event. Edits keep every property Walnut did not
 * change exactly as it came.
 */
import { describe, expect, it } from 'vitest';
import { eventsOfResource, type ResourceContext } from '../../src/integrations/calendar/caldav/events.js';
import { editTimes, newEventCalendar, removeOccurrence } from '../../src/integrations/calendar/caldav/edit.js';
import { parseIcs, serializeIcs } from '../../src/integrations/calendar/caldav/ics.js';
import { resolveZone, wallToEpoch } from '../../src/integrations/calendar/caldav/tz.js';
import { calendarEventNeedsApproval } from '../../src/integrations/calendar/event-rules.js';
import { ics } from '../helpers/fake-caldav-server.js';

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

const ALL = { start: -8.64e15, end: 8.64e15 };
const root = (text: string) => parseIcs(text)[0];
const range = (from: string, to: string) => ({ start: Date.parse(from), end: Date.parse(to) });

describe('recurring events', () => {
  const weekly = ics([
    'UID:weekly-1',
    'DTSTART;TZID=America/New_York:20260302T090000',
    'DTEND;TZID=America/New_York:20260302T093000',
    'RRULE:FREQ=WEEKLY;COUNT=3',
    'SUMMARY:Standup',
  ]);

  it('stays at 09:00 on its own clock across the March daylight-saving change', () => {
    const events = eventsOfResource(root(weekly), ctx('America/New_York'), ALL);
    expect(events.map((e) => [e.start, e.end])).toEqual([
      ['2026-03-02T09:00:00', '2026-03-02T09:30:00'],
      ['2026-03-09T09:00:00', '2026-03-09T09:30:00'],
      ['2026-03-16T09:00:00', '2026-03-16T09:30:00'],
    ]);
    expect(events.every((e) => e.recurring && e.title === 'Standup')).toBe(true);
  });

  it('moves by the hour on a server whose clock has no DST (UTC)', () => {
    const events = eventsOfResource(root(weekly), ctx('UTC'), ALL);
    expect(events.map((e) => e.start)).toEqual(['2026-03-02T14:00:00', '2026-03-09T13:00:00', '2026-03-16T13:00:00']);
  });

  it('names each occurrence by its original start, the way EventKit occurrence ids do', () => {
    const events = eventsOfResource(root(weekly), ctx('UTC'), ALL);
    expect(events[0].id).toBe(`caldav:imap:abc/L3gu#${Date.UTC(2026, 2, 2, 14) / 1000}`);
    expect(new Set(events.map((e) => e.id)).size).toBe(3);
  });

  it('leaves out an EXDATE and lets a RECURRENCE-ID override stand in for its occurrence', () => {
    const text = ics(
      ['UID:daily-1', 'DTSTART:20260810T100000Z', 'DTEND:20260810T110000Z', 'RRULE:FREQ=DAILY;COUNT=5', 'EXDATE:20260812T100000Z', 'SUMMARY:Daily'],
      ['UID:daily-1', 'RECURRENCE-ID:20260813T100000Z', 'DTSTART:20260813T150000Z', 'DTEND:20260813T153000Z', 'SUMMARY:Moved'],
    );
    const events = eventsOfResource(root(text), ctx('UTC'), ALL);
    expect(events.map((e) => [e.start, e.title])).toEqual([
      ['2026-08-10T10:00:00', 'Daily'],
      ['2026-08-11T10:00:00', 'Daily'],
      ['2026-08-13T15:00:00', 'Moved'],
      ['2026-08-14T10:00:00', 'Daily'],
    ]);
    // The override keeps the id of the occurrence it replaces.
    expect(events[2].id).toBe(`caldav:imap:abc/L3gu#${Date.UTC(2026, 7, 13, 10) / 1000}`);
  });

  it('expands the last Friday of each month, and the last weekday through BYSETPOS', () => {
    const lastFriday = ics(['UID:m1', 'DTSTART;VALUE=DATE:20260130', 'RRULE:FREQ=MONTHLY;BYDAY=-1FR;COUNT=3', 'SUMMARY:Review']);
    expect(eventsOfResource(root(lastFriday), ctx('UTC'), ALL).map((e) => e.start)).toEqual(['2026-01-30', '2026-02-27', '2026-03-27']);
    const lastWeekday = ics(['UID:m2', 'DTSTART:20260130T120000Z', 'RRULE:FREQ=MONTHLY;BYDAY=MO,TU,WE,TH,FR;BYSETPOS=-1;COUNT=3', 'SUMMARY:Close']);
    expect(eventsOfResource(root(lastWeekday), ctx('UTC'), ALL).map((e) => e.start.slice(0, 10))).toEqual(['2026-01-30', '2026-02-27', '2026-03-31']);
  });

  it('stops at UNTIL, with several weekdays in a week', () => {
    const text = ics(['UID:w2', 'DTSTART:20260302T080000Z', 'RRULE:FREQ=WEEKLY;BYDAY=MO,WE;UNTIL=20260318T235959Z', 'SUMMARY:Gym']);
    expect(eventsOfResource(root(text), ctx('UTC'), ALL).map((e) => e.start.slice(0, 10))).toEqual([
      '2026-03-02', '2026-03-04', '2026-03-09', '2026-03-11', '2026-03-16', '2026-03-18',
    ]);
  });

  it('returns only the occurrences in the range asked, for a series with no end', () => {
    const text = ics(['UID:d', 'DTSTART:20200101T070000Z', 'DTEND:20200101T073000Z', 'RRULE:FREQ=DAILY', 'SUMMARY:Walk']);
    const events = eventsOfResource(root(text), ctx('UTC'), range('2026-08-03T00:00:00Z', '2026-08-06T00:00:00Z'));
    expect(events.map((e) => e.start)).toEqual(['2026-08-03T07:00:00', '2026-08-04T07:00:00', '2026-08-05T07:00:00']);
  });
});

describe('times', () => {
  it('ends an all-day event on its last day, inclusive, as EventKit does', () => {
    const text = ics(['UID:a', 'DTSTART;VALUE=DATE:20260805', 'DTEND;VALUE=DATE:20260807', 'SUMMARY:Trip']);
    expect(eventsOfResource(root(text), ctx('Asia/Tokyo'), ALL)).toMatchObject([{ start: '2026-08-05', end: '2026-08-06', allDay: true }]);
    const oneDay = ics(['UID:b', 'DTSTART;VALUE=DATE:20260805', 'SUMMARY:Holiday']);
    expect(eventsOfResource(root(oneDay), ctx('UTC'), ALL)).toMatchObject([{ start: '2026-08-05', end: '2026-08-05', allDay: true }]);
  });

  it('reads floating times as local wall time, and maps Windows zone names', () => {
    const floating = ics(['UID:f', 'DTSTART:20260805T090000', 'DURATION:PT45M', 'SUMMARY:Call']);
    expect(eventsOfResource(root(floating), ctx('Europe/Berlin'), ALL)).toMatchObject([{ start: '2026-08-05T09:00:00', end: '2026-08-05T09:45:00' }]);
    expect(resolveZone('Pacific Standard Time')).toBe('America/Los_Angeles');
    expect(resolveZone('/mozilla.org/20070129_1/Europe/Berlin')).toBe('Europe/Berlin');
    const windows = ics(['UID:w', 'DTSTART;TZID=Pacific Standard Time:20260805T090000', 'DTEND;TZID=Pacific Standard Time:20260805T100000', 'SUMMARY:Sync']);
    expect(eventsOfResource(root(windows), ctx('UTC'), ALL)).toMatchObject([{ start: '2026-08-05T16:00:00' }]);
  });

  it('moves a time in the spring-forward gap forward by the gap', () => {
    // 02:30 does not exist in New York on 2026-03-08; it reads as 03:30 EDT.
    expect(wallToEpoch({ y: 2026, m: 3, d: 8, h: 2, mi: 30, s: 0 }, 'America/New_York')).toBe(Date.UTC(2026, 2, 8, 7, 30));
  });

  it('takes the first of a repeated autumn hour', () => {
    // 01:30 happens twice in New York on 2026-11-01; calendars mean the first (EDT, UTC-4).
    expect(wallToEpoch({ y: 2026, m: 11, d: 1, h: 1, mi: 30, s: 0 }, 'America/New_York')).toBe(Date.UTC(2026, 10, 1, 5, 30));
  });
});

describe('write safety, the same rule as EventKit', () => {
  it('lets Walnut move its own private block without asking', () => {
    const text = ics(['UID:own', 'DTSTART:20260805T090000Z', 'DTEND:20260805T100000Z', 'SUMMARY:Focus', 'X-WALNUT-CREATED:TRUE']);
    const [event] = eventsOfResource(root(text), ctx('UTC'), ALL);
    expect(event).toMatchObject({ walnutCreated: true, hasAttendees: false, writeSafetyVersion: 1 });
    expect(calendarEventNeedsApproval(event)).toBe(false);
  });

  it('asks for a meeting with attendees someone else organizes, and knows the user answer', () => {
    const text = ics([
      'UID:mtg', 'DTSTART:20260805T090000Z', 'DTEND:20260805T100000Z', 'SUMMARY:Planning',
      'ORGANIZER;CN=Sam:mailto:sam@example.com',
      'ATTENDEE;PARTSTAT=ACCEPTED:mailto:sam@example.com',
      'ATTENDEE;PARTSTAT=DECLINED:mailto:PAT@example.com',
    ]);
    const [event] = eventsOfResource(root(text), ctx('UTC'), ALL);
    expect(event).toMatchObject({ hasAttendees: true, organizerIsCurrentUser: false, organizerName: 'Sam', selfStatus: 'declined', walnutCreated: false });
    expect(calendarEventNeedsApproval(event)).toBe(true);
  });

  it('asks for any event Walnut did not make, even a private one', () => {
    const text = ics(['UID:p', 'DTSTART:20260805T090000Z', 'SUMMARY:Dentist']);
    expect(calendarEventNeedsApproval(eventsOfResource(root(text), ctx('UTC'), ALL)[0])).toBe(true);
  });

  it('marks a cancelled event instead of dropping it', () => {
    const text = ics(['UID:c', 'DTSTART:20260805T090000Z', 'SUMMARY:Off', 'STATUS:CANCELLED']);
    expect(eventsOfResource(root(text), ctx('UTC'), ALL)[0].status).toBe('canceled');
  });
});

describe('edits keep what Walnut does not change', () => {
  const series = () => ics([
    'UID:s1', 'DTSTART;TZID=America/New_York:20260302T090000', 'DTEND;TZID=America/New_York:20260302T093000',
    'RRULE:FREQ=WEEKLY;COUNT=4', 'SUMMARY:Standup', 'X-SOMETHING-ELSE;X-P="a:b":keep me exactly',
    // Test data: accented letters (two UTF-8 octets each) where a fold could split one.
    'DESCRIPTION:A very long description line that a server folds at seventy five octets, with unicode \u00e9\u00e8\u00ea to fold safely',
  ]);

  it('writes untouched properties back byte for byte, folded at 75 octets', () => {
    const out = serializeIcs(root(series()));
    expect(out).toContain('X-SOMETHING-ELSE;X-P="a:b":keep me exactly');
    for (const line of out.split('\r\n')) expect(new TextEncoder().encode(line).length).toBeLessThanOrEqual(75);
    // Unfolds back to the same description.
    expect(serializeIcs(root(out))).toBe(out);
  });

  it('moves one occurrence through a RECURRENCE-ID override, in the series own zone', () => {
    const tree = root(series());
    const occurrence = Date.UTC(2026, 2, 9, 13) / 1000; // 09:00 EDT
    editTimes(tree, occurrence, { start: '2026-03-09T11:00:00', end: '2026-03-09T11:30:00', title: 'Standup, later' }, 'America/New_York');
    const text = serializeIcs(tree);
    expect(text).toContain('RECURRENCE-ID;TZID=America/New_York:20260309T090000');
    expect(text).toContain('DTSTART;TZID=America/New_York:20260309T110000');
    const events = eventsOfResource(root(text), ctx('America/New_York'), ALL);
    expect(events.map((e) => [e.start, e.title])).toEqual([
      ['2026-03-02T09:00:00', 'Standup'],
      ['2026-03-09T11:00:00', 'Standup, later'],
      ['2026-03-16T09:00:00', 'Standup'],
      ['2026-03-23T09:00:00', 'Standup'],
    ]);
    // Moving it again edits the same override instead of adding a second one.
    editTimes(tree, occurrence, { start: '2026-03-09T12:00:00', end: '2026-03-09T12:30:00' }, 'America/New_York');
    expect(tree.children.filter((c) => c.name === 'VEVENT')).toHaveLength(2);
  });

  it('removes one occurrence with an EXDATE and drops its override', () => {
    const tree = root(series());
    const occurrence = Date.UTC(2026, 2, 16, 13) / 1000;
    editTimes(tree, occurrence, { start: '2026-03-16T10:00:00', end: '2026-03-16T10:30:00' }, 'America/New_York');
    removeOccurrence(tree, occurrence, 'America/New_York');
    const events = eventsOfResource(root(serializeIcs(tree)), ctx('America/New_York'), ALL);
    expect(events.map((e) => e.start.slice(0, 10))).toEqual(['2026-03-02', '2026-03-09', '2026-03-23']);
  });

  it('makes a new event in UTC, marked as made by Walnut, all-day ends exclusive on the wire', () => {
    const timed = newEventCalendar({ start: '2026-08-05T09:00:00', end: '2026-08-05T10:00:00', title: 'Block; with, commas' }, 'America/Los_Angeles');
    const text = serializeIcs(timed.calendar);
    expect(text).toContain('DTSTART:20260805T160000Z');
    expect(text).toContain('SUMMARY:Block\\; with\\, commas');
    expect(text).toContain('X-WALNUT-CREATED:TRUE');
    const [event] = eventsOfResource(root(text), ctx('America/Los_Angeles'), ALL);
    expect(event).toMatchObject({ title: 'Block; with, commas', start: '2026-08-05T09:00:00', walnutCreated: true, hasAttendees: false });
    expect(calendarEventNeedsApproval(event)).toBe(false);
    const allDay = serializeIcs(newEventCalendar({ start: '2026-08-05', end: '2026-08-05', title: 'Off' }, 'UTC').calendar);
    expect(allDay).toContain('DTSTART;VALUE=DATE:20260805');
    expect(allDay).toContain('DTEND;VALUE=DATE:20260806');
  });
});
