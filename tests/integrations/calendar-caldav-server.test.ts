/**
 * The CalDAV source against a CalDAV server (tests/helpers/fake-caldav-server.ts, in this
 * process): discovery from a mail account, reads with recurrence, and every write the
 * calendar makes, each with the ETag it read, so a change made meanwhile is never overwritten.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createCalDavSource } from '../../src/integrations/calendar/caldav/source.js';
import { discoverCalendars, signInProvider, startUrls, type MailAccountForCalendar } from '../../src/integrations/calendar/caldav/discovery.js';
import { davRequest } from '../../src/integrations/calendar/caldav/dav.js';
import { calendarErrorCode } from '../../src/integrations/calendar/api.js';
import { calendarSourceOf } from '../../src/integrations/calendar/event-rules.js';
import type { CalendarSource } from '../../src/integrations/calendar/types.js';
import { ics, startFakeCalDav, type FakeCalDavServer } from '../helpers/fake-caldav-server.js';

const WORK = '/dav/calendars/pat/work/';
const SHARED = '/dav/calendars/pat/shared/';

let server: FakeCalDavServer;
let account: MailAccountForCalendar;

function seed(): void {
  server.resources.clear();
  server.put(`${WORK}one.ics`, ics(['UID:one', 'DTSTART:20260805T160000Z', 'DTEND:20260805T170000Z', 'SUMMARY:Focus block', 'X-WALNUT-CREATED:TRUE']));
  server.put(`${WORK}series.ics`, ics(['UID:series', 'DTSTART:20260803T150000Z', 'DTEND:20260803T153000Z', 'RRULE:FREQ=DAILY;COUNT=3', 'SUMMARY:Standup', 'X-WALNUT-CREATED:TRUE']));
  server.put(`${WORK}far.ics`, ics(['UID:far', 'DTSTART:20270105T160000Z', 'DTEND:20270105T170000Z', 'SUMMARY:Next year']));
  server.put(`${SHARED}holiday.ics`, ics(['UID:h', 'DTSTART;VALUE=DATE:20260806', 'SUMMARY:Holiday']));
}

beforeAll(async () => {
  server = await startFakeCalDav({
    username: 'pat@example.com',
    password: 'app-pass',
    calendars: [
      { path: WORK, name: 'Work', color: '#1d6ff2' },
      { path: SHARED, name: 'Holidays', readonly: true },
    ],
  });
  account = { accountId: 'imap:abc123', address: 'pat@example.com', password: 'app-pass', hosts: { imap: 'imap.example.com', caldav: `${server.origin}/.well-known/caldav` } };
});

afterAll(async () => {
  await server.close();
});

beforeEach(() => {
  seed();
  server.beforeWrite = null;
  server.failWith = null;
  server.failPath = null;
});

function source(over: Partial<MailAccountForCalendar> = {}): CalendarSource {
  return createCalDavSource({ accountId: 'imap:abc123', credentials: async () => ({ ...account, ...over }), localZone: () => 'UTC' });
}

async function codeOf(p: Promise<unknown>): Promise<string | undefined> {
  try {
    await p;
    return undefined;
  } catch (err) {
    return calendarErrorCode(err) ?? `not a calendar error: ${String(err)}`;
  }
}

describe('discovery', () => {
  it('follows the well-known redirect to the principal, its home and its event calendars', async () => {
    const found = await discoverCalendars(account);
    expect(found.homeUrl).toBe(`${server.origin}/dav/calendars/pat/`);
    expect(found.calendars).toEqual([
      { path: WORK, title: 'Work', color: '#1d6ff2', readonly: false },
      { path: SHARED, title: 'Holidays', readonly: true },
    ]);
  });

  it('says the password was refused, and stops there', async () => {
    expect(await codeOf(discoverCalendars({ ...account, password: 'wrong' }))).toBe('auth-failed');
  });

  it('says no calendar when nothing CalDAV answers where the account points', async () => {
    expect(await codeOf(discoverCalendars({ ...account, hosts: { caldav: `${server.origin}/nothing-here/` } }))).toBe('no-calendar');
  });

  it('knows Gmail and Outlook need their own sign-in and never sends them the password', async () => {
    const before = server.requests.length;
    expect(signInProvider({ address: 'pat@gmail.com', hosts: {} })).toBe('Google');
    expect(signInProvider({ address: 'pat@work.example', hosts: { imap: 'imap.gmail.com' } })).toBe('Google');
    expect(signInProvider({ address: 'pat@hotmail.com', hosts: {} })).toBe('Microsoft');
    expect(signInProvider({ address: 'pat@work.example', hosts: { imap: 'outlook.office365.com' } })).toBe('Microsoft');
    expect(signInProvider({ address: 'pat@fastmail.com', hosts: {} })).toBeNull();
    expect(await codeOf(discoverCalendars({ ...account, address: 'pat@gmail.com', hosts: { imap: 'imap.gmail.com' } }))).toBe('needs-sign-in');
    expect(server.requests.length).toBe(before);
  });

  it('starts at the known server of iCloud, Fastmail and Yahoo, else RFC 6764 with the SRV record', async () => {
    const none = async () => [];
    expect(await startUrls({ ...account, address: 'pat@icloud.com', hosts: {} }, { resolveSrv: none })).toEqual([{ url: 'https://caldav.icloud.com/', guessed: false, trusted: true }]);
    expect(await startUrls({ ...account, address: 'pat@fastmail.com', hosts: {} }, { resolveSrv: none })).toEqual([{ url: 'https://caldav.fastmail.com/', guessed: false, trusted: true }]);
    expect(await startUrls({ ...account, address: 'pat@yahoo.com', hosts: {} }, { resolveSrv: none })).toEqual([{ url: 'https://caldav.calendar.yahoo.com/', guessed: false, trusted: true }]);
    const srv = async () => [{ name: 'dav.host.example.', port: 8443, priority: 0, weight: 1 }];
    // A guessed host is never trusted with the password, not even on the IMAP server's domain.
    expect(await startUrls({ ...account, address: 'pat@example.org', hosts: {} }, { resolveSrv: srv })).toEqual([
      { url: 'https://example.org/.well-known/caldav', guessed: true, trusted: false },
      { url: 'https://dav.host.example:8443/.well-known/caldav', guessed: true, trusted: false },
    ]);
    expect(await startUrls({ ...account, address: 'pat@example.org', hosts: { imap: 'imap.example.org' } }, { resolveSrv: srv })).toEqual([
      { url: 'https://example.org/.well-known/caldav', guessed: true, trusted: false },
      { url: 'https://dav.host.example:8443/.well-known/caldav', guessed: true, trusted: false },
    ]);
  });

  it('never sends the password over plain http to another machine', async () => {
    let called = false;
    const fetchSpy = async () => { called = true; return new Response('', { status: 200 }); };
    const code = await codeOf(davRequest({ username: 'a', password: 'b' }, { method: 'GET', url: 'http://calendar.example.com/' }, fetchSpy));
    expect(code).toBe('fetch-error');
    expect(called).toBe(false);
  });

  it('gives up on a server that never answers, within the deadline', async () => {
    const hang = (_url: string, init: RequestInit) => new Promise<Response>((_, reject) => {
      init.signal?.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'TimeoutError' })));
    });
    const started = Date.now();
    const code = await codeOf(davRequest({ username: 'a', password: 'b' }, { method: 'GET', url: 'https://slow.example/', timeoutMs: 200 }, hang));
    expect(code).toBe('fetch-error');
    expect(Date.now() - started).toBeLessThan(2000);
  });
});

describe('reading', () => {
  it('says so when one of the calendars did not answer, while the others still show', async () => {
    const src = source();
    server.failPath = { prefix: SHARED, status: 500 };
    const events = await src.listEvents('2026-08-01', '2026-08-31');
    expect(events.some((e) => e.title === 'Focus block')).toBe(true);
    expect(src.degraded?.()).toMatch(/"Holidays" did not answer/);
    server.failPath = null;
    await src.listEvents('2026-08-01', '2026-08-31');
    expect(src.degraded?.()).toBeUndefined();
  });

  it('lists the calendars with source-prefixed ids and the account address as their account', async () => {
    const calendars = await source().listCalendars();
    expect(calendars.map((c) => [c.title, c.account, c.readonly])).toEqual([['Work', 'pat@example.com', false], ['Holidays', 'pat@example.com', true]]);
    expect(calendars.every((c) => calendarSourceOf(c.id) === 'caldav:imap:abc123')).toBe(true);
  });

  it('reads a range from every calendar, recurring series expanded, outside events left out', async () => {
    const events = await source().listEvents('2026-08-01', '2026-08-31');
    expect(events.map((e) => [e.title, e.start]).sort()).toEqual([
      ['Focus block', '2026-08-05T16:00:00'],
      ['Holiday', '2026-08-06'],
      ['Standup', '2026-08-03T15:00:00'],
      ['Standup', '2026-08-04T15:00:00'],
      ['Standup', '2026-08-05T15:00:00'],
    ]);
    expect(events.find((e) => e.title === 'Holiday')).toMatchObject({ readonly: true, calendarName: 'Holidays', source: 'caldav:imap:abc123' });
    // The REPORT carried the range as a time-range filter.
    expect(server.requests.some((r) => r.method === 'REPORT')).toBe(true);
  });

  it('reads one event by id, an occurrence too', async () => {
    const s = source();
    const events = await s.listEvents('2026-08-01', '2026-08-31');
    const second = events.filter((e) => e.title === 'Standup')[1];
    expect(await s.getEvent!(second.id)).toMatchObject({ id: second.id, start: '2026-08-04T15:00:00', recurring: true });
  });

  it('says why when the server is down, as a calendar error', async () => {
    const s = source();
    await s.listCalendars();
    server.failWith = 503;
    expect(await codeOf(s.listEvents('2026-08-01', '2026-08-31'))).toBe('fetch-error');
  });
});

describe('writing, each with the ETag it read', () => {
  it('creates an event on a calendar and reads it back as Walnut-made', async () => {
    const s = source();
    const [work] = await s.listCalendars();
    const created = await s.createEvent({ calendarId: work.id, title: 'New block', start: '2026-08-07T10:00:00', end: '2026-08-07T11:00:00' });
    expect(created).toMatchObject({ title: 'New block', start: '2026-08-07T10:00:00', walnutCreated: true, hasAttendees: false });
    const put = server.requests.filter((r) => r.method === 'PUT').pop()!;
    expect(put.headers['if-none-match']).toBe('*');
    const again = await s.listEvents('2026-08-07', '2026-08-07');
    expect(again.map((e) => e.id)).toContain(created.id);
  });

  it('moves and renames an event in place with If-Match', async () => {
    const s = source();
    const focus = (await s.listEvents('2026-08-05', '2026-08-05')).find((e) => e.title === 'Focus block')!;
    const moved = await s.updateEvent(focus.id, { start: '2026-08-05T18:00:00', end: '2026-08-05T19:00:00', title: 'Focus, later' });
    expect(moved).toMatchObject({ id: focus.id, start: '2026-08-05T18:00:00', title: 'Focus, later' });
    const put = server.requests.filter((r) => r.method === 'PUT').pop()!;
    expect(put.headers['if-match']).toMatch(/^"etag-/);
    expect(server.resources.get(`${WORK}one.ics`)!.ics).toContain('DTSTART:20260805T180000Z');
  });

  it('moves one occurrence of a series, leaving the others', async () => {
    const s = source();
    const standups = (await s.listEvents('2026-08-01', '2026-08-31')).filter((e) => e.title === 'Standup');
    await s.updateEvent(standups[1].id, { start: '2026-08-04T17:00:00', end: '2026-08-04T17:30:00' });
    const after = (await s.listEvents('2026-08-01', '2026-08-31')).filter((e) => e.title === 'Standup').map((e) => e.start);
    expect(after.sort()).toEqual(['2026-08-03T15:00:00', '2026-08-04T17:00:00', '2026-08-05T15:00:00']);
  });

  it('deletes a one-off event and one occurrence of a series', async () => {
    const s = source();
    const all = await s.listEvents('2026-08-01', '2026-08-31');
    await s.deleteEvent(all.find((e) => e.title === 'Focus block')!.id);
    expect(server.resources.has(`${WORK}one.ics`)).toBe(false);
    const del = server.requests.filter((r) => r.method === 'DELETE').pop()!;
    expect(del.headers['if-match']).toMatch(/^"etag-/);
    const standups = all.filter((e) => e.title === 'Standup');
    await s.deleteEvent(standups[0].id);
    const after = (await s.listEvents('2026-08-01', '2026-08-31')).filter((e) => e.title === 'Standup');
    expect(after.map((e) => e.start)).toEqual(['2026-08-04T15:00:00', '2026-08-05T15:00:00']);
    expect(server.resources.get(`${WORK}series.ics`)!.ics).toContain('EXDATE:20260803T150000Z');
  });

  it('refuses as a conflict when the event changed on the server meanwhile (412), and saves nothing', async () => {
    const s = source();
    const focus = (await s.listEvents('2026-08-05', '2026-08-05')).find((e) => e.title === 'Focus block')!;
    const theirs = ics(['UID:one', 'DTSTART:20260805T200000Z', 'DTEND:20260805T210000Z', 'SUMMARY:Changed elsewhere']);
    server.beforeWrite = (path) => { server.put(path, theirs); server.beforeWrite = null; };
    expect(await codeOf(s.updateEvent(focus.id, { start: '2026-08-05T18:00:00', end: '2026-08-05T19:00:00' }))).toBe('conflict');
    expect(server.resources.get(`${WORK}one.ics`)!.ics).toBe(theirs);
    server.beforeWrite = (path) => { server.put(path, theirs); server.beforeWrite = null; };
    expect(await codeOf(s.deleteEvent(focus.id))).toBe('conflict');
    expect(server.resources.has(`${WORK}one.ics`)).toBe(true);
  });

  it('refuses writes to a read-only calendar before sending one', async () => {
    const s = source();
    const holiday = (await s.listEvents('2026-08-06', '2026-08-06')).find((e) => e.title === 'Holiday')!;
    const puts = server.requests.filter((r) => r.method === 'PUT').length;
    expect(await codeOf(s.updateEvent(holiday.id, { start: '2026-08-07', end: '2026-08-07' }))).toBe('readonly');
    expect(server.requests.filter((r) => r.method === 'PUT').length).toBe(puts);
  });

  it('answers not-found for an id that names nothing', async () => {
    const s = source();
    expect(await codeOf(s.getEvent!('caldav:imap:abc123/bm9wZQ'))).toBe('not-found');
    expect(await codeOf(s.getEvent!(`caldav:imap:abc123/${Buffer.from(`${WORK}gone.ics`).toString('base64url')}`))).toBe('not-found');
  });
});
