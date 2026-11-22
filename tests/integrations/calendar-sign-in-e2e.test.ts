/**
 * A Gmail and an Outlook mail account bring their calendars by signing in, end to end through a
 * real server (startServer({ port: 0, dev: true })): the calendar plugin's sign-in routes, the
 * shared desktop sign-in, the signed-in sources and the calendar routes, against fakes of Google
 * (OAuth + CalDAV taking only its token) and Microsoft (OAuth + Graph). The Mac's EventKit
 * source is a mock, as in every calendar route test.
 *
 * The mail accounts are real IMAP accounts of the mail-imap plugin (its config and secret file),
 * so the routes read each account's address and mail servers from the plugin itself.
 *
 * Covered: which accounts sign in (by address, and by mail server for a Google Workspace or
 * Microsoft 365 account on its own domain); a sign-in starts only for a real account of that
 * provider; Google signs in through the loopback (Drive's client reused) and its events show;
 * Microsoft walks through its client (only the person at the Mac sets one, a wrong one refused, a
 * right one kept), signs in by the pasted address and its events show; a revoked sign-in says
 * "sign in again" on its source and keeps its events; signing in again reads it again; Remove
 * forgets the sign-in and leaves the grant Drive's client shares; the experiment off answers as
 * today.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import fsp from 'node:fs/promises';
import path from 'node:path';
import yaml from 'js-yaml';
import type { Server as HttpServer } from 'node:http';
import { createMockConstants } from '../helpers/mock-constants.js';
import { localIdFor } from '../../src/integrations/mail-imap/config.js';

vi.mock('../../src/constants.js', () => createMockConstants('calendar-sign-in-e2e'));

import { CONFIG_FILE, WALNUT_HOME } from '../../src/constants.js';
import { CalendarService, _setCalendarServiceForTest } from '../../src/integrations/calendar/service.js';
import { startServer, stopServer } from '../../src/web/server.js';
import { createMockCalendarSource } from '../helpers/mock-calendar-source.js';
import { ics } from '../helpers/fake-caldav-server.js';
import {
  GOOGLE_CLIENT, MICROSOFT_CLIENT_ID, graphEvent, startFakeGoogleCalendar, startFakeMicrosoftGraph,
  type FakeGoogleCalendar, type FakeMicrosoftGraph,
} from '../helpers/fake-calendar-providers.js';

const GMAIL = 'pat@gmail.com';
const OUTLOOK = 'pat@outlook.com';
/** A Google Workspace and a Microsoft 365 account on their own domains: known by their mail servers. */
const WORKSPACE = 'pat@acme.example';
const M365 = 'sam@contoso.example';
/** Another mail host: no sign-in. */
const OTHER = 'lee@mailhost.example';
const idOf = (address: string) => `imap:${localIdFor(address)}`;
const GMAIL_ACCOUNT = idOf(GMAIL);
const OUTLOOK_ACCOUNT = idOf(OUTLOOK);
const WORK = '/dav/calendars/pat/work/';

let google: FakeGoogleCalendar;
let graph: FakeMicrosoftGraph;
let server: HttpServer;
let port = 0;
const savedEnv = { ...process.env };

const api = (p: string) => `http://127.0.0.1:${port}${p}`;
const json = async <T>(res: Response): Promise<T> => (await res.json()) as T;
const post = (p: string, body: unknown) => fetch(api(p), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
const signInPath = (account: string) => `/api/calendar/mail-accounts/${encodeURIComponent(account)}/sign-in`;

interface SignInState { off?: boolean; provider?: string; client?: { ready: boolean; from?: string }; signedIn?: boolean; email?: string; pending?: boolean; outcome?: { ok: boolean; message?: string } }

async function state(account: string): Promise<SignInState> {
  return json<SignInState>(await fetch(api(signInPath(account))));
}

async function settled(account: string): Promise<SignInState> {
  for (let i = 0; i < 200; i++) {
    const s = await state(account);
    if (!s.pending && s.outcome) return s;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error('sign-in did not settle');
}

async function sources(): Promise<Array<{ id: string; kind?: string; available: boolean; reason?: string; message?: string }>> {
  return (await json<{ sources: Array<{ id: string; kind?: string; available: boolean; reason?: string }> }>(await fetch(api('/api/calendar/sources')))).sources;
}

/** The week's event titles, read from the sources now (`fresh`), not from the cache. */
async function titles(): Promise<string[]> {
  return (await json<{ events: Array<{ title: string }> }>(await fetch(api('/api/calendar/events?from=2026-08-03&to=2026-08-09&fresh=1')))).events.map((e) => e.title);
}

beforeAll(async () => {
  google = await startFakeGoogleCalendar({ calendars: [{ path: WORK, name: 'Pat (Google)' }] });
  google.caldav.put(`${WORK}g1.ics`, ics(['UID:g1', 'DTSTART:20260804T160000Z', 'DTEND:20260804T170000Z', 'SUMMARY:Google dentist']));
  graph = await startFakeMicrosoftGraph({ calendars: [{ id: 'cal-1', name: 'Calendar', canEdit: true }] });
  graph.put('cal-1', graphEvent('Outlook standup', '2026-08-05T16:00:00', '2026-08-05T16:15:00'));
  // Drive backups' Google client (the environment's) serves the calendar too.
  Object.assign(process.env, google.env, graph.env, { WALNUT_GDRIVE_CLIENT_ID: GOOGLE_CLIENT.id, WALNUT_GDRIVE_CLIENT_SECRET: GOOGLE_CLIENT.secret });
  // The IMAP plugin's own two stores, as its setup form writes them: settings in config, the
  // password in its secret file. No IMAP server is reached by this test.
  const accounts: Array<[string, string]> = [[GMAIL, 'imap.gmail.com'], [OUTLOOK, 'outlook.office365.com'], [WORKSPACE, 'imap.gmail.com'], [M365, 'outlook.office365.com'], [OTHER, 'imap.mailhost.example']];
  await fsp.mkdir(path.join(WALNUT_HOME, 'secrets', 'plugins'), { recursive: true });
  await fsp.writeFile(path.join(WALNUT_HOME, 'secrets', 'plugins', 'mail-imap.json'), JSON.stringify(
    Object.fromEntries(accounts.map(([a]) => [`password.${localIdFor(a)}`, 'app-pass'])),
  ), { mode: 0o600 });
  await fsp.writeFile(CONFIG_FILE, yaml.dump({
    experimental: { mail_calendars: true },
    plugins: { 'mail-imap': { accounts: Object.fromEntries(accounts.map(([a, host]) => [localIdFor(a), { address: a, imap_host: host, imap_port: 993, imap_tls: 'tls' }])) } },
  }), 'utf-8');
  _setCalendarServiceForTest(new CalendarService(createMockCalendarSource().source));
  server = await startServer({ port: 0, dev: true });
  const addr = server.address();
  port = typeof addr === 'object' && addr ? addr.port : 0;
}, 120_000);

afterAll(async () => {
  process.env = savedEnv;
  _setCalendarServiceForTest(null);
  await stopServer();
  await google.close();
  await graph.close();
  await fsp.rm(WALNUT_HOME, { recursive: true, force: true }).catch(() => {});
});

describe('Gmail and Outlook calendars by sign-in', () => {
  it('knows which accounts sign in, by address and by mail server, and starts one only for a real account of that provider', async () => {
    const ids = [GMAIL, OUTLOOK, WORKSPACE, M365, OTHER].map(idOf).concat('imap:nobody-here');
    const { providers } = await json<{ providers: Record<string, string> }>(await fetch(api(`/api/calendar/mail-accounts/sign-in-providers?ids=${ids.map(encodeURIComponent).join(',')}`)));
    expect(providers).toEqual({ [idOf(GMAIL)]: 'Google', [idOf(OUTLOOK)]: 'Microsoft', [idOf(WORKSPACE)]: 'Google', [idOf(M365)]: 'Microsoft' });
    // A Workspace account on its own domain signs in as itself.
    const started = await json<{ ok: boolean; authUrl: string }>(await post(signInPath(idOf(WORKSPACE)), {}));
    expect(started.ok).toBe(true);
    expect(new URL(started.authUrl).searchParams.get('login_hint')).toBe(WORKSPACE);
    expect(await json(await post(`${signInPath(idOf(WORKSPACE))}/cancel`, {}))).toEqual({ ok: true, cancelled: true });
    expect(await state(idOf(M365))).toMatchObject({ provider: 'Microsoft', signedIn: false });
    // No listener is opened for an id that is no mail account, nor for an account of another host.
    for (const id of ['imap:nobody-here', idOf(OTHER)]) {
      const res = await post(signInPath(id), {});
      expect(res.status).toBe(400);
      expect(await json(res)).toMatchObject({ ok: false, reason: 'usage' });
    }
    expect(await state(idOf(OTHER))).toEqual({ provider: null });
  });

  it('a sign-in as another account waits for the person\'s choice through the routes', async () => {
    google.oauth.signInAs('lee@gmail.com');
    try {
      const started = await json<{ authUrl: string }>(await post(signInPath(idOf(WORKSPACE)), {}));
      await fetch(started.authUrl);
      expect((await settled(idOf(WORKSPACE))).outcome).toMatchObject({ ok: false, held: { email: 'lee@gmail.com' }, message: "Signed in as lee@gmail.com. Use lee@gmail.com's calendar for this account?" });
      expect(await state(idOf(WORKSPACE))).toMatchObject({ signedIn: false });
      expect((await post(`${signInPath(idOf(WORKSPACE))}/decide`, { use: 'yes' })).status).toBe(400);
      expect(await json(await post(`${signInPath(idOf(WORKSPACE))}/decide`, { use: false }))).toEqual({ ok: false, message: 'Walnut kept nothing of the sign-in as lee@gmail.com.' });
      expect(await state(idOf(WORKSPACE))).toMatchObject({ signedIn: false, outcome: { cancelled: true } });
      expect((await post(`${signInPath(idOf(WORKSPACE))}/decide`, { use: true })).status).toBe(400);
      expect(google.requests).not.toContain('POST /revoke');
    } finally {
      google.oauth.signInAs(undefined);
    }
  });

  it('Google: signs in through the loopback with Drive\'s client, and its events show beside the Mac', async () => {
    expect(await state(GMAIL_ACCOUNT)).toMatchObject({ provider: 'Google', client: { ready: true, from: 'drive' }, signedIn: false, pending: false });
    const started = await json<{ ok: boolean; authUrl: string }>(await post(signInPath(GMAIL_ACCOUNT), {}));
    expect(started.ok).toBe(true);
    // The browser: the provider's page sends it back to Walnut's listener on this machine.
    expect(await (await fetch(started.authUrl)).text()).toContain('Walnut is connected to your Google calendar');
    expect(await settled(GMAIL_ACCOUNT)).toMatchObject({ signedIn: true, email: GMAIL, outcome: { ok: true } });
    expect((await sources()).find((s) => s.id === `caldav:${GMAIL_ACCOUNT}`)).toMatchObject({ kind: 'caldav', available: true });
    expect(await titles()).toContain('Google dentist');
    const raw = yaml.load(await fsp.readFile(CONFIG_FILE, 'utf-8')) as Record<string, any>;
    expect(raw.plugins.calendar.mail_calendar_accounts).toEqual([GMAIL_ACCOUNT]);
    // Tokens are never in config.
    expect(await fsp.readFile(CONFIG_FILE, 'utf-8')).not.toMatch(/1\/\/fake-|ya29\./);
  });

  it('Microsoft: a client is checked before it is kept, then the pasted address signs in', async () => {
    expect(await state(OUTLOOK_ACCOUNT)).toMatchObject({ provider: 'Microsoft', client: { ready: false } });
    const none = await json<{ ok: boolean; reason: string }>(await post(signInPath(OUTLOOK_ACCOUNT), {}));
    expect(none).toMatchObject({ ok: false, reason: 'no-client' });
    // An agent cannot set, replace or remove the client (the app the person's consent page names).
    for (const sent of [{ client_id: MICROSOFT_CLIENT_ID }, { client_id: '' }]) {
      const asAgent = await fetch(api('/api/calendar/sign-in-clients/Microsoft'), { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-walnut-caller-sid': 'some-session' }, body: JSON.stringify(sent) });
      expect(asAgent.status).toBe(403);
      expect(await json(asAgent)).toMatchObject({ ok: false, reason: 'human-approval-required' });
    }
    expect(await json(await fetch(api('/api/calendar/sign-in-clients/Microsoft')))).toEqual({ ready: false });
    expect(await json(await post('/api/calendar/sign-in-clients/Microsoft', { client_id: 'not-registered' }))).toMatchObject({ ok: false, message: expect.stringMatching(/does not accept this client/) });
    expect(await json(await post('/api/calendar/sign-in-clients/Microsoft', { client_id: MICROSOFT_CLIENT_ID }))).toMatchObject({ ok: true, client: { ready: true, from: 'calendar' } });
    const started = await json<{ authUrl: string }>(await post(signInPath(OUTLOOK_ACCOUNT), {}));
    // The browser was on another device: the person pastes where it landed.
    const back = (await fetch(started.authUrl, { redirect: 'manual' })).headers.get('location')!;
    expect(await json(await post(`${signInPath(OUTLOOK_ACCOUNT)}/complete`, { url: back }))).toEqual({ ok: true });
    expect((await sources()).find((s) => s.id === `caldav:${OUTLOOK_ACCOUNT}`)).toMatchObject({ kind: 'graph', available: true });
    expect(await titles()).toEqual(expect.arrayContaining(['Google dentist', 'Outlook standup']));
  });

  it('a revoked sign-in says to sign in again and keeps the events it read; signing in again reads it again', async () => {
    google.oauth.revokeAll();
    expect(await titles()).toContain('Google dentist');
    const gone = (await sources()).find((s) => s.id === `caldav:${GMAIL_ACCOUNT}`)!;
    expect(gone).toMatchObject({ available: false, reason: 'needs-sign-in', message: expect.stringMatching(/Sign in again/) });
    const started = await json<{ authUrl: string }>(await post(signInPath(GMAIL_ACCOUNT), {}));
    await fetch(started.authUrl);
    expect(await settled(GMAIL_ACCOUNT)).toMatchObject({ outcome: { ok: true } });
    expect((await sources()).find((s) => s.id === `caldav:${GMAIL_ACCOUNT}`)).toMatchObject({ available: true });
    expect(await titles()).toContain('Google dentist');
  });

  it('Remove its calendar forgets the sign-in, and leaves the grant Drive\'s client shares at Google', async () => {
    const file = path.join(WALNUT_HOME, 'local', 'calendar', `sign-in-${GMAIL_ACCOUNT.replace(':', '_')}.json`);
    await fsp.access(file);
    // Drive backups' client: the row says Walnut stays in the Google account's app list.
    expect(await state(GMAIL_ACCOUNT)).toMatchObject({ signedIn: true, keepsGrant: true });
    const res = await fetch(api(`/api/calendar/mail-accounts/${encodeURIComponent(GMAIL_ACCOUNT)}/calendar`), { method: 'DELETE' });
    expect(await json(res)).toMatchObject({ removed: true });
    await expect(fsp.access(file)).rejects.toThrow();
    // Signed in with Drive backups' client: revoking would end Drive's grant too.
    expect(google.requests).not.toContain('POST /revoke');
    expect(await state(GMAIL_ACCOUNT)).toMatchObject({ signedIn: false });
    expect((await sources()).map((s) => s.id)).toEqual(['eventkit', `caldav:${OUTLOOK_ACCOUNT}`]);
    expect(await titles()).not.toContain('Google dentist');
  });

  it('with the experiment off, nothing signs in and no mail calendar is read', async () => {
    const flag = (on: boolean) => fetch(api('/api/config'), { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ experimental: { mail_calendars: on } }) });
    expect((await flag(false)).ok).toBe(true);
    expect(await state(GMAIL_ACCOUNT)).toEqual({ off: true });
    expect(await json(await post(signInPath(GMAIL_ACCOUNT), {}))).toMatchObject({ ok: false, reason: 'off' });
    expect(await json(await post('/api/calendar/sign-in-clients/Microsoft', { client_id: '' }))).toMatchObject({ ok: false, reason: 'off' });
    expect(await json(await post(`${signInPath(GMAIL_ACCOUNT)}/cancel`, {}))).toMatchObject({ ok: false, reason: 'off' });
    await expect.poll(async () => (await sources()).map((s) => s.id), { timeout: 5000 }).toEqual(['eventkit']);
    // On again: the signed-in Outlook calendar comes back with no new sign-in.
    await flag(true);
    await expect.poll(async () => (await sources()).map((s) => s.id), { timeout: 5000 }).toEqual(['eventkit', `caldav:${OUTLOOK_ACCOUNT}`]);
  });
});
