/**
 * The calendar rules the server and the browser must agree on, in ONE browser-safe module
 * (no Node imports): which events a write needs the person's yes for, and which source an
 * event or calendar id belongs to. web/src/api/calendar.ts re-exports both, so the web UI
 * asks first exactly when the server would refuse an unconfirmed write.
 *
 * Id shapes, per source:
 * - EventKit (the Mac's calendars): the ids macOS gives, unchanged, so existing clients and
 *   stored ids (hidden events, the default calendar) keep working byte for byte.
 * - A mail account's calendar (CalDAV): `caldav:<mail account id>/<rest>`, where `<rest>` is
 *   the server's resource or collection path in base64url (no `/` and no `#` in it), and an
 *   occurrence of a recurring event adds `#<epoch seconds of its original start>` as EventKit's do.
 *   An EventKit id is a UUID-style string and never starts with `caldav:`.
 */

/** The fields the write-safety rule reads. Every source fills them the same way. */
export interface CalendarWriteSafetyFields {
  writeSafetyVersion?: number;
  walnutCreated?: boolean;
  hasAttendees?: boolean;
  organizerIsCurrentUser?: boolean;
}

/**
 * An event a write may change without the person's yes: one Walnut made, with no attendees,
 * whose organizer (when the source names one) is the user, from a source that reported all
 * of this (`writeSafetyVersion: 1`). Anything unknown counts as unsafe.
 */
export function calendarEventNeedsApproval(event: CalendarWriteSafetyFields): boolean {
  return event.writeSafetyVersion !== 1 || event.walnutCreated !== true || event.hasAttendees !== false ||
    (event.organizerIsCurrentUser !== undefined && event.organizerIsCurrentUser !== true);
}

export const CALDAV_SOURCE_PREFIX = 'caldav:';

/**
 * Why a mail account's event with attendees is read-only in Walnut, whatever anyone confirms:
 * a change or delete there goes out to the other people as an invitation update from the
 * user's own server (RFC 6638), and Walnut has no second, server-side yes for that yet.
 */
export const ATTENDEES_READONLY_TEXT = 'This event has other people on it; change it in its own calendar app.';

/** Whether an event is a mail account's (CalDAV) event with other people on it. */
export function isSharedMailCalendarEvent(event: { source?: string; hasAttendees?: boolean }): boolean {
  return typeof event.source === 'string' && event.source.startsWith(CALDAV_SOURCE_PREFIX) && event.hasAttendees !== false;
}

/** The source id of a mail account's calendar, e.g. `caldav:imap:1a2b3c4d5e6f`. */
export function caldavSourceIdFor(mailAccountId: string): string {
  return `${CALDAV_SOURCE_PREFIX}${mailAccountId}`;
}

/** Which source an event or calendar id belongs to: `eventkit`, or the CalDAV source id. */
export function calendarSourceOf(id: string): string {
  if (!id.startsWith(CALDAV_SOURCE_PREFIX)) return 'eventkit';
  const slash = id.indexOf('/');
  return slash < 0 ? id : id.slice(0, slash);
}
