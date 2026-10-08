/**
 * Personal AI calendar tools — query and edit the user's external calendars
 * (EventKit: every macOS system-account calendar, incl. Google/iCloud).
 * Backed by the same CalendarService the plugin's REST routes use; every write
 * announces an update so the calendar view reflects agent edits live.
 *
 * The service arrives as a RESOLVER, not an instance: the plugin owns exactly one
 * service, and resolving per call is what lets a fixture swap the instance while the
 * server stays up (tests/web/routes/calendar-api.test.ts does that on every case).
 *
 * `patchConfig` is the host's `walnut.config.patch` (calendar_event_visibility writes through it).
 *
 * Date contract: tz-less LOCAL ISO — "2026-08-05T09:00:00" or "2026-08-05".
 */
import type { ToolDefinition } from '../../model/tools.js';
import { calendarErrorCode } from './api.js';
import type { CalendarConfigPatcher, CalendarService } from './service.js';

function json(data: unknown): string {
  return JSON.stringify(data, null, 2);
}

function errText(err: unknown): string {
  const code = calendarErrorCode(err);
  if (code) {
    const message = err instanceof Error ? err.message : String(err);
    if (code === 'permission-denied') {
      return `Error: ${message} The user must grant Calendar access in System Settings → Privacy & Security → Calendars.`;
    }
    return `Error (${code}): ${message}`;
  }
  return `Error: ${String(err).slice(0, 300)}`;
}

const LOCAL_ISO_RE = /^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2}):(\d{2}))?$/;
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

export function createCalendarTools(
  resolve: () => CalendarService,
  patchConfig: CalendarConfigPatcher,
): ToolDefinition[] {
  return [
    {
      name: 'calendar_query',
      description:
        "Query the user's calendars (all macOS system accounts: iCloud, Google, Exchange). Returns events in a date range, plus source status. Use list_calendars:true to enumerate the calendars themselves (for calendar_event_create targets). Dates are LOCAL tz-less ISO (YYYY-MM-DD). An event may carry status:'canceled' (the organizer cancelled it; macOS still holds the row) or selfStatus:'declined' — never present either one as a meeting the user is attending. Events the user hid in Walnut are left out; include_hidden:true returns them marked hidden:true.",
      input_schema: {
        type: 'object',
        properties: {
          from: { type: 'string', description: 'Range start day, YYYY-MM-DD (inclusive)' },
          to: { type: 'string', description: 'Range end day, YYYY-MM-DD (inclusive)' },
          calendar: { type: 'string', description: 'Optional calendar name filter (case-insensitive substring)' },
          list_calendars: { type: 'boolean', description: 'Also return the calendar list (id/title/account/readonly)' },
          include_hidden: {
            type: 'boolean',
            description: 'Also return events hidden with calendar_event_visibility, marked hidden:true',
          },
        },
        required: ['from', 'to'],
      },
      async execute(params) {
        const from = params.from as string;
        const to = params.to as string;
        if (!DAY_RE.test(from) || !DAY_RE.test(to) || from > to) {
          return 'Error: from/to must be YYYY-MM-DD with from <= to.';
        }
        if (params.include_hidden !== undefined && typeof params.include_hidden !== 'boolean') {
          return 'Error: include_hidden must be true or false.';
        }
        const service = resolve();
        try {
          let events = await service.getEvents(from, to, { includeHidden: params.include_hidden === true });
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
              ...(e.status ? { status: e.status } : {}),
              ...(e.selfStatus ? { selfStatus: e.selfStatus } : {}),
              ...(e.hidden ? { hidden: true } : {}),
              ...(e.walnutCreated !== undefined ? { walnutCreated: e.walnutCreated } : {}),
              ...(e.hasAttendees !== undefined ? { hasAttendees: e.hasAttendees } : {}),
              ...(e.organizerIsCurrentUser !== undefined ? { organizerIsCurrentUser: e.organizerIsCurrentUser } : {}),
              ...(e.organizerName ? { organizerName: e.organizerName } : {}),
              ...(e.recurring !== undefined ? { recurring: e.recurring } : {}),
              ...(e.writeSafetyVersion !== undefined ? { writeSafetyVersion: e.writeSafetyVersion } : {}),
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
          const event = await resolve().createEvent({
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
        'Move or rename a private block created by Walnut (id from calendar_query). Requires start AND end as tz-less local ISO. Invited events and events without Walnut ownership are blocked, including recurring meetings: changing them can notify the organizer or affect the whole series. Ask the person to use the calendar UI for a protected write; never bypass a refusal. To remove or skip a meeting in Walnut, use calendar_event_visibility with hidden:true instead.',
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
          const event = await resolve().updateEvent(params.id as string, {
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
        'Delete only a private block created by Walnut (id from calendar_query). Events without proven Walnut ownership and events with attendees or another organizer are blocked, including recurring meeting occurrences. A conversation approval does not unlock protected writes; the person must use the calendar UI and confirm on their Mac. For remove/skip this meeting, use calendar_event_visibility with hidden:true: it is local, reversible, and never notifies anyone. Never call the native helper or another calendar API to bypass a refusal.',
      input_schema: {
        type: 'object',
        properties: {
          id: { type: 'string', description: 'Event id from calendar_query' },
        },
        required: ['id'],
      },
      async execute(params) {
        try {
          await resolve().deleteEvent(params.id as string);
          return `Event ${params.id} deleted.`;
        } catch (err) {
          return errText(err);
        }
      },
    },
    {
      name: 'calendar_event_visibility',
      description:
        "Default for remove/skip this meeting: hide one calendar event from Walnut, or show it again (hidden:false). Walnut only: the event is NOT deleted or changed in the user's calendar (macOS, Google, Exchange keep it), it is just left out of Walnut's calendar views and calendar_query. Works on read-only events too. For a recurring event the id names ONE occurrence and only that occurrence is hidden. Take the id from calendar_query (hiding an event Walnut has not loaded asks you to query its date range first); to find hidden events again, use calendar_query with include_hidden:true.",
      input_schema: {
        type: 'object',
        properties: {
          id: { type: 'string', description: 'Event id from calendar_query (an occurrence id for a recurring event)' },
          hidden: { type: 'boolean', description: 'true hides the event in Walnut, false shows it again' },
        },
        required: ['id', 'hidden'],
      },
      async execute(params) {
        const id = params.id;
        if (typeof id !== 'string' || !id.trim()) return 'Error: id is required (an event id from calendar_query).';
        if (typeof params.hidden !== 'boolean') return 'Error: hidden must be true or false.';
        const hidden = params.hidden;
        try {
          const result = await resolve().setEventHidden(id, hidden, patchConfig);
          const verb = hidden ? 'hidden in Walnut' : 'shown in Walnut again';
          const note = result.changed ? '' : ` (it was already ${hidden ? 'hidden' : 'shown'})`;
          return `Event ${id} ${verb}${note}. The event itself was not changed.`;
        } catch (err) {
          return errText(err);
        }
      },
    },
  ];
}
