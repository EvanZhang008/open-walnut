/**
 * `GET` / `POST /api/plugins/mail/messages/:a/:m/invite` through a REAL server.
 *
 * Everything below the route is real: the plugin loader, a fixture provider declaring `rsvp`, the
 * worker-thread cache, ingest with its envelope hash. What this file is for:
 *
 * - The marker's path from a listing to the DTO, and the one rule about it a unit test cannot show:
 *   a listing that stops calling a row an invite rewrites the row, and the row stops saying so.
 * - The refusals that come BEFORE the provider is asked: not an invite, not a response, not JSON.
 * - One answer in flight per invite: a second click while the first is still sending is a 409, and
 *   the provider is asked exactly once.
 * - The caps: every string the calendar hands over was written by whoever sent the invite.
 */
import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from 'vitest';
import fsp from 'node:fs/promises';
import path from 'node:path';
import type { Server as HttpServer } from 'node:http';
import yaml from 'js-yaml';
import { createMockConstants } from '../helpers/mock-constants.js';

vi.mock('../../src/constants.js', () => createMockConstants('mail-invites-route-test'));

import { WALNUT_HOME, CONFIG_FILE, TASKS_FILE } from '../../src/constants.js';
import { mailDatabaseForTesting } from '../../src/integrations/mail/db.js';
import { startServer, stopServer } from '../../src/web/server.js';

const FIXTURE_ID = 'mail-invite-fixture';
const ACCOUNT = 'invite:one';
const INVITE = 'INBOX:900:1';
const NOTE = 'INBOX:900:2';
const CANCELED = 'INBOX:900:3';

/** What the provider was asked, and how it should behave next. Files: the provider runs in the loader's module graph. */
const CALLS_FILE = path.join(WALNUT_HOME, 'invite-fixture-calls.json');
const CONTROL_FILE = path.join(WALNUT_HOME, 'invite-fixture-control.json');

interface Control {
  /** The respond call waits until this flips back to false. */
  holdRespond?: boolean;
  /** The respond call throws this provider refusal. */
  refuse?: string;
  /** The poll stops marking the invite. */
  dropInvite?: boolean;
  /** inviteDetails answers this instead of the default. */
  details?: Record<string, unknown>;
}

async function control(next: Control): Promise<void> {
  await fsp.writeFile(CONTROL_FILE, JSON.stringify(next));
}

async function calls(): Promise<Array<{ method: string; invite: Record<string, unknown>; response?: string }>> {
  try { return JSON.parse(await fsp.readFile(CALLS_FILE, 'utf8')); }
  catch { return []; }
}

let server: HttpServer;
let port = 0;

async function api<T>(method: string, routePath: string, body?: string): Promise<{ status: number; body: T }> {
  const response = await fetch(`http://127.0.0.1:${port}/api/plugins/mail${routePath}`, {
    method,
    headers: { 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body }),
  });
  return { status: response.status, body: await response.json() as T };
}

const invitePath = (messageId: string) => `/messages/${encodeURIComponent(ACCOUNT)}/${encodeURIComponent(messageId)}/invite`;

interface InviteAnswer {
  ok?: boolean;
  invite?: Record<string, unknown>;
  error?: string;
  message?: string;
}

async function writeFixtureProvider(): Promise<void> {
  const dir = path.join(WALNUT_HOME, 'plugins', FIXTURE_ID);
  await fsp.mkdir(path.join(dir, 'dist'), { recursive: true });
  await fsp.writeFile(path.join(dir, 'manifest.json'), JSON.stringify({
    id: FIXTURE_ID,
    name: 'Mail Invite Fixture',
    description: 'A mail provider with meeting invites and a calendar',
    version: '1.0.0',
    apiVersion: 1,
    engines: { walnut: '>=0.0.0' },
    server: 'dist/server.mjs',
    dependencies: { mail: '^1.0.0' },
  }));
  await fsp.writeFile(path.join(dir, 'dist', 'server.mjs'), `
import fs from 'node:fs';

const CALLS = ${JSON.stringify(CALLS_FILE)};
const CONTROL = ${JSON.stringify(CONTROL_FILE)};

function control() {
  try { return JSON.parse(fs.readFileSync(CONTROL, 'utf8')); } catch { return {}; }
}
function record(entry) {
  let held = [];
  try { held = JSON.parse(fs.readFileSync(CALLS, 'utf8')); } catch { held = []; }
  held.push(entry);
  const staging = CALLS + '.' + process.pid + '.tmp';
  fs.writeFileSync(staging, JSON.stringify(held));
  fs.renameSync(staging, CALLS);
}
function refusal(message) {
  const error = new Error(message);
  error.code = 'unsupported';
  error.stage = 'before-data';
  return error;
}

const START = Date.UTC(2026, 9, 22, 22, 0, 0);
let answer = 'none';

function envelopes() {
  const drop = control().dropInvite === true;
  return [
    { uid: 1, subject: 'Mooring review', invite: drop ? undefined : { kind: 'request' } },
    { uid: 2, subject: 'Lunch on Thursday?' },
    { uid: 3, subject: 'Canceled: Slipway walk', invite: { kind: 'canceled' } },
  ].map((one) => ({
    messageId: 'INBOX:900:' + one.uid,
    rfcMessageId: '<invite-' + one.uid + '@example.invalid>',
    mailboxId: 'INBOX',
    from: { name: 'Harbour Office', address: 'office@example.invalid' },
    to: [{ address: 'reader@example.invalid' }],
    subject: one.subject,
    sentAt: Date.UTC(2026, 9, 1, 9, one.uid, 0),
    flags: [],
    attachments: [],
    ...(one.invite ? { invite: one.invite } : {}),
  }));
}

function details() {
  return control().details ?? {
    state: 'open',
    subject: 'Mooring review',
    start: START,
    end: START + 3600000,
    location: 'Room 5',
    organizer: { name: 'Harbour Office', address: 'office@example.invalid' },
    response: answer,
    canRespond: true,
  };
}

export function activate(walnut) {
  const base = walnut.services.require('mail:base');
  const handle = base.registerProvider({
    id: 'invite',
    label: 'Invite fixture',
    capabilities: {
      search: false, watch: false, drafts: false, markRead: false, flags: false, threads: false,
      send: false, sendAsReply: false, bodies: 'text', attachments: 'none', rsvp: true,
    },
    setup: {
      fields: [{ name: 'which', label: 'Which', kind: 'text' }],
      submit: async () => ({
        accountId: '${ACCOUNT}', providerId: 'invite', displayName: 'Invites', address: 'reader@example.invalid', state: 'active',
      }),
    },
    listAccounts: async () => [{
      accountId: '${ACCOUNT}', providerId: 'invite', displayName: 'Invites', address: 'reader@example.invalid', state: 'active',
    }],
    health: async () => ({ state: 'ok', checkedAt: Date.now() }),
    listMailboxes: async () => [{ mailboxId: 'INBOX', name: 'INBOX', role: 'inbox', unread: 0, total: 3 }],
    poll: async (_accountId, request) => ({
      messages: request.mailbox === 'INBOX' ? envelopes() : [],
      cursor: 'c:' + Date.now(),
      more: false,
    }),
    getBody: async () => ({ format: 'text', text: 'Agenda.', bytes: 7 }),
    send: async () => { throw new Error('this fixture cannot send'); },
    inviteDetails: async (_accountId, invite) => {
      record({ method: 'details', invite });
      return details();
    },
    respondToInvite: async (_accountId, invite, response) => {
      record({ method: 'respond', invite, response });
      while (control().holdRespond === true) await new Promise((resolve) => setTimeout(resolve, 50));
      const refuse = control().refuse;
      if (refuse) throw refusal(refuse);
      answer = response === 'accept' ? 'accepted' : response === 'tentative' ? 'tentative' : 'declined';
      return details();
    },
  });
  return { dispose: () => handle.dispose() };
}
`);
}

async function rows<T extends Record<string, unknown>>(sql: string): Promise<T[]> {
  return mailDatabaseForTesting()!.all<T>(sql);
}

beforeAll(async () => {
  await fsp.rm(WALNUT_HOME, { recursive: true, force: true });
  await fsp.mkdir(path.dirname(TASKS_FILE), { recursive: true });
  await fsp.writeFile(TASKS_FILE, JSON.stringify({ version: 1, tasks: [] }));
  await writeFixtureProvider();
  await control({});
  await fsp.writeFile(CONFIG_FILE, yaml.dump({
    version: 1,
    user: { name: 'test' },
    defaults: { priority: 'none' },
    plugins: { mail: { poll_interval_seconds: 3600, retention_days: 3650 } },
  }), 'utf-8');
  server = await startServer({ port: 0, dev: true });
  const address = server.address();
  port = typeof address === 'object' && address ? address.port : 0;

  const created = await api<unknown>('POST', '/accounts', JSON.stringify({ providerId: 'invite', values: { which: 'one' } }));
  expect(created.status).toBe(201);
  const until = Date.now() + 30_000;
  while (Date.now() < until && (await rows('SELECT rowid FROM messages')).length < 3) {
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  expect(await rows('SELECT rowid FROM messages')).toHaveLength(3);
}, 180_000);

beforeEach(async () => {
  await control({});
  await fsp.rm(CALLS_FILE, { force: true });
});

afterAll(async () => {
  await stopServer();
  await fsp.rm(WALNUT_HOME, { recursive: true, force: true }).catch(() => undefined);
});

describe('the marker', () => {
  it('reaches the list DTO for the invites and only for them', async () => {
    const page = await api<{ messages: Array<{ messageId: string; invite?: unknown }> }>(
      'GET', `/messages?account=${encodeURIComponent(ACCOUNT)}&mailbox=INBOX&limit=10`,
    );
    const byId = new Map(page.body.messages.map((one) => [one.messageId, one]));
    expect(byId.get(INVITE)!.invite).toEqual({ kind: 'request' });
    expect(byId.get(CANCELED)!.invite).toEqual({ kind: 'canceled' });
    expect('invite' in byId.get(NOTE)!).toBe(false);
  });

  it('the provider declares rsvp, and the console can read it off the provider row', async () => {
    const providers = await api<{ providers: Array<{ id: string; capabilities: { rsvp?: boolean } }> }>('GET', '/providers');
    expect(providers.body.providers.find((one) => one.id === 'invite')?.capabilities.rsvp).toBe(true);
  });
});

describe('GET /invite', () => {
  it('hands the provider the cached message and relays its answer', async () => {
    const read = await api<InviteAnswer>('GET', invitePath(INVITE));
    expect(read.status).toBe(200);
    expect(read.body.invite).toMatchObject({ state: 'open', response: 'none', canRespond: true, location: 'Room 5' });
    const [call] = await calls();
    expect(call).toMatchObject({
      method: 'details',
      invite: {
        messageId: INVITE,
        subject: 'Mooring review',
        from: { name: 'Harbour Office', address: 'office@example.invalid' },
        kind: 'request',
      },
    });
  });

  it('caps what the sender wrote and never offers buttons it cannot explain', async () => {
    await control({
      details: {
        state: 'canceled',
        subject: 'x'.repeat(5_000),
        location: 'Room\n\n5 '.repeat(400),
        organizer: { name: 'n'.repeat(900), address: 'office@example.invalid' },
        response: 'banana',
        start: 'tomorrow',
        canRespond: true,
      },
    });
    const read = await api<InviteAnswer>('GET', invitePath(INVITE));
    const invite = read.body.invite as Record<string, unknown>;
    expect((invite.subject as string).length).toBe(300);
    expect((invite.location as string).length).toBeLessThanOrEqual(300);
    expect(invite.location).not.toMatch(/\n/);
    expect(((invite.organizer as { name: string }).name).length).toBe(200);
    expect('response' in invite).toBe(false);
    expect('start' in invite).toBe(false);
    // Canceled cannot be answered, whatever the provider claimed, and it says why.
    expect(invite.canRespond).toBe(false);
    expect(invite.reason).toBe('This meeting was canceled.');
  });

  it('refuses an ordinary mail without asking the provider', async () => {
    const read = await api<InviteAnswer>('GET', invitePath(NOTE));
    expect(read.status).toBe(409);
    expect(read.body).toMatchObject({ error: 'not-an-invite', message: 'This message is not a meeting invite.' });
    expect(await calls()).toEqual([]);
  });

  it('a message the cache does not have is a 404', async () => {
    const read = await api<InviteAnswer>('GET', invitePath('INBOX:900:99'));
    expect(read.status).toBe(404);
  });
});

describe('POST /invite', () => {
  it('sends one answer and returns the calendar after it', async () => {
    const sent = await api<InviteAnswer>('POST', invitePath(INVITE), JSON.stringify({ response: 'accept' }));
    expect(sent.status).toBe(200);
    expect(sent.body).toMatchObject({ ok: true, invite: { state: 'open', response: 'accepted' } });
    expect((await calls()).filter((one) => one.method === 'respond').map((one) => one.response)).toEqual(['accept']);
  });

  it('refuses a missing or invented response, and a body that is not JSON, before the provider', async () => {
    for (const body of [JSON.stringify({}), JSON.stringify({ response: 'maybe' }), JSON.stringify({ response: 'ACCEPT' })]) {
      const sent = await api<InviteAnswer>('POST', invitePath(INVITE), body);
      expect(sent.status, body).toBe(400);
      expect(sent.body.error).toBe('invalid');
    }
    const garbled = await api<InviteAnswer>('POST', invitePath(INVITE), '{"response": "accept"');
    expect(garbled.status).toBe(400);
    expect(await calls()).toEqual([]);
  });

  it('refuses to answer an ordinary mail', async () => {
    const sent = await api<InviteAnswer>('POST', invitePath(NOTE), JSON.stringify({ response: 'accept' }));
    expect(sent.status).toBe(409);
    expect(sent.body.error).toBe('not-an-invite');
    expect(await calls()).toEqual([]);
  });

  it('a second click while the first is still sending is a 409, and the provider is asked once', async () => {
    await control({ holdRespond: true });
    const first = api<InviteAnswer>('POST', invitePath(INVITE), JSON.stringify({ response: 'tentative' }));
    const until = Date.now() + 10_000;
    while (Date.now() < until && !(await calls()).some((one) => one.method === 'respond')) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    const second = await api<InviteAnswer>('POST', invitePath(INVITE), JSON.stringify({ response: 'decline' }));
    expect(second.status).toBe(409);
    expect(second.body).toMatchObject({ error: 'in-flight', message: 'Walnut is still sending your answer to this invite.' });
    // A reader reopened meanwhile is told what is on its way, not just the calendar's old answer.
    const meanwhile = await api<InviteAnswer>('GET', invitePath(INVITE));
    expect(meanwhile.body.invite).toMatchObject({ answering: 'tentative' });

    await control({});
    const settled = await first;
    expect(settled.status).toBe(200);
    expect(settled.body.invite).toMatchObject({ response: 'tentative' });
    expect((await calls()).filter((one) => one.method === 'respond').map((one) => one.response)).toEqual(['tentative']);

    // And once it settled, the invite can be answered again (a person changing their mind).
    const again = await api<InviteAnswer>('POST', invitePath(INVITE), JSON.stringify({ response: 'accept' }));
    expect(again.status).toBe(200);
  });

  it('an answer that outlives the budget is a 202, and still lands', async () => {
    await control({ holdRespond: true });
    const started = Date.now();
    const sent = await api<InviteAnswer & { completed?: boolean }>('POST', invitePath(INVITE), JSON.stringify({ response: 'decline' }));
    expect(sent.status).toBe(202);
    expect(sent.body).toMatchObject({ ok: true, completed: false, message: 'Walnut is still sending your answer.' });
    // Inside the 15 s budget plus slack: the browser connection is not pinned past it.
    expect(Date.now() - started).toBeLessThan(20_000);
    await control({});
    const until = Date.now() + 10_000;
    let response: unknown;
    while (Date.now() < until) {
      const read = await api<InviteAnswer>('GET', invitePath(INVITE));
      response = read.body.invite?.response;
      if (response === 'declined') break;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    expect(response).toBe('declined');
  }, 60_000);

  it('a provider refusal reaches the console in the provider own words', async () => {
    await control({ refuse: 'This invite is for a recurring series. Answer it in Outlook.' });
    const sent = await api<InviteAnswer>('POST', invitePath(INVITE), JSON.stringify({ response: 'accept' }));
    expect(sent.status).toBe(409);
    expect(sent.body).toMatchObject({ error: 'unsupported', message: 'This invite is for a recurring series. Answer it in Outlook.' });
  });
});

describe('a listing that stops calling a row an invite', () => {
  it('rewrites the row, and the DTO stops carrying the marker', async () => {
    await control({ dropInvite: true });
    const refreshed = await api<unknown>('POST', `/refresh`, JSON.stringify({ accountId: ACCOUNT }));
    expect([200, 202]).toContain(refreshed.status);
    const until = Date.now() + 30_000;
    let marker: unknown = { kind: 'request' };
    while (Date.now() < until) {
      const page = await api<{ messages: Array<{ messageId: string; invite?: unknown }> }>(
        'GET', `/messages?account=${encodeURIComponent(ACCOUNT)}&mailbox=INBOX&limit=10`,
      );
      marker = page.body.messages.find((one) => one.messageId === INVITE)?.invite;
      if (marker === undefined) break;
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
    expect(marker).toBeUndefined();
    const read = await api<InviteAnswer>('GET', invitePath(INVITE));
    expect(read.status).toBe(409);
  });
});
