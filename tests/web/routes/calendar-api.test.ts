/**
 * E2E tests for /api/calendar — real HTTP through startServer with a mock
 * CalendarSource injected via _setCalendarServiceForTest (only the EventKit
 * helper is mocked; service cache/write-through/bus wiring is real).
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { vi } from 'vitest';
import fs from 'node:fs/promises';
import type { Server as HttpServer } from 'node:http';
import { createMockConstants } from '../../helpers/mock-constants.js';

vi.mock('../../../src/constants.js', () => createMockConstants());

import { WALNUT_HOME } from '../../../src/constants.js';
import { bus, EventNames, type BusEvent } from '../../../src/core/event-bus.js';
import { CalendarService, _setCalendarServiceForTest } from '../../../src/core/calendar/index.js';
import { CalendarHelperError } from '../../../src/core/calendar/index.js';
import { createMockCalendarSource, type MockCalendarState } from '../../helpers/mock-calendar-source.js';
import { startServer, stopServer } from '../../../src/web/server.js';

let server: HttpServer;
let port: number;
let state: MockCalendarState;
let busEvents: BusEvent[] = [];

function apiUrl(p: string): string {
  return `http://localhost:${port}${p}`;
}

function resetService(): void {
  const mock = createMockCalendarSource();
  state = mock.state;
  const service = new CalendarService(mock.source);
  _setCalendarServiceForTest(service);
}

beforeAll(async () => {
  await fs.rm(WALNUT_HOME, { recursive: true, force: true });
  await fs.mkdir(WALNUT_HOME, { recursive: true });
  resetService(); // in place before startServer's getCalendarService().init()
  server = await startServer({ port: 0, dev: true });
  const addr = server.address();
  port = typeof addr === 'object' && addr ? addr.port : 0;
  bus.subscribe('calendar-api-test', (e) => { busEvents.push(e); }, { global: true, interest: ['calendar:'] });
});

afterAll(async () => {
  bus.unsubscribe('calendar-api-test');
  _setCalendarServiceForTest(null);
  await stopServer();
  await fs.rm(WALNUT_HOME, { recursive: true, force: true });
});

beforeEach(() => {
  resetService();
  busEvents = [];
});

interface EventShape {
  id: string;
  title: string;
  start: string;
  end: string;
  allDay: boolean;
  calendarId: string;
  readonly?: boolean;
  status?: string;
  selfStatus?: string;
}

describe('GET /api/calendar/events', () => {
  it('returns events overlapping the range only, with source status', async () => {
    const res = await fetch(apiUrl('/api/calendar/events?from=2026-08-03&to=2026-08-09'));
    expect(res.status).toBe(200);
    const body = await res.json() as { events: EventShape[]; sources: { id: string; available: boolean }[] };
    const ids = body.events.map((e) => e.id).sort();
    // ev-outside (8/12) excluded; ev-canceled/ev-declined are in range and stay
    // in the payload — they are marked, not dropped.
    expect(ids).toEqual([
      'ev-canceled', 'ev-declined', 'ev-gym#1770000000', 'ev-holiday', 'ev-standup',
    ]);
    expect(body.sources[0]).toMatchObject({ id: 'eventkit', available: true, enabled: true });
    // tz-less local ISO contract
    for (const e of body.events) {
      expect(e.start).toMatch(/^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}:\d{2})?$/);
    }
  });

  it('marks cancelled and declined events instead of dropping or hiding them', async () => {
    const res = await fetch(apiUrl('/api/calendar/events?from=2026-08-03&to=2026-08-09'));
    const body = await res.json() as { events: EventShape[] };
    const canceled = body.events.find((e) => e.id === 'ev-canceled');
    expect(canceled?.status).toBe('canceled');
    expect(canceled?.selfStatus).toBe('accepted');
    const declined = body.events.find((e) => e.id === 'ev-declined');
    expect(declined?.status).toBe('confirmed');
    expect(declined?.selfStatus).toBe('declined');
    // A plain personal event carries neither key rather than a bogus default.
    const standup = body.events.find((e) => e.id === 'ev-standup');
    expect(standup?.status).toBeUndefined();
    expect(standup?.selfStatus).toBeUndefined();
  });

  it('serves a repeat read from cache but re-fetches when fresh=1 is asked for', async () => {
    const url = '/api/calendar/events?from=2026-08-03&to=2026-08-09';
    await fetch(apiUrl(url));
    const afterFirst = state.calls.filter((c) => c.method === 'listEvents').length;
    expect(afterFirst).toBe(1);

    await fetch(apiUrl(url)); // inside the read TTL → no new source call
    expect(state.calls.filter((c) => c.method === 'listEvents')).toHaveLength(afterFirst);

    // Something changes behind Walnut's back (a meeting cancelled in Exchange).
    state.events = state.events.filter((e) => e.id !== 'ev-standup');
    const stale = await fetch(apiUrl(url)).then((r) => r.json()) as { events: EventShape[] };
    expect(stale.events.some((e) => e.id === 'ev-standup')).toBe(true); // still cached

    const fresh = await fetch(apiUrl(`${url}&fresh=1`)).then((r) => r.json()) as { events: EventShape[] };
    expect(fresh.events.some((e) => e.id === 'ev-standup')).toBe(false);
    expect(state.calls.filter((c) => c.method === 'listEvents').length).toBe(afterFirst + 1);
  });

  it('collapses concurrent reads of one window onto a single source fetch', async () => {
    const url = '/api/calendar/events?from=2026-08-03&to=2026-08-09';
    await Promise.all([fetch(apiUrl(url)), fetch(apiUrl(url)), fetch(apiUrl(url))]);
    expect(state.calls.filter((c) => c.method === 'listEvents')).toHaveLength(1);
  });

  it('asks the source to pull from remote accounts on an explicit refresh', async () => {
    await fetch(apiUrl('/api/calendar/events?from=2026-08-03&to=2026-08-09')); // prime a window
    state.calls.length = 0;
    await fetch(apiUrl('/api/calendar/refresh'), { method: 'POST' });
    const refreshCall = state.calls.find((c) => c.method === 'listEvents');
    expect(refreshCall?.args[2]).toEqual({ refresh: true });
  });

  it('rejects bad ranges with 400', async () => {
    for (const q of ['from=2026-08-09&to=2026-08-03', 'from=aug-3&to=2026-08-09', 'to=2026-08-09']) {
      const res = await fetch(apiUrl(`/api/calendar/events?${q}`));
      expect(res.status).toBe(400);
    }
  });

  it('degrades to empty events (not an error) when the source fails', async () => {
    state.failWith = new CalendarHelperError('Calendar access denied.', 'permission-denied');
    const res = await fetch(apiUrl('/api/calendar/events?from=2026-09-01&to=2026-09-07'));
    expect(res.status).toBe(200);
    const body = await res.json() as { events: unknown[]; sources: { available: boolean; reason?: string }[] };
    expect(body.events).toEqual([]);
    expect(body.sources[0].available).toBe(false);
    expect(body.sources[0].reason).toBe('permission-denied');
  });
});

describe('GET /api/calendar/sources', () => {
  it('lists calendars with readonly flags', async () => {
    const res = await fetch(apiUrl('/api/calendar/sources'));
    expect(res.status).toBe(200);
    const body = await res.json() as { calendars: { id: string; readonly: boolean }[] };
    expect(body.calendars).toHaveLength(3);
    expect(body.calendars.find((c) => c.id === 'cal-holidays')?.readonly).toBe(true);
  });
});

describe('PATCH /api/calendar/events/:id', () => {
  it('moves an event and write-through makes the next read see it', async () => {
    const res = await fetch(apiUrl('/api/calendar/events/ev-standup'), {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ start: '2026-08-04T14:00:00', end: '2026-08-04T14:30:00' }),
    });
    expect(res.status).toBe(200);
    const { event } = await res.json() as { event: EventShape };
    expect(event.start).toBe('2026-08-04T14:00:00');

    const read = await fetch(apiUrl('/api/calendar/events?from=2026-08-03&to=2026-08-09'));
    const body = await read.json() as { events: EventShape[] };
    expect(body.events.find((e) => e.id === 'ev-standup')?.start).toBe('2026-08-04T14:00:00');
  });

  it('resolves URL-encoded recurring-occurrence ids (# in id)', async () => {
    const res = await fetch(apiUrl(`/api/calendar/events/${encodeURIComponent('ev-gym#1770000000')}`), {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ start: '2026-08-05T19:00:00', end: '2026-08-05T20:00:00' }),
    });
    expect(res.status).toBe(200);
    expect(state.calls.some((c) => c.method === 'updateEvent' && c.args[0] === 'ev-gym#1770000000')).toBe(true);
  });

  it('emits calendar:updated to web-ui after a write', async () => {
    await fetch(apiUrl('/api/calendar/events/ev-standup'), {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ start: '2026-08-04T10:00:00', end: '2026-08-04T10:30:00' }),
    });
    await new Promise((r) => setTimeout(r, 20)); // async bus delivery
    const updated = busEvents.filter((e) => e.name === EventNames.CALENDAR_UPDATED);
    expect(updated.length).toBeGreaterThan(0);
    expect(updated[0].destinations).toContain('web-ui');
  });

  it('maps readonly → 409, unknown id → 404, bad dates → 400', async () => {
    const readonly = await fetch(apiUrl('/api/calendar/events/ev-holiday'), {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ start: '2026-08-08', end: '2026-08-08' }),
    });
    expect(readonly.status).toBe(409);

    const missing = await fetch(apiUrl('/api/calendar/events/ev-nope'), {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ start: '2026-08-08T10:00:00', end: '2026-08-08T11:00:00' }),
    });
    expect(missing.status).toBe(404);

    const badDates = await fetch(apiUrl('/api/calendar/events/ev-standup'), {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ start: '2026-08-04T10:00:00Z', end: '2026-08-04T11:00:00' }),
    });
    expect(badDates.status).toBe(400); // tz suffix rejected
  });
});

describe('POST /api/calendar/events + DELETE', () => {
  it('creates on a writable calendar and the event shows up in reads', async () => {
    const res = await fetch(apiUrl('/api/calendar/events'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        calendarId: 'cal-work',
        title: 'Design review',
        start: '2026-08-06T15:00:00',
        end: '2026-08-06T16:00:00',
      }),
    });
    expect(res.status).toBe(201);
    const { event } = await res.json() as { event: EventShape };
    expect(event.title).toBe('Design review');
    expect(event.calendarId).toBe('cal-work');

    const read = await fetch(apiUrl('/api/calendar/events?from=2026-08-03&to=2026-08-09'));
    const body = await read.json() as { events: EventShape[] };
    expect(body.events.some((e) => e.id === event.id)).toBe(true);

    const del = await fetch(apiUrl(`/api/calendar/events/${event.id}`), { method: 'DELETE' });
    expect(del.status).toBe(200);
    const read2 = await fetch(apiUrl('/api/calendar/events?from=2026-08-03&to=2026-08-09'));
    const body2 = await read2.json() as { events: EventShape[] };
    expect(body2.events.some((e) => e.id === event.id)).toBe(false);
  });

  it('a 404 delete does NOT latch the source unavailable', async () => {
    // Regression: trackErrors stored the benign not-found as lastError, so a
    // double-delete (two tabs, stale chip) flipped available:false and
    // silently removed the Event tab + "New event…" until a manual refresh.
    const created = await fetch(apiUrl('/api/calendar/events'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        calendarId: 'cal-work',
        title: 'Double delete',
        start: '2026-08-06T10:00:00',
        end: '2026-08-06T10:30:00',
      }),
    });
    const { event } = await created.json() as { event: EventShape };
    expect((await fetch(apiUrl(`/api/calendar/events/${event.id}`), { method: 'DELETE' })).status).toBe(200);
    expect((await fetch(apiUrl(`/api/calendar/events/${event.id}`), { method: 'DELETE' })).status).toBe(404);

    const res = await fetch(apiUrl('/api/calendar/sources'));
    const { sources } = await res.json() as { sources: { available: boolean }[] };
    expect(sources[0].available).toBe(true);
  });

  it('rejects creates on read-only calendars (409) and incomplete bodies (400)', async () => {
    const readonly = await fetch(apiUrl('/api/calendar/events'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ calendarId: 'cal-holidays', title: 'X', start: '2026-08-07', end: '2026-08-07' }),
    });
    expect(readonly.status).toBe(409);

    const missing = await fetch(apiUrl('/api/calendar/events'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: 'no calendar', start: '2026-08-07T10:00:00' }),
    });
    expect(missing.status).toBe(400);
  });
});

describe('PUT /api/calendar/sources/eventkit', () => {
  it('enabled:false makes reads return empty and status say disabled', async () => {
    const put = await fetch(apiUrl('/api/calendar/sources/eventkit'), {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ enabled: false }),
    });
    expect(put.status).toBe(200);
    const { sources } = await put.json() as { sources: { enabled: boolean; reason?: string }[] };
    expect(sources[0].enabled).toBe(false);
    expect(sources[0].reason).toBe('disabled');

    const read = await fetch(apiUrl('/api/calendar/events?from=2026-08-03&to=2026-08-09'));
    const body = await read.json() as { events: unknown[] };
    expect(body.events).toEqual([]);

    // restore for other tests (config persists across resetService)
    await fetch(apiUrl('/api/calendar/sources/eventkit'), {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ enabled: true }),
    });
  });

  it('rejects a non-array hidden_calendar_ids', async () => {
    const res = await fetch(apiUrl('/api/calendar/sources/eventkit'), {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ hidden_calendar_ids: 'cal-work' }),
    });
    expect(res.status).toBe(400);
  });

  it('hiding a calendar filters its events from reads without a refetch, and unhiding restores them', async () => {
    // Prime the cache, then hide — the filter must apply to the CACHED window.
    await fetch(apiUrl('/api/calendar/events?from=2026-08-03&to=2026-08-09'));
    const put = await fetch(apiUrl('/api/calendar/sources/eventkit'), {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ hidden_calendar_ids: ['cal-work'] }),
    });
    expect(put.status).toBe(200);

    const hidden = await fetch(apiUrl('/api/calendar/events?from=2026-08-03&to=2026-08-09'));
    const hiddenBody = await hidden.json() as { events: EventShape[] };
    expect(hiddenBody.events.some((e) => e.calendarId === 'cal-work')).toBe(false);
    expect(hiddenBody.events.some((e) => e.calendarId === 'cal-home')).toBe(true);

    // /sources reflects the hidden flag
    const sources = await fetch(apiUrl('/api/calendar/sources'));
    const sourcesBody = await sources.json() as { calendars: { id: string; hidden: boolean }[] };
    expect(sourcesBody.calendars.find((c) => c.id === 'cal-work')?.hidden).toBe(true);

    // unhide → events come back (cache kept them)
    await fetch(apiUrl('/api/calendar/sources/eventkit'), {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ hidden_calendar_ids: [] }),
    });
    const restored = await fetch(apiUrl('/api/calendar/events?from=2026-08-03&to=2026-08-09'));
    const restoredBody = await restored.json() as { events: EventShape[] };
    expect(restoredBody.events.some((e) => e.calendarId === 'cal-work')).toBe(true);
  });

  it('visible_calendar_ids allowlist shows ONLY listed calendars; null clears it', async () => {
    await fetch(apiUrl('/api/calendar/events?from=2026-08-03&to=2026-08-09')); // prime cache
    const put = await fetch(apiUrl('/api/calendar/sources/eventkit'), {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ visible_calendar_ids: ['cal-home'] }),
    });
    expect(put.status).toBe(200);

    // Only the allowlisted calendar's events survive — applies to the CACHED window.
    const allow = await fetch(apiUrl('/api/calendar/events?from=2026-08-03&to=2026-08-09'));
    const allowBody = await allow.json() as { events: EventShape[] };
    expect(allowBody.events.length).toBeGreaterThan(0);
    expect(allowBody.events.every((e) => e.calendarId === 'cal-home')).toBe(true);

    // /sources marks everything outside the allowlist hidden.
    const sources = await fetch(apiUrl('/api/calendar/sources'));
    const sourcesBody = await sources.json() as { calendars: { id: string; hidden: boolean }[] };
    expect(sourcesBody.calendars.find((c) => c.id === 'cal-work')?.hidden).toBe(true);
    expect(sourcesBody.calendars.find((c) => c.id === 'cal-home')?.hidden).toBe(false);

    // Denylist still applies ON TOP of the allowlist.
    await fetch(apiUrl('/api/calendar/sources/eventkit'), {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ hidden_calendar_ids: ['cal-home'] }),
    });
    const both = await fetch(apiUrl('/api/calendar/events?from=2026-08-03&to=2026-08-09'));
    const bothBody = await both.json() as { events: EventShape[] };
    expect(bothBody.events).toEqual([]);

    // null clears the allowlist; empty denylist restores everything.
    await fetch(apiUrl('/api/calendar/sources/eventkit'), {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ visible_calendar_ids: null, hidden_calendar_ids: [] }),
    });
    const restored = await fetch(apiUrl('/api/calendar/events?from=2026-08-03&to=2026-08-09'));
    const restoredBody = await restored.json() as { events: EventShape[] };
    expect(restoredBody.events.some((e) => e.calendarId === 'cal-work')).toBe(true);
    expect(restoredBody.events.some((e) => e.calendarId === 'cal-home')).toBe(true);
  });

  it('rejects a non-array visible_calendar_ids', async () => {
    const res = await fetch(apiUrl('/api/calendar/sources/eventkit'), {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ visible_calendar_ids: 'cal-home' }),
    });
    expect(res.status).toBe(400);
  });

  it('emits calendar:updated when visibility changes so open views refresh', async () => {
    await fetch(apiUrl('/api/calendar/sources/eventkit'), {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ hidden_calendar_ids: ['cal-home'] }),
    });
    await new Promise((r) => setTimeout(r, 20));
    expect(busEvents.some((e) => e.name === EventNames.CALENDAR_UPDATED)).toBe(true);
    // restore
    await fetch(apiUrl('/api/calendar/sources/eventkit'), {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ hidden_calendar_ids: [] }),
    });
  });
});
