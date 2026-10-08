import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createMockConstants } from '../helpers/mock-constants.js';
vi.mock('../../src/constants.js', () => createMockConstants());
import { CalendarService } from '../../src/integrations/calendar/service.js';
import { calendarEventNeedsApproval, type CalendarEvent } from '../../src/integrations/calendar/types.js';
import { createCalendarTools } from '../../src/integrations/calendar/tools.js';
import { createMockCalendarSource } from '../helpers/mock-calendar-source.js';

const invited: CalendarEvent = {
  id: 'invited-series#1770000000', source: 'eventkit', calendarId: 'cal-work', calendarName: 'Work', accountName: 'Cloud Calendar',
  title: 'Team daily sync', start: '2026-08-05T11:00:00', end: '2026-08-05T12:00:00', allDay: false,
  walnutCreated: false, hasAttendees: true, organizerIsCurrentUser: false, organizerName: 'Meeting organizer', recurring: true, writeSafetyVersion: 1,
};
let mock: ReturnType<typeof createMockCalendarSource>;
let service: CalendarService;
beforeEach(() => { mock = createMockCalendarSource({ events: [{ ...invited }] }); service = new CalendarService(mock.source); });

describe('calendar write safety', () => {
  it('rejects deleting and moving an invited occurrence before the source writes', async () => {
    await expect(service.deleteEvent(invited.id)).rejects.toMatchObject({ code: 'human-approval-required' });
    await expect(service.updateEvent(invited.id, { start: '2026-08-05T13:00:00', end: '2026-08-05T14:00:00' })).rejects.toThrow(/Hide event/);
    expect(mock.state.calls.map((c) => c.method)).toEqual(['getEvent', 'getEvent']);
    expect(mock.state.events).toEqual([invited]);
    expect(service.status().available).toBe(true);
  });
  it('announces changes to invitation metadata even when title and times stay the same', async () => {
    const announce = vi.fn();
    const { setCalendarAnnouncer } = await import('../../src/integrations/calendar/service.js');
    await service.getEvents('2026-08-05', '2026-08-05');
    setCalendarAnnouncer(announce);
    try {
      Object.assign(mock.state.events[0], { organizerName: 'New organizer', hasAttendees: false });
      await service.refreshAll();
      expect(announce).toHaveBeenCalledTimes(1);
      expect((await service.getEvents('2026-08-05', '2026-08-05'))[0].organizerName).toBe('New organizer');
    } finally { setCalendarAnnouncer(null); }
  });
  it('does not treat lack of attendees, a title, or a caller flag as creation provenance', () => {
    expect(calendarEventNeedsApproval({ ...invited, title: 'Walnut block', hasAttendees: false, organizerIsCurrentUser: true })).toBe(true);
    expect(calendarEventNeedsApproval({ ...invited, walnutCreated: true, hasAttendees: true })).toBe(true);
    expect(calendarEventNeedsApproval({ ...invited, walnutCreated: true, hasAttendees: false, organizerIsCurrentUser: undefined, writeSafetyVersion: undefined })).toBe(true);
  });
  it('permits deleting a newly created private Walnut block', async () => {
    const block = await service.createEvent({ calendarId: 'cal-work', title: 'Own block', start: '2026-08-05T14:00:00', end: '2026-08-05T15:00:00' });
    expect(calendarEventNeedsApproval(block)).toBe(false);
    await service.deleteEvent(block.id);
    expect(mock.state.events.some((e) => e.id === block.id)).toBe(false);
    expect(mock.state.events).toEqual([invited]);
  });
  it('requires actual human confirmation rather than the request flag alone', async () => {
    await expect(service.deleteEvent(invited.id, { humanConfirm: true })).rejects.toMatchObject({ code: 'approval-canceled' });
    expect(mock.state.events).toEqual([invited]);
    expect(service.status().available).toBe(true);
    mock.state.humanConfirmation = true;
    await service.deleteEvent(invited.id, { humanConfirm: true });
    expect(mock.state.events).toEqual([]);
  });
  it('checks current metadata even after a cached private block becomes an invitation', async () => {
    const block = await service.createEvent({ calendarId: 'cal-work', title: 'Own block', start: '2026-08-05T14:00:00', end: '2026-08-05T15:00:00' });
    await service.getEvents('2026-08-05', '2026-08-05');
    Object.assign(mock.state.events.find((e) => e.id === block.id)!, { hasAttendees: true });
    await expect(service.deleteEvent(block.id)).rejects.toThrow(/Hide event/);
    expect(mock.state.calls.filter((c) => c.method === 'deleteEvent')).toHaveLength(0);
  });
  it('fails closed when source cannot prove metadata', async () => {
    delete mock.source.getEvent;
    await expect(service.deleteEvent(invited.id)).rejects.toMatchObject({ code: 'human-approval-required' });
    expect(mock.state.calls).toEqual([]);
  });
  it('agent tools reject an invited series deletion even with invented approval fields', async () => {
    const tools = createCalendarTools(() => service, vi.fn());
    const remove = tools.find((t) => t.name === 'calendar_event_delete')!;
    const out = await remove.execute({ id: invited.id, human_confirm: true, approved: true });
    expect(out).toContain('human-approval-required');
    expect(out).toContain('Hide event');
    expect(mock.state.calls.filter((c) => c.method === 'deleteEvent')).toHaveLength(0);
  });
});
