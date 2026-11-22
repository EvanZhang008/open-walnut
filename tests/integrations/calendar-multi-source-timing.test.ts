/**
 * The calendar over several sources, when a mail account's server is slow, gone or switched
 * off. Each case failed on the first version (an independent review found them):
 *
 * - Turning the `mail_calendars` experiment off (or on) takes effect at once, no restart.
 * - A slow mail server costs a read one short deadline; its late answer is kept and served to
 *   the next read, and the views are told it arrived.
 * - A write's refresh reads every cached window at once and latches no source failure.
 * - An id of a mail account no longer read is not found (never handed to the Mac's source), and
 *   a mail account whose calendars partly fail says so.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createMockConstants } from '../helpers/mock-constants.js';

vi.mock('../../src/constants.js', () => createMockConstants('calendar-multi-source-timing'));

import { updateConfig, updatePluginConfig } from '../../src/core/config-manager.js';
import { CalendarHelperError } from '../../src/core/calendar/helper-error.js';
import { CalendarService, setCalendarAnnouncer } from '../../src/integrations/calendar/service.js';
import type { CalendarEvent, CalendarSource } from '../../src/integrations/calendar/types.js';
import { createMockCalendarSource, type MockCalendarState } from '../helpers/mock-calendar-source.js';

const ACCOUNT = 'imap:slow01';
const SOURCE_ID = `caldav:${ACCOUNT}` as const;

function mailEvent(day: string): CalendarEvent {
  return {
    id: `${SOURCE_ID}/L3gu`, source: SOURCE_ID, calendarId: `${SOURCE_ID}/L2Nhb`, calendarName: 'Mail', accountName: 'pat@example.com',
    title: 'Mail event', start: `${day}T10:00:00`, end: `${day}T11:00:00`, allDay: false,
  };
}

/** A mail account's source whose reads take `delayMs` each. */
function slowSource(delayMs: number, calls: string[]): CalendarSource {
  return {
    id: SOURCE_ID,
    describe: () => ({ kind: 'caldav', account: ACCOUNT, label: 'pat@example.com' }),
    available: () => ({ ok: true }),
    listCalendars: async () => [],
    listEvents: async (from) => {
      calls.push(from);
      await new Promise((r) => setTimeout(r, delayMs));
      return [mailEvent('2026-08-05')];
    },
    getEvent: async () => { throw new CalendarHelperError('event not found', 'not-found'); },
    updateEvent: async () => { throw new CalendarHelperError('no', 'readonly'); },
    createEvent: async () => { throw new CalendarHelperError('no', 'readonly'); },
    deleteEvent: async () => { throw new CalendarHelperError('no', 'readonly'); },
  };
}

let primary: MockCalendarState;
let service: CalendarService;
let calls: string[];
let announced: number;

async function build(opts: { delayMs: number; deadlineMs: number; flag?: boolean }): Promise<void> {
  await updateConfig({ experimental: { mail_calendars: opts.flag ?? true } } as never);
  await updatePluginConfig('calendar', { mail_calendar_accounts: [ACCOUNT], hidden_calendar_ids: [], default_calendar_id: '' });
  const mock = createMockCalendarSource();
  primary = mock.state;
  calls = [];
  service = new CalendarService(mock.source, { extraReadDeadlineMs: opts.deadlineMs });
  service.setMailCalendarSourceFactory(() => slowSource(opts.delayMs, calls));
  await service.reloadConfig();
}

beforeEach(() => {
  announced = 0;
  setCalendarAnnouncer(() => { announced += 1; });
});
afterEach(() => { setCalendarAnnouncer(null); });

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('the experiment switch', () => {
  it('turned off at run time, the next read has only the Mac', async () => {
    await build({ delayMs: 0, deadlineMs: 1000 });
    expect((await service.getEvents('2026-08-03', '2026-08-09')).some((e) => e.source === SOURCE_ID)).toBe(true);
    await updateConfig({ experimental: { mail_calendars: false } } as never);
    await service.experimentsChanged();
    expect(service.statuses().map((s) => s.id)).toEqual(['eventkit']);
    expect((await service.getEvents('2026-08-03', '2026-08-09')).every((e) => e.source === 'eventkit')).toBe(true);
  });

  it('turned on at run time, the accounts already listed come back', async () => {
    await build({ delayMs: 0, deadlineMs: 1000, flag: false });
    expect(service.statuses()).toHaveLength(1);
    await updateConfig({ experimental: { mail_calendars: true } } as never);
    await service.experimentsChanged();
    expect(service.statuses().map((s) => s.id)).toEqual(['eventkit', SOURCE_ID]);
  });

  it('a config change that leaves the switch alone reloads nothing', async () => {
    await build({ delayMs: 0, deadlineMs: 1000 });
    const reload = vi.spyOn(service, 'reloadConfig');
    await service.experimentsChanged();
    expect(reload).not.toHaveBeenCalled();
  });
});

describe('a slow mail server', () => {
  it("never holds the Mac's events past the deadline, and its late answer serves the next read", async () => {
    await build({ delayMs: 400, deadlineMs: 100 });
    let started = Date.now();
    const first = await service.getEvents('2026-08-03', '2026-08-09');
    expect(Date.now() - started).toBeLessThan(350);
    expect(first.some((e) => e.source === 'eventkit')).toBe(true);
    expect(first.some((e) => e.source === SOURCE_ID)).toBe(false);
    expect(service.statuses()[1]).toMatchObject({ available: false, reason: 'fetch-error' });
    // The late answer lands in the cache and the views are told to read again.
    const told = announced;
    await vi.waitFor(() => expect(announced).toBeGreaterThan(told), { timeout: 3000, interval: 10 });
    started = Date.now();
    const second = await service.getEvents('2026-08-03', '2026-08-09');
    expect(Date.now() - started).toBeLessThan(80);
    expect(second.some((e) => e.source === SOURCE_ID)).toBe(true);
    expect(calls).toHaveLength(1); // the late read was used, not asked again
    expect(service.statuses()[1]).toMatchObject({ available: true });
  });

  it('a read while the slow one still runs joins it instead of asking again', async () => {
    await build({ delayMs: 400, deadlineMs: 100 });
    await service.getEvents('2026-08-03', '2026-08-09');
    await service.getEvents('2026-08-03', '2026-08-09', { force: true });
    expect(calls).toHaveLength(1);
  });
});

describe("a write's refresh", () => {
  it('reads every cached window at once', async () => {
    await build({ delayMs: 250, deadlineMs: 2000 });
    for (const month of ['2026-06', '2026-07', '2026-08', '2026-09']) await service.getEvents(`${month}-03`, `${month}-09`);
    const started = Date.now();
    await service.updateEvent('ev-standup', { start: '2026-08-04T10:00:00', end: '2026-08-04T10:30:00' });
    // One window's time, not four.
    expect(Date.now() - started).toBeLessThan(700);
  });

  it("latches no failure of the Mac's source, as before", async () => {
    await build({ delayMs: 0, deadlineMs: 1000 });
    await service.getEvents('2026-08-03', '2026-08-09');
    const mockSource = (service as unknown as { sources: { primary: { source: CalendarSource } } }).sources.primary.source;
    const list = mockSource.listEvents.bind(mockSource);
    let failNext = false;
    mockSource.listEvents = async (...args) => {
      if (failNext) throw new CalendarHelperError('Calendar access denied', 'permission-denied');
      return list(...args);
    };
    failNext = true;
    await service.updateEvent('ev-standup', { start: '2026-08-04T10:00:00', end: '2026-08-04T10:30:00' });
    expect(service.status()).toMatchObject({ available: true });
  });
});

describe('ids and partial failures', () => {
  it("an event id of a mail account no longer read is not found, and the Mac's source is never asked", async () => {
    await build({ delayMs: 0, deadlineMs: 1000 });
    const before = primary.calls.length;
    await expect(service.deleteEvent('caldav:imap:gone00/L3gu', { humanConfirm: true })).rejects.toMatchObject({ code: 'not-found' });
    await expect(service.updateEvent('caldav:imap:gone00/L3gu', { start: '2026-08-04T10:00:00', end: '2026-08-04T10:30:00' })).rejects.toMatchObject({ code: 'not-found' });
    expect(primary.calls.slice(before).filter((c) => c.method !== 'available')).toEqual([]);
  });
});

describe("round two: the Mac's helper runs one window at a time, as before", () => {
  it('with the experiment off, a refresh and a write read the cached windows one after another', async () => {
    await build({ delayMs: 0, deadlineMs: 1000, flag: false });
    for (const month of ['2026-06', '2026-07', '2026-08', '2026-09']) await service.getEvents(`${month}-03`, `${month}-09`);
    const mockSource = (service as unknown as { sources: { primary: { source: CalendarSource } } }).sources.primary.source;
    const list = mockSource.listEvents.bind(mockSource);
    let running = 0;
    let most = 0;
    mockSource.listEvents = async (...args) => {
      running += 1;
      most = Math.max(most, running);
      await wait(30);
      try { return await list(...args); } finally { running -= 1; }
    };
    await service.refreshAll();
    await service.updateEvent('ev-standup', { start: '2026-08-04T10:00:00', end: '2026-08-04T10:30:00' });
    expect(most).toBe(1);
  });
});

describe("round three: a refresh keeps a failing source's events", () => {
  it("the Mac's events stay in the cache when its helper fails once and the mail calendar answers", async () => {
    await build({ delayMs: 0, deadlineMs: 1000 });
    expect((await service.getEvents('2026-08-03', '2026-08-09')).some((e) => e.source === 'eventkit')).toBe(true);
    const mockSource = (service as unknown as { sources: { primary: { source: CalendarSource } } }).sources.primary.source;
    const list = mockSource.listEvents.bind(mockSource);
    mockSource.listEvents = async () => { throw new CalendarHelperError('helper crashed', 'fetch-error'); };
    await service.refreshAll();
    mockSource.listEvents = list;
    const cached = await service.getEvents('2026-08-03', '2026-08-09');
    expect(cached.some((e) => e.source === 'eventkit')).toBe(true);
    expect(cached.some((e) => e.source === SOURCE_ID)).toBe(true);
  });
});
