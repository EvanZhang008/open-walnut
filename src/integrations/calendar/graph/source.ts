/**
 * A mail account's Outlook or Microsoft 365 calendar as a calendar source, read and written
 * through Microsoft Graph with the account's Microsoft sign-in (Microsoft has no CalDAV).
 *
 * Every request goes through the calendar's one HTTP client (caldav/dav.ts `davRequest`): its
 * deadline, its answer size cap, and the sign-in's rule that the token goes only to Graph's own
 * host, a 401 renewing it once. A next page (`@odata.nextLink`) on another host is not followed.
 *
 * Ids: a calendar is `caldav:<account>/<calendar id in base64url>` and an event
 * `caldav:<account>/<calendar id>.<event id>`, both base64url, so an event names the calendar it
 * is in and every id names its source (event-rules.ts). An occurrence of a series has its own id
 * in Graph, so no `#<start>` suffix is needed.
 *
 * Writes carry the ETag of the copy Walnut just read (`If-Match`): an event someone changed in
 * between is not overwritten (412, refused as a conflict). What a write may change is checked on
 * that same copy: not on a read-only calendar, not an event with attendees (Graph would send them
 * an update), whatever anyone confirms.
 */
import { CalendarHelperError } from '../../../core/calendar/helper-error.js';
import { ATTENDEES_READONLY_TEXT, caldavSourceIdFor } from '../event-rules.js';
import type { CalendarEvent, CalendarEventCreate, CalendarEventPatch, CalendarInfo, CalendarSource, CalendarSourceStatus } from '../types.js';
import { davRequest, type DavAnswer, type DavBearer, type FetchLike } from '../caldav/dav.js';
import { MAX_READ_DAYS } from '../caldav/source.js';
import { addDays, localZone as systemZone, parseLocalIso, wallToEpoch } from '../caldav/tz.js';
import { EVENT_EXPAND, EVENT_SELECT, WALNUT_CREATED_PROPERTY, graphTimes, toCalendarEvent, type GraphCalendarInfo, type GraphEvent } from './events.js';

const CALENDAR_LIST_TTL_MS = 5 * 60_000;
const PAGE_SIZE = 250;
/** At most this many pages per calendar per read (25,000 occurrences is far past any real window). */
const MAX_PAGES = 100;
const DEFAULT_COLOR = '#0f6cbd';
/** Times in UTC; ids that stay the same when an event moves to another folder or calendar. */
const PREFER = 'outlook.timezone="UTC", IdType="ImmutableId"';

export interface GraphSourceOptions {
  accountId: string;
  /** The account's sign-in, its address and Graph's base URL; undefined when it is gone. */
  signIn: () => Promise<{ bearer: DavBearer; address: string; base: string } | undefined>;
  localZone?: () => string;
  fetch?: FetchLike;
}

const b64 = (value: string) => Buffer.from(value, 'utf8').toString('base64url');
const unb64 = (value: string) => Buffer.from(value, 'base64url').toString('utf8');

interface Session { bearer: DavBearer; address: string; base: string }

export function createGraphSource(options: GraphSourceOptions): CalendarSource {
  const sourceId = caldavSourceIdFor(options.accountId) as `caldav:${string}`;
  const zone = () => options.localZone?.() ?? systemZone();
  let calendars: GraphCalendarInfo[] | null = null;
  let listedAt = 0;
  let address: string | undefined;
  let partial: string | undefined;

  const session = async (): Promise<Session> => {
    const s = await options.signIn();
    if (!s) throw new CalendarHelperError(`Walnut is not signed in to Microsoft for ${options.accountId} on this computer. Sign in again.`, 'needs-sign-in');
    address = s.address;
    return s;
  };

  const calendarWalnutId = (calId: string) => `${sourceId}/${b64(calId)}`;
  const eventId = (calId: string, graphId: string) => `${sourceId}/${b64(calId)}.${b64(graphId)}`;

  const parseEventId = (id: string): { calId: string; graphId: string } => {
    const rest = id.startsWith(`${sourceId}/`) ? id.slice(sourceId.length + 1) : '';
    const [cal, ev, extra] = rest.split('.');
    if (!cal || !ev || extra !== undefined) throw new CalendarHelperError(`event not found: ${id}`, 'not-found');
    return { calId: unb64(cal), graphId: unb64(ev) };
  };

  const call = async (s: Session, method: 'GET' | 'POST' | 'PATCH' | 'DELETE', pathOrUrl: string, opts: { body?: unknown; headers?: Record<string, string> } = {}): Promise<DavAnswer> => {
    const url = /^https?:\/\//.test(pathOrUrl) ? pathOrUrl : `${s.base}${pathOrUrl}`;
    // A refused sign-in forgets the calendar list, so the next list asks Microsoft again
    // instead of answering from memory as if the account worked (and clearing "sign in again").
    return davRequest(s.bearer, {
      method,
      url,
      ...(opts.body !== undefined ? { body: JSON.stringify(opts.body), contentType: 'application/json' } : {}),
      headers: { Accept: 'application/json', Prefer: PREFER, ...opts.headers },
    }, options.fetch).catch((err: unknown) => {
      if (err instanceof CalendarHelperError && err.code === 'needs-sign-in') calendars = null;
      throw err;
    });
  };

  const json = <T>(answer: DavAnswer, what: string): T => {
    if (answer.status === 404 || answer.status === 410) throw new CalendarHelperError(`${what} not found`, 'not-found');
    if (answer.status === 403) throw new CalendarHelperError(`Microsoft refused Walnut's request for ${what} (403): ${graphError(answer)}`, 'auth-failed');
    if (answer.status < 200 || answer.status >= 300) throw new CalendarHelperError(`Microsoft answered ${answer.status} for ${what}: ${graphError(answer)}`, 'fetch-error');
    try {
      return JSON.parse(answer.text) as T;
    } catch {
      throw new CalendarHelperError(`Microsoft sent ${what} in a form Walnut cannot read.`, 'fetch-error');
    }
  };

  const ensureCalendars = async (): Promise<{ s: Session; list: GraphCalendarInfo[] }> => {
    const s = await session();
    if (calendars && Date.now() - listedAt < CALENDAR_LIST_TTL_MS) return { s, list: calendars };
    const body = json<{ value?: Array<{ id: string; name?: string; hexColor?: string; canEdit?: boolean }> }>(
      await call(s, 'GET', '/me/calendars?$select=id,name,hexColor,canEdit&$top=100'), 'the calendar list');
    calendars = (body.value ?? []).filter((c) => typeof c.id === 'string').map((c) => ({
      id: c.id,
      walnutId: calendarWalnutId(c.id),
      title: c.name || 'Calendar',
      color: /^#[0-9a-f]{6}$/i.test(c.hexColor ?? '') ? c.hexColor!.toLowerCase() : DEFAULT_COLOR,
      readonly: c.canEdit === false,
    }));
    listedAt = Date.now();
    if (calendars.length === 0) throw new CalendarHelperError(`Microsoft offers no calendar for ${s.address}.`, 'no-calendar');
    return { s, list: calendars };
  };

  const ctxFor = (s: Session, cal: GraphCalendarInfo) => ({ sourceId, eventId, calendar: cal, accountName: s.address, localZone: zone() });

  const readCalendar = async (s: Session, cal: GraphCalendarInfo, startIso: string, endIso: string): Promise<CalendarEvent[]> => {
    const q = new URLSearchParams({ startDateTime: startIso, endDateTime: endIso, $top: String(PAGE_SIZE), $select: EVENT_SELECT, $expand: EVENT_EXPAND });
    let next: string | undefined = `/me/calendars/${encodeURIComponent(cal.id)}/calendarView?${q.toString()}`;
    const out: CalendarEvent[] = [];
    for (let page = 0; next && page < MAX_PAGES; page++) {
      // A next page is Graph's own address; one on another site is not followed (dav.ts refuses it too).
      if (/^https?:\/\//.test(next) && new URL(next).origin !== new URL(s.base).origin) {
        throw new CalendarHelperError(`Microsoft pointed the next page of "${cal.title}" at ${new URL(next).host}; Walnut does not follow that.`, 'fetch-error');
      }
      const body: { value?: GraphEvent[]; '@odata.nextLink'?: string } = json(await call(s, 'GET', next), `"${cal.title}"`);
      for (const e of body.value ?? []) {
        const event = toCalendarEvent(e, ctxFor(s, cal));
        if (event) out.push(event);
      }
      next = body['@odata.nextLink'];
    }
    return out;
  };

  const calendarOf = (list: GraphCalendarInfo[], calId: string, id: string): GraphCalendarInfo => {
    const cal = list.find((c) => c.id === calId);
    if (!cal) throw new CalendarHelperError(`event not found: ${id}`, 'not-found');
    return cal;
  };

  /** The event as it is in Graph now, with the ETag a write must match. */
  const fetchEvent = async (id: string) => {
    const { calId, graphId } = parseEventId(id);
    const { s, list } = await ensureCalendars();
    const cal = calendarOf(list, calId, id);
    const q = new URLSearchParams({ $select: EVENT_SELECT, $expand: EVENT_EXPAND });
    const raw = json<GraphEvent>(await call(s, 'GET', `/me/calendars/${encodeURIComponent(calId)}/events/${encodeURIComponent(graphId)}?${q.toString()}`), `event ${id}`);
    const event = toCalendarEvent(raw, ctxFor(s, cal));
    if (!event) throw new CalendarHelperError(`event not found: ${id}`, 'not-found');
    return { s, cal, calId, graphId, event, etag: raw['@odata.etag'] };
  };

  const assertWritable = (r: Awaited<ReturnType<typeof fetchEvent>>): void => {
    if (r.cal.readonly) throw new CalendarHelperError('calendar is read-only', 'readonly');
    if (r.event.hasAttendees !== false) throw new CalendarHelperError(ATTENDEES_READONLY_TEXT, 'readonly');
  };

  const checkWrite = (answer: DavAnswer, what: string): void => {
    if (answer.status === 412) throw new CalendarHelperError(`The event changed in Outlook while Walnut was ${what} it. Nothing was saved; look at it again and retry.`, 'conflict');
    if (answer.status === 404 || answer.status === 410) throw new CalendarHelperError('event not found', 'not-found');
    if (answer.status === 403) throw new CalendarHelperError('calendar is read-only', 'readonly');
    if (answer.status < 200 || answer.status >= 300) throw new CalendarHelperError(`Microsoft refused the change (${answer.status}): ${graphError(answer)}`, 'fetch-error');
  };

  const ifMatch = (etag: string | undefined): Record<string, string> => (etag ? { 'If-Match': etag } : {});

  return {
    id: sourceId,

    describe(): Pick<CalendarSourceStatus, 'kind' | 'account' | 'label'> {
      return { kind: 'graph', account: options.accountId, ...(address ? { label: address } : {}) };
    },

    degraded: () => partial,

    available: () => ({ ok: true }),

    async listCalendars(): Promise<CalendarInfo[]> {
      const { s, list } = await ensureCalendars();
      return list.map((c) => ({ id: c.walnutId, title: c.title, account: s.address, color: c.color, readonly: c.readonly, hidden: false }));
    },

    async listEvents(from: string, to: string): Promise<CalendarEvent[]> {
      const a = parseLocalIso(from);
      const b = parseLocalIso(to);
      if (!a || !b) throw new CalendarHelperError('from/to must be YYYY-MM-DD', 'usage');
      const start = wallToEpoch(a.wall, zone());
      const end = Math.min(wallToEpoch(addDays(b.wall, 1), zone()), start + MAX_READ_DAYS * 86_400_000);
      const { s, list } = await ensureCalendars();
      const iso = (ms: number) => new Date(ms).toISOString();
      const results = await Promise.allSettled(list.map((cal) => readCalendar(s, cal, iso(start), iso(end))));
      const ok = results.filter((r): r is PromiseFulfilledResult<CalendarEvent[]> => r.status === 'fulfilled');
      if (ok.length === 0 && results.length > 0) throw (results[0] as PromiseRejectedResult).reason;
      const missed = list.filter((_, i) => results[i].status === 'rejected').map((c) => `"${c.title}"`);
      partial = missed.length ? `${missed.join(', ')} did not answer.` : undefined;
      return ok.flatMap((r) => r.value);
    },

    async getEvent(id: string): Promise<CalendarEvent> {
      return (await fetchEvent(id)).event;
    },

    async updateEvent(id: string, patch: CalendarEventPatch): Promise<CalendarEvent> {
      if (!patch.start || !patch.end) throw new CalendarHelperError('update requires start and end', 'usage');
      const r = await fetchEvent(id);
      assertWritable(r);
      const times = graphTimes(patch.start, patch.end, zone());
      if (!times) throw new CalendarHelperError('start and end must be local ISO times', 'usage');
      const body = { ...times, ...(patch.title !== undefined ? { subject: patch.title } : {}) };
      checkWrite(await call(r.s, 'PATCH', `/me/events/${encodeURIComponent(r.graphId)}`, { body, headers: ifMatch(r.etag) }), 'saving');
      return (await fetchEvent(id)).event;
    },

    async createEvent(input: CalendarEventCreate): Promise<CalendarEvent> {
      const rest = input.calendarId.startsWith(`${sourceId}/`) ? input.calendarId.slice(sourceId.length + 1) : '';
      const { s, list } = await ensureCalendars();
      const cal = list.find((c) => c.walnutId === input.calendarId);
      if (!rest || !cal) throw new CalendarHelperError(`calendar not found: ${input.calendarId}`, 'not-found');
      if (cal.readonly) throw new CalendarHelperError('calendar is read-only', 'readonly');
      const allDay = input.allDay === true || !input.start.includes('T');
      const times = graphTimes(allDay ? input.start.slice(0, 10) : input.start, allDay ? input.end.slice(0, 10) : input.end, zone());
      if (!times) throw new CalendarHelperError('start and end must be local ISO times', 'usage');
      const answer = await call(s, 'POST', `/me/calendars/${encodeURIComponent(cal.id)}/events`, {
        body: { subject: input.title, ...times, singleValueExtendedProperties: [{ id: WALNUT_CREATED_PROPERTY, value: 'true' }] },
      });
      checkWrite(answer, 'creating');
      const made = json<GraphEvent>(answer, 'the new event');
      return (await fetchEvent(eventId(cal.id, made.id))).event;
    },

    async deleteEvent(id: string): Promise<void> {
      const r = await fetchEvent(id);
      assertWritable(r);
      checkWrite(await call(r.s, 'DELETE', `/me/events/${encodeURIComponent(r.graphId)}`, { headers: ifMatch(r.etag) }), 'deleting');
    },
  };
}

/** Graph's own error words, short. */
function graphError(answer: DavAnswer): string {
  try {
    const e = (JSON.parse(answer.text) as { error?: { code?: string; message?: string } }).error;
    return [e?.code, e?.message].filter(Boolean).join(': ').slice(0, 200) || 'no detail';
  } catch {
    return answer.text.slice(0, 120) || 'no detail';
  }
}
