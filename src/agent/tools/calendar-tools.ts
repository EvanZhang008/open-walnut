/**
 * Butler calendar tools — query and edit the user's external calendars
 * (EventKit: every macOS system-account calendar, incl. Google/iCloud).
 * Backed by the same CalendarService the web UI uses; every write emits
 * calendar:updated so the calendar view reflects agent edits live.
 *
 * Date contract: tz-less LOCAL ISO — "2026-08-05T09:00:00" or "2026-08-05".
 */
import type { ToolDefinition } from '../tools.js';
import { getCalendarService, CalendarHelperError } from '../../core/calendar/index.js';

function json(data: unknown): string {
  return JSON.stringify(data, null, 2);
}

function errText(err: unknown): string {
  if (err instanceof CalendarHelperError) {
    if (err.code === 'permission-denied') {
      return `Error: ${err.message} The user must grant Calendar access in System Settings → Privacy & Security → Calendars.`;
    }
    return `Error (${err.code}): ${err.message}`;
  }
  return `Error: ${String(err).slice(0, 300)}`;
}

const LOCAL_ISO_RE = /^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2}):(\d{2}))?$/;
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

export const calendarTools: ToolDefinition[] = [
  {
    name: 'calendar_query',
    description:
      "Query the user's calendars (all macOS system accounts: iCloud, Google, Exchange). Returns events in a date range, plus source status. Use list_calendars:true to enumerate the calendars themselves (for calendar_event_create targets). Dates are LOCAL tz-less ISO (YYYY-MM-DD).",
    input_schema: {
      type: 'object',
      properties: {
        from: { type: 'string', description: 'Range start day, YYYY-MM-DD (inclusive)' },
        to: { type: 'string', description: 'Range end day, YYYY-MM-DD (inclusive)' },
        calendar: { type: 'string', description: 'Optional calendar name filter (case-insensitive substring)' },
        list_calendars: { type: 'boolean', description: 'Also return the calendar list (id/title/account/readonly)' },
      },
      required: ['from', 'to'],
    },
    async execute(params) {
      const from = params.from as string;
      const to = params.to as string;
      if (!DAY_RE.test(from) || !DAY_RE.test(to) || from > to) {
        return 'Error: from/to must be YYYY-MM-DD with from <= to.';
      }
      const service = getCalendarService();
      try {
        let events = await service.getEvents(from, to);
        const filter = (params.calendar as string | undefined)?.toLowerCase();
        if (filter) events = events.filter((e) => e.calendarName.toLowerCase().includes(filter));
        const result: Record<string, unknown> = {
          status: service.status(),
          events: events.map((e) => ({
            id: e.id,
            title: e.title,
            start: e.start,
            end: e.end,
            allDay: e.allDay,
            calendar: e.calendarName,
            account: e.accountName,
            ...(e.location ? { location: e.location } : {}),
            ...(e.readonly ? { readonly: true } : {}),
          })),
        };
        if (params.list_calendars) result.calendars = await service.listCalendars();
        return json(result);
      } catch (err) {
        return errText(err);
      }
    },
  },
  {
    name: 'calendar_event_create',
    description:
      'Create an event on one of the user\'s calendars. calendar_id comes from calendar_query with list_calendars:true (pick a writable one). Times are LOCAL tz-less ISO; all-day events use YYYY-MM-DD for start/end (end inclusive).',
    input_schema: {
      type: 'object',
      properties: {
        calendar_id: { type: 'string', description: 'Target calendar id (writable)' },
        title: { type: 'string' },
        start: { type: 'string', description: 'YYYY-MM-DDTHH:MM:SS, or YYYY-MM-DD for all-day' },
        end: { type: 'string', description: 'Same format as start. Defaults to start + 1h (or same day for all-day).' },
        all_day: { type: 'boolean' },
      },
      required: ['calendar_id', 'title', 'start'],
    },
    async execute(params) {
      const start = params.start as string;
      if (!LOCAL_ISO_RE.test(start)) return 'Error: start must be tz-less local ISO.';
      let end = (params.end as string | undefined) ?? '';
      if (!end) {
        if (start.includes('T')) {
          const [day, time] = start.split('T');
          const [h, m] = time.split(':').map(Number);
          end = `${day}T${String(Math.min(h + 1, 23)).padStart(2, '0')}:${String(m).padStart(2, '0')}:00`;
        } else {
          end = start;
        }
      }
      if (!LOCAL_ISO_RE.test(end)) return 'Error: end must be tz-less local ISO.';
      try {
        const event = await getCalendarService().createEvent({
          calendarId: params.calendar_id as string,
          title: params.title as string,
          start,
          end,
          allDay: (params.all_day as boolean | undefined) ?? !start.includes('T'),
        });
        return `Event created: ${json(event)}`;
      } catch (err) {
        return errText(err);
      }
    },
  },
  {
    name: 'calendar_event_update',
    description:
      'Move/retime/rename an existing calendar event (id from calendar_query). Recurring events: only that occurrence is changed. Requires start AND end (both tz-less local ISO).',
    input_schema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Event id from calendar_query' },
        start: { type: 'string' },
        end: { type: 'string' },
        title: { type: 'string', description: 'Optional new title' },
      },
      required: ['id', 'start', 'end'],
    },
    async execute(params) {
      const start = params.start as string;
      const end = params.end as string;
      if (!LOCAL_ISO_RE.test(start) || !LOCAL_ISO_RE.test(end)) {
        return 'Error: start/end must be tz-less local ISO.';
      }
      try {
        const event = await getCalendarService().updateEvent(params.id as string, {
          start,
          end,
          ...(params.title ? { title: params.title as string } : {}),
        });
        return `Event updated: ${json(event)}`;
      } catch (err) {
        return errText(err);
      }
    },
  },
  {
    name: 'calendar_event_delete',
    description:
      'Delete a calendar event (id from calendar_query). Recurring events: deletes only that occurrence. Confirm with the user before deleting anything you did not just create.',
    input_schema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Event id from calendar_query' },
      },
      required: ['id'],
    },
    async execute(params) {
      try {
        await getCalendarService().deleteEvent(params.id as string);
        return `Event ${params.id} deleted.`;
      } catch (err) {
        return errText(err);
      }
    },
  },
];
