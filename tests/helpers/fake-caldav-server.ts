/**
 * A small CalDAV server in the test process, for the calendar's CalDAV source.
 *
 * It speaks the parts a client needs, the way real servers do:
 *   - `/.well-known/caldav` redirects (301) to `/dav/` (RFC 6764);
 *   - PROPFIND on `/dav/` answers the current-user-principal, the principal answers the
 *     calendar-home-set, and the home (depth 1) lists its calendars with displayname, colour,
 *     privileges and supported components;
 *   - REPORT calendar-query returns each resource's getetag and calendar-data, honouring the
 *     time-range for one-off events (recurring ones are always returned, as their expansion
 *     is the client's work here);
 *   - GET, PUT (If-Match / If-None-Match: *) and DELETE (If-Match) with real ETags; a stale
 *     ETag is 412, a write to a read-only calendar 403;
 *   - Basic auth on every request (401 otherwise).
 *
 * `beforeWrite` lets a test change a resource between the client's read and its write, which
 * is how a 412 conflict is produced on purpose.
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';

export interface FakeCalendar {
  path: string; // "/dav/calendars/pat/work/"
  name: string;
  color?: string;
  readonly?: boolean;
}

export interface FakeCalDavOptions {
  username: string;
  password: string;
  calendars: FakeCalendar[];
  /** path → ics text */
  resources?: Record<string, string>;
}

export interface FakeCalDavServer {
  url: string;
  origin: string;
  resources: Map<string, { ics: string; etag: string }>;
  requests: Array<{ method: string; path: string; headers: http.IncomingHttpHeaders }>;
  beforeWrite: ((path: string) => void) | null;
  /** When set, every request answers this status (a server that is down). */
  failWith: number | null;
  /** When set, requests under this path answer this status (one calendar that fails). */
  failPath: { prefix: string; status: number } | null;
  put(path: string, ics: string): void;
  close(): Promise<void>;
}

const PRINCIPAL = '/dav/principals/pat/';
const HOME = '/dav/calendars/pat/';

function multistatus(body: string): string {
  return `<?xml version="1.0" encoding="utf-8"?>\n<d:multistatus xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav" xmlns:a="http://apple.com/ns/ical/">${body}</d:multistatus>`;
}

function escapeXml(v: string): string {
  return v.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** "20260805T090000Z" → epoch; a DATE value → its UTC midnight. */
function stampToEpoch(v: string): number | null {
  const m = /^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})Z?)?$/.exec(v.trim());
  if (!m) return null;
  return Date.UTC(+m[1], +m[2] - 1, +m[3], +(m[4] ?? 0), +(m[5] ?? 0), +(m[6] ?? 0));
}

function inRange(ics: string, start: number | null, end: number | null): boolean {
  if (/^RRULE:/m.test(ics) || /^RECURRENCE-ID/m.test(ics)) return true;
  const s = /^DTSTART[^:]*:(.+)$/m.exec(ics);
  const e = /^DTEND[^:]*:(.+)$/m.exec(ics);
  const from = s ? stampToEpoch(s[1]) : null;
  const to = e ? stampToEpoch(e[1]) : from;
  if (from === null || start === null || end === null) return true;
  // Loose by a day either way: floating and zoned values are read as UTC here.
  return from < end + 86_400_000 && (to ?? from) > start - 86_400_000;
}

export async function startFakeCalDav(options: FakeCalDavOptions): Promise<FakeCalDavServer> {
  let etagSeq = 0;
  const nextEtag = () => `"etag-${++etagSeq}"`;
  const resources = new Map<string, { ics: string; etag: string }>();
  for (const [path, ics] of Object.entries(options.resources ?? {})) resources.set(path, { ics, etag: nextEtag() });
  const requests: FakeCalDavServer['requests'] = [];
  const expected = `Basic ${Buffer.from(`${options.username}:${options.password}`).toString('base64')}`;

  const state: Pick<FakeCalDavServer, 'beforeWrite' | 'failWith' | 'failPath'> = { beforeWrite: null, failWith: null, failPath: null };

  const calendarOf = (path: string) => options.calendars.find((c) => path.startsWith(c.path));

  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const body = Buffer.concat(chunks).toString('utf8');
      const path = decodeURIComponent(new URL(req.url ?? '/', 'http://x').pathname);
      requests.push({ method: req.method ?? '', path, headers: req.headers });
      const send = (status: number, text = '', headers: Record<string, string> = {}) => {
        res.writeHead(status, { 'Content-Type': 'application/xml; charset=utf-8', ...headers });
        res.end(text);
      };
      if (state.failWith) return send(state.failWith, 'down');
      if (state.failPath && path.startsWith(state.failPath.prefix)) return send(state.failPath.status, 'broken');
      if (path === '/.well-known/caldav') return send(301, '', { Location: '/dav/' });
      if (req.headers.authorization !== expected) return send(401, 'no', { 'WWW-Authenticate': 'Basic realm="fake"' });
      const method = req.method ?? '';

      if (method === 'PROPFIND' && (path === '/dav/' || path === '/dav')) {
        return send(207, multistatus(`<d:response><d:href>/dav/</d:href><d:propstat><d:prop><d:current-user-principal><d:href>${PRINCIPAL}</d:href></d:current-user-principal></d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response>`));
      }
      if (method === 'PROPFIND' && path === PRINCIPAL) {
        return send(207, multistatus(`<d:response><d:href>${PRINCIPAL}</d:href><d:propstat><d:prop><c:calendar-home-set><d:href>${HOME}</d:href></c:calendar-home-set></d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response>`));
      }
      if (method === 'PROPFIND' && path === HOME) {
        const home = `<d:response><d:href>${HOME}</d:href><d:propstat><d:prop><d:resourcetype><d:collection/></d:resourcetype></d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response>`;
        const cals = options.calendars.map((c) => `<d:response><d:href>${c.path}</d:href><d:propstat><d:prop>
          <d:resourcetype><d:collection/><c:calendar/></d:resourcetype>
          <d:displayname>${escapeXml(c.name)}</d:displayname>
          ${c.color ? `<a:calendar-color>${c.color}FF</a:calendar-color>` : ''}
          <d:current-user-privilege-set><d:privilege><d:read/></d:privilege>${c.readonly ? '' : '<d:privilege><d:write/></d:privilege>'}</d:current-user-privilege-set>
          <c:supported-calendar-component-set><c:comp name="VEVENT"/></c:supported-calendar-component-set>
        </d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response>`).join('');
        // A task list the client must leave out (it holds no events).
        const tasks = `<d:response><d:href>${HOME}tasks/</d:href><d:propstat><d:prop><d:resourcetype><d:collection/><c:calendar/></d:resourcetype><d:displayname>Tasks</d:displayname><c:supported-calendar-component-set><c:comp name="VTODO"/></c:supported-calendar-component-set></d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response>`;
        return send(207, multistatus(home + cals + tasks));
      }
      if (method === 'REPORT') {
        const cal = options.calendars.find((c) => c.path === path);
        if (!cal) return send(404);
        const range = /time-range\s+start="([^"]+)"\s+end="([^"]+)"/.exec(body);
        const start = range ? stampToEpoch(range[1]) : null;
        const end = range ? stampToEpoch(range[2]) : null;
        const hits = [...resources.entries()].filter(([p, r]) => p.startsWith(cal.path) && inRange(r.ics, start, end));
        return send(207, multistatus(hits.map(([p, r]) => `<d:response><d:href>${p}</d:href><d:propstat><d:prop><d:getetag>${escapeXml(r.etag)}</d:getetag><c:calendar-data><![CDATA[${r.ics}]]></c:calendar-data></d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response>`).join('')));
      }
      if (method === 'GET') {
        const r = resources.get(path);
        if (!r) return send(404);
        return send(200, r.ics, { 'Content-Type': 'text/calendar; charset=utf-8', ETag: r.etag });
      }
      if (method === 'PUT') {
        const cal = calendarOf(path);
        if (!cal) return send(409);
        state.beforeWrite?.(path);
        if (cal.readonly) return send(403);
        const current = resources.get(path);
        const ifMatch = req.headers['if-match'];
        if (req.headers['if-none-match'] === '*' && current) return send(412);
        if (ifMatch && (!current || current.etag !== ifMatch)) return send(412);
        const etag = nextEtag();
        resources.set(path, { ics: body, etag });
        return send(current ? 204 : 201, '', { ETag: etag });
      }
      if (method === 'DELETE') {
        state.beforeWrite?.(path);
        const current = resources.get(path);
        if (!current) return send(404);
        const ifMatch = req.headers['if-match'];
        if (ifMatch && current.etag !== ifMatch) return send(412);
        resources.delete(path);
        return send(204);
      }
      return send(405);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  const origin = `http://127.0.0.1:${port}`;
  return {
    url: `${origin}/`,
    origin,
    resources,
    requests,
    get beforeWrite() { return state.beforeWrite; },
    set beforeWrite(fn) { state.beforeWrite = fn; },
    get failWith() { return state.failWith; },
    set failWith(v) { state.failWith = v; },
    get failPath() { return state.failPath; },
    set failPath(v) { state.failPath = v; },
    put(path, ics) { resources.set(path, { ics, etag: nextEtag() }); },
    close: () => new Promise<void>((resolve) => { server.closeAllConnections?.(); server.close(() => resolve()); }),
  };
}

/** A VCALENDAR around VEVENT lines, CRLF-joined as servers send them. */
export function ics(...veventLines: string[][]): string {
  const lines = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Fake//EN'];
  for (const ev of veventLines) lines.push('BEGIN:VEVENT', ...ev, 'END:VEVENT');
  lines.push('END:VCALENDAR');
  return `${lines.join('\r\n')}\r\n`;
}
