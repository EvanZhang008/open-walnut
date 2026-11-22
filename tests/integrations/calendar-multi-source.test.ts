/**
 * The calendar over several sources: the Mac's (EventKit, a mock here) and a mail account's
 * calendar (a real CalDAV source against tests/helpers/fake-caldav-server.ts).
 *
 * What has to hold:
 * - With the `mail_calendars` experiment off, nothing changes: one source, `[status()]`, the
 *   Mac's events only, whatever config lists.
 * - On, every source is read and merged, each one's status is reported, and a source that
 *   fails degrades alone (its status says why); only when every source fails does a read fail.
 * - A write goes to the source its id names, and the write-safety rule is the same for both.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createMockConstants } from '../helpers/mock-constants.js';

vi.mock('../../src/constants.js', () => createMockConstants('calendar-multi-source'));

import { updateConfig, updatePluginConfig } from '../../src/core/config-manager.js';
import { CalendarHelperError } from '../../src/core/calendar/helper-error.js';
import { CalendarService } from '../../src/integrations/calendar/service.js';
import { createCalDavSource } from '../../src/integrations/calendar/caldav/source.js';
import { ATTENDEES_READONLY_TEXT, calendarSourceOf } from '../../src/integrations/calendar/event-rules.js';
import type { CalendarSource } from '../../src/integrations/calendar/types.js';
import { createMockCalendarSource, type MockCalendarState } from '../helpers/mock-calendar-source.js';
import { ics, startFakeCalDav, type FakeCalDavServer } from '../helpers/fake-caldav-server.js';

const ACCOUNT = 'imap:abc123';
const BROKEN = 'imap:dead00';
const WORK = '/dav/calendars/pat/work/';

let server: FakeCalDavServer;
let primary: MockCalendarState;
let service: CalendarService;

/** A source that fails every call the way an unreachable server does. */
function brokenSource(accountId: string): CalendarSource {
  const fail = async (): Promise<never> => { throw new CalendarHelperError('mail.example.net did not answer within 15 seconds.', 'fetch-error'); };
  return {
    id: `caldav:${accountId}`,
    describe: () => ({ kind: 'caldav', account: accountId, label: 'sam@example.net' }),
    available: () => ({ ok: true }),
    listCalendars: fail, listEvents: fail, getEvent: fail, updateEvent: fail, createEvent: fail, deleteEvent: fail,
  };
}

async function build(opts: { flag: boolean; accounts: string[]; primaryOk?: boolean }): Promise<void> {
  await updateConfig({ experimental: { mail_calendars: opts.flag } } as never);
  await updatePluginConfig('calendar', { mail_calendar_accounts: opts.accounts, hidden_calendar_ids: [], default_calendar_id: '' });
  const mock = createMockCalendarSource();
  primary = mock.state;
  if (opts.primaryOk === false) mock.source.available = () => ({ ok: false, reason: 'not-configured', message: 'EventKit calendars require macOS.' });
  service = new CalendarService(mock.source);
  service.setMailCalendarSourceFactory((accountId) => accountId === BROKEN
    ? brokenSource(accountId)
    : createCalDavSource({
      accountId,
      credentials: async () => ({ accountId, address: 'pat@example.com', password: 'app-pass', hosts: { caldav: `${server.origin}/.well-known/caldav` } }),
      localZone: () => 'UTC',
    }));
  await service.reloadConfig();
}

beforeAll(async () => {
  server = await startFakeCalDav({ username: 'pat@example.com', password: 'app-pass', calendars: [{ path: WORK, name: 'Mail work', color: '#aa3300' }] });
});
afterAll(async () => { await server.close(); });
beforeEach(() => {
  server.resources.clear();
  server.put(`${WORK}m1.ics`, ics(['UID:m1', 'DTSTART:20260804T160000Z', 'DTEND:20260804T170000Z', 'SUMMARY:Mail meeting', 'X-WALNUT-CREATED:TRUE']));
  server.put(`${WORK}m2.ics`, ics(['UID:m2', 'DTSTART:20260805T160000Z', 'DTEND:20260805T170000Z', 'SUMMARY:Invite', 'ORGANIZER:mailto:sam@example.com', 'ATTENDEE:mailto:pat@example.com']));
  server.failWith = null;
});

describe('experiment off: exactly the old behaviour', () => {
  it('reads only the Mac whatever config lists, and reports one source', async () => {
    await build({ flag: false, accounts: [ACCOUNT] });
    const events = await service.getEvents('2026-08-03', '2026-08-09');
    expect(events.every((e) => e.source === 'eventkit')).toBe(true);
    expect(service.statuses()).toEqual([service.status()]);
    expect(service.statuses()[0]).toMatchObject({ id: 'eventkit', available: true });
    expect(server.requests.filter((r) => r.method === 'REPORT')).toHaveLength(0);
  });
});

describe('experiment on', () => {
  it('merges both sources and reports each status, the Mac first', async () => {
    await build({ flag: true, accounts: [ACCOUNT] });
    const events = await service.getEvents('2026-08-03', '2026-08-09');
    expect(events.some((e) => e.title === 'Standup' && e.source === 'eventkit')).toBe(true);
    expect(events.filter((e) => e.source === 'caldav:imap:abc123').map((e) => e.title).sort()).toEqual(['Invite', 'Mail meeting']);
    const statuses = service.statuses();
    expect(statuses.map((s) => s.id)).toEqual(['eventkit', 'caldav:imap:abc123']);
    expect(statuses[1]).toMatchObject({ kind: 'caldav', account: ACCOUNT, label: 'pat@example.com', available: true, eventCount: 2 });
    const calendars = await service.listCalendars();
    expect(calendars.filter((c) => calendarSourceOf(c.id) === 'caldav:imap:abc123').map((c) => c.title)).toEqual(['Mail work']);
  });

  it('a failing mail calendar degrades alone and says why', async () => {
    await build({ flag: true, accounts: [ACCOUNT, BROKEN] });
    const events = await service.getEvents('2026-08-03', '2026-08-09');
    expect(events.some((e) => e.source === 'eventkit')).toBe(true);
    expect(events.some((e) => e.source === 'caldav:imap:abc123')).toBe(true);
    const broken = service.statuses().find((s) => s.id === 'caldav:imap:dead00')!;
    expect(broken).toMatchObject({ available: false, reason: 'fetch-error', message: expect.stringContaining('did not answer') });
    expect(service.status()).toMatchObject({ id: 'eventkit', available: true });
    const { complete } = await service.listCalendarsDetailed();
    expect(complete).toBe(false);
  });

  it('the Mac failing leaves the mail calendar readable, and its status says why', async () => {
    await build({ flag: true, accounts: [ACCOUNT] });
    primary.failWith = new CalendarHelperError('Calendar access denied', 'permission-denied');
    const events = await service.getEvents('2026-08-03', '2026-08-09', { force: true });
    expect(events.map((e) => e.source)).toEqual(['caldav:imap:abc123', 'caldav:imap:abc123']);
    expect(service.status()).toMatchObject({ available: false, reason: 'permission-denied' });
  });

  it('a read fails only when every source fails', async () => {
    await build({ flag: true, accounts: [BROKEN] });
    primary.failWith = new CalendarHelperError('Calendar access denied', 'permission-denied');
    await expect(service.getEvents('2026-08-03', '2026-08-09')).rejects.toMatchObject({ code: 'permission-denied' });
  });

  it('reads the mail calendar on a machine with no EventKit', async () => {
    await build({ flag: true, accounts: [ACCOUNT], primaryOk: false });
    const events = await service.getEvents('2026-08-03', '2026-08-09');
    expect(events.map((e) => e.title).sort()).toEqual(['Invite', 'Mail meeting']);
    expect(service.status()).toMatchObject({ available: false, reason: 'not-configured' });
  });

  it('routes each write to the source its id names', async () => {
    await build({ flag: true, accounts: [ACCOUNT] });
    const events = await service.getEvents('2026-08-03', '2026-08-09');
    const mine = events.find((e) => e.title === 'Mail meeting')!;
    await service.updateEvent(mine.id, { start: '2026-08-04T18:00:00', end: '2026-08-04T19:00:00' });
    expect(server.resources.get(`${WORK}m1.ics`)!.ics).toContain('DTSTART:20260804T180000Z');
    expect(primary.calls.some((c) => c.method === 'updateEvent')).toBe(false);
    await service.updateEvent('ev-standup', { start: '2026-08-04T10:00:00', end: '2026-08-04T10:30:00' });
    expect(primary.calls.some((c) => c.method === 'updateEvent')).toBe(true);
    const mailCalendar = (await service.listCalendars()).find((c) => c.title === 'Mail work')!;
    const created = await service.createEvent({ calendarId: mailCalendar.id, title: 'From Walnut', start: '2026-08-06T09:00:00', end: '2026-08-06T09:30:00' });
    expect(created.source).toBe('caldav:imap:abc123');
    expect(primary.calls.some((c) => c.method === 'createEvent')).toBe(false);
    // The write-through re-read shows it at once.
    expect((await service.getEvents('2026-08-06', '2026-08-06')).map((e) => e.title)).toContain('From Walnut');
  });

  it('keeps a mail event with other people on it read-only, whatever the person confirmed', async () => {
    await build({ flag: true, accounts: [ACCOUNT] });
    const invite = (await service.getEvents('2026-08-05', '2026-08-05')).find((e) => e.title === 'Invite')!;
    expect(invite).toMatchObject({ readonly: true, readonlyReason: ATTENDEES_READONLY_TEXT });
    const writes = () => server.requests.filter((r) => r.method === 'PUT' || r.method === 'DELETE').length;
    const before = writes();
    for (const opts of [undefined, { humanConfirm: true }]) {
      await expect(service.updateEvent(invite.id, { start: '2026-08-05T18:00:00', end: '2026-08-05T19:00:00' }, opts)).rejects.toMatchObject({ code: 'readonly', message: ATTENDEES_READONLY_TEXT });
      await expect(service.deleteEvent(invite.id, opts)).rejects.toMatchObject({ code: 'readonly', message: ATTENDEES_READONLY_TEXT });
    }
    expect(writes()).toBe(before);
  });

  it('the source checks attendees on the copy it writes: one added since the read still stops the write', async () => {
    await build({ flag: true, accounts: [ACCOUNT] });
    const mine = (await service.getEvents('2026-08-04', '2026-08-04')).find((e) => e.title === 'Mail meeting')!;
    const caldav = createCalDavSource({
      accountId: ACCOUNT,
      credentials: async () => ({ accountId: ACCOUNT, address: 'pat@example.com', password: 'app-pass', hosts: { caldav: `${server.origin}/.well-known/caldav` } }),
      localZone: () => 'UTC',
    });
    await caldav.getEvent!(mine.id);
    server.put(`${WORK}m1.ics`, ics(['UID:m1', 'DTSTART:20260804T160000Z', 'DTEND:20260804T170000Z', 'SUMMARY:Mail meeting', 'X-WALNUT-CREATED:TRUE', 'ATTENDEE:mailto:sam@example.com']));
    const before = server.requests.filter((r) => r.method === 'PUT').length;
    await expect(caldav.updateEvent(mine.id, { start: '2026-08-04T18:00:00', end: '2026-08-04T19:00:00' }, { humanConfirm: true })).rejects.toMatchObject({ code: 'readonly' });
    expect(server.requests.filter((r) => r.method === 'PUT').length).toBe(before);
  });

  it('an occurrence of a series with other people on it is read-only even when its own override has none', async () => {
    server.put(`${WORK}m4.ics`, ics(
      ['UID:m4', 'DTSTART:20260803T150000Z', 'DTEND:20260803T153000Z', 'RRULE:FREQ=DAILY;COUNT=3', 'SUMMARY:Sync', 'X-WALNUT-CREATED:TRUE', 'ATTENDEE:mailto:sam@example.com'],
      ['UID:m4', 'RECURRENCE-ID:20260804T150000Z', 'DTSTART:20260804T160000Z', 'DTEND:20260804T163000Z', 'SUMMARY:Sync', 'X-WALNUT-CREATED:TRUE'],
    ));
    await build({ flag: true, accounts: [ACCOUNT] });
    const moved = (await service.getEvents('2026-08-04', '2026-08-04')).find((e) => e.title === 'Sync')!;
    expect(moved).toMatchObject({ readonly: true });
    const before = server.requests.filter((r) => r.method === 'PUT').length;
    await expect(service.deleteEvent(moved.id, { humanConfirm: true })).rejects.toMatchObject({ code: 'readonly' });
    expect(server.requests.filter((r) => r.method === 'PUT').length).toBe(before);
  });

  it('asks the person before changing a mail event Walnut did not make, as for the Mac', async () => {
    server.put(`${WORK}m3.ics`, ics(['UID:m3', 'DTSTART:20260805T100000Z', 'DTEND:20260805T110000Z', 'SUMMARY:Dentist']));
    await build({ flag: true, accounts: [ACCOUNT] });
    const dentist = (await service.getEvents('2026-08-05', '2026-08-05')).find((e) => e.title === 'Dentist')!;
    await expect(service.updateEvent(dentist.id, { start: '2026-08-05T12:00:00', end: '2026-08-05T13:00:00' })).rejects.toMatchObject({ code: 'human-approval-required' });
    await service.updateEvent(dentist.id, { start: '2026-08-05T12:00:00', end: '2026-08-05T13:00:00' }, { humanConfirm: true });
    expect(server.resources.get(`${WORK}m3.ics`)!.ics).toContain('DTSTART:20260805T120000Z');
  });

  it('a removed account leaves the calendar at once', async () => {
    await build({ flag: true, accounts: [ACCOUNT] });
    await service.getEvents('2026-08-03', '2026-08-09');
    await updatePluginConfig('calendar', { mail_calendar_accounts: [] });
    await service.reloadConfig();
    expect(service.statuses().map((s) => s.id)).toEqual(['eventkit']);
    expect((await service.getEvents('2026-08-03', '2026-08-09')).every((e) => e.source === 'eventkit')).toBe(true);
  });
});
