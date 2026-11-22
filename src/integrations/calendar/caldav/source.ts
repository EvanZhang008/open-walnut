/**
 * A mail account's calendar as a calendar source, read and written over CalDAV.
 *
 * The account's password is asked for on every use (the mail plugin's credential service
 * reads it from its own secret store) and never kept here. What is kept: where the calendars
 * are (found once, again after the server says a path is gone) and the calendar list (five
 * minutes, so Settings and the calendar views reading `/sources` do not each cost a request).
 *
 * Writes carry the ETag of the copy Walnut just read (`If-Match`), so an event someone else
 * changed in between is never overwritten: the server answers 412 and the write is refused as
 * a conflict. A new event is put with `If-None-Match: *`. The check of what a write may change
 * (read-only calendar, an event with other people on it) is made on that same copy.
 *
 * Every path a server names is used on the origin the calendars were found at, never on a host
 * an href might smuggle in ("//elsewhere/...").
 */
import { CalendarHelperError } from '../../../core/calendar/helper-error.js';
import { caldavSourceIdFor } from '../event-rules.js';
import type {
  CalendarEvent,
  CalendarEventCreate,
  CalendarEventPatch,
  CalendarInfo,
  CalendarSource,
  CalendarSourceStatus,
} from '../types.js';
import { ATTENDEES_READONLY_TEXT } from '../event-rules.js';
import { davRequest, escapeXml, parseMultistatus, textOf, type DavAnswer, type DavCredentials, type DavRequest, type FetchLike } from './dav.js';
import { discoverCalendars, listHome, type DiscoveredCalendar, type Discovery, type DiscoveryDeps, type MailAccountForCalendar } from './discovery.js';
import { newEventCalendar, editTimes, removeOccurrence } from './edit.js';
import { eventsOfResource, instanceOf, isRecurring, occurrenceOf, splitResource, type EpochRange, type ResourceContext } from './events.js';
import { parseIcs, props, serializeIcs, type IcsComponent } from './ics.js';
import type { SharedBudget } from './recurrence.js';
import { localZone as systemZone, parseLocalIso, utcStamp, wallToEpoch, addDays } from './tz.js';

const CALENDAR_LIST_TTL_MS = 5 * 60_000;
/** The longest span one read of a mail calendar covers (about two years). */
export const MAX_READ_DAYS = 732;
/** The expansion work one listEvents may do over every calendar and resource it reads. */
export const READ_BUDGET = 300_000;
/** How long resources are expanded before the event loop gets a turn. */
const YIELD_AFTER_MS = 8;
/** The background poll re-reads the calendar list, but not once per cached window. */
const REFRESH_RELIST_MS = 60_000;
const DEFAULT_COLOR = '#5b8def';
const ICS_TYPE = 'text/calendar; charset=utf-8';

export interface CalDavSourceOptions extends DiscoveryDeps {
  /** The mail account id this calendar comes with (`imap:<id>`). */
  accountId: string;
  /** Asked on every use; undefined when the account or its password is gone. */
  credentials: () => Promise<MailAccountForCalendar | undefined>;
  /** The server's local zone (tests pin one). */
  localZone?: () => string;
  fetch?: FetchLike;
}

const b64 = (value: string) => Buffer.from(value, 'utf8').toString('base64url');
const unb64 = (value: string) => Buffer.from(value, 'base64url').toString('utf8');

export function createCalDavSource(options: CalDavSourceOptions): CalendarSource {
  const sourceId = caldavSourceIdFor(options.accountId) as `caldav:${string}`;
  const zone = () => options.localZone?.() ?? systemZone();
  let discovery: Discovery | null = null;
  let listedAt = 0;
  let address: string | undefined;
  /** Set while the last read had calendars that did not answer (the others' events still show). */
  let partial: string | undefined;
  /** Series the last read could not expand to the end of its range (their budget ran out). */
  const truncated = new Set<string>();
  /** Set when the last read asked for more than `MAX_READ_DAYS`. */
  let clipped: string | undefined;

  const dav = (acct: MailAccountForCalendar, req: DavRequest): Promise<DavAnswer> => {
    const creds: DavCredentials = { username: acct.username || acct.address, password: acct.password };
    return davRequest(creds, req, options.fetch, options.lookup);
  };

  const account = async (): Promise<MailAccountForCalendar> => {
    const found = await options.credentials();
    if (!found) throw new CalendarHelperError(`The mail account ${options.accountId} is gone, or Walnut has no saved password for it.`, 'not-configured');
    address = found.address;
    return found;
  };

  const calendarId = (path: string) => `${sourceId}/${b64(path)}`;
  const resourceId = (path: string) => `${sourceId}/${b64(path)}`;

  /** The resource path an event id names, and its occurrence (seconds) when it has one. */
  const parseEventId = (id: string): { path: string; occurrence: number | null } => {
    const rest = id.slice(sourceId.length + 1).replace(/#\d+$/, '');
    const path = rest ? unb64(rest) : '';
    if (!id.startsWith(`${sourceId}/`) || !path.startsWith('/')) throw new CalendarHelperError(`event not found: ${id}`, 'not-found');
    return { path, occurrence: occurrenceOf(id) };
  };

  const calendarPathOf = (id: string): string => {
    const rest = id.startsWith(`${sourceId}/`) ? id.slice(sourceId.length + 1) : '';
    const path = rest ? unb64(rest) : '';
    if (!path.startsWith('/')) throw new CalendarHelperError(`calendar not found: ${id}`, 'not-found');
    return path;
  };

  let finding: Promise<Discovery> | null = null;

  /** Where the calendars are: found once (one search at a time), the list re-read when stale. */
  const ensureCalendars = async (refresh = false): Promise<{ acct: MailAccountForCalendar; found: Discovery }> => {
    const acct = await account();
    const stale = Date.now() - listedAt > (refresh ? REFRESH_RELIST_MS : CALENDAR_LIST_TTL_MS);
    if (discovery && !stale) return { acct, found: discovery };
    if (!finding) {
      const known = discovery;
      finding = (async () => {
        if (known) {
          try {
            return { ...known, calendars: await listHome(acct, known.homeUrl, options) };
          } catch (err) {
            // The home moved or is gone: look for it again from the start.
            if (err instanceof CalendarHelperError && err.code === 'auth-failed') throw err;
          }
        }
        return discoverCalendars(acct, options);
      })().then((found) => {
        discovery = found;
        listedAt = Date.now();
        return found;
      }).finally(() => { finding = null; });
    }
    return { acct, found: await finding };
  };

  const contextFor = (acct: MailAccountForCalendar, cal: DiscoveredCalendar, path: string, budget?: SharedBudget): ResourceContext => ({
    baseId: resourceId(path),
    sourceId,
    calendarId: calendarId(cal.path),
    calendarName: cal.title,
    accountName: acct.address,
    color: cal.color ?? DEFAULT_COLOR,
    readonly: cal.readonly,
    selfAddress: acct.address,
    localZone: zone(),
    noteTruncated: (title) => { truncated.add(title || 'An event'); },
    budget,
  });

  const calendarOfResource = (found: Discovery, path: string): DiscoveredCalendar => {
    const parent = path.replace(/[^/]+$/, '');
    const cal = found.calendars.find((c) => c.path.replace(/\/?$/, '/') === parent);
    if (!cal) throw new CalendarHelperError(`event not found: ${path}`, 'not-found');
    return cal;
  };

  /** A server path on the calendars' own origin; one that would leave it is no event of this account. */
  const url = (found: Discovery, path: string) => {
    const at = new URL(`${found.origin}${path.startsWith('/') ? path : `/${path}`}`);
    if (at.origin !== found.origin) throw new CalendarHelperError(`event not found: ${path}`, 'not-found');
    return at.toString();
  };

  /** The day range the contract's day strings name, as instants on the server's clock. */
  const dayRange = (from: string, to: string): EpochRange => {
    const a = parseLocalIso(from);
    const b = parseLocalIso(to);
    if (!a || !b) throw new CalendarHelperError('from/to must be YYYY-MM-DD', 'usage');
    return { start: wallToEpoch(a.wall, zone()), end: wallToEpoch(addDays(b.wall, 1), zone()) };
  };

  const queryBody = (range: EpochRange) => `<?xml version="1.0" encoding="utf-8"?>
<c:calendar-query xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav">
  <d:prop><d:getetag/><c:calendar-data/></d:prop>
  <c:filter><c:comp-filter name="VCALENDAR"><c:comp-filter name="VEVENT">
    <c:time-range start="${escapeXml(utcStamp(range.start))}" end="${escapeXml(utcStamp(range.end))}"/>
  </c:comp-filter></c:comp-filter></c:filter>
</c:calendar-query>`;

  const readCalendar = async (acct: MailAccountForCalendar, found: Discovery, cal: DiscoveredCalendar, range: EpochRange, budget: SharedBudget): Promise<CalendarEvent[]> => {
    const answer = await dav(acct, { method: 'REPORT', url: url(found, cal.path), depth: '1', body: queryBody(range) });
    if (answer.status === 404) discovery = null; // look again next time
    if (answer.status !== 207) {
      throw new CalendarHelperError(`${new URL(answer.url).host} answered ${answer.status} for "${cal.title}".`, answer.status === 401 || answer.status === 403 ? 'auth-failed' : 'fetch-error');
    }
    const out: CalendarEvent[] = [];
    let since = performance.now();
    for (const r of parseMultistatus(answer.text)) {
      // Resources are expanded in slices: the event loop gets a turn every few milliseconds.
      if (performance.now() - since > YIELD_AFTER_MS) {
        await new Promise((done) => setImmediate(done));
        since = performance.now();
      }
      const data = textOf(r.props.get('calendar-data'));
      if (!data) continue;
      const path = new URL(r.href, answer.url).pathname;
      for (const root of parseIcs(data)) out.push(...eventsOfResource(root, contextFor(acct, cal, path, budget), range));
    }
    return out;
  };

  /** The resource as it is on the server now, with the ETag a write must match. */
  const fetchResource = async (id: string) => {
    const { path, occurrence } = parseEventId(id);
    const { acct, found } = await ensureCalendars();
    const cal = calendarOfResource(found, path);
    const answer = await dav(acct, { method: 'GET', url: url(found, path) });
    if (answer.status === 404 || answer.status === 410) throw new CalendarHelperError(`event not found: ${id}`, 'not-found');
    if (answer.status < 200 || answer.status >= 300) throw new CalendarHelperError(`${new URL(answer.url).host} answered ${answer.status} for the event.`, 'fetch-error');
    const root = parseIcs(answer.text).find((c) => c.name === 'VCALENDAR');
    if (!root) throw new CalendarHelperError(`event not found: ${id}`, 'not-found');
    return { acct, found, cal, path, occurrence, root, etag: answer.headers.get('etag') ?? undefined };
  };

  /** The one instance an id names, read from a resource tree (events.ts `instanceOf`, bounded work). */
  const instanceIn = (root: IcsComponent, id: string, ctx: ResourceContext, occurrence: number | null): CalendarEvent => {
    const hit = instanceOf(root, ctx, occurrence);
    if (!hit) throw new CalendarHelperError(`event not found: ${id}`, 'not-found');
    return hit;
  };

  /** What a write may not change, checked on the copy it will write back. */
  const assertWritable = (r: Awaited<ReturnType<typeof fetchResource>>, id: string): void => {
    if (r.cal.readonly) throw new CalendarHelperError('calendar is read-only', 'readonly');
    const target = instanceIn(r.root, id, contextFor(r.acct, r.cal, r.path), r.occurrence);
    // Shared when the instance or any VEVENT of the resource (the series, another override) has
    // other people on it: the write goes back as the whole resource, and its server tells them.
    const shared = target.hasAttendees !== false || r.root.children.some((c) => c.name === 'VEVENT' && props(c, 'ATTENDEE').length > 0);
    if (shared) throw new CalendarHelperError(ATTENDEES_READONLY_TEXT, 'readonly');
  };

  const put = async (acct: MailAccountForCalendar, found: Discovery, path: string, root: IcsComponent, condition: Record<string, string>) => {
    const body = serializeIcs(root);
    // Text that arrived damaged (U+FFFD where a character was) would be written back for good.
    if (body.includes('\uFFFD')) {
      throw new CalendarHelperError('Part of this event\'s text arrived damaged from its server, and saving would keep the damage. Change it in its own calendar app.', 'readonly');
    }
    const answer = await dav(acct, { method: 'PUT', url: url(found, path), body, contentType: ICS_TYPE, headers: condition });
    if (answer.status === 412) {
      throw new CalendarHelperError('The event changed on its server while Walnut was saving it. Nothing was saved; look at it again and retry.', 'conflict');
    }
    if (answer.status === 403) throw new CalendarHelperError('calendar is read-only', 'readonly');
    if (answer.status < 200 || answer.status >= 300) throw new CalendarHelperError(`${new URL(answer.url).host} refused the change (${answer.status}).`, 'fetch-error');
  };

  const ifMatch = (etag: string | undefined): Record<string, string> => (etag ? { 'If-Match': etag } : {});

  return {
    id: sourceId,

    describe(): Pick<CalendarSourceStatus, 'kind' | 'account' | 'label'> {
      return { kind: 'caldav', account: options.accountId, ...(address ? { label: address } : {}) };
    },

    degraded: () => {
      const notes = [
        partial,
        clipped,
        truncated.size ? `${[...truncated].slice(0, 3).map((t) => `"${t}"`).join(', ')} repeat${truncated.size === 1 ? 's' : ''} in a way too costly to read in full; some of ${truncated.size === 1 ? 'its' : 'their'} occurrences are missing.` : undefined,
      ].filter(Boolean);
      return notes.length ? notes.join(' ') : undefined;
    },

    // Nothing static gates a CalDAV source; its failures are recorded per read.
    available: () => ({ ok: true }),

    async listCalendars(): Promise<CalendarInfo[]> {
      const { acct, found } = await ensureCalendars();
      return found.calendars.map((c) => ({
        id: calendarId(c.path),
        title: c.title,
        account: acct.address,
        color: c.color ?? DEFAULT_COLOR,
        readonly: c.readonly,
        hidden: false,
      }));
    },

    async listEvents(from: string, to: string, opts?: { refresh?: boolean }): Promise<CalendarEvent[]> {
      const { acct, found } = await ensureCalendars(opts?.refresh === true);
      const asked = dayRange(from, to);
      // A read of decades would expand every series over all of them: one read covers at most this.
      const range = { start: asked.start, end: Math.min(asked.end, asked.start + MAX_READ_DAYS * 86_400_000) };
      clipped = range.end < asked.end ? `Walnut reads a mail calendar ${MAX_READ_DAYS} days at a time; events after that are not in this answer.` : undefined;
      truncated.clear();
      const budget: SharedBudget = { left: READ_BUDGET }; // one for every calendar this read expands
      const results = await Promise.allSettled(found.calendars.map((cal) => readCalendar(acct, found, cal, range, budget)));
      const ok = results.filter((r): r is PromiseFulfilledResult<CalendarEvent[]> => r.status === 'fulfilled');
      if (ok.length === 0 && results.length > 0) throw (results[0] as PromiseRejectedResult).reason;
      const missed = found.calendars.filter((_, i) => results[i].status === 'rejected').map((c) => `"${c.title}"`);
      partial = missed.length
        ? `${missed.join(', ')} did not answer: ${String(((results.find((r) => r.status === 'rejected') as PromiseRejectedResult).reason as Error)?.message ?? '').slice(0, 160)}`
        : undefined;
      return ok.flatMap((r) => r.value);
    },

    async getEvent(id: string): Promise<CalendarEvent> {
      const r = await fetchResource(id);
      return instanceIn(r.root, id, contextFor(r.acct, r.cal, r.path), r.occurrence);
    },

    async updateEvent(id: string, patch: CalendarEventPatch): Promise<CalendarEvent> {
      if (!patch.start || !patch.end) throw new CalendarHelperError('update requires start and end', 'usage');
      const r = await fetchResource(id);
      assertWritable(r, id);
      editTimes(r.root, r.occurrence, { start: patch.start, end: patch.end, ...(patch.title !== undefined ? { title: patch.title } : {}) }, zone());
      await put(r.acct, r.found, r.path, r.root, ifMatch(r.etag));
      return instanceIn(r.root, id, contextFor(r.acct, r.cal, r.path), r.occurrence);
    },

    async createEvent(input: CalendarEventCreate): Promise<CalendarEvent> {
      const path = calendarPathOf(input.calendarId);
      const { acct, found } = await ensureCalendars();
      const cal = found.calendars.find((c) => c.path === path);
      if (!cal) throw new CalendarHelperError(`calendar not found: ${input.calendarId}`, 'not-found');
      if (cal.readonly) throw new CalendarHelperError('calendar is read-only', 'readonly');
      const allDay = input.allDay === true || !input.start.includes('T');
      const start = allDay ? input.start.slice(0, 10) : input.start;
      const end = allDay ? input.end.slice(0, 10) : input.end;
      const { uid, calendar } = newEventCalendar({ start, end, title: input.title }, zone());
      const resource = `${cal.path.replace(/\/?$/, '/')}${encodeURIComponent(uid)}.ics`;
      await put(acct, found, resource, calendar, { 'If-None-Match': '*' });
      return instanceIn(calendar, resourceId(resource), contextFor(acct, cal, resource), null);
    },

    async deleteEvent(id: string): Promise<void> {
      const r = await fetchResource(id);
      assertWritable(r, id);
      const { master, overrides } = splitResource(r.root);
      if (r.occurrence !== null && (isRecurring(master) || overrides.length > 0)) {
        removeOccurrence(r.root, r.occurrence, zone());
        await put(r.acct, r.found, r.path, r.root, ifMatch(r.etag));
        return;
      }
      const answer = await dav(r.acct, { method: 'DELETE', url: url(r.found, r.path), headers: ifMatch(r.etag) });
      if (answer.status === 412) throw new CalendarHelperError('The event changed on its server while Walnut was deleting it. Nothing was deleted; look at it again and retry.', 'conflict');
      if (answer.status === 404 || answer.status === 410) throw new CalendarHelperError(`event not found: ${id}`, 'not-found');
      if (answer.status === 403) throw new CalendarHelperError('calendar is read-only', 'readonly');
      if (answer.status < 200 || answer.status >= 300) throw new CalendarHelperError(`${new URL(answer.url).host} refused the delete (${answer.status}).`, 'fetch-error');
    },
  };
}

