/**
 * A mail account's Google or Microsoft calendar by sign-in (sign-in/), against fakes of both
 * providers (tests/helpers/fake-calendar-providers.ts): the sign-in itself (loopback and pasted
 * address, state and PKCE), what it keeps, and the signed-in sources reading with it: a 401
 * renews the token once, a revoked grant says to sign in again, and the token never goes to a
 * host its provider did not name.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fsp from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { createHash } from 'node:crypto';
import { CalendarSignInStore } from '../../src/integrations/calendar/sign-in/store.js';
import { calendarSignInState, completeCalendarSignIn, decideCalendarSignIn, startCalendarSignIn, type SignInDeps } from '../../src/integrations/calendar/sign-in/flow.js';
import { signedInCalendarSource } from '../../src/integrations/calendar/sign-in/sources.js';
import { CALENDAR_SIGN_INS, GOOGLE_CALENDAR_SCOPE, calendarGrantMayGo } from '../../src/integrations/calendar/sign-in/providers.js';
import { checkClient } from '../../src/core/oauth/desktop-oauth.js';
import { DRIVE_SCOPE, makeAccessTokenGetter as driveTokenGetter, readDriveTokens, revokeDriveTokens, writeDriveTokens } from '../../src/core/backup/gdrive-oauth.js';
import { ics } from '../helpers/fake-caldav-server.js';
import {
  GOOGLE_CLIENT, MICROSOFT_CLIENT_ID, startFakeGoogleCalendar, startFakeMicrosoftGraph,
  type FakeGoogleCalendar, type FakeMicrosoftGraph,
} from '../helpers/fake-calendar-providers.js';

const GMAIL = 'pat@gmail.com';
const GMAIL_ACCOUNT = 'imap:gmail-pat';
const OUTLOOK = 'pat@outlook.com';
const OUTLOOK_ACCOUNT = 'imap:outlook-pat';
const WORK = '/dav/calendars/pat/work/';

let google: FakeGoogleCalendar;
let graph: FakeMicrosoftGraph;
let dataDir: string;
let savedEnv: NodeJS.ProcessEnv;
let store: CalendarSignInStore;
let added: string[];

const deps = (): SignInDeps => ({
  store,
  client: async (p) => (p === 'Google'
    ? { client: { clientId: GOOGLE_CLIENT.id, clientSecret: GOOGLE_CLIENT.secret, source: 'custom' }, from: 'calendar' }
    : { client: { clientId: MICROSOFT_CLIENT_ID, source: 'custom' }, from: 'calendar' }),
  afterSignIn: async (accountId) => { added.push(accountId); return { ok: true }; },
});

beforeEach(async () => {
  savedEnv = { ...process.env };
  google = await startFakeGoogleCalendar({ calendars: [{ path: WORK, name: 'Pat (Google)' }] });
  google.caldav.put(`${WORK}g1.ics`, ics(['UID:g1', 'DTSTART:20260804T160000Z', 'DTEND:20260804T170000Z', 'SUMMARY:Google dentist']));
  graph = await startFakeMicrosoftGraph({ calendars: [{ id: 'cal-1', name: 'Calendar', hexColor: '#3366ff', canEdit: true }] });
  Object.assign(process.env, google.env, graph.env);
  dataDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'walnut-cal-sign-in-'));
  store = new CalendarSignInStore(dataDir, async (p) => (await deps().client(p))!.client);
  added = [];
});

afterEach(async () => {
  process.env = savedEnv;
  await google.close();
  await graph.close();
  await fsp.rm(dataDir, { recursive: true, force: true });
});

/** Start a sign-in and return where the provider sends the browser back to (not followed). */
async function landing(accountId: string, address: string, provider: 'Google' | 'Microsoft'): Promise<{ authUrl: string; back: string }> {
  const { authUrl } = await startCalendarSignIn(deps(), accountId, address, provider);
  const consent = await fetch(authUrl, { redirect: 'manual' });
  expect(consent.status).toBe(302);
  return { authUrl, back: consent.headers.get('location')! };
}

async function settled(accountId: string) {
  for (let i = 0; i < 100; i++) {
    const s = calendarSignInState(accountId);
    if (!s.pending && s.outcome) return s.outcome;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error('sign-in did not settle');
}

describe('signing in for a calendar', () => {
  it('Google: the loopback answer saves the sign-in (0600, the signed-in address) and adds the calendar', async () => {
    const { authUrl, back } = await landing(GMAIL_ACCOUNT, GMAIL, 'Google');
    const q = new URL(authUrl).searchParams;
    expect(q.get('login_hint')).toBe(GMAIL);
    expect(q.get('scope')!.split(' ')).toEqual(expect.arrayContaining(['openid', 'email', GOOGLE_CALENDAR_SCOPE]));
    expect(q.get('code_challenge_method')).toBe('S256');
    expect(calendarSignInState(GMAIL_ACCOUNT)).toMatchObject({ pending: true, authUrl });
    const page = await fetch(back);
    expect(await page.text()).toContain('Walnut is connected to your Google calendar.');
    expect(await settled(GMAIL_ACCOUNT)).toEqual({ ok: true, email: GMAIL });
    expect(added).toEqual([GMAIL_ACCOUNT]);
    const saved = (await store.read(GMAIL_ACCOUNT))!;
    expect(saved).toMatchObject({ provider: 'Google', account_id: GMAIL_ACCOUNT, address: GMAIL, email: GMAIL, client_id: GOOGLE_CLIENT.id });
    const file = path.join(dataDir, 'local', 'calendar', 'sign-in-imap_gmail-pat.json');
    expect((await fsp.stat(file)).mode & 0o777).toBe(0o600);
    expect((await fsp.stat(path.dirname(file))).mode & 0o777).toBe(0o700);
    // A new store finds it again from the file.
    const again = new CalendarSignInStore(dataDir, async () => null);
    await again.load();
    expect(again.providerOf(GMAIL_ACCOUNT)).toBe('Google');
  });

  it('the pasted address finishes the same sign-in (the browser was on another device)', async () => {
    const { back } = await landing(OUTLOOK_ACCOUNT, OUTLOOK, 'Microsoft');
    expect(await completeCalendarSignIn(OUTLOOK_ACCOUNT, `  ${back}\n`, 'Microsoft')).toEqual({ ok: true, email: OUTLOOK });
    expect(store.providerOf(OUTLOOK_ACCOUNT)).toBe('Microsoft');
    // Microsoft is asked for its calendar scope and an offline grant.
    expect(graph.oauth.tokenRequests.at(-1)!.get('client_secret')).toBeNull();
    await expect(completeCalendarSignIn(OUTLOOK_ACCOUNT, back, 'Microsoft')).rejects.toThrow(/no longer waiting/);
  });

  it('refuses a wrong state, and a code made for another sign-in (PKCE), keeping nothing', async () => {
    const { back } = await landing(GMAIL_ACCOUNT, GMAIL, 'Google');
    const listener = new URL(back).origin;
    expect((await fetch(`${listener}/?state=wrong&code=x`)).status).toBe(400);
    await expect(completeCalendarSignIn(GMAIL_ACCOUNT, 'state=other&code=x', 'Google')).rejects.toThrow(/no longer waiting/);
    // A code another sign-in got (its own PKCE challenge), sent back with this sign-in's state.
    const other = await fetch(`${google.env.WALNUT_GDRIVE_AUTH_URL}?${new URLSearchParams({
      client_id: GOOGLE_CLIENT.id, redirect_uri: listener, response_type: 'code', state: 'x', code_challenge: 'A'.repeat(43), code_challenge_method: 'S256',
    })}`, { redirect: 'manual' });
    const stolen = new URL(other.headers.get('location')!).searchParams.get('code')!;
    const mine = new URL(back);
    mine.searchParams.set('code', stolen);
    await expect(completeCalendarSignIn(GMAIL_ACCOUNT, mine.toString(), 'Google')).rejects.toThrow(/Invalid code verifier/);
    expect(await settled(GMAIL_ACCOUNT)).toMatchObject({ ok: false, signedIn: false });
    expect(await store.read(GMAIL_ACCOUNT)).toBeNull();
    expect(added).toEqual([]);
  });

  it('checks a client with the provider before it is kept', async () => {
    expect(await checkClient(CALENDAR_SIGN_INS.Microsoft, { clientId: MICROSOFT_CLIENT_ID, source: 'custom' })).toEqual({ ok: true });
    expect(await checkClient(CALENDAR_SIGN_INS.Microsoft, { clientId: 'not-a-client', source: 'custom' })).toMatchObject({ ok: false, message: expect.stringMatching(/invalid_client/) });
    expect(await checkClient(CALENDAR_SIGN_INS.Google, { clientId: GOOGLE_CLIENT.id, clientSecret: 'wrong', source: 'custom' })).toMatchObject({ ok: false });
  });
});

async function signedIn(accountId: string, address: string, provider: 'Google' | 'Microsoft') {
  const { back } = await landing(accountId, address, provider);
  await completeCalendarSignIn(accountId, back, provider);
  return signedInCalendarSource(store, accountId)!;
}

describe('a Google calendar read with its sign-in', () => {
  it('reads over CalDAV with the token, renews it once on a 401, and says sign in again when revoked', async () => {
    const source = await signedIn(GMAIL_ACCOUNT, GMAIL, 'Google');
    expect(source.describe?.()).toMatchObject({ kind: 'caldav', account: GMAIL_ACCOUNT });
    expect((await source.listEvents('2026-08-03', '2026-08-09')).map((e) => e.title)).toEqual(['Google dentist']);
    expect(google.caldav.requests.every((r) => /^Bearer /.test(String(r.headers.authorization)))).toBe(true);

    const refreshes = () => google.oauth.tokenRequests.filter((f) => f.get('grant_type') === 'refresh_token').length;
    google.oauth.expireAccessTokens();
    expect((await source.listEvents('2026-08-03', '2026-08-09')).map((e) => e.title)).toEqual(['Google dentist']);
    expect(refreshes()).toBe(1);

    google.oauth.revokeAll();
    const err = await source.listEvents('2026-08-03', '2026-08-09').then(() => null, (e: Error) => e);
    expect(err).toMatchObject({ code: 'needs-sign-in', message: expect.stringMatching(/revoked or has expired\. Sign in again/) });
    expect(err!.message).not.toMatch(/1\/\/fake-|ya29/);
  });

  it('never sends the token to another host, even one its CalDAV server redirects to', async () => {
    await signedIn(GMAIL_ACCOUNT, GMAIL, 'Google');
    // Google's address now answers with a redirect to another host (the CalDAV fake's port).
    const redirector = http.createServer((req, res) => { res.writeHead(301, { Location: `${google.caldav.origin}${req.url}` }); res.end(); });
    await new Promise<void>((r) => redirector.listen(0, '127.0.0.1', r));
    process.env.WALNUT_GOOGLE_CALDAV_URL = `http://127.0.0.1:${(redirector.address() as AddressInfo).port}/dav/`;
    const before = google.caldav.requests.length;
    const source = signedInCalendarSource(store, GMAIL_ACCOUNT)!;
    await expect(source.listCalendars()).rejects.toThrow(/sends its Google sign-in only to/);
    expect(google.caldav.requests.length).toBe(before);
    redirector.close();
  });
});

describe('an Outlook calendar read through Graph', () => {
  it('reads timed, all-day and recurring events, and keeps events with attendees read-only', async () => {
    graph.put('cal-1', { subject: 'Standup', start: { dateTime: '2026-08-04T16:00:00.0000000', timeZone: 'UTC' }, end: { dateTime: '2026-08-04T16:15:00.0000000', timeZone: 'UTC' }, type: 'occurrence', isOrganizer: true, attendees: [] });
    graph.put('cal-1', { subject: 'Offsite', start: { dateTime: '2026-08-05T00:00:00.0000000', timeZone: 'UTC' }, end: { dateTime: '2026-08-07T00:00:00.0000000', timeZone: 'UTC' }, isAllDay: true, type: 'singleInstance', isOrganizer: true, attendees: [] });
    graph.put('cal-1', { subject: 'Review with Sam', start: { dateTime: '2026-08-06T17:00:00.0000000', timeZone: 'UTC' }, end: { dateTime: '2026-08-06T18:00:00.0000000', timeZone: 'UTC' }, isOrganizer: false, responseStatus: { response: 'accepted' }, organizer: { emailAddress: { address: 'sam@example.com', name: 'Sam' } }, attendees: [{ emailAddress: { address: 'sam@example.com' } }] });
    const source = await signedIn(OUTLOOK_ACCOUNT, OUTLOOK, 'Microsoft');
    graph.pageSize = 2; // two pages
    const events = await source.listEvents('2026-08-03', '2026-08-09');
    expect(events.map((e) => e.title).sort()).toEqual(['Offsite', 'Review with Sam', 'Standup']);
    expect(events.find((e) => e.title === 'Standup')).toMatchObject({ recurring: true, allDay: false, hasAttendees: false, writeSafetyVersion: 1 });
    expect(events.find((e) => e.title === 'Offsite')).toMatchObject({ allDay: true, start: '2026-08-05', end: '2026-08-06' });
    const shared = events.find((e) => e.title === 'Review with Sam')!;
    expect(shared).toMatchObject({ readonly: true, hasAttendees: true, selfStatus: 'accepted', organizerIsCurrentUser: false });
    await expect(source.deleteEvent(shared.id)).rejects.toMatchObject({ code: 'readonly' });
    expect(graph.requests.filter((r) => r.method === 'DELETE')).toEqual([]);
    expect(graph.requests.filter((r) => r.path.startsWith('/v1.0/')).every((r) => r.authorized)).toBe(true);
  });

  it('creates a Walnut event, moves it with If-Match, and refuses a change made meanwhile', async () => {
    const source = await signedIn(OUTLOOK_ACCOUNT, OUTLOOK, 'Microsoft');
    const [cal] = await source.listCalendars();
    const made = await source.createEvent({ calendarId: cal.id, title: 'Focus', start: '2026-08-04T09:00:00', end: '2026-08-04T10:00:00' });
    expect(made).toMatchObject({ title: 'Focus', walnutCreated: true, hasAttendees: false, writeSafetyVersion: 1 });
    const moved = await source.updateEvent(made.id, { start: '2026-08-04T11:00:00', end: '2026-08-04T12:00:00' });
    expect(moved.start).toBe('2026-08-04T11:00:00');
    expect(graph.requests.filter((r) => r.method === 'PATCH').length).toBe(1);
    // Someone changes it in Outlook between Walnut's read and its write: nothing is overwritten.
    const stored = [...graph.events.values()][0];
    graph.beforeWrite = () => { stored.etag = 'W/"changed-in-outlook"'; };
    await expect(source.updateEvent(made.id, { start: '2026-08-04T13:00:00', end: '2026-08-04T14:00:00' })).rejects.toMatchObject({ code: 'conflict' });
    expect(stored.body.start).toMatchObject({ dateTime: expect.stringMatching(/T\d\d:00:00$/) });
    graph.beforeWrite = null;
    await source.deleteEvent(made.id);
    expect(graph.events.size).toBe(0);
  });

  it('does not follow a next page to another host, and sends it nothing', async () => {
    graph.put('cal-1', { subject: 'A', start: { dateTime: '2026-08-04T16:00:00', timeZone: 'UTC' }, end: { dateTime: '2026-08-04T17:00:00', timeZone: 'UTC' }, attendees: [] });
    graph.put('cal-1', { subject: 'B', start: { dateTime: '2026-08-05T16:00:00', timeZone: 'UTC' }, end: { dateTime: '2026-08-05T17:00:00', timeZone: 'UTC' }, attendees: [] });
    let elsewhere = 0;
    const other = http.createServer((_req, res) => { elsewhere++; res.end('{}'); });
    await new Promise<void>((r) => other.listen(0, '127.0.0.1', r));
    const source = await signedIn(OUTLOOK_ACCOUNT, OUTLOOK, 'Microsoft');
    graph.pageSize = 1;
    graph.nextLinkOrigin = `http://127.0.0.1:${(other.address() as AddressInfo).port}`;
    await expect(source.listEvents('2026-08-03', '2026-08-09')).rejects.toThrow(/does not follow that/);
    expect(elsewhere).toBe(0);
    other.close();
  });
});

describe('the account checked against the row', () => {
  it('the same account by its provider\'s rules is kept at once: Gmail dots, googlemail, a work sign-in name on the row\'s domain', async () => {
    google.oauth.signInAs('Pat.Smith+mail@googlemail.com');
    const { back } = await landing('imap:gmail-dots', 'patsmith@gmail.com', 'Google');
    await completeCalendarSignIn('imap:gmail-dots', back, 'Google');
    expect(await settled('imap:gmail-dots')).toEqual({ ok: true, email: 'Pat.Smith+mail@googlemail.com' });
    // Microsoft 365: the sign-in name (UPN) is not the mail address, on the same work domain.
    graph.oauth.signInAs('rlee@corp.example');
    const m365 = await landing('imap:m365-robin', 'robin.lee@corp.example', 'Microsoft');
    await completeCalendarSignIn('imap:m365-robin', m365.back, 'Microsoft');
    expect(await settled('imap:m365-robin')).toEqual({ ok: true, email: 'rlee@corp.example' });
    expect(added).toEqual(['imap:gmail-dots', 'imap:m365-robin']);
    expect(await store.read('imap:m365-robin')).toMatchObject({ address: 'robin.lee@corp.example', email: 'rlee@corp.example' });
  });

  it('another account is held, kept nowhere, until the person uses its calendar', async () => {
    google.oauth.signInAs('lee@gmail.com');
    const { back } = await landing(GMAIL_ACCOUNT, GMAIL, 'Google');
    expect(await completeCalendarSignIn(GMAIL_ACCOUNT, back, 'Google')).toEqual({
      ok: false, signedIn: false, held: { email: 'lee@gmail.com' }, message: 'Signed in as lee@gmail.com. Use lee@gmail.com\'s calendar for this account?',
    });
    expect(calendarSignInState(GMAIL_ACCOUNT)).toMatchObject({ pending: false, outcome: { held: { email: 'lee@gmail.com' } } });
    expect(await store.read(GMAIL_ACCOUNT)).toBeNull();
    expect(added).toEqual([]);
    expect(await decideCalendarSignIn(deps(), GMAIL_ACCOUNT, true)).toEqual({ ok: true, email: 'lee@gmail.com' });
    expect(added).toEqual([GMAIL_ACCOUNT]);
    expect(await store.read(GMAIL_ACCOUNT)).toMatchObject({ address: GMAIL, email: 'lee@gmail.com' });
    expect(calendarSignInState(GMAIL_ACCOUNT)).toEqual({ pending: false, outcome: { ok: true, email: 'lee@gmail.com' } });
    // Decided once: a second answer has nothing to decide.
    await expect(decideCalendarSignIn(deps(), GMAIL_ACCOUNT, false)).rejects.toThrow(/No sign-in waits for a choice/);
  });

  it('another account is held until the person discards it; then nothing is kept and nothing revoked', async () => {
    graph.oauth.signInAs('sam@contoso.example');
    const { back } = await landing(OUTLOOK_ACCOUNT, OUTLOOK, 'Microsoft');
    const listener = await fetch(back);
    expect(listener.status).toBe(200);
    expect(await settled(OUTLOOK_ACCOUNT)).toMatchObject({ ok: false, held: { email: 'sam@contoso.example' } });
    expect(await decideCalendarSignIn(deps(), OUTLOOK_ACCOUNT, false)).toEqual({
      ok: false, signedIn: false, cancelled: true, message: 'Walnut kept nothing of the sign-in as sam@contoso.example.',
    });
    expect(await store.read(OUTLOOK_ACCOUNT)).toBeNull();
    expect(store.providerOf(OUTLOOK_ACCOUNT)).toBeUndefined();
    expect(added).toEqual([]);
    expect(graph.requests.filter((r) => /revoke/i.test(r.path))).toEqual([]);
  });
});

/** Drive backups connect as `address` with the same Google client (a code flow against the fake), as Settings > Backup does. */
async function connectDrive(address: string): Promise<void> {
  const verifier = 'v'.repeat(43);
  const redirect = 'http://127.0.0.1:9/';
  const auth = await fetch(`${google.env.WALNUT_GDRIVE_AUTH_URL}?${new URLSearchParams({
    client_id: GOOGLE_CLIENT.id, redirect_uri: redirect, response_type: 'code', state: 's', login_hint: address, scope: `openid email ${DRIVE_SCOPE}`,
    code_challenge: createHash('sha256').update(verifier).digest('base64url'), code_challenge_method: 'S256',
  })}`, { redirect: 'manual' });
  const code = new URL(auth.headers.get('location')!).searchParams.get('code')!;
  const tokens = await (await fetch(google.env.WALNUT_GDRIVE_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'authorization_code', code, client_id: GOOGLE_CLIENT.id, client_secret: GOOGLE_CLIENT.secret, redirect_uri: redirect, code_verifier: verifier }),
  })).json() as { refresh_token: string; access_token: string };
  await writeDriveTokens(dataDir, { refresh_token: tokens.refresh_token, access_token: tokens.access_token, expires_at: Date.now() + 3_600_000, client_id: GOOGLE_CLIENT.id, connected_at: new Date().toISOString(), email: address });
}

describe('a Google grant Drive backups share (one grant per account and client)', () => {
  const revokes = () => google.requests.filter((r) => r === 'POST /revoke').length;
  const driveRefreshes = () => driveTokenGetter(dataDir, { clientId: GOOGLE_CLIENT.id, clientSecret: GOOGLE_CLIENT.secret, source: 'builtin' })(true);

  beforeEach(() => {
    // Drive's client is the calendar's, and forgetting a sign-in revokes only a grant no one else holds.
    process.env.WALNUT_GDRIVE_CLIENT_ID = GOOGLE_CLIENT.id;
    process.env.WALNUT_GDRIVE_CLIENT_SECRET = GOOGLE_CLIENT.secret;
    store = new CalendarSignInStore(dataDir, async (p) => (await deps().client(p))!.client, { mayRevoke: (t, file) => calendarGrantMayGo(t, file, dataDir) });
  });

  it('Remove on the Gmail row forgets only its own sign-in: Drive keeps refreshing', async () => {
    await connectDrive(GMAIL);
    await signedIn(GMAIL_ACCOUNT, GMAIL, 'Google');
    expect(await store.forget(GMAIL_ACCOUNT)).toBe(true);
    expect(revokes()).toBe(0);
    expect(await store.read(GMAIL_ACCOUNT)).toBeNull();
    await expect(driveRefreshes()).resolves.toMatch(/^ya29\.fake-/);
  });

  it('Drive\'s Disconnect leaves the calendar signed in and reading', async () => {
    await connectDrive(GMAIL);
    const source = await signedIn(GMAIL_ACCOUNT, GMAIL, 'Google');
    await revokeDriveTokens(dataDir);
    expect(revokes()).toBe(0);
    expect(await readDriveTokens(dataDir)).toBeNull();
    google.oauth.expireAccessTokens(); // the next read needs a refresh, which the grant still allows
    expect((await source.listEvents('2026-08-03', '2026-08-09')).map((e) => e.title)).toEqual(['Google dentist']);
  });

  it('the grant is revoked when nothing else holds it, and the fake drops the whole grant (as Google does)', async () => {
    await connectDrive(GMAIL);
    await signedIn(GMAIL_ACCOUNT, GMAIL, 'Google');
    await revokeDriveTokens(dataDir); // the calendar still holds it: no revoke
    // The calendar's client is Drive's: its Remove still never revokes it (Drive may connect again with it).
    await store.forget(GMAIL_ACCOUNT);
    expect(revokes()).toBe(0);
    // A client of the calendar's own (not Drive's), held by no one else: Remove revokes it.
    process.env.WALNUT_GDRIVE_CLIENT_ID = 'another-drive-client.apps.googleusercontent.com';
    await connectDrive(GMAIL);
    await signedIn(GMAIL_ACCOUNT, GMAIL, 'Google');
    await fsp.rm(path.join(dataDir, 'local', 'backup', 'gdrive-token.json'));
    await store.forget(GMAIL_ACCOUNT);
    expect(revokes()).toBe(1);
    await connectDrive(GMAIL);
    await revokeDriveTokens(dataDir);
    expect(revokes()).toBe(2);
    await expect(driveRefreshes()).rejects.toThrow(/not connected/);
  });
});

describe('Outlook writes', () => {
  it('asks Graph for immutable ids, and writes an all-day event in the person\'s own zone', async () => {
    const localZone = 'America/Los_Angeles';
    await signedIn(OUTLOOK_ACCOUNT, OUTLOOK, 'Microsoft');
    const source = signedInCalendarSource(store, OUTLOOK_ACCOUNT, { localZone: () => localZone })!;
    const [cal] = await source.listCalendars();
    await source.createEvent({ calendarId: cal.id, title: 'Holiday', start: '2026-08-07', end: '2026-08-07', allDay: true });
    const stored = [...graph.events.values()][0];
    expect(stored.body).toMatchObject({ isAllDay: true, start: { dateTime: '2026-08-07T00:00:00', timeZone: localZone }, end: { dateTime: '2026-08-08T00:00:00', timeZone: localZone } });
    const api = graph.requests.filter((r) => r.path.startsWith('/v1.0/'));
    expect(api.length).toBeGreaterThan(0);
    expect(api.every((r) => /IdType="ImmutableId"/.test(r.prefer) && /outlook\.timezone="UTC"/.test(r.prefer))).toBe(true);
  });
});
