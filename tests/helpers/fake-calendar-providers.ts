/**
 * Fakes of the two calendar providers a mail account signs in with, for the calendar's sign-in:
 *
 * - Google: its OAuth endpoints (fake-oauth.ts) on one server, and a CalDAV server that takes only
 *   that sign-in's Bearer token (fake-caldav-server.ts with `bearer`), as Google's CalDAV does.
 * - Microsoft: its OAuth endpoints (`/common/oauth2/v2.0/...`) and the Microsoft Graph calendar
 *   subset Walnut uses (`/v1.0/me/calendars`, `calendarView` with paging, events read, created,
 *   changed with If-Match and deleted), one server. Graph's occurrences are given as stored:
 *   expanding a series is Graph's work, so a test stores each occurrence it wants.
 *
 * `env` points Walnut at a fake (the `WALNUT_*_URL` variables of sign-in/providers.ts).
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { randomBytes } from 'node:crypto';
import { createFakeOAuth, type FakeOAuth, type SignInAs } from './fake-oauth.js';
import { startFakeCalDav, type FakeCalDavServer, type FakeCalendar } from './fake-caldav-server.js';

export const GOOGLE_CLIENT = { id: 'cal-client.apps.googleusercontent.com', secret: 'cal-client-secret' };
export const MICROSOFT_CLIENT_ID = '00000000-0000-4000-8000-00000000c0de';

async function listen(server: http.Server): Promise<string> {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

const close = (server: http.Server) => new Promise<void>((resolve) => { server.closeAllConnections?.(); server.close(() => resolve()); });

export interface FakeGoogleCalendar {
  oauth: FakeOAuth;
  caldav: FakeCalDavServer;
  env: Record<string, string>;
  /** `METHOD /path` of every request to the OAuth server. */
  requests: string[];
  close(): Promise<void>;
}

export async function startFakeGoogleCalendar(opts: { calendars: FakeCalendar[]; email?: SignInAs; consentPage?: boolean }): Promise<FakeGoogleCalendar> {
  const oauth = createFakeOAuth({
    clients: { [GOOGLE_CLIENT.id]: GOOGLE_CLIENT.secret },
    ...(opts.email ? { email: opts.email } : {}),
    ...(opts.consentPage ? { consentPage: { title: 'Sign in with Google (test)', lines: ['See, edit, share, and permanently delete all the calendars you can access using Google Calendar'] } } : {}),
  });
  const requests: string[] = [];
  const server = http.createServer((req, res) => {
    const u = new URL(req.url ?? '/', 'http://127.0.0.1');
    requests.push(`${req.method} ${u.pathname}`);
    void oauth.handle(req, res, u).then((handled) => { if (!handled) { res.writeHead(404); res.end(); } });
  });
  const url = await listen(server);
  const caldav = await startFakeCalDav({ username: '', password: '', calendars: opts.calendars, bearer: (h) => oauth.validBearer(h) });
  return {
    oauth,
    caldav,
    requests,
    env: {
      WALNUT_GDRIVE_AUTH_URL: `${url}/o/oauth2/v2/auth`,
      WALNUT_GDRIVE_TOKEN_URL: `${url}/token`,
      WALNUT_GDRIVE_REVOKE_URL: `${url}/revoke`,
      WALNUT_GOOGLE_CALDAV_URL: `${caldav.origin}/dav/`,
    },
    close: async () => { await close(server); await caldav.close(); },
  };
}

export interface FakeGraphEvent {
  id: string;
  calendarId: string;
  etag: string;
  body: Record<string, unknown>;
}

export interface FakeMicrosoftGraph {
  oauth: FakeOAuth;
  url: string;
  env: Record<string, string>;
  calendars: Array<{ id: string; name: string; hexColor?: string; canEdit?: boolean }>;
  events: Map<string, FakeGraphEvent>;
  /** Every request: method, path with query, whether it carried an Authorization header, and its Prefer header. */
  requests: Array<{ method: string; path: string; authorized: boolean; prefer: string }>;
  /** Put an event as Graph would answer it (times in UTC). */
  put(calendarId: string, body: Record<string, unknown>): FakeGraphEvent;
  /** Answers per calendarView page (paging); default all at once. */
  pageSize: number;
  /** When set, a next page points at this origin instead of the fake's own. */
  nextLinkOrigin: string | null;
  /** Runs before a change or delete is checked (a test changes the event meanwhile). */
  beforeWrite: ((eventId: string) => void) | null;
  close(): Promise<void>;
}

const utc = (iso: string) => Date.parse(/Z$|[+-]\d\d:\d\d$/.test(iso) ? iso : `${iso.replace(/\.\d+$/, '')}Z`);

export async function startFakeMicrosoftGraph(opts: { calendars: FakeMicrosoftGraph['calendars']; email?: SignInAs; consentPage?: boolean }): Promise<FakeMicrosoftGraph> {
  const oauth = createFakeOAuth({
    paths: { auth: '/common/oauth2/v2.0/authorize', token: '/common/oauth2/v2.0/token', revoke: '/none' },
    clients: { [MICROSOFT_CLIENT_ID]: null },
    tokenPrefix: 'EwB-fake-',
    ...(opts.email ? { email: opts.email } : {}),
    ...(opts.consentPage ? { consentPage: { title: 'Sign in with Microsoft (test)', lines: ['Have full access to your calendars', 'Maintain access to data you have given it access to'] } } : {}),
  });
  const events = new Map<string, FakeGraphEvent>();
  const requests: FakeMicrosoftGraph['requests'] = [];
  let etagSeq = 0;
  const etag = () => `W/"etag-${++etagSeq}"`;
  const state = { pageSize: 1000, nextLinkOrigin: null as string | null, beforeWrite: null as ((id: string) => void) | null };
  let url = '';

  const shape = (e: FakeGraphEvent) => ({ ...e.body, id: e.id, '@odata.etag': e.etag });
  const put = (calendarId: string, body: Record<string, unknown>): FakeGraphEvent => {
    const e = { id: `AAMk-${randomBytes(9).toString('base64url')}=`, calendarId, etag: etag(), body };
    events.set(e.id, e);
    return e;
  };

  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      void (async () => {
        const u = new URL(req.url ?? '/', 'http://127.0.0.1');
        requests.push({ method: req.method ?? '', path: `${u.pathname}${u.search}`, authorized: !!req.headers.authorization, prefer: String(req.headers.prefer ?? '') });
        const send = (status: number, body?: unknown) => {
          res.writeHead(status, { 'Content-Type': 'application/json' });
          res.end(body === undefined ? '' : JSON.stringify(body));
        };
        if (u.pathname.startsWith('/common/')) {
          if (!(await oauth.handle(req, res, u, Buffer.concat(chunks).toString('utf8')))) send(404);
          return;
        }
        if (!oauth.validBearer(req.headers.authorization)) return send(401, { error: { code: 'InvalidAuthenticationToken', message: 'Access token has expired or is not yet valid.' } });
        const m = req.method ?? 'GET';
        const p = decodeURIComponent(u.pathname);
        const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown> : {};
        if (m === 'GET' && p === '/v1.0/me/calendars') return send(200, { value: opts.calendars });
        const view = /^\/v1\.0\/me\/calendars\/([^/]+)\/calendarView$/.exec(p);
        if (m === 'GET' && view) {
          const from = utc(u.searchParams.get('startDateTime') ?? '');
          const to = utc(u.searchParams.get('endDateTime') ?? '');
          const hits = [...events.values()].filter((e) => e.calendarId === view[1]).filter((e) => {
            const s = utc(String((e.body.start as { dateTime?: string })?.dateTime ?? ''));
            const t = utc(String((e.body.end as { dateTime?: string })?.dateTime ?? ''));
            return s < to && (t > from || s >= from);
          });
          const skip = Number(u.searchParams.get('$skip') ?? 0);
          const page = hits.slice(skip, skip + state.pageSize);
          const more = skip + state.pageSize < hits.length;
          const next = new URL(`${state.nextLinkOrigin ?? url}${u.pathname}${u.search}`);
          next.searchParams.set('$skip', String(skip + state.pageSize));
          return send(200, { value: page.map(shape), ...(more ? { '@odata.nextLink': next.toString() } : {}) });
        }
        const inCal = /^\/v1\.0\/me\/calendars\/([^/]+)\/events(?:\/([^/]+))?$/.exec(p);
        if (inCal && m === 'GET' && inCal[2]) {
          const e = events.get(inCal[2]);
          return e && e.calendarId === inCal[1] ? send(200, shape(e)) : send(404, { error: { code: 'ErrorItemNotFound', message: 'Not found.' } });
        }
        if (inCal && m === 'POST' && !inCal[2]) {
          const cal = opts.calendars.find((c) => c.id === inCal[1]);
          if (!cal) return send(404, { error: { code: 'ErrorItemNotFound' } });
          if (cal.canEdit === false) return send(403, { error: { code: 'ErrorAccessDenied', message: 'Access is denied.' } });
          return send(201, shape(put(cal.id, { ...body, type: 'singleInstance', isOrganizer: true, attendees: [] })));
        }
        const one = /^\/v1\.0\/me\/events\/([^/]+)$/.exec(p);
        if (one && (m === 'PATCH' || m === 'DELETE')) {
          state.beforeWrite?.(one[1]);
          const e = events.get(one[1]);
          if (!e) return send(404, { error: { code: 'ErrorItemNotFound' } });
          if (opts.calendars.find((c) => c.id === e.calendarId)?.canEdit === false) return send(403, { error: { code: 'ErrorAccessDenied' } });
          const ifMatch = req.headers['if-match'];
          if (ifMatch && ifMatch !== e.etag) return send(412, { error: { code: 'ErrorIrresolvableConflict', message: 'The change key passed in the request does not match the current change key for the item.' } });
          if (m === 'DELETE') { events.delete(e.id); return send(204); }
          e.body = { ...e.body, ...body };
          e.etag = etag();
          return send(200, shape(e));
        }
        send(404, { error: { code: 'BadRequest', message: `No route for ${m} ${p}` } });
      })().catch((err: unknown) => { if (!res.headersSent) { res.writeHead(500); res.end(String(err)); } });
    });
  });
  url = await listen(server);
  return {
    oauth,
    url,
    env: {
      WALNUT_MICROSOFT_AUTH_URL: `${url}/common/oauth2/v2.0/authorize`,
      WALNUT_MICROSOFT_TOKEN_URL: `${url}/common/oauth2/v2.0/token`,
      WALNUT_GRAPH_URL: `${url}/v1.0`,
    },
    calendars: opts.calendars,
    events,
    requests,
    put,
    get pageSize() { return state.pageSize; },
    set pageSize(n) { state.pageSize = n; },
    get nextLinkOrigin() { return state.nextLinkOrigin; },
    set nextLinkOrigin(v) { state.nextLinkOrigin = v; },
    get beforeWrite() { return state.beforeWrite; },
    set beforeWrite(fn) { state.beforeWrite = fn; },
    close: () => close(server),
  };
}

/** A Graph event body with UTC times (`at` is "2026-08-04T16:00:00"). */
export function graphEvent(subject: string, start: string, end: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    subject,
    start: { dateTime: `${start}.0000000`, timeZone: 'UTC' },
    end: { dateTime: `${end}.0000000`, timeZone: 'UTC' },
    isAllDay: false,
    type: 'singleInstance',
    isOrganizer: true,
    attendees: [],
    ...extra,
  };
}
