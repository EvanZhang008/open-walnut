/**
 * Butler calendar_* tool tests — mock CalendarSource behind a real
 * CalendarService (cache + write-through logic exercised for real).
 */
import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest';
import { createMockConstants } from '../../helpers/mock-constants.js';

vi.mock('../../../src/constants.js', () => createMockConstants());

import { CalendarService, _setCalendarServiceForTest } from '../../../src/core/calendar/index.js';
import { CalendarHelperError } from '../../../src/core/calendar/index.js';
import { createMockCalendarSource, type MockCalendarState } from '../../helpers/mock-calendar-source.js';
import { calendarTools } from '../../../src/agent/tools/calendar-tools.js';
import type { ToolDefinition } from '../../../src/agent/tools.js';

let state: MockCalendarState;

function tool(name: string): ToolDefinition {
  const t = calendarTools.find((t) => t.name === name);
  if (!t) throw new Error(`tool not registered: ${name}`);
  return t;
}

async function run(name: string, params: Record<string, unknown>): Promise<string> {
  const result = await tool(name).execute(params);
  if (typeof result !== 'string') throw new Error('calendar tools return plain strings');
  return result;
}

beforeEach(() => {
  const mock = createMockCalendarSource();
  state = mock.state;
  _setCalendarServiceForTest(new CalendarService(mock.source));
});

afterAll(() => {
  _setCalendarServiceForTest(null);
});

describe('calendar tool registration', () => {
  it('exports the four calendar tools with schemas', () => {
    const names = calendarTools.map((t) => t.name);
    expect(names).toEqual(['calendar_query', 'calendar_event_create', 'calendar_event_update', 'calendar_event_delete']);
    for (const t of calendarTools) {
      expect(t.description.length).toBeGreaterThan(20);
      expect((t.input_schema as { type: string }).type).toBe('object');
    }
  });
});

describe('calendar_query', () => {
  it('returns range-filtered events with status', async () => {
    const out = await run('calendar_query', { from: '2026-08-03', to: '2026-08-09' });
    const parsed = JSON.parse(out) as { status: { available: boolean }; events: { id: string; calendar: string }[] };
    expect(parsed.status.available).toBe(true);
    expect(parsed.events.map((e) => e.id).sort()).toEqual(['ev-gym#1770000000', 'ev-holiday', 'ev-standup']);
  });

  it('filters by calendar name substring and can list calendars', async () => {
    const out = await run('calendar_query', {
      from: '2026-08-03', to: '2026-08-09', calendar: 'work', list_calendars: true,
    });
    const parsed = JSON.parse(out) as { events: { calendar: string }[]; calendars: { id: string }[] };
    expect(parsed.events.every((e) => e.calendar === 'Work')).toBe(true);
    expect(parsed.calendars).toHaveLength(3);
  });

  it('rejects bad ranges without touching the source', async () => {
    const out = await run('calendar_query', { from: '2026-08-09', to: '2026-08-03' });
    expect(out).toMatch(/^Error:/);
    expect(state.calls).toHaveLength(0);
  });

  it('surfaces permission-denied with actionable guidance', async () => {
    state.failWith = new CalendarHelperError('Calendar access denied.', 'permission-denied');
    const out = await run('calendar_query', { from: '2026-08-03', to: '2026-08-09' });
    // Unlike the REST read (which degrades to []), the tool tells the butler
    // what's wrong so it can relay the fix to the user.
    expect(out).toContain('System Settings');
    expect(out).toMatch(/^Error:/);
  });
});

describe('calendar_event_create', () => {
  it('creates with a defaulted 1h end and returns the event', async () => {
    const out = await run('calendar_event_create', {
      calendar_id: 'cal-work', title: 'Focus block', start: '2026-08-06T09:00:00',
    });
    expect(out).toContain('Event created');
    const call = state.calls.find((c) => c.method === 'createEvent');
    expect(call?.args[0]).toMatchObject({ start: '2026-08-06T09:00:00', end: '2026-08-06T10:00:00', allDay: false });
  });

  it('date-only start defaults to an all-day event', async () => {
    await run('calendar_event_create', { calendar_id: 'cal-home', title: 'Trip', start: '2026-08-08' });
    const call = state.calls.find((c) => c.method === 'createEvent');
    expect(call?.args[0]).toMatchObject({ start: '2026-08-08', end: '2026-08-08', allDay: true });
  });

  it('maps readonly calendars to a readable error', async () => {
    const out = await run('calendar_event_create', {
      calendar_id: 'cal-holidays', title: 'X', start: '2026-08-08T10:00:00',
    });
    expect(out).toMatch(/Error \(readonly\)/);
  });

  it('rejects tz-suffixed dates', async () => {
    const out = await run('calendar_event_create', {
      calendar_id: 'cal-work', title: 'X', start: '2026-08-08T10:00:00Z',
    });
    expect(out).toMatch(/^Error:/);
    expect(state.calls).toHaveLength(0);
  });
});

describe('calendar_event_update / delete', () => {
  it('updates start+end+title and write-through refreshes reads', async () => {
    const out = await run('calendar_event_update', {
      id: 'ev-standup', start: '2026-08-04T14:00:00', end: '2026-08-04T14:30:00', title: 'Standup (moved)',
    });
    expect(out).toContain('Event updated');
    const query = JSON.parse(await run('calendar_query', { from: '2026-08-03', to: '2026-08-09' })) as {
      events: { id: string; start: string; title: string }[];
    };
    const ev = query.events.find((e) => e.id === 'ev-standup');
    expect(ev).toMatchObject({ start: '2026-08-04T14:00:00', title: 'Standup (moved)' });
  });

  it('handles recurring-occurrence ids verbatim', async () => {
    await run('calendar_event_update', {
      id: 'ev-gym#1770000000', start: '2026-08-05T19:00:00', end: '2026-08-05T20:00:00',
    });
    expect(state.calls.some((c) => c.method === 'updateEvent' && c.args[0] === 'ev-gym#1770000000')).toBe(true);
  });

  it('unknown id → not-found error text', async () => {
    const out = await run('calendar_event_update', {
      id: 'ev-nope', start: '2026-08-05T19:00:00', end: '2026-08-05T20:00:00',
    });
    expect(out).toMatch(/Error \(not-found\)/);
  });

  it('deletes an event so subsequent queries omit it', async () => {
    const out = await run('calendar_event_delete', { id: 'ev-standup' });
    expect(out).toContain('deleted');
    const query = JSON.parse(await run('calendar_query', { from: '2026-08-03', to: '2026-08-09' })) as {
      events: { id: string }[];
    };
    expect(query.events.some((e) => e.id === 'ev-standup')).toBe(false);
  });
});
