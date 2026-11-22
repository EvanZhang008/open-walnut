/**
 * A list that was asked before a write and answers after it never goes into the server's
 * calendar cache. 2026-11-21: right after a server restart (empty cache) the side panel's load
 * was still listing when a new event was created; the write-through skipped the uncached
 * window, the old list then filled the cache without the event, and the client's re-ask read
 * that "fresh" cache, so the event was gone from the grid.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createMockConstants } from '../helpers/mock-constants.js';
vi.mock('../../src/constants.js', () => createMockConstants());
import { CalendarService } from '../../src/integrations/calendar/service.js';
import type { CalendarEvent } from '../../src/integrations/calendar/types.js';
import { createMockCalendarSource } from '../helpers/mock-calendar-source.js';

const DAY = '2026-08-05';
let mock: ReturnType<typeof createMockCalendarSource>;
let service: CalendarService;
/** Lists in order; each takes its snapshot when it is asked and answers when released. */
let held: Array<() => void>;
let holdLists: boolean;

beforeEach(() => {
  mock = createMockCalendarSource({ events: [] });
  const list = mock.source.listEvents.bind(mock.source);
  holdLists = false;
  held = [];
  mock.source.listEvents = async (from, to, opts) => {
    const snapshot = await list(from, to, opts);
    if (holdLists) await new Promise<void>((release) => held.push(release));
    return snapshot;
  };
  service = new CalendarService(mock.source);
});

const titles = (events: CalendarEvent[]) => events.map((e) => e.title);
const create = (title: string) =>
  service.createEvent({ calendarId: 'cal-home', title, start: `${DAY}T10:15:00`, end: `${DAY}T11:00:00` });
const flush = () => new Promise((r) => setTimeout(r, 0));

describe('calendar cache across a write', () => {
  it('a load listing when an event is created does not cache the list without it', async () => {
    holdLists = true;
    const load = service.getEvents(DAY, DAY);
    await flush();
    expect(held).toHaveLength(1); // the load's list took its snapshot: no event yet
    holdLists = false;
    await create('Practice');
    held.shift()!(); // the old list answers after the create
    expect(titles(await load)).toEqual(['Practice']);
    // The client's re-ask reads the cache: it holds the event.
    expect(titles(await service.getEvents(DAY, DAY))).toEqual(['Practice']);
  });

  it('a refresh listing across a write keeps the write-through list', async () => {
    await service.getEvents(DAY, DAY);
    holdLists = true;
    const refresh = service.refreshAll();
    await flush();
    holdLists = false;
    await create('Practice');
    held.shift()!();
    await refresh;
    expect(titles(await service.getEvents(DAY, DAY))).toEqual(['Practice']);
  });

  it('of two write-throughs, the later one wins even when the earlier answers last', async () => {
    await service.getEvents(DAY, DAY);
    holdLists = true;
    const first = create('First');
    await flush();
    expect(held).toHaveLength(1); // the first write-through listed before the second write
    holdLists = false;
    await create('Second');
    held.shift()!();
    await first;
    expect(titles(await service.getEvents(DAY, DAY)).sort()).toEqual(['First', 'Second']);
  });

  it('a write-through cut short by a slow write that is then refused leaves no list from before it', async () => {
    await service.getEvents(DAY, DAY);
    await service.getEvents('2026-10-05', '2026-10-05'); // a second cached window
    // The second write waits (a meeting the Mac must confirm), then is refused.
    let refuse = () => {};
    const sourceCreate = mock.source.createEvent.bind(mock.source);
    mock.source.createEvent = async (input) => {
      if (input.title !== 'Refused') return sourceCreate(input);
      await new Promise<void>((_, reject) => { refuse = () => reject(new Error('Calendar confirmation canceled.')); });
      throw new Error('unreachable');
    };
    holdLists = true;
    const first = create('Practice');
    await flush();
    holdLists = false;
    const second = service.createEvent({ calendarId: 'cal-home', title: 'Refused', start: `${DAY}T12:00:00`, end: `${DAY}T13:00:00` });
    await flush();
    held.shift()!();
    await first;
    expect(titles(await service.getEvents(DAY, DAY))).toEqual(['Practice']);
    refuse();
    await expect(second).rejects.toThrow(/canceled/);
    expect(titles(await service.getEvents(DAY, DAY))).toEqual(['Practice']);
  });
});
