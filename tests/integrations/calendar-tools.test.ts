/**
 * Personal AI calendar_* tool tests — mock CalendarSource behind a real
 * CalendarService (cache + write-through logic exercised for real).
 */
import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest';
import { createMockConstants } from '../helpers/mock-constants.js';

vi.mock('../../src/constants.js', () => createMockConstants());

import {
  CalendarService,
  getCalendarService,
  _setCalendarServiceForTest,
} from '../../src/integrations/calendar/service.js';
import { CalendarHelperError } from '../../src/core/calendar/sources/eventkit.js';
import { getConfig, updatePluginConfig } from '../../src/core/config-manager.js';
import {
  createMockCalendarSource,
  fixtureEvents,
  type MockCalendarState,
} from '../helpers/mock-calendar-source.js';
import { createCalendarTools } from '../../src/integrations/calendar/tools.js';
import type { CalendarEvent } from '../../src/integrations/calendar/types.js';
import type { ToolDefinition } from '../../src/model/tools.js';

// The real config writer over this file's isolated home, standing in for the host's
// `walnut.config.patch` (which wraps the same function).
const patchCalendarConfig = async (patch: Record<string, unknown>): Promise<void> => {
  await updatePluginConfig('calendar', patch);
};

// The tools resolve the plugin's service per call, so one array built here sees whichever
// instance beforeEach installed.
const calendarTools = createCalendarTools(getCalendarService, patchCalendarConfig);

let state: MockCalendarState;

async function hiddenEventIds(): Promise<unknown> {
  const config = (await getConfig()) as { plugins?: Record<string, Record<string, unknown>> };
  return config.plugins?.calendar?.hidden_event_ids;
}

type QueryEvent = { id: string; hidden?: boolean; readonly?: boolean };

async function queryIds(params: Record<string, unknown> = {}): Promise<QueryEvent[]> {
  const out = await run('calendar_query', { from: '2026-08-01', to: '2026-08-31', ...params });
  return (JSON.parse(out) as { events: QueryEvent[] }).events;
}

function sourceWrites(): string[] {
  return state.calls
    .map((c) => c.method)
    .filter((m) => m === 'updateEvent' || m === 'deleteEvent' || m === 'createEvent');
}

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

function installService(events = fixtureEvents()): CalendarService {
  const mock = createMockCalendarSource({ events });
  state = mock.state;
  const service = new CalendarService(mock.source);
  _setCalendarServiceForTest(service);
  return service;
}

beforeEach(async () => {
  // The config file outlives a service instance, so every case starts with nothing hidden.
  await patchCalendarConfig({ hidden_event_ids: [] });
  installService();
});

afterAll(() => {
  _setCalendarServiceForTest(null);
});

describe('calendar tool registration', () => {
  it('exports the five calendar tools with schemas', () => {
    const names = calendarTools.map((t) => t.name);
    expect(names).toEqual([
      'calendar_query',
      'calendar_event_create',
      'calendar_event_update',
      'calendar_event_delete',
      'calendar_event_visibility',
    ]);
    for (const t of calendarTools) {
      expect(t.description.length).toBeGreaterThan(20);
      expect((t.input_schema as { type: string }).type).toBe('object');
    }
  });
});

describe('calendar_query', () => {
  it('returns range-filtered events with status', async () => {
    const out = await run('calendar_query', { from: '2026-08-03', to: '2026-08-09' });
    const parsed = JSON.parse(out) as {
      status: { available: boolean };
      events: { id: string; calendar: string; status?: string; selfStatus?: string }[];
    };
    expect(parsed.status.available).toBe(true);
    expect(parsed.events.map((e) => e.id).sort()).toEqual([
      'ev-canceled', 'ev-declined', 'ev-gym#1770000000', 'ev-holiday', 'ev-standup',
    ]);
    // The agent must be able to see that one of these is off — otherwise it
    // reports a cancelled meeting as something the user is attending.
    expect(parsed.events.find((e) => e.id === 'ev-canceled')?.status).toBe('canceled');
    expect(parsed.events.find((e) => e.id === 'ev-declined')?.selfStatus).toBe('declined');
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
    // Unlike the REST read (which degrades to []), the tool tells the Personal AI
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

describe('calendar_event_visibility', () => {
  const hide = (id: unknown, hidden: unknown = true) => run('calendar_event_visibility', { id, hidden });

  function secondGymOccurrence(): CalendarEvent {
    const gym = fixtureEvents().find((e) => e.id === 'ev-gym#1770000000')!;
    return { ...gym, id: 'ev-gym#1770604800', start: '2026-08-12T18:00:00', end: '2026-08-12T19:00:00' };
  }

  it('hides a read-only event in Walnut only, and include_hidden returns it marked', async () => {
    await queryIds();
    expect(await hide('ev-holiday')).toContain('hidden in Walnut');

    expect((await queryIds()).some((e) => e.id === 'ev-holiday')).toBe(false);
    const withHidden = await queryIds({ include_hidden: true });
    expect(withHidden.find((e) => e.id === 'ev-holiday')).toMatchObject({ hidden: true, readonly: true });
    expect(withHidden.filter((e) => e.hidden).map((e) => e.id)).toEqual(['ev-holiday']);
    expect(await hiddenEventIds()).toEqual(['ev-holiday']);
    // Walnut-only: the source was never asked to change anything and still holds the event.
    expect(sourceWrites()).toEqual([]);
    expect(state.events.some((e) => e.id === 'ev-holiday')).toBe(true);
  });

  it('hides exactly one occurrence of a recurring event', async () => {
    installService([...fixtureEvents(), secondGymOccurrence()]);
    await queryIds();
    await hide('ev-gym#1770000000');
    const ids = (await queryIds()).map((e) => e.id);
    expect(ids).not.toContain('ev-gym#1770000000');
    expect(ids).toContain('ev-gym#1770604800');
  });

  it('is idempotent in both directions', async () => {
    await queryIds();
    await hide('ev-standup');
    expect(await hide('ev-standup')).toContain('already hidden');
    expect(await hiddenEventIds()).toEqual(['ev-standup']);
    expect(await hide('ev-standup', false)).toContain('shown in Walnut again');
    expect(await hide('ev-standup', false)).toContain('already shown');
    expect(await hiddenEventIds()).toEqual([]);
  });

  it('keeps both ids when two hides race', async () => {
    await queryIds();
    const outs = await Promise.all([hide('ev-standup'), hide('ev-holiday')]);
    for (const out of outs) expect(out).toContain('hidden in Walnut');
    expect(((await hiddenEventIds()) as string[]).slice().sort()).toEqual(['ev-holiday', 'ev-standup']);
  });

  it('applies an interleaved hide/show sequence in call order', async () => {
    await queryIds();
    await Promise.all([
      hide('ev-standup'),
      hide('ev-standup', false),
      hide('ev-holiday'),
      hide('ev-standup'),
      hide('ev-standup', false),
    ]);
    expect(await hiddenEventIds()).toEqual(['ev-holiday']);
    const ids = (await queryIds()).map((e) => e.id);
    expect(ids).toContain('ev-standup');
    expect(ids).not.toContain('ev-holiday');
  });

  it('stays hidden across a refresh and a new service instance', async () => {
    await queryIds();
    await hide('ev-standup');
    await getCalendarService().refreshAll();
    expect((await queryIds()).some((e) => e.id === 'ev-standup')).toBe(false);
    expect(sourceWrites()).toEqual([]);

    // A service built outside activate reads config only on init/reloadConfig.
    const fresh = installService();
    await fresh.reloadConfig();
    expect((await queryIds()).some((e) => e.id === 'ev-standup')).toBe(false);
    expect((await queryIds({ include_hidden: true })).find((e) => e.id === 'ev-standup')?.hidden).toBe(true);
  });

  it('rejects a missing or empty id and a non-boolean flag without touching config or source', async () => {
    const bad: Record<string, unknown>[] = [
      { hidden: true },
      { id: '', hidden: true },
      { id: '   ', hidden: true },
      { id: 'ev-standup' },
      { id: 'ev-standup', hidden: 'true' },
    ];
    for (const params of bad) {
      expect(await run('calendar_event_visibility', params)).toMatch(/^Error:/);
    }
    expect(await run('calendar_query', { from: '2026-08-01', to: '2026-08-31', include_hidden: 'yes' })).toMatch(/^Error:/);
    expect(await hiddenEventIds()).toEqual([]);
    expect(state.calls).toHaveLength(0);
  });

  it('proves an uncached id with one exact source read, and reports a missing one as not-found', async () => {
    expect(await hide('ev-standup')).toContain('hidden in Walnut');
    expect(await hide('ev-gym#1770000000')).toContain('hidden in Walnut');
    expect(await hide('ev-nope')).toMatch(/Error \(not-found\)/);
    expect(await hide('ev-nope#1770000000')).toMatch(/Error \(not-found\)/);
    // Exact reads only: no window was listed to find any of them.
    expect(state.calls.map((c) => [c.method, c.args[0]])).toEqual([
      ['getEvent', 'ev-standup'],
      ['getEvent', 'ev-gym#1770000000'],
      ['getEvent', 'ev-nope'],
      ['getEvent', 'ev-nope#1770000000'],
    ]);
    expect(await hiddenEventIds()).toEqual(['ev-standup', 'ev-gym#1770000000']);
  });

  describe('over a source with no read-by-id', () => {
    beforeEach(() => {
      const mock = createMockCalendarSource();
      delete (mock.source as { getEvent?: unknown }).getEvent;
      state = mock.state;
      _setCalendarServiceForTest(new CalendarService(mock.source));
    });

    it('asks for a query first when a one-off id was never loaded, without scanning for it', async () => {
      const out = await hide('ev-standup');
      expect(out).toMatch(/Error \(usage\)/);
      expect(out).toContain('calendar_query');
      expect(state.calls).toHaveLength(0);
      expect(await hiddenEventIds()).toEqual([]);
    });

    it('reads only the month an uncached occurrence id names, and reports a missing one as not-found', async () => {
      expect(await hide('ev-gym#1770000000')).toContain('hidden in Walnut');
      const windows = state.calls.filter((c) => c.method === 'listEvents').map((c) => c.args.slice(0, 2));
      expect(windows).toEqual([['2026-02-01', '2026-02-28']]);

      expect(await hide('ev-nope#1770000000')).toMatch(/Error \(not-found\)/);
      expect(await hiddenEventIds()).toEqual(['ev-gym#1770000000']);
    });
  });

  it('shows any persisted id again, even one the source no longer holds', async () => {
    await patchCalendarConfig({ hidden_event_ids: ['ev-gone'] });
    await getCalendarService().reloadConfig();
    expect(await hide('ev-gone', false)).toContain('shown in Walnut again');
    expect(await hiddenEventIds()).toEqual([]);
    expect(state.calls).toHaveLength(0);
  });

  it('a failed config write does not wedge the next hide', async () => {
    const service = getCalendarService();
    await queryIds();
    let failNext = true;
    const flaky = async (patch: Record<string, unknown>): Promise<void> => {
      if (failNext) {
        failNext = false;
        throw new Error('disk full');
      }
      await patchCalendarConfig(patch);
    };
    await expect(service.setEventHidden('ev-standup', true, flaky)).rejects.toThrow('disk full');
    await expect(service.setEventHidden('ev-standup', true, flaky)).resolves.toMatchObject({ changed: true });
    expect(await hiddenEventIds()).toEqual(['ev-standup']);
  });
});
