/**
 * The default calendar: where a create with no calendar id goes.
 *
 * Why it exists: `calendar_event_create` required a calendar id, so every agent had to pick
 * one, and after a context reset an agent picked the calendar it had seen most in its own
 * reads, which on a Mac with a work account is the work calendar. Now a create with no id
 * goes to `plugins.calendar.default_calendar_id`, and a configured id that is gone or
 * read-only is refused with a warning rather than replaced by a guess.
 *
 * Real CalendarService + real config writer over an isolated home; only the EventKit
 * source is a mock (tests/helpers/mock-calendar-source.ts).
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { createMockConstants } from '../helpers/mock-constants.js';

vi.mock('../../src/constants.js', () => createMockConstants());

import {
  CalendarService,
  getCalendarService,
  mergeCalendarConfig,
  _setCalendarServiceForTest,
} from '../../src/integrations/calendar/service.js';
import { CalendarHelperError } from '../../src/core/calendar/sources/eventkit.js';
import { getConfig, updatePluginConfig } from '../../src/core/config-manager.js';
import { createMockCalendarSource, fixtureCalendars, type MockCalendarState } from '../helpers/mock-calendar-source.js';
import { createCalendarTools } from '../../src/integrations/calendar/tools.js';
import type { CalendarInfo, CalendarEventPatch } from '../../src/integrations/calendar/types.js';

/** Placeholder ids only: real calendar ids never go into this public repo. */
const PERSONAL = 'cal-home';
const WORK = 'cal-work';
const READ_ONLY = 'cal-holidays';

const tools = createCalendarTools(getCalendarService, (patch) => updatePluginConfig('calendar', patch));
const tool = (name: string) => tools.find((t) => t.name === name)!;
const run = async (name: string, params: Record<string, unknown>) => (await tool(name).execute(params)) as string;

let state: MockCalendarState;
let service: CalendarService;

async function install(defaultId: string, calendars?: CalendarInfo[]): Promise<void> {
  await updatePluginConfig('calendar', { default_calendar_id: defaultId, hidden_calendar_ids: [] });
  const mock = createMockCalendarSource(calendars ? { calendars } : undefined);
  state = mock.state;
  service = new CalendarService(mock.source);
  _setCalendarServiceForTest(service);
  await service.reloadConfig();
}

const creates = () => state.calls.filter((c) => c.method === 'createEvent').map((c) => c.args[0] as { calendarId: string });

beforeEach(async () => {
  await install('');
});

describe('mergeCalendarConfig: default_calendar_id', () => {
  it('takes the plugin value, falls back to the legacy section, and lets a cleared plugin value win', () => {
    expect(mergeCalendarConfig({ default_calendar_id: 'a' }, { default_calendar_id: 'b' }).default_calendar_id).toBe('a');
    expect(mergeCalendarConfig({}, { default_calendar_id: 'b' }).default_calendar_id).toBe('b');
    // Settings clears it by writing '' (present), which must not resurrect the legacy id.
    expect(mergeCalendarConfig({ default_calendar_id: '' }, { default_calendar_id: 'b' }).default_calendar_id).toBe('');
    expect(mergeCalendarConfig({ default_calendar_id: null }, { default_calendar_id: 'b' }).default_calendar_id).toBeNull();
    expect(mergeCalendarConfig(undefined, undefined).default_calendar_id).toBeUndefined();
  });
});

describe('describeDefault', () => {
  it('resolves a writable configured calendar, hidden ones included', async () => {
    await install(PERSONAL);
    expect(service.describeDefault(fixtureCalendars())).toEqual({
      id: PERSONAL, configuredId: PERSONAL, title: 'Home', account: 'iCloud',
    });
    const hidden = fixtureCalendars().map((c) => (c.id === PERSONAL ? { ...c, hidden: true } : c));
    expect(service.describeDefault(hidden).id).toBe(PERSONAL);
  });

  it('never substitutes another calendar for one that is gone or read-only', async () => {
    await install('cal-removed');
    const gone = service.describeDefault(fixtureCalendars());
    expect(gone).toMatchObject({ id: null, configuredId: 'cal-removed' });
    expect(gone.warning).toMatch(/not on this Mac any more.*Settings → Calendar Accounts/);

    await install(READ_ONLY);
    const ro = service.describeDefault(fixtureCalendars());
    expect(ro).toMatchObject({ id: null, configuredId: READ_ONLY, title: 'Holidays' });
    expect(ro.warning).toContain('read-only');
  });

  it('reports nothing set as no default and no warning; blanks and whitespace count as unset', async () => {
    expect(service.describeDefault(fixtureCalendars())).toEqual({ id: null, configuredId: null });
    await install('   ');
    expect(service.configuredDefaultId()).toBeNull();
  });

  it('marks only a usable default in listCalendars', async () => {
    await install(PERSONAL);
    const cals = await service.listCalendars();
    expect(cals.filter((c) => c.default).map((c) => c.id)).toEqual([PERSONAL]);
    await install(READ_ONLY);
    expect((await service.listCalendars()).some((c) => c.default)).toBe(false);
  });
});

describe('createEvent without a calendar id', () => {
  const block = { title: 'Focus', start: '2026-08-06T09:00:00', end: '2026-08-06T10:00:00' };

  it('goes to the default calendar; an explicit id still wins', async () => {
    await install(PERSONAL);
    const ev = await service.createEvent(block);
    expect(ev.calendarId).toBe(PERSONAL);
    await service.createEvent({ ...block, calendarId: WORK });
    // Blank counts as "not given", not as a calendar called "".
    await service.createEvent({ ...block, calendarId: '  ' });
    expect(creates().map((c) => c.calendarId)).toEqual([PERSONAL, WORK, PERSONAL]);
  });

  it('is refused, with nothing written, when no default is set', async () => {
    await expect(service.createEvent(block)).rejects.toMatchObject({ code: 'usage', message: /No default calendar is set/ });
    expect(creates()).toEqual([]);
  });

  it('is refused with the warning when the configured default is unusable', async () => {
    await install(READ_ONLY);
    await expect(service.createEvent(block)).rejects.toMatchObject({ code: 'usage', message: /read-only.*pass a calendar id/ });
    await install('cal-removed');
    await expect(service.createEvent(block)).rejects.toMatchObject({ code: 'usage', message: /not on this Mac/ });
    expect(creates()).toEqual([]);
  });

  it('follows a config change after reloadConfig, without a new service', async () => {
    await install(PERSONAL);
    await updatePluginConfig('calendar', { default_calendar_id: WORK });
    await service.reloadConfig();
    expect((await service.createEvent(block)).calendarId).toBe(WORK);
  });

  it('reads a legacy top-level calendar.default_calendar_id when the plugin section has none', async () => {
    const mock = createMockCalendarSource();
    state = mock.state;
    service = new CalendarService(mock.source);
    _setCalendarServiceForTest(service);
    const { saveConfig } = await import('../../src/core/config-manager.js');
    const config = (await getConfig()) as Record<string, unknown> & { plugins?: Record<string, Record<string, unknown>> };
    const plugins = { ...(config.plugins ?? {}) };
    const calendar = { ...(plugins.calendar ?? {}) };
    delete calendar.default_calendar_id;
    await saveConfig({ ...config, plugins: { ...plugins, calendar }, calendar: { default_calendar_id: PERSONAL } } as never);
    await service.reloadConfig();
    expect(service.configuredDefaultId()).toBe(PERSONAL);
    await saveConfig({ ...config, plugins: { ...plugins, calendar } } as never);
  });
});

describe('updates stay on their own calendar', () => {
  it('passes only start/end/title to the source, whatever else a caller adds', async () => {
    await install(PERSONAL);
    const patch = { start: '2026-08-04T14:00:00', end: '2026-08-04T14:30:00', calendarId: PERSONAL } as CalendarEventPatch;
    const ev = await service.updateEvent('ev-standup', patch);
    expect(ev.calendarId).toBe(WORK);
    const sent = state.calls.find((c) => c.method === 'updateEvent')!.args[1];
    expect(sent).toEqual({ start: patch.start, end: patch.end });
  });
});

describe('a write refused for want of a grant does not take reads down', () => {
  it('keeps the source available after a permission-denied create', async () => {
    await install(PERSONAL);
    await service.getEvents('2026-08-01', '2026-08-31');
    const realCreate = state.failWith;
    state.failWith = new CalendarHelperError('macOS has not been asked to allow the walnut-calendar helper.', 'permission-denied');
    // An explicit id, so the refusal comes from the write itself and not from a calendar list read.
    await expect(service.createEvent({ calendarId: PERSONAL, title: 'X', start: '2026-08-06T09:00:00', end: '2026-08-06T10:00:00' }))
      .rejects.toMatchObject({ code: 'permission-denied' });
    state.failWith = realCreate;
    expect(service.status()).toMatchObject({ available: true, enabled: true });
    expect(service.status().reason).toBeUndefined();
  });
});

describe('calendar tools', () => {
  it('calendar_event_create does not require calendar_id and tells agents to leave it out', () => {
    const create = tool('calendar_event_create');
    expect((create.input_schema as { required: string[] }).required).toEqual(['title', 'start']);
    expect(create.description).toMatch(/Leave calendar_id out/);
    expect(create.description).toMatch(/never pick a work or Exchange calendar unless the user explicitly asks/);
  });

  it('creates on the default calendar when calendar_id is omitted', async () => {
    await install(PERSONAL);
    const out = await run('calendar_event_create', { title: 'Focus block', start: '2026-08-06T09:00:00' });
    expect(out).toContain('Event created');
    expect(creates()).toEqual([expect.objectContaining({ calendarId: PERSONAL, end: '2026-08-06T10:00:00' })]);
    // An explicit id is honoured, and a null one is the same as leaving it out.
    await run('calendar_event_create', { calendar_id: WORK, title: 'Named', start: '2026-08-06T11:00:00' });
    await run('calendar_event_create', { calendar_id: null, title: 'Null', start: '2026-08-06T12:00:00' });
    expect(creates().map((c) => c.calendarId)).toEqual([PERSONAL, WORK, PERSONAL]);
  });

  it('says what to do, and writes nothing, when there is no usable default', async () => {
    const out = await run('calendar_event_create', { title: 'Focus block', start: '2026-08-06T09:00:00' });
    expect(out).toMatch(/^Error \(usage\): No default calendar is set/);
    const bad = await run('calendar_event_create', { calendar_id: 42, title: 'X', start: '2026-08-06T09:00:00' });
    expect(bad).toMatch(/^Error: calendar_id must be/);
    const untitled = await run('calendar_event_create', { title: '  ', start: '2026-08-06T09:00:00' });
    expect(untitled).toMatch(/^Error: title is required/);
    expect(creates()).toEqual([]);
  });

  it('calendar_query list_calendars marks the default and names it', async () => {
    await install(PERSONAL);
    const out = JSON.parse(await run('calendar_query', { from: '2026-08-01', to: '2026-08-31', list_calendars: true })) as {
      calendars: CalendarInfo[]; defaultCalendar: { id: string; title: string };
    };
    expect(out.calendars.find((c) => c.default)?.id).toBe(PERSONAL);
    expect(out.defaultCalendar).toMatchObject({ id: PERSONAL, title: 'Home' });
  });

  it('keeps a write refusal that names its fix as it is', async () => {
    await install(PERSONAL);
    state.failWith = new CalendarHelperError(
      'Walnut cannot change your calendars yet. Nothing was changed. Press Request access in Settings → macOS Access → Calendar, then try again.',
      'permission-denied',
    );
    const out = await run('calendar_event_create', { calendar_id: PERSONAL, title: 'Focus', start: '2026-08-06T09:00:00' });
    expect(out).toContain('Request access');
    expect(out).not.toContain('Privacy & Security');
  });
});
