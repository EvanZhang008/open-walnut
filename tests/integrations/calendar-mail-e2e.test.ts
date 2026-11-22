/**
 * A mail account brings its calendar, end to end through a real server
 * (startServer({ port: 0, dev: true })): the IMAP plugin's saved account and password, the
 * host's credential broker, the calendar plugin's CalDAV source, and its routes, against a
 * CalDAV server in this process. Only the Mac's EventKit source is a mock (as in every
 * calendar route test), so nothing compiles Swift or reads a real calendar.
 *
 * Covered: "Add its calendar" finds and adds it (and its events show), a Gmail account is told
 * it needs a Google sign-in without its password being tried, edits go to the mail server,
 * "Remove its calendar" takes it out, the experiment off answers as today, and the broker
 * hands a password to the calendar plugin only. Also: a calendar server the person picks
 * ("Use <host>") is saved as the account's `caldav_url` and connected; an event with other
 * people on it is refused whatever `human_confirm` says; the experiment switched in Settings
 * takes effect without a restart.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import fsp from 'node:fs/promises';
import path from 'node:path';
import yaml from 'js-yaml';
import http, { type Server as HttpServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createMockConstants } from '../helpers/mock-constants.js';

vi.mock('../../src/constants.js', () => createMockConstants('calendar-mail-e2e'));

import { CONFIG_FILE, WALNUT_HOME } from '../../src/constants.js';
import { CalendarService, _setCalendarServiceForTest } from '../../src/integrations/calendar/service.js';
import { localIdFor } from '../../src/integrations/mail-imap/config.js';
import { createServiceHandle } from '../../src/core/plugins/service-registry.js';
import type { CoreMailCalendarCredentialsApi } from '../../src/core/calendar/mail-credentials.js';
import { startServer, stopServer } from '../../src/web/server.js';
import { createMockCalendarSource } from '../helpers/mock-calendar-source.js';
import { ics, startFakeCalDav, type FakeCalDavServer } from '../helpers/fake-caldav-server.js';

const ADDRESS = 'pat@example.com';
const GMAIL = 'pat@gmail.com';
const LEE = 'lee@example.org';
const LEE_ACCOUNT = `imap:${localIdFor(LEE)}`;
const ACCOUNT = `imap:${localIdFor(ADDRESS)}`;
const GMAIL_ACCOUNT = `imap:${localIdFor(GMAIL)}`;
const WORK = '/dav/calendars/pat/work/';

let caldav: FakeCalDavServer;
let leeCaldav: FakeCalDavServer;
let redirectors: HttpServer[] = [];
let redirectPort = 0;
let server: HttpServer;
let port = 0;

const api = (p: string) => `http://127.0.0.1:${port}${p}`;
const json = async <T>(res: Response): Promise<T> => (await res.json()) as T;

async function writeConfig(flag: boolean, extra: Record<string, unknown> = {}): Promise<void> {
  const current = (yaml.load(await fsp.readFile(CONFIG_FILE, 'utf-8').catch(() => '')) ?? {}) as Record<string, any>;
  const next = { ...current, experimental: { ...(current.experimental ?? {}), mail_calendars: flag }, ...extra };
  await fsp.writeFile(CONFIG_FILE, yaml.dump(next), 'utf-8');
}

async function sourcesNow(): Promise<Array<{ id: string; kind?: string; account?: string; available: boolean }>> {
  return (await json<{ sources: Array<{ id: string; kind?: string; account?: string; available: boolean }> }>(await fetch(api('/api/calendar/sources')))).sources;
}

beforeAll(async () => {
  caldav = await startFakeCalDav({ username: ADDRESS, password: 'app-pass', calendars: [{ path: WORK, name: 'Mail calendar', color: '#aa3300' }] });
  caldav.put(`${WORK}e1.ics`, ics(['UID:e1', 'DTSTART:20260804T160000Z', 'DTEND:20260804T170000Z', 'SUMMARY:Dentist from mail', 'X-WALNUT-CREATED:TRUE']));
  caldav.put(`${WORK}e2.ics`, ics(['UID:e2', 'DTSTART:20260805T160000Z', 'DTEND:20260805T170000Z', 'SUMMARY:Review with Sam', 'X-WALNUT-CREATED:TRUE', 'ATTENDEE:mailto:sam@example.com']));
  leeCaldav = await startFakeCalDav({ username: LEE, password: 'lee-pass', calendars: [{ path: WORK, name: 'Lee calendar' }] });
  // Lee's calendar setting names "localhost", which sends Walnut to 127.0.0.1: another host.
  const onRequest: http.RequestListener = (_req, res) => { res.writeHead(301, { Location: `${leeCaldav.origin}/.well-known/caldav` }); res.end(); };
  const v4 = http.createServer(onRequest);
  await new Promise<void>((resolve) => v4.listen(0, '127.0.0.1', () => resolve()));
  redirectPort = (v4.address() as AddressInfo).port;
  const v6 = http.createServer(onRequest);
  await new Promise<void>((resolve) => { v6.once('error', () => resolve()); v6.listen(redirectPort, '::1', () => resolve()); });
  redirectors = [v4, v6];
  await fsp.mkdir(path.join(WALNUT_HOME, 'secrets', 'plugins'), { recursive: true });
  // The IMAP plugin's own two stores, as its setup form writes them: settings in config, the
  // password in its secret file. The IMAP server itself is never reached by this test.
  await fsp.writeFile(path.join(WALNUT_HOME, 'secrets', 'plugins', 'mail-imap.json'), JSON.stringify({
    [`password.${localIdFor(ADDRESS)}`]: 'app-pass',
    [`password.${localIdFor(GMAIL)}`]: 'gmail-app-pass',
    [`password.${localIdFor(LEE)}`]: 'lee-pass',
  }), { mode: 0o600 });
  await writeConfig(true, {
    plugins: {
      'mail-imap': {
        accounts: {
          [localIdFor(ADDRESS)]: { address: ADDRESS, imap_host: '127.0.0.1', imap_port: 1, imap_tls: 'tls', caldav_url: `${caldav.origin}/.well-known/caldav` },
          [localIdFor(GMAIL)]: { address: GMAIL, imap_host: 'imap.gmail.com', imap_port: 993, imap_tls: 'tls' },
          [localIdFor(LEE)]: { address: LEE, imap_host: 'imap.mailhost.example', imap_port: 993, imap_tls: 'tls', caldav_url: `http://localhost:${redirectPort}/` },
        },
      },
    },
  });
  _setCalendarServiceForTest(new CalendarService(createMockCalendarSource().source));
  server = await startServer({ port: 0, dev: true });
  const addr = server.address();
  port = typeof addr === 'object' && addr ? addr.port : 0;
}, 120_000);

afterAll(async () => {
  _setCalendarServiceForTest(null);
  await stopServer();
  await caldav.close();
  await leeCaldav.close();
  for (const r of redirectors) r.close();
  await fsp.rm(WALNUT_HOME, { recursive: true, force: true }).catch(() => {});
});

describe('a mail account brings its calendar', () => {
  it('starts with the Mac calendar alone', async () => {
    expect((await sourcesNow()).map((s) => s.id)).toEqual(['eventkit']);
  });

  it('Add its calendar finds it with the saved password, and its events show beside the Mac', async () => {
    const added = await json<{ ok: boolean; source?: { id: string; kind: string; account: string }; calendars?: Array<{ title: string; account: string }> }>(
      await fetch(api(`/api/calendar/mail-accounts/${encodeURIComponent(ACCOUNT)}/calendar`), {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ address: ADDRESS }),
      }),
    );
    expect(added).toMatchObject({ ok: true, source: { id: `caldav:${ACCOUNT}`, kind: 'caldav', account: ACCOUNT } });
    expect(added.calendars).toEqual([expect.objectContaining({ title: 'Mail calendar', account: ADDRESS })]);
    const raw = yaml.load(await fsp.readFile(CONFIG_FILE, 'utf-8')) as Record<string, any>;
    expect(raw.plugins.calendar.mail_calendar_accounts).toEqual([ACCOUNT]);

    const events = await json<{ events: Array<{ title: string; source: string }>; sources: Array<{ id: string }> }>(
      await fetch(api('/api/calendar/events?from=2026-08-03&to=2026-08-09')),
    );
    expect(events.sources.map((s) => s.id)).toEqual(['eventkit', `caldav:${ACCOUNT}`]);
    expect(events.events.find((e) => e.title === 'Dentist from mail')?.source).toBe(`caldav:${ACCOUNT}`);
    expect(events.events.some((e) => e.source === 'eventkit')).toBe(true);
  });

  it('moves a Walnut-made mail event on its server through the same route as the Mac', async () => {
    const events = await json<{ events: Array<{ id: string; title: string }> }>(await fetch(api('/api/calendar/events?from=2026-08-04&to=2026-08-04')));
    const ev = events.events.find((e) => e.title === 'Dentist from mail')!;
    const res = await fetch(api(`/api/calendar/events/${encodeURIComponent(ev.id)}`), {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ start: '2026-08-04T10:00:00', end: '2026-08-04T11:00:00' }),
    });
    expect(res.status).toBe(200);
    expect(caldav.resources.get(`${WORK}e1.ics`)!.ics).toMatch(/DTSTART:\d{8}T\d{6}Z/);
    expect(caldav.resources.get(`${WORK}e1.ics`)!.ics).not.toContain('DTSTART:20260804T160000Z');
  });

  it('refuses to change or delete a mail event with other people on it, even confirmed', async () => {
    const events = await json<{ events: Array<{ id: string; title: string; readonly?: boolean; readonlyReason?: string }> }>(await fetch(api('/api/calendar/events?from=2026-08-05&to=2026-08-05')));
    const ev = events.events.find((e) => e.title === 'Review with Sam')!;
    expect(ev).toMatchObject({ readonly: true, readonlyReason: expect.stringContaining('other people on it') });
    const writes = () => caldav.requests.filter((r) => r.method === 'PUT' || r.method === 'DELETE').length;
    const before = writes();
    const patch = await fetch(api(`/api/calendar/events/${encodeURIComponent(ev.id)}`), {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ start: '2026-08-05T10:00:00', end: '2026-08-05T11:00:00', human_confirm: true }),
    });
    expect(patch.status).toBeGreaterThanOrEqual(400);
    expect(JSON.stringify(await patch.json())).toContain('other people on it');
    const del = await fetch(api(`/api/calendar/events/${encodeURIComponent(ev.id)}?human_confirm=1`), { method: 'DELETE' });
    expect(del.status).toBeGreaterThanOrEqual(400);
    expect(writes()).toBe(before);
  });

  it('a calendar server is used only when this Walnut found it for that account just now', async () => {
    const url = api(`/api/calendar/mail-accounts/${encodeURIComponent(LEE_ACCOUNT)}/calendar`);
    const post = (body: unknown) => fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const picked = `${leeCaldav.origin}/.well-known/caldav`;
    const leeAccountConfig = async () => (yaml.load(await fsp.readFile(CONFIG_FILE, 'utf-8')) as Record<string, any>).plugins['mail-imap'].accounts[localIdFor(LEE)];
    // Named before any add found it: refused, nothing sent there.
    const early = await post({ address: LEE, server: picked });
    expect(early.status).toBe(409);
    expect(leeCaldav.requests).toHaveLength(0);
    // The add finds it behind the redirect and asks the person.
    const found = await json<{ ok: boolean; reason: string; server: string }>(await post({ address: LEE }));
    expect(found).toMatchObject({ ok: false, reason: 'found-server', server: picked });
    expect(leeCaldav.requests).toHaveLength(0);
    // The found one, sent by a session (caller sid) or from another origin: refused as a protected write is.
    for (const headers of [{ 'x-walnut-caller-sid': 'session-1' }, { 'x-walnut-origin': 'host:devbox' }]) {
      const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify({ address: LEE, server: picked }) });
      expect(res.status).toBe(403);
    }
    expect(leeCaldav.requests).toHaveLength(0);
    // Any other server is still refused.
    expect((await post({ address: LEE, server: 'https://calendar.example.net/' })).status).toBe(409);
    expect((await leeAccountConfig()).caldav_url).toBe(`http://localhost:${redirectPort}/`);
    // The one it found, picked: saved as the account's calendar server, then connected.
    const added = await json<{ ok: boolean; source?: { id: string } }>(await post({ address: LEE, server: picked }));
    expect(added).toMatchObject({ ok: true, source: { id: `caldav:${LEE_ACCOUNT}` } });
    expect((await leeAccountConfig()).caldav_url).toBe(picked);
    expect((await leeAccountConfig()).imap_host).toBe('imap.mailhost.example');
    await fetch(url, { method: 'DELETE' });
  });

  it('a Gmail account is told it needs a Google sign-in, and nothing is saved', async () => {
    const before = caldav.requests.length;
    const answer = await json<{ ok: boolean; reason: string; message: string }>(
      await fetch(api(`/api/calendar/mail-accounts/${encodeURIComponent(GMAIL_ACCOUNT)}/calendar`), {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ address: GMAIL }),
      }),
    );
    expect(answer).toMatchObject({ ok: false, reason: 'needs-sign-in' });
    expect(answer.message).toContain('Gmail calendars need a Google sign-in');
    expect(caldav.requests.length).toBe(before);
    const raw = yaml.load(await fsp.readFile(CONFIG_FILE, 'utf-8')) as Record<string, any>;
    expect(raw.plugins.calendar.mail_calendar_accounts).toEqual([ACCOUNT]);
  });

  it('an account with no saved password says so', async () => {
    const answer = await json<{ ok: boolean; reason: string }>(
      await fetch(api('/api/calendar/mail-accounts/outlook%3Aabc/calendar'), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ address: 'pat@hotmail.com' }) }),
    );
    expect(answer).toMatchObject({ ok: false, reason: 'needs-sign-in' });
  });

  it('Remove its calendar takes it out of every answer', async () => {
    const res = await fetch(api(`/api/calendar/mail-accounts/${encodeURIComponent(ACCOUNT)}/calendar`), { method: 'DELETE' });
    expect(await json(res)).toMatchObject({ removed: true });
    expect((await sourcesNow()).map((s) => s.id)).toEqual(['eventkit']);
    const events = await json<{ events: Array<{ source: string }> }>(await fetch(api('/api/calendar/events?from=2026-08-03&to=2026-08-09')));
    expect(events.events.every((e) => e.source === 'eventkit')).toBe(true);
  });

  it('the experiment switched off in Settings takes the mail calendar out at once', async () => {
    await fetch(api(`/api/calendar/mail-accounts/${encodeURIComponent(ACCOUNT)}/calendar`), {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ address: ADDRESS }),
    });
    expect((await sourcesNow()).map((s) => s.id)).toEqual(['eventkit', `caldav:${ACCOUNT}`]);
    const res = await fetch(api('/api/config'), { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ experimental: { mail_calendars: false } }) });
    expect(res.ok).toBe(true);
    await expect.poll(async () => (await sourcesNow()).map((s) => s.id), { timeout: 5000 }).toEqual(['eventkit']);
    await fetch(api('/api/config'), { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ experimental: { mail_calendars: true } }) });
    await expect.poll(async () => (await sourcesNow()).map((s) => s.id), { timeout: 5000 }).toEqual(['eventkit', `caldav:${ACCOUNT}`]);
    await fetch(api(`/api/calendar/mail-accounts/${encodeURIComponent(ACCOUNT)}/calendar`), { method: 'DELETE' });
  });

  it('with the experiment off, the add is refused and config entries are not read', async () => {
    await writeConfig(false, {});
    const raw = yaml.load(await fsp.readFile(CONFIG_FILE, 'utf-8')) as Record<string, any>;
    raw.plugins.calendar = { ...(raw.plugins.calendar ?? {}), mail_calendar_accounts: [ACCOUNT] };
    await fsp.writeFile(CONFIG_FILE, yaml.dump(raw), 'utf-8');
    const answer = await json<{ ok: boolean; reason: string }>(
      await fetch(api(`/api/calendar/mail-accounts/${encodeURIComponent(ACCOUNT)}/calendar`), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' }),
    );
    expect(answer).toMatchObject({ ok: false, reason: 'off' });
    // A config re-read (any settings write) still finds one source.
    await fetch(api('/api/calendar/sources/eventkit'), { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ hidden_calendar_ids: [] }) });
    expect((await sourcesNow()).map((s) => s.id)).toEqual(['eventkit']);
  });
});

describe('the credential broker', () => {
  const as = (consumerId: string | undefined) => createServiceHandle<CoreMailCalendarCredentialsApi>({
    key: 'core:mail-calendar-credentials', publisherId: 'core', ...(consumerId ? { consumerId } : {}),
  });

  it('hands one account to the calendar plugin only', async () => {
    const found = await as('calendar').credentials(ACCOUNT);
    expect(found).toMatchObject({ accountId: ACCOUNT, address: ADDRESS, password: 'app-pass', hosts: { imap: '127.0.0.1' } });
    await expect(as('some-plugin').credentials(ACCOUNT)).rejects.toThrow(/Only the calendar plugin/);
    await expect(as(undefined).credentials(ACCOUNT)).rejects.toThrow(/Only the calendar plugin/);
    expect(await as('calendar').credentials('imap:unknown')).toBeUndefined();
  });

  it('lets only the calendar plugin set a calendar server, and only an https one', async () => {
    await expect(as('some-plugin').setCalendarServer(ACCOUNT, 'https://caldav.example.net/')).rejects.toThrow(/Only the calendar plugin/);
    expect(await as('calendar').setCalendarServer(ACCOUNT, 'http://caldav.example.net/')).toBe(false);
    expect(await as('calendar').setCalendarServer(ACCOUNT, 'https://pat:secret@caldav.example.net/')).toBe(false);
    expect(await as('calendar').setCalendarServer('imap:unknown', 'https://caldav.example.net/')).toBe(false);
  });

  it('takes credentials only from the plugin of that account kind', () => {
    expect(() => as('some-plugin').provide('imap', { credentials: async () => undefined })).toThrow(/Only the mail-imap plugin/);
    expect(() => as('calendar').provide('imap', { credentials: async () => undefined })).toThrow();
  });
});
