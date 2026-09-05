/**
 * The IMAP provider against a fake ImapFlow, plus the MIME half against a real message.
 *
 * No socket and no server here on purpose: this file grades the parts that are hard to observe
 * against a live mailbox and easy to get wrong, and the one live check runs separately in
 * mail-imap-live.test.ts.
 *
 * The transport facts pinned below are each a real bug if forgotten:
 *
 * - `UID n:*` returns AT LEAST ONE message even when nothing is at or above n, so an unfiltered
 *   poll re-reports a quiet mailbox's newest message forever.
 * - A UID means nothing without UIDVALIDITY, so the cursor carries it and a change answers
 *   `reset: true` rather than silently returning nothing.
 * - A mailbox name is nearly arbitrary text: "Projects/2026: old" is legal, so the message handle
 *   is parsed from the RIGHT.
 * - IMAP runs one command at a time per connection. A SELECT interleaved with another caller's
 *   FETCH reads the WRONG mailbox, which is a data bug rather than an error.
 * - Nothing over the byte cap is parsed at all. One multi-megabyte MIME parse is CPU work on the
 *   single event loop every route shares.
 * - The password reaches the transport and nothing else, least of all a log line.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  ImapPool,
  setImapClientFactory,
  toProviderError,
  type ImapClient,
  type ImapConnectOptions,
  type ImapFetchedMessage,
  type ImapListEntry,
} from '../../src/integrations/mail-imap/client.js';
import { accountIdFor, ImapAccountStore, localIdFor } from '../../src/integrations/mail-imap/config.js';
import {
  decodeCursor,
  decodeMessageId,
  encodeCursor,
  encodeMessageId,
  mailboxRole,
} from '../../src/integrations/mail-imap/coords.js';
import {
  attachmentsFromStructure,
  MAX_SOURCE_BYTES,
  messageIdList,
  parseHeaders,
  parseMime,
  setMimeParserForTesting,
} from '../../src/integrations/mail-imap/mime.js';
import { createImapProvider } from '../../src/integrations/mail-imap/provider.js';
import type { MailProviderSpec } from '../../src/integrations/mail/types.js';

const FIXTURES = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'fixtures', 'mail');
const ADDRESS = 'alice@example.invalid';
const ACCOUNT_ID = accountIdFor(ADDRESS);
const PASSWORD = 'app-password-not-a-real-one';

interface FakeMessage {
  uid: number;
  subject: string;
  messageId: string;
  date: Date;
  flags: string[];
  headers?: string;
  bodyStructure?: unknown;
  size?: number;
}

/** Everything the fake server answers with, and everything it records. */
interface Wire {
  capabilities: string[];
  listing: ImapListEntry[];
  boxes: Record<string, { uidValidity: string; messages: FakeMessage[] }>;
  source: Buffer | null;
  sourceSize?: number;
  /** What the server says the fetched message is made of. `null` = the server sent none. */
  sourceStructure: unknown;
  /** Answer the fetch with no RFC822.SIZE at all, the way some servers do. */
  noSize: boolean;
  /** Ordered command log. Interleaving shows up here and nowhere else. */
  commands: string[];
  connects: number;
  connectOptions: ImapConnectOptions[];
  failConnectWith: unknown;
  failListWith: unknown;
  hangOn: string | null;
  flagOps: Array<{ range: string; flags: string[]; add: boolean; uid: boolean }>;
  gate: Promise<void> | null;
  fireExists: (() => void) | null;
  /** Simulate the socket going away: the connection sees `close` and builds a new client. */
  dropClient: (() => void) | null;
}

let wire: Wire;
const logLines: string[] = [];
const log = {
  debug: (message: string, meta?: Record<string, unknown>) => logLines.push(`${message} ${JSON.stringify(meta ?? {})}`),
  info: (message: string, meta?: Record<string, unknown>) => logLines.push(`${message} ${JSON.stringify(meta ?? {})}`),
  warn: (message: string, meta?: Record<string, unknown>) => logLines.push(`${message} ${JSON.stringify(meta ?? {})}`),
};

class FakeImap implements ImapClient {
  usable = true;
  readonly capabilities: Set<string>;
  private readonly listeners = new Map<string, Array<(payload: unknown) => void>>();
  private open = '';

  constructor(readonly options: ImapConnectOptions) {
    this.capabilities = new Set(wire.capabilities);
  }

  private async step(name: string): Promise<void> {
    wire.commands.push(name);
    if (wire.hangOn === name) await new Promise(() => undefined);
    if (wire.gate) await wire.gate;
  }

  async connect(): Promise<void> {
    wire.connects += 1;
    wire.connectOptions.push(this.options);
    if (wire.failConnectWith) throw wire.failConnectWith;
    wire.dropClient = () => {
      this.usable = false;
      for (const one of this.listeners.get('close') ?? []) one(undefined);
      this.listeners.delete('exists');
      wire.fireExists = null;
    };
  }

  async logout(): Promise<void> { wire.commands.push('logout'); }

  close(): void { wire.commands.push('close'); }

  async list(): Promise<ImapListEntry[]> {
    await this.step('list');
    if (wire.failListWith) throw wire.failListWith;
    return wire.listing;
  }

  async mailboxOpen(mailbox: string) {
    await this.step(`open ${mailbox}`);
    const box = wire.boxes[mailbox];
    if (!box) throw new Error(`no such mailbox: ${mailbox}`);
    this.open = mailbox;
    return { path: mailbox, uidValidity: box.uidValidity, exists: box.messages.length };
  }

  async *fetch(range: string): AsyncIterable<ImapFetchedMessage> {
    await this.step(`fetch ${this.open} ${range}`);
    const box = wire.boxes[this.open]!;
    const from = Number(range.split(':')[0]) || 1;
    // The quirk, reproduced exactly: `n:*` never answers empty, so a range past the end still
    // hands back the newest message and the caller is the one that has to filter it out.
    const above = box.messages.filter((message) => message.uid >= from);
    const answer = above.length > 0 ? above : box.messages.slice(-1);
    for (const message of answer) {
      yield {
        uid: message.uid,
        size: message.size ?? 1_024,
        flags: new Set(message.flags),
        envelope: {
          date: message.date,
          subject: message.subject,
          messageId: message.messageId,
          from: [{ name: 'Alice Bell', address: ADDRESS }],
          to: [{ address: 'me@example.invalid' }],
        },
        internalDate: message.date,
        ...(message.headers ? { headers: Buffer.from(message.headers, 'utf8') } : {}),
        ...(message.bodyStructure ? { bodyStructure: message.bodyStructure } : {}),
      };
    }
  }

  async fetchOne(range: string): Promise<ImapFetchedMessage | false> {
    await this.step(`fetchOne ${this.open} ${range}`);
    if (!wire.source) return false;
    return {
      uid: Number(range),
      ...(wire.noSize ? {} : { size: wire.sourceSize ?? wire.source.byteLength }),
      source: wire.source,
      ...(wire.sourceStructure ? { bodyStructure: wire.sourceStructure } : {}),
    };
  }

  async messageFlagsAdd(range: string, flags: string[], options?: unknown): Promise<boolean> {
    await this.step('flagsAdd');
    wire.flagOps.push({ range, flags, add: true, uid: (options as { uid?: boolean } | undefined)?.uid === true });
    return true;
  }

  async messageFlagsRemove(range: string, flags: string[], options?: unknown): Promise<boolean> {
    await this.step('flagsRemove');
    wire.flagOps.push({ range, flags, add: false, uid: (options as { uid?: boolean } | undefined)?.uid === true });
    return true;
  }

  on(event: string, listener: (payload: unknown) => void): this {
    const list = this.listeners.get(event) ?? [];
    list.push(listener);
    this.listeners.set(event, list);
    if (event === 'exists') {
      wire.fireExists = () => { for (const one of this.listeners.get('exists') ?? []) one(undefined) };
    }
    return this;
  }

  removeAllListeners(event?: string): this {
    if (event) this.listeners.delete(event);
    else this.listeners.clear();
    if (!event || event === 'exists') wire.fireExists = null;
    return this;
  }
}

function message(uid: number, subject: string, extra: Partial<FakeMessage> = {}): FakeMessage {
  return {
    uid,
    subject,
    messageId: `<m${uid}@example.invalid>`,
    date: new Date(Date.UTC(2026, 0, 10 + uid, 9, 0, 0)),
    flags: [],
    ...extra,
  };
}

function freshWire(): Wire {
  return {
    capabilities: ['IMAP4rev1', 'IDLE', 'SPECIAL-USE'],
    listing: [
      { path: 'INBOX', specialUse: '\\Inbox', status: { messages: 3, unseen: 1 } },
      { path: 'Projects/2026', status: { messages: 1, unseen: 0 } },
      { path: 'Papierkorb', flags: ['\\Trash'], status: { messages: 0, unseen: 0 } },
    ],
    boxes: {
      INBOX: { uidValidity: '9001', messages: [message(1, 'Kickoff'), message(2, 'Second thoughts')] },
      'Projects/2026': { uidValidity: '9001', messages: [message(1, 'Filed away')] },
    },
    source: null,
    noSize: false,
    // The fixture really is multipart/alternative with a text part plus an html part.
    sourceStructure: {
      type: 'multipart/mixed',
      childNodes: [
        {
          type: 'multipart/alternative',
          childNodes: [
            { part: '1.1', type: 'text/plain', size: 120 },
            { part: '1.2', type: 'text/html', size: 180 },
          ],
        },
        { part: '2', type: 'text/csv', disposition: 'attachment', dispositionParameters: { filename: 'summary.csv' } },
      ],
    },
    commands: [],
    connects: 0,
    connectOptions: [],
    failConnectWith: null,
    failListWith: null,
    hangOn: null,
    flagOps: [],
    gate: null,
    fireExists: null,
    dropClient: null,
  };
}

/** A store over an in-memory config and secret bag, shaped like the host's. */
function makeStore() {
  let config: Record<string, unknown> = {};
  const secrets = new Map<string, string>();
  const host = {
    config: {
      get: async () => config,
      patch: async (patch: Record<string, unknown>) => { config = { ...config, ...patch }; return config },
    },
    secrets: {
      get: async (key: string) => secrets.get(key),
      set: async (key: string, value: string) => { secrets.set(key, value) },
      delete: async (key: string) => { secrets.delete(key) },
      list: async () => [...secrets.keys()],
    },
  };
  return { store: new ImapAccountStore(host as never), config: () => config, secrets };
}

interface Wired {
  provider: MailProviderSpec;
  pool: ImapPool;
  store: ImapAccountStore;
  config: () => Record<string, unknown>;
  secrets: Map<string, string>;
}

/** A provider over its own empty store, ready for either `submit` or a seeded account. */
function buildProvider(commandTimeoutMs?: number): Wired {
  const made = makeStore();
  const pool = new ImapPool({
    settings: (accountId) => made.store.settings(accountId),
    password: (accountId) => made.store.password(accountId),
    log,
    ...(commandTimeoutMs !== undefined ? { commandTimeoutMs } : {}),
  });
  return {
    provider: createImapProvider({ store: made.store, pool, log }),
    pool,
    store: made.store,
    config: made.config,
    secrets: made.secrets,
  };
}

/** The same provider with the account already saved, exactly as `submit` would have saved it. */
async function withAccount(commandTimeoutMs?: number): Promise<Wired> {
  const wired = buildProvider(commandTimeoutMs);
  await wired.store.save({
    address: ADDRESS, host: 'imap.example.invalid', port: 993, tls: 'tls',
    password: PASSWORD, displayName: 'Alice',
  });
  wire.commands.length = 0;
  wire.connects = 0;
  wire.connectOptions.length = 0;
  return wired;
}

let live: Wired;

beforeAll(() => {
  setImapClientFactory(async (options) => new FakeImap(options));
});

afterAll(async () => {
  setImapClientFactory(null);
  setMimeParserForTesting(null);
  await live?.pool.disposeAll();
});

beforeEach(async () => {
  await live?.pool.disposeAll();
  wire = freshWire();
  logLines.length = 0;
  live = await withAccount();
});

describe('the cursor', () => {
  it('round-trips, and refuses anything it did not write', () => {
    expect(encodeCursor('9001', 42)).toBe('9001:42');
    expect(decodeCursor('9001:42')).toEqual({ uidValidity: '9001', lastUid: 42 });
    expect(decodeCursor('9001:0')).toEqual({ uidValidity: '9001', lastUid: 0 });

    // A cursor that cannot be read has to mean "resync", never "start from 0 and hope": the
    // second reading would silently skip every message the provider had already handed over.
    for (const junk of [undefined, '', 'abc', '9001', ':42', '9001:', '9001:x', '9001:-1', 'v2:9001:42']) {
      expect(decodeCursor(junk), `cursor ${JSON.stringify(junk)}`).toBeUndefined();
    }
  });
});

describe('the message handle', () => {
  it.each([
    ['INBOX', '9001', 7],
    ['Projects/2026', '9001', 7],
    ['Notes: 2026', '9001', 7],
    ['INBOX.Sent', '12', 1],
    ['a:b:c/d:e', '4294967295', 999_999],
  ])('round-trips %j', (mailbox, uidValidity, uid) => {
    const handle = encodeMessageId(mailbox, uidValidity, uid);
    // Parsed from the RIGHT: the two numeric tails are the coordinates and everything before
    // them is the name, colons and all. Splitting from the left loses every real mailbox name.
    expect(decodeMessageId(handle)).toEqual({ mailbox, uidValidity, uid });
  });

  it.each(['', 'INBOX', 'INBOX:9001', ':9001:1', 'INBOX:x:1', 'INBOX:9001:0', 'INBOX:9001:x'])(
    'refuses %j',
    (handle) => {
      expect(decodeMessageId(handle)).toBeUndefined();
    },
  );
});

describe('mailbox roles', () => {
  it('prefer an override, then SPECIAL-USE, then an English name, then other', () => {
    expect(mailboxRole({ path: 'INBOX', specialUse: '\\Inbox' })).toBe('inbox');
    expect(mailboxRole({ path: 'Archive', flags: ['\\All'] })).toBe('archive');
    expect(mailboxRole({ path: 'Papierkorb', flags: ['\\Trash'] })).toBe('trash');
    // The server's flag loses to what the user said, and only to that.
    expect(mailboxRole({ path: 'Papierkorb', flags: ['\\Trash'] }, { Papierkorb: 'archive' })).toBe('archive');
    expect(mailboxRole({ path: 'Papierkorb', flags: ['\\Trash'] }, { Papierkorb: 'nonsense' })).toBe('trash');

    // Names, only when the server said nothing.
    expect(mailboxRole({ path: 'inbox' })).toBe('inbox');
    expect(mailboxRole({ path: 'INBOX.Sent Items' })).toBe('sent');
    expect(mailboxRole({ path: 'Deleted Items' })).toBe('trash');
    expect(mailboxRole({ path: 'All Mail' })).toBe('archive');

    // A localized name is NOT guessed at. Turning "Borradores" into an archive is how a user's
    // drafts disappear from the console, and `other` is the honest answer.
    expect(mailboxRole({ path: 'Borradores' })).toBe('other');
    expect(mailboxRole({ path: 'Projects/2026' })).toBe('other');
  });
});

describe('account setup', () => {
  it('proves the credential with a real command before storing anything', async () => {
    const { provider, config, secrets } = buildProvider();

    const account = await provider.setup.submit({
      address: ADDRESS,
      password: PASSWORD,
      imap_host: 'imap.example.invalid',
      imap_port: '993',
      imap_tls: 'tls',
    });

    expect(account).toMatchObject({ accountId: ACCOUNT_ID, providerId: 'imap', address: ADDRESS, state: 'active' });
    // A LIST, not just a connect: a server accepts a TCP connection and a greeting from anybody,
    // and only a real command proves the login went through.
    expect(wire.commands).toContain('list');
    expect(config()).toEqual({
      accounts: {
        [localIdFor(ADDRESS)]: {
          address: ADDRESS,
          imap_host: 'imap.example.invalid',
          imap_port: 993,
          imap_tls: 'tls',
          display_name: ADDRESS,
        },
      },
    });
    // The password is in the secret store and NOWHERE else: not in the config, not in a log line.
    expect(secrets.get(`password.${localIdFor(ADDRESS)}`)).toBe(PASSWORD);
    expect(JSON.stringify(config())).not.toContain(PASSWORD);
    expect(logLines.join('\n')).not.toContain(PASSWORD);
    // It did reach the transport, which is the one place it belongs.
    expect(wire.connectOptions[0]!.auth).toEqual({ user: ADDRESS, pass: PASSWORD });
    expect(wire.connectOptions[0]!.logger).toBe(false);
    // And the probe connection is thrown away rather than joining the pool.
    expect(wire.commands).toContain('logout');
  });

  it('stores nothing at all when the server rejects the sign-in', async () => {
    const { provider, config, secrets } = buildProvider();
    wire.failListWith = Object.assign(new Error('Invalid credentials'), { authenticationFailed: true });

    await expect(provider.setup.submit({
      address: ADDRESS,
      password: 'wrong',
      imap_host: 'imap.example.invalid',
    })).rejects.toMatchObject({ code: 'auth' });

    // The whole point of probing before writing: a failed setup leaves the box exactly as it was.
    expect(config()).toEqual({});
    expect([...secrets.keys()]).toEqual([]);
  });

  it('defaults the port from the encryption choice and refuses a half-filled form', async () => {
    const { provider } = buildProvider();

    await provider.setup.submit({
      address: 'bob@example.invalid',
      password: PASSWORD,
      imap_host: 'imap.example.invalid',
      imap_tls: 'starttls',
    });
    expect(wire.connectOptions[0]).toMatchObject({ port: 143, secure: false });

    await expect(provider.setup.submit({ address: ADDRESS, password: PASSWORD }))
      .rejects.toMatchObject({ code: 'invalid' });
  });
});

describe('a poll', () => {
  it('asks from the cursor, filters the n:* quirk, and reports whether more is behind it', async () => {
    const first = await live.provider.poll(ACCOUNT_ID, { mailbox: 'INBOX', limit: 50 });

    expect(first.messages.map((one) => one.messageId)).toEqual(['INBOX:9001:1', 'INBOX:9001:2']);
    expect(first.cursor).toBe('9001:2');
    expect(first.more).toBe(false);
    expect(first.reset).toBeUndefined();
    expect(wire.commands).toEqual(['open INBOX', 'fetch INBOX 1:*']);
    // Epoch milliseconds, and the header string only when the server sent one.
    expect(first.messages[1]).toMatchObject({
      rfcMessageId: '<m2@example.invalid>',
      mailboxId: 'INBOX',
      from: { name: 'Alice Bell', address: ADDRESS },
      subject: 'Second thoughts',
      sentAt: Date.UTC(2026, 0, 12, 9, 0, 0),
    });

    // Nothing new. The server still answers with its newest message because `n:*` cannot be
    // empty, and an unfiltered provider would re-report it on every poll forever.
    wire.commands.length = 0;
    const quiet = await live.provider.poll(ACCOUNT_ID, { mailbox: 'INBOX', limit: 50, cursor: first.cursor });
    expect(wire.commands).toEqual(['open INBOX', 'fetch INBOX 3:*']);
    expect(quiet.messages).toEqual([]);
    expect(quiet.cursor).toBe('9001:2');
    expect(quiet.more).toBe(false);
  });

  it('caps the page and says more when it filled', async () => {
    wire.boxes.INBOX!.messages = [1, 2, 3, 4, 5].map((uid) => message(uid, `Note ${uid}`));

    const page = await live.provider.poll(ACCOUNT_ID, { mailbox: 'INBOX', limit: 2 });

    expect(page.messages.map((one) => one.messageId)).toEqual(['INBOX:9001:1', 'INBOX:9001:2']);
    expect(page.cursor).toBe('9001:2');
    // Saying `false` here would leave a backfill stuck at one page per tick.
    expect(page.more).toBe(true);
  });

  it('answers reset when UIDVALIDITY changed, and starts again from the beginning', async () => {
    const stale = encodeCursor('8000', 900);

    const result = await live.provider.poll(ACCOUNT_ID, { mailbox: 'INBOX', limit: 50, cursor: stale });

    // Every UID behind that cursor is void, so the fetch starts at 1 rather than at 901: asking
    // from 901 under a new generation would skip the whole mailbox.
    expect(wire.commands).toEqual(['open INBOX', 'fetch INBOX 1:*']);
    expect(result.reset).toBe(true);
    expect(result.cursor).toBe('9001:2');
    expect(result.messages.map((one) => one.messageId)).toEqual(['INBOX:9001:1', 'INBOX:9001:2']);
  });

  it('carries the References chain and the verbatim Date, which the envelope loses', async () => {
    wire.boxes.INBOX!.messages = [message(1, 'Re: notes', {
      headers: [
        'Date: Sat, 10 Jan 2026 09:15:00 +0900',
        'Message-ID: <m1@example.invalid>',
        'In-Reply-To: <m0@example.invalid>',
        'References: <root@example.invalid>',
        ' <m0@example.invalid>',
      ].join('\r\n'),
    })];

    const [envelope] = (await live.provider.poll(ACCOUNT_ID, { mailbox: 'INBOX', limit: 50 })).messages;

    expect(envelope!.sentAtHeader).toBe('Sat, 10 Jan 2026 09:15:00 +0900');
    expect(envelope!.inReplyTo).toBe('<m0@example.invalid>');
    // Folded across two lines on the wire, one chain here. Splitting on every newline is how a
    // thread becomes several broken ones.
    expect(envelope!.references).toEqual(['<root@example.invalid>', '<m0@example.invalid>']);
  });

  it('carries attachment metadata straight from BODYSTRUCTURE, with no download', async () => {
    wire.boxes.INBOX!.messages = [message(1, 'With a file', {
      bodyStructure: {
        part: '', type: 'multipart/mixed', parameters: { name: 'ignored-on-a-multipart' },
        childNodes: [
          { part: '1', type: 'text/plain', size: 400 },
          {
            part: '2', type: 'application/pdf', size: 90_000,
            disposition: 'attachment', dispositionParameters: { filename: 'report.pdf' },
          },
        ],
      },
    })];

    const [envelope] = (await live.provider.poll(ACCOUNT_ID, { mailbox: 'INBOX', limit: 50 })).messages;

    expect(envelope!.attachments).toEqual([
      { id: '2', filename: 'report.pdf', mimeType: 'application/pdf', bytes: 90_000 },
    ]);
    // A paperclip in a list costs nothing: the poll already asked for the structure.
    expect(wire.commands.some((one) => one.startsWith('fetchOne'))).toBe(false);
  });
});

describe('a mailbox list', () => {
  it('asks for the counts in the same round trip and maps roles', async () => {
    const mailboxes = await live.provider.listMailboxes(ACCOUNT_ID);

    expect(mailboxes).toEqual([
      { mailboxId: 'INBOX', name: 'INBOX', role: 'inbox', unread: 1, total: 3 },
      // No SPECIAL-USE flag and not an English special name, so `other` rather than a guess.
      { mailboxId: 'Projects/2026', name: 'Projects/2026', role: 'other', unread: 0, total: 1 },
      { mailboxId: 'Papierkorb', name: 'Papierkorb', role: 'trash', unread: 0, total: 0 },
    ]);
  });
});

describe('a body', () => {
  it('parses a real multipart message into text, HTML and attachment metadata', async () => {
    setMimeParserForTesting(null);
    wire.source = await fsp.readFile(path.join(FIXTURES, 'multipart.eml'));

    const body = await live.provider.getBody(ACCOUNT_ID, 'INBOX:9001:2');

    expect(wire.commands).toEqual(['open INBOX', 'fetchOne INBOX 2']);
    expect(body.format).toBe('both');
    expect(body.attachments?.[0]).toMatchObject({ filename: 'summary.csv' });
    expect(body.text).toContain('marzipan');
    expect(body.html).toContain('<b>marzipan</b>');
    // The HTML is RAW, exactly as it arrived: the sanitizer belongs next to the renderer.
    expect(body.html).toContain('<html>');
    expect(body.attachments).toEqual([
      expect.objectContaining({ filename: 'summary.csv', mimeType: 'text/csv' }),
    ]);
    expect(body.bytes).toBe(wire.source.byteLength);
  });

  it('labels html-only mail as html, not as both', async () => {
    setMimeParserForTesting(null);
    wire.source = Buffer.from(
      'Subject: html only\r\nContent-Type: text/html; charset=utf-8\r\n\r\n<p>hello <b>x</b></p>\r\n',
    );
    wire.sourceStructure = { part: '1', type: 'text/html', size: 40 };

    const body = await live.provider.getBody(ACCOUNT_ID, 'INBOX:9001:2');

    // mailparser hands back a `text` here anyway: it synthesizes plain text from the HTML part,
    // and it does so even with skipTextToHtml. Trusting that field reported html-only mail as
    // carrying both representations, so the console showed a "plain text" view of a machine's
    // rendering. The server's own BODYSTRUCTURE is what decides.
    expect(body.text).toBeTruthy();
    expect(body.format).toBe('html');
  });

  it('falls back to the parse when the server sent no structure', async () => {
    setMimeParserForTesting(null);
    wire.source = await fsp.readFile(path.join(FIXTURES, 'multipart.eml'));
    wire.sourceStructure = null;

    // A guess, and labelled as one in the code: better than refusing to answer, and a provider
    // that cannot report structure is not a reason to lose the body.
    expect((await live.provider.getBody(ACCOUNT_ID, 'INBOX:9001:2')).format).toBe('both');
  });

  it('refuses from the poll-reported size WITHOUT fetching anything', async () => {
    const parser = vi.fn();
    setMimeParserForTesting(parser as never);
    wire.source = Buffer.from('Subject: big\r\n\r\nbody');

    await expect(live.provider.getBody(ACCOUNT_ID, 'INBOX:9001:2', MAX_SOURCE_BYTES + 1))
      .rejects.toMatchObject({ code: 'too-large' });

    // Not one command. The size the POLL already reported is enough, and checking only after the
    // fetch meant downloading up to 2 MB of every over-cap message to discover it is over the cap.
    expect(wire.commands).toEqual([]);
    expect(parser).not.toHaveBeenCalled();
    setMimeParserForTesting(null);
  });

  it('refuses a truncated download the server gave no size for', async () => {
    const parser = vi.fn();
    setMimeParserForTesting(parser as never);
    // Exactly maxLength and no RFC822.SIZE: indistinguishable from a 50 MB message cut at 2 MB.
    wire.source = Buffer.alloc(MAX_SOURCE_BYTES, 0x61);
    wire.sourceSize = undefined;
    wire.noSize = true;

    await expect(live.provider.getBody(ACCOUNT_ID, 'INBOX:9001:2'))
      .rejects.toMatchObject({ code: 'too-large' });

    // Parsing it would answer with the first 2 MB of a much larger message labelled complete,
    // which is worse than refusing: the user would read a truncated mail and not be told.
    expect(parser).not.toHaveBeenCalled();
    setMimeParserForTesting(null);
  });

  it('refuses anything over the cap WITHOUT parsing a byte of it', async () => {
    const parser = vi.fn();
    setMimeParserForTesting(parser as never);
    wire.source = Buffer.from('Subject: too big\r\n\r\nbody');
    wire.sourceSize = MAX_SOURCE_BYTES + 1;

    await expect(live.provider.getBody(ACCOUNT_ID, 'INBOX:9001:2')).rejects.toMatchObject({ code: 'too-large' });

    // The size the server already reported is what decides. Parsing first and refusing after
    // would put the multi-megabyte parse on the event loop it was meant to protect.
    expect(parser).not.toHaveBeenCalled();
    setMimeParserForTesting(null);
  });

  it('reports a vanished message as not-found and a bad handle as invalid', async () => {
    wire.source = null;
    await expect(live.provider.getBody(ACCOUNT_ID, 'INBOX:9001:2')).rejects.toMatchObject({ code: 'not-found' });
    await expect(live.provider.getBody(ACCOUNT_ID, 'nonsense')).rejects.toMatchObject({ code: 'invalid' });
  });
});

describe('the read flag', () => {
  it('adds and removes \\Seen by UID', async () => {
    await live.provider.markRead!(ACCOUNT_ID, 'INBOX:9001:2', true);
    await live.provider.markRead!(ACCOUNT_ID, 'INBOX:9001:2', false);

    expect(wire.flagOps).toEqual([
      { range: '2', flags: ['\\Seen'], add: true, uid: true },
      { range: '2', flags: ['\\Seen'], add: false, uid: true },
    ]);
  });
});

describe('failures', () => {
  it('are one of two things the user can act on', () => {
    expect(toProviderError(Object.assign(new Error('nope'), { authenticationFailed: true }), 'x').code).toBe('auth');
    expect(toProviderError(Object.assign(new Error('nope'), { code: 'AuthenticationFailed' }), 'x').code).toBe('auth');
    expect(toProviderError(new Error('Invalid credentials for user'), 'x').code).toBe('auth');
    expect(toProviderError({ responseText: 'NO [AUTHENTICATIONFAILED] nope' }, 'x').code).toBe('auth');
    // Everything else is `unreachable`, because the user's next action is the same in all of it.
    expect(toProviderError(new Error('ECONNRESET'), 'x').code).toBe('unreachable');
    expect(toProviderError(new Error('getaddrinfo ENOTFOUND'), 'x').code).toBe('unreachable');
    // The regression this pattern exists for: a HOSTNAME containing "auth". The old `/auth/i`
    // over the raw message parked the account and told the user to fix a password that was fine
    // while their DNS was broken.
    expect(toProviderError(new Error('getaddrinfo ENOTFOUND imap.authsmtp.com'), 'x').code)
      .toBe('unreachable');
    expect(toProviderError(new Error('connect ETIMEDOUT 10.0.0.1:993 (password vault proxy)'), 'x').code)
      .toBe('unreachable');
    // An already-mapped code travels unedited rather than being wrapped twice.
    const mapped = toProviderError(Object.assign(new Error('too big'), { code: 'too-large' }), 'x');
    expect(mapped.code).toBe('too-large');
    expect(mapped.message).toBe('too big');
  });

  it('turn a silent socket into unreachable instead of waiting forever', async () => {
    const short = await withAccount(40);
    wire.hangOn = 'open INBOX';

    // A TCP socket to a machine that went away does not error, it goes quiet. Without the
    // deadline this poll never returns and the account never syncs again.
    await expect(short.provider.poll(ACCOUNT_ID, { mailbox: 'INBOX', limit: 10 }))
      .rejects.toMatchObject({ code: 'unreachable' });
    await short.pool.disposeAll();
  });

  it('refuse fast while a host is down instead of opening a socket per command', async () => {
    wire.failConnectWith = new Error('ECONNREFUSED');

    await expect(live.provider.poll(ACCOUNT_ID, { mailbox: 'INBOX', limit: 10 }))
      .rejects.toMatchObject({ code: 'unreachable' });
    const connectsAfterFirst = wire.connects;

    // Inside the reconnect window: refused from memory, so a tick's worth of commands cannot
    // each open a fresh socket to a host that is not there.
    await expect(live.provider.poll(ACCOUNT_ID, { mailbox: 'INBOX', limit: 10 }))
      .rejects.toMatchObject({ code: 'unreachable' });
    expect(wire.connects).toBe(connectsAfterFirst);
  });

  it('report a missing password as auth rather than trying to connect', async () => {
    const bare = await withAccount();
    bare.secrets.clear();

    await expect(bare.provider.poll(ACCOUNT_ID, { mailbox: 'INBOX', limit: 10 }))
      .rejects.toMatchObject({ code: 'auth' });
    expect(wire.connects).toBe(0);
    await bare.pool.disposeAll();
  });

  it('say not-found for an account this box does not have', async () => {
    await expect(live.provider.poll('imap:unknown', { mailbox: 'INBOX', limit: 10 }))
      .rejects.toMatchObject({ code: 'not-found' });
  });
});

describe('one connection per account', () => {
  it('gives two callers arriving at once the SAME connection', async () => {
    // The creation reads config, which is an await, so a pool that only caches the FINISHED
    // connection hands each of them their own: two logins, two gates, and no serialization at
    // all. The base does exactly this on a first sync, arming the watch while polling the inbox.
    const [one, two] = await Promise.all([live.pool.for(ACCOUNT_ID), live.pool.for(ACCOUNT_ID)]);
    expect(one).toBe(two);
  });
});

describe('one command at a time', () => {
  it('never interleaves another caller\'s SELECT with a FETCH', async () => {
    // Both callers are released only after both have been issued, so an unserialized
    // implementation would have both SELECTs queued before either FETCH ran.
    let release = () => undefined as void;
    wire.gate = new Promise<void>((resolve) => { release = () => resolve() });
    wire.source = Buffer.from('Subject: hi\r\n\r\nbody');
    setMimeParserForTesting(async () => ({ text: 'body', attachments: [] }) as never);

    const both = Promise.all([
      live.provider.poll(ACCOUNT_ID, { mailbox: 'INBOX', limit: 10 }),
      live.provider.getBody(ACCOUNT_ID, 'Projects/2026:9001:1'),
    ]);
    release();
    await both;

    // A SELECT that lands between another caller's SELECT and FETCH makes the FETCH read the
    // WRONG mailbox, which is a data bug and not an error anybody would see.
    expect(wire.commands).toEqual([
      'open INBOX', 'fetch INBOX 1:*',
      'open Projects/2026', 'fetchOne Projects/2026 1',
    ]);
    setMimeParserForTesting(null);
  });
});

describe('the IDLE watch', () => {
  it('hands back a handle at once and does NO I/O in the hint callback', async () => {
    const hints: unknown[] = [];
    const handle = live.provider.watch!(ACCOUNT_ID, (hint) => hints.push(hint));
    // Synchronous by contract: the base needs the Disposable before any connection exists.
    expect(typeof handle.dispose).toBe('function');

    await expect.poll(() => wire.fireExists, { timeout: 5_000 }).not.toBeNull();
    const commandsBefore = wire.commands.length;

    wire.fireExists!();

    // The callback runs on the transport's own stack, so it may only flip a flag and kick the
    // base's loop. Anything awaited here would be a fetch in the middle of the event loop.
    expect(hints).toEqual([{ mailbox: 'INBOX' }]);
    expect(wire.commands.length).toBe(commandsBefore);

    handle.dispose();
    wire.fireExists?.();
    expect(hints).toHaveLength(1);
  });

  it('re-arms itself after the socket drops and reconnects', async () => {
    const hints: unknown[] = [];
    const handle = live.provider.watch!(ACCOUNT_ID, (hint) => hints.push(hint));
    await expect.poll(() => wire.fireExists, { timeout: 5_000 }).not.toBeNull();

    // The socket goes. `connect()` builds a FRESH ImapFlow, and the listener was bound to the dead
    // one, so without re-arming the account silently degrades to poll-only for the life of the
    // process with nothing in the logs to say so.
    wire.dropClient!();
    expect(wire.fireExists).toBeNull();
    await live.provider.poll(ACCOUNT_ID, { mailbox: 'INBOX', limit: 5 });
    await expect.poll(() => wire.fireExists, { timeout: 5_000 }).not.toBeNull();

    wire.fireExists!();
    expect(hints).toEqual([{ mailbox: 'INBOX' }]);
    handle.dispose();
  });

  it('degrades to poll-only, without throwing, when the server has no IDLE', async () => {
    wire.capabilities = ['IMAP4rev1'];
    const hints: unknown[] = [];

    const handle = live.provider.watch!(ACCOUNT_ID, (hint) => hints.push(hint));
    await expect.poll(
      () => logLines.some((line) => line.includes('does not advertise IDLE')),
      { timeout: 5_000 },
    ).toBe(true);

    expect(wire.fireExists).toBeNull();
    expect(hints).toEqual([]);
    handle.dispose();
  });
});

describe('sending', () => {
  it('refuses rather than looking like it worked', async () => {
    await expect(live.provider.send!(ACCOUNT_ID, { to: [], subject: '', text: '' } as never))
      .rejects.toMatchObject({ code: 'unsupported' });
  });
});

describe('removing an account', () => {
  it('drops the connection, the settings and the password', async () => {
    const owned = await withAccount();

    await owned.provider.removeAccount!(ACCOUNT_ID);

    expect(owned.config()).toEqual({ accounts: {} });
    expect([...owned.secrets.keys()]).toEqual([]);
    await owned.pool.disposeAll();
  });
});

describe('MIME helpers', () => {
  it('unfold headers, keep the last value, and pull out message ids', () => {
    const headers = parseHeaders([
      'Subject: One',
      'References: <a@example.invalid>',
      "\t<b@example.invalid>",
      'Subject: Two',
      'not a header line',
    ].join('\r\n'));

    expect(headers.subject).toBe('Two');
    expect(headers.references).toBe('<a@example.invalid> <b@example.invalid>');
    expect(messageIdList(headers.references)).toEqual(['<a@example.invalid>', '<b@example.invalid>']);
    expect(messageIdList(undefined)).toEqual([]);
  });

  it('never call a multipart node an attachment', () => {
    expect(attachmentsFromStructure({
      type: 'multipart/mixed', parameters: { name: 'looks-like-a-file.zip' },
      childNodes: [{ part: '1', type: 'text/plain', size: 10 }],
    })).toEqual([]);
    expect(attachmentsFromStructure(undefined)).toEqual([]);
  });
});

/**
 * The parse cost of a body at the cap, measured rather than assumed.
 *
 * The number is what justifies the cap: a MIME parse is CPU work in the server process, and the
 * server has ONE event loop that every route shares. The fixture is inflated in memory instead of
 * committed, because a 2 MB blob in a public repo buys nothing a generator does not.
 */
describe('a 2 MB body', () => {
  it('parses inside a budget, and the cost is printed', async () => {
    setMimeParserForTesting(null);
    const small = await fsp.readFile(path.join(FIXTURES, 'multipart.eml'));
    const anchor = 'The word marzipan appears only in the body, never in a header.';
    const filler = `${anchor}\n`.repeat(Math.ceil((MAX_SOURCE_BYTES - small.byteLength) / (anchor.length + 1)));
    const big = Buffer.from(small.toString('utf8').replace(anchor, `${anchor}\n${filler}`), 'utf8');
    expect(big.byteLength).toBeGreaterThan(2 * 1024 * 1024 - 4_096);

    // Twice, and both numbers are printed. The first pays for the lazy `mailparser` import and a
    // cold JIT, which is real cost on the first body a process ever reads but says nothing about
    // the steady state, and the cap is justified by the steady state.
    const coldAt = performance.now();
    await parseMime(big);
    const coldMs = performance.now() - coldAt;
    const warmAt = performance.now();
    const parsed = await parseMime(big);
    const tookMs = performance.now() - warmAt;
    // eslint-disable-next-line no-console -- the measurement IS the point of this test
    console.log(
      `[mail-imap] parsed ${big.byteLength} bytes of multipart MIME:`
      + ` cold ${coldMs.toFixed(0)}ms, warm ${tookMs.toFixed(0)}ms`,
    );

    expect(parsed.text).toContain('marzipan');
    expect(parsed.html).toContain('<b>marzipan</b>');
    expect(parsed.attachments).toHaveLength(1);
    // Generous on purpose: this is a ratchet against an order-of-magnitude regression (a
    // quadratic unfold, a synchronous re-encode), not a benchmark.
    expect(tookMs).toBeLessThan(1_500);

    // The other shape a 2 MB message actually comes in: a small body plus one big base64
    // attachment. Measured too, because the two costs are not the same work and the cap has to
    // be defensible for whichever one arrives.
    const payload = Buffer.alloc(1_500_000, 0x61).toString('base64').replace(/(.{76})/g, '$1\r\n');
    const attached = Buffer.from(small.toString('utf8').replace(
      'Y29sdW1uLHZhbHVlCmZpcnN0LDEKc2Vjb25kLDIK',
      payload,
    ), 'utf8');
    const attachedAt = performance.now();
    const withFile = await parseMime(attached);
    const attachedMs = performance.now() - attachedAt;
    // eslint-disable-next-line no-console -- the measurement IS the point of this test
    console.log(
      `[mail-imap] parsed ${attached.byteLength} bytes dominated by one base64 attachment`
      + ` in ${attachedMs.toFixed(0)}ms`,
    );
    expect(withFile.attachments).toHaveLength(1);
    expect(attachedMs).toBeLessThan(1_500);
  }, 60_000);
});
