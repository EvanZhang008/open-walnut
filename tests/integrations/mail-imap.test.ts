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
import crypto from 'node:crypto';
import fsp from 'node:fs/promises';
import path from 'node:path';
import type { Transform } from 'node:stream';
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
  replyToList,
  setMimeParserForTesting,
} from '../../src/integrations/mail-imap/mime.js';
import { createImapProvider } from '../../src/integrations/mail-imap/provider.js';
import { classify, messageIdFor, setSmtpTransportFactory } from '../../src/integrations/mail-imap/smtp.js';
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
  /** Every IMAP APPEND, which is how a Sent copy is filed. */
  appends: Array<{ mailbox: string; bytes: string; flags: string[]; hasDate: boolean }>;
  failAppendWith: unknown;
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

  async append(mailbox: string, content: Buffer | string, flags?: string[], date?: Date): Promise<unknown> {
    await this.step(`append ${mailbox}`);
    wire.appends.push({
      mailbox,
      bytes: Buffer.isBuffer(content) ? content.toString('utf8') : content,
      flags: flags ?? [],
      hasDate: date instanceof Date,
    });
    if (wire.failAppendWith) throw wire.failAppendWith;
    return true;
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

/** One `sendMail` call, as nodemailer would have received it. */
interface SentRecord {
  from?: { name?: string; address?: string };
  to?: Array<{ name?: string; address: string }>;
  cc?: Array<{ name?: string; address: string }>;
  bcc?: Array<{ name?: string; address: string }>;
  subject?: string;
  text?: string;
  html?: string;
  inReplyTo?: string;
  references?: string[];
  messageId?: string;
  date?: Date;
}

/** The options the transporter was built with. Only the fields worth grading. */
interface FakeTransportOptions {
  host?: string;
  port?: number;
  secure?: boolean;
  requireTLS?: boolean;
  ignoreTLS?: boolean;
  pool?: boolean;
  logger?: boolean;
  auth?: { user?: string; pass?: string };
}

interface SmtpWire {
  options: FakeTransportOptions[];
  sent: SentRecord[];
  verifies: number;
  closes: number;
  failWith: unknown;
  failVerifyWith: unknown;
  /** Write the message bytes BEFORE failing, which is what makes an outcome ambiguous. */
  streamBeforeFailure: boolean;
}

let smtp: SmtpWire;

function freshSmtp(): SmtpWire {
  return {
    options: [],
    sent: [],
    verifies: 0,
    closes: 0,
    failWith: null,
    failVerifyWith: null,
    streamBeforeFailure: false,
  };
}

/** The exact bytes the fake writes down DATA, which is what a Sent copy has to match. */
const RAW_MIME = 'MIME-Version: 1.0\r\nSubject: Lunch on Thursday\r\n\r\nDoes **noon** work?\r\n';

const sha1 = (value: string) => crypto.createHash('sha1').update(value).digest('hex');

/**
 * A transporter that behaves like nodemailer at the two boundaries the send path depends on.
 *
 * The `stream` plugin's transform is the only honest "DATA has begun" signal, so the fake really
 * writes the message through it rather than pretending: a fake that skipped it would let a wrong
 * `stage` pass unnoticed, which is the one bug in this file worth a duplicated mail.
 */
function fakeTransporter(options: FakeTransportOptions) {
  smtp.options.push(options);
  let makeTransform: (() => Transform) | null = null;
  return {
    use(
      name: string,
      plugin: (
        mail: { message: { transform: (factory: () => Transform) => void } },
        callback: () => void,
      ) => void,
    ) {
      if (name !== 'stream') return;
      plugin({ message: { transform: (factory) => { makeTransform = factory } } }, () => undefined);
    },
    async verify() {
      smtp.verifies += 1;
      if (smtp.failVerifyWith) throw smtp.failVerifyWith;
      return true;
    },
    async sendMail(mail: SentRecord) {
      smtp.sent.push(mail);
      // Failing with no byte written is the provably harmless case; the flag is what turns the
      // same error into the one nobody can resolve.
      if (smtp.failWith && !smtp.streamBeforeFailure) throw smtp.failWith;
      const factory = makeTransform;
      if (factory) {
        const stream = factory();
        const drained = new Promise<void>((resolve) => { stream.on('end', () => resolve()) });
        stream.end(Buffer.from(RAW_MIME, 'utf8'));
        await drained;
      }
      if (smtp.failWith) throw smtp.failWith;
      return {
        messageId: mail.messageId,
        accepted: [...(mail.to ?? []), ...(mail.cc ?? [])].map((one) => one.address),
        rejected: [],
        response: '250 2.0.0 OK',
      };
    },
    close() { smtp.closes += 1 },
  };
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
    appends: [],
    failAppendWith: null,
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
  return {
    store: new ImapAccountStore(host as never),
    config: () => config,
    patch: (values: Record<string, unknown>) => host.config.patch(values),
    secrets,
  };
}

interface Wired {
  provider: MailProviderSpec;
  pool: ImapPool;
  store: ImapAccountStore;
  config: () => Record<string, unknown>;
  patch: (values: Record<string, unknown>) => Promise<unknown>;
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
    patch: made.patch,
    secrets: made.secrets,
  };
}

/** The same provider with the account already saved, exactly as `submit` would have saved it. */
async function withAccount(
  commandTimeoutMs?: number,
  /** Give the account an outgoing server too, which is what makes it able to send. */
  smtp = false,
): Promise<Wired> {
  const wired = buildProvider(commandTimeoutMs);
  await wired.store.save({
    address: ADDRESS, host: 'imap.example.invalid', port: 993, tls: 'tls',
    password: PASSWORD, displayName: 'Alice',
    ...(smtp ? { smtpHost: 'smtp.example.invalid', smtpPort: 587, smtpSecurity: 'starttls' as const } : {}),
  });
  wire.commands.length = 0;
  wire.connects = 0;
  wire.connectOptions.length = 0;
  return wired;
}

let live: Wired;

beforeAll(() => {
  setImapClientFactory(async (options) => new FakeImap(options));
  setSmtpTransportFactory(async (options) => fakeTransporter(options as FakeTransportOptions) as never);
});

afterAll(async () => {
  setImapClientFactory(null);
  setSmtpTransportFactory(null);
  setMimeParserForTesting(null);
  await live?.pool.disposeAll();
});

beforeEach(async () => {
  await live?.pool.disposeAll();
  wire = freshWire();
  smtp = freshSmtp();
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
  it('joins up an app password pasted in groups of four, and leaves every other password alone', async () => {
    // Google shows a 16-character app password as four groups of four and says to enter it without
    // the spaces. A paste straight off that screen used to fail the login, which reads as "wrong
    // password" for a credential the human copied correctly.
    const pasted = buildProvider();
    await pasted.provider.setup.submit({
      address: ADDRESS,
      password: 'abcd efgh ijkl mnop',
      imap_host: 'imap.gmail.com',
      imap_tls: 'tls',
    });
    expect(pasted.secrets.get(`password.${localIdFor(ADDRESS)}`)).toBe('abcdefghijklmnop');

    // A password that merely CONTAINS spaces is somebody's real password, and a client that strips
    // them locks them out of their own mailbox. Byte for byte, including the spaces.
    const spaced = buildProvider();
    const real = 'two words and more';
    await spaced.provider.setup.submit({
      address: ADDRESS,
      password: real,
      imap_host: 'imap.example.invalid',
      imap_tls: 'tls',
    });
    expect(spaced.secrets.get(`password.${localIdFor(ADDRESS)}`)).toBe(real);
  });

  it('stamps a known service that files its own Sent copy, and stamps nothing otherwise', async () => {
    // Nobody should have to know this about their own mail host. Gmail saves anything sent through
    // smtp.gmail.com, so without the stamp the human gets two of every message in Sent and has to
    // find a plugin setting to explain it.
    const gmail = buildProvider();
    await gmail.provider.setup.submit({
      address: ADDRESS,
      password: PASSWORD,
      imap_host: 'imap.gmail.com',
      imap_tls: 'tls',
      smtp_host: 'smtp.gmail.com',
      smtp_tls: 'starttls',
    });
    expect(gmail.config().accounts?.[localIdFor(ADDRESS)]).toMatchObject({ server_saves_sent: true });

    // A host nothing is known about is left ALONE rather than stamped false: that keeps the
    // plugin-level default meaningful for a hand-configured server.
    const other = buildProvider();
    await other.provider.setup.submit({
      address: ADDRESS,
      password: PASSWORD,
      imap_host: 'imap.example.invalid',
      imap_tls: 'tls',
      smtp_host: 'smtp.example.invalid',
      smtp_tls: 'starttls',
    });
    expect(other.config().accounts?.[localIdFor(ADDRESS)]).not.toHaveProperty('server_saves_sent');
  });

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

/**
 * The known services the form offers, which are pure data and need no server.
 *
 * They are graded because they are FACTS ABOUT SOMEBODY ELSE'S SERVICE: a wrong port here does not
 * fail loudly at build time, it fails as "Walnut cannot reach my mail" for the one person whose
 * provider it is. The invariants below are the ones the console silently depends on.
 */
describe('setup presets', () => {
  const presetsOf = () => buildProvider().provider.setup.presets ?? [];

  it('answers Gmail with the settings Google documents', () => {
    const gmail = presetsOf().find((one) => one.id === 'gmail');
    expect(gmail).toBeDefined();
    expect(gmail!.match).toEqual(['gmail.com', 'googlemail.com']);
    expect(gmail!.values).toEqual({
      imap_host: 'imap.gmail.com',
      imap_tls: 'tls',
      smtp_host: 'smtp.gmail.com',
    });
    expect(gmail!.help).toMatch(/app password/i);
    expect(gmail!.helpUrl).toBe('https://myaccount.google.com/apppasswords');
  });

  it('covers the services a person is most likely to be adding', () => {
    expect(presetsOf().map((one) => one.id))
      .toEqual(['gmail', 'icloud', 'outlook', 'fastmail', 'yahoo']);
  });

  it('fills only fields this form declares, and never the credential', () => {
    const { provider } = buildProvider();
    const declared = new Set(provider.setup.fields.map((field) => field.name));
    const secret = new Set(
      provider.setup.fields.filter((field) => field.kind === 'password').map((field) => field.name),
    );
    for (const preset of provider.setup.presets ?? []) {
      for (const name of Object.keys(preset.values)) {
        expect(declared, `${preset.id} fills a field this form does not have: ${name}`).toContain(name);
        expect(secret, `${preset.id} must not fill a credential`).not.toContain(name);
      }
      // The servers are the whole point: a preset that named neither would be a dead chip.
      expect(Object.keys(preset.values)).toContain('imap_host');
      expect(Object.keys(preset.values)).toContain('smtp_host');
    }
  });

  it('matches on bare lowercase domains, which is what the console compares against', () => {
    for (const preset of presetsOf()) {
      expect(preset.match?.length, `${preset.id} has no domain to match`).toBeGreaterThan(0);
      for (const domain of preset.match ?? []) {
        // The console lowercases the typed address and compares strings, so an upper-case letter
        // or a stray `@` here is a preset that can never be chosen by typing an address.
        expect(domain).toBe(domain.toLowerCase());
        expect(domain).not.toContain('@');
        expect(domain).toMatch(/^[a-z0-9-]+(\.[a-z0-9-]+)+$/);
      }
    }
  });

  /**
   * No preset names a PORT, and that is the fix for a real hole rather than an omission.
   *
   * A preset that wrote `imap_port: '993'` looked right and was: 993 is the TLS port. Then somebody
   * switched the encryption to STARTTLS underneath the fill and submitted 993 with STARTTLS, which
   * no server speaks, and before this slice existed that same form would have submitted 143. The
   * port now comes from the encryption choice inside `submit` (see the submit case below), so the
   * two cannot disagree, and the fields' placeholders still show the numbers.
   */
  it('names no port, so the encryption choice is the only thing that decides one', () => {
    for (const preset of presetsOf()) {
      expect(Object.keys(preset.values)).not.toContain('imap_port');
      expect(Object.keys(preset.values)).not.toContain('smtp_port');
      expect(['tls', 'starttls']).toContain(preset.values.imap_tls);
      expect(preset.help).toBeTruthy();
      // No id, and nobody's address, in a string a console shows.
      expect(preset.help).not.toContain('@');
      expect(preset.helpUrl, `${preset.id} has no page for its credential`).toMatch(/^https:\/\//);
    }
  });

  /**
   * The one service that must NOT be told to make an app password.
   *
   * Outlook.com IMAP answers `LOGINDISABLED` and offers `AUTH=XOAUTH2` alone (checked against the
   * live servers on 2026-09-08), so "use an app password" would send somebody to make a credential
   * that is refused at sign-in, which is worse than saying nothing. If Walnut ever grows OAuth for
   * IMAP this is the assertion to revisit, deliberately.
   */
  it('does not promise an app password for a service that refuses one', () => {
    const outlook = presetsOf().find((one) => one.id === 'outlook')!;
    expect(outlook.values.imap_host).toBe('outlook.office365.com');
    expect(outlook.values.smtp_host).toBe('smtp-mail.outlook.com');
    expect(outlook.help).not.toMatch(/use an app password/i);
    expect(outlook.help).toMatch(/OAuth/);
    // The other four do say it, because for them it is both true and the fix. Each vendor's own
    // wording travels, so the pattern allows Apple's "app specific password" as well as the plain
    // "app password" the rest use: matching the exact phrase would push every help string towards
    // words its own vendor does not use, which is the opposite of useful.
    for (const preset of presetsOf().filter((one) => one.id !== 'outlook')) {
      expect(preset.help, `${preset.id} should name the credential it wants`)
        .toMatch(/app[ -]?(specific[ -]?)?password/i);
    }
  });

  // Every preset id has to be usable as a chip's test id and as a stable key.
  it('gives every preset a unique simple id and a label', () => {
    const ids = presetsOf().map((one) => one.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const preset of presetsOf()) {
      expect(preset.id).toMatch(/^[a-z0-9-]+$/);
      expect(preset.label.trim()).toBeTruthy();
    }
  });

  /**
   * The whole point of the two changes above, driven through `submit` the way the console does.
   *
   * The console posts `{...preset.values, ...whatever the human typed}`, so this is the exact map
   * that reaches the provider. The regression it pins: fill from Gmail, then pick STARTTLS, and the
   * account must store 143. A preset carrying `993` stored 993 with STARTTLS, which connects to a
   * port that is not speaking STARTTLS and reads as "unreachable" for a form that looks right.
   */
  it('stores the port the encryption implies when a preset fill is switched to STARTTLS', async () => {
    const { provider, config } = buildProvider();
    const gmail = provider.setup.presets!.find((one) => one.id === 'gmail')!;

    await provider.setup.submit({
      ...gmail.values,
      address: ADDRESS,
      password: PASSWORD,
      // The human changed this AFTER the fill, which is the order that used to break.
      imap_tls: 'starttls',
    });

    expect(wire.connectOptions[0]).toMatchObject({ port: 143, secure: false });
    const stored = (config().accounts as Record<string, Record<string, unknown>>)[localIdFor(ADDRESS)]!;
    expect(stored).toMatchObject({ imap_host: 'imap.gmail.com', imap_port: 143, imap_tls: 'starttls' });
  });

  /**
   * A stale canonical port is read as the same intent, in both directions and on both halves.
   *
   * `993` with STARTTLS and `143` with TLS can only be produced by filling the form in one order
   * and changing it in another, so the provider treats them as "the port this encryption uses"
   * rather than connecting somewhere nobody is listening. Anything that is NOT one of the four
   * canonical numbers is somebody's real mail host and survives exactly as typed.
   */
  it('reconciles a stale canonical port, and leaves a deliberate one alone', async () => {
    const stale = buildProvider();
    await stale.provider.setup.submit({
      address: ADDRESS, password: PASSWORD, imap_host: 'imap.example.invalid',
      imap_tls: 'starttls', imap_port: '993',
      smtp_host: 'smtp.example.invalid', smtp_tls: 'tls', smtp_port: '587',
    });
    let stored = (stale.config().accounts as Record<string, Record<string, unknown>>)[localIdFor(ADDRESS)]!;
    expect(stored).toMatchObject({ imap_port: 143, smtp_port: 465, smtp_tls: 'tls' });
    await stale.pool.disposeAll();

    const other = buildProvider();
    await other.provider.setup.submit({
      address: ADDRESS, password: PASSWORD, imap_host: 'imap.example.invalid',
      imap_tls: 'tls', imap_port: '143',
      smtp_host: 'smtp.example.invalid', smtp_tls: 'starttls', smtp_port: '465',
    });
    stored = (other.config().accounts as Record<string, Record<string, unknown>>)[localIdFor(ADDRESS)]!;
    expect(stored).toMatchObject({ imap_port: 993, smtp_port: 587 });
    await other.pool.disposeAll();

    const deliberate = buildProvider();
    await deliberate.provider.setup.submit({
      address: ADDRESS, password: PASSWORD, imap_host: 'imap.example.invalid',
      imap_tls: 'starttls', imap_port: '1143',
      smtp_host: 'smtp.example.invalid', smtp_tls: 'starttls', smtp_port: '2525',
    });
    stored = (deliberate.config().accounts as Record<string, Record<string, unknown>>)[localIdFor(ADDRESS)]!;
    expect(stored).toMatchObject({ imap_port: 1143, smtp_port: 2525 });
    await deliberate.pool.disposeAll();
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

/**
 * Sending, against a fake transporter rather than a real SMTP server.
 *
 * The one thing worth grading here is `stage`, because it is the field the base uses to decide
 * whether a human may retry, and getting it wrong in the safe-looking direction means sending
 * somebody's mail twice. SMTP has no dedupe and no way to ask "did you already get this?", so
 * every ambiguous case has to resolve to `after-data`.
 */
describe('sending', () => {
  const OUTGOING = {
    to: [{ name: 'Bob', address: 'bob@example.invalid' }],
    cc: [{ address: 'carol@example.invalid' }],
    subject: 'Lunch on Thursday',
    bodyMarkdown: 'Does **noon** work?',
    bodyHtml: '<p>Does <strong>noon</strong> work?</p>',
    inReplyTo: '<original@example.invalid>',
    references: ['<root@example.invalid>', '<original@example.invalid>'],
  };

  it('refuses an account with no outgoing server, and says so per account', async () => {
    // The account `live` holds has IMAP settings only, which is a perfectly good read-only
    // account. The capability answer and the refusal have to agree, or the console offers a Send
    // button that always fails.
    expect((await live.provider.accountCapabilities!(ACCOUNT_ID)).send).toBe(false);
    await expect(live.provider.send(ACCOUNT_ID, OUTGOING, { idempotencyKey: 'dr-1:1' }))
      .rejects.toMatchObject({ code: 'unsupported' });
    expect(smtp.sent).toEqual([]);

    const sending = await withAccount(undefined, true);
    expect((await sending.provider.accountCapabilities!(ACCOUNT_ID)).send).toBe(true);
    await sending.pool.disposeAll();
  });

  it('sends both alternatives with the reply headers and a Message-ID derived from the key', async () => {
    const sending = await withAccount(undefined, true);
    const result = await sending.provider.send(ACCOUNT_ID, OUTGOING, { idempotencyKey: 'dr-7:3' });

    expect(smtp.sent).toHaveLength(1);
    const sent = smtp.sent[0]!;
    expect(sent.to).toEqual([{ name: 'Bob', address: 'bob@example.invalid' }]);
    expect(sent.cc).toEqual([{ address: 'carol@example.invalid' }]);
    expect(sent.subject).toBe('Lunch on Thursday');
    // The markdown source IS the text alternative, and the html half is the base's rendering
    // passed straight through: a provider that re-rendered it would be the second sanitizer in a
    // pipeline that only has room for one.
    expect(sent.text).toBe('Does **noon** work?');
    expect(sent.html).toBe('<p>Does <strong>noon</strong> work?</p>');
    expect(sent.inReplyTo).toBe('<original@example.invalid>');
    expect(sent.references).toEqual(['<root@example.invalid>', '<original@example.invalid>']);
    expect(sent.date instanceof Date).toBe(true);

    // Derived from the ledger key, so the same approved revision always produces the same id: if
    // a human ever does retry after checking the Sent folder, the duplicate is recognisable.
    expect(sent.messageId).toBe(messageIdFor('dr-7:3', ADDRESS));
    expect(sent.messageId).toBe(`<walnut-${sha1('dr-7:3')}@example.invalid>`);
    expect(messageIdFor('dr-7:3', ADDRESS)).toBe(messageIdFor('dr-7:3', ADDRESS));
    expect(messageIdFor('dr-7:4', ADDRESS)).not.toBe(messageIdFor('dr-7:3', ADDRESS));
    expect(result.providerMessageId).toBe(sent.messageId);

    // Per send, never pooled, and closed afterwards: an authenticated socket to the user's
    // provider must not stay open between messages.
    expect(smtp.options).toHaveLength(1);
    expect(smtp.options[0]).toMatchObject({
      host: 'smtp.example.invalid', port: 587, secure: false, requireTLS: true, pool: false, logger: false,
    });
    expect(smtp.closes).toBe(1);
    await sending.pool.disposeAll();
  });

  /**
   * The stage table, and why it is a table over `command` rather than over `code`.
   *
   * `dataStarted` (did anything read the composed message) is NOT the signal it looks like:
   * nodemailer pipes the whole message into a throwaway stream on the envelope-error path, so a
   * refused recipient drains the body without DATA ever beginning. `mail-smtp-live-server.test.ts`
   * proves that against a real scripted socket; this table pins the mapping the code derives.
   *
   * `bytes` means "something pulled the message out of the composer", which is deliberately NOT the
   * same claim as "the server received it". It matters for exactly one row group: the transient codes
   * reported at `command: 'CONN'` by both the socket-timeout handler and the closed-connection
   * handler, where only "nothing was ever read" can prove the message was not in flight.
   */
  const stages: Array<{
    code?: string
    command?: string
    bytes: boolean
    stage: 'before-data' | 'after-data'
    mapped: string
  }> = [
    // Provable from the code alone, whatever the byte signal says. EENVELOPE is the fix for the
    // real bug: a mistyped recipient used to become an unretriable `unknown`.
    { code: 'EENVELOPE', command: 'RCPT TO', bytes: true, stage: 'before-data', mapped: 'invalid' },
    { code: 'EENVELOPE', command: 'DATA', bytes: true, stage: 'before-data', mapped: 'invalid' },
    { code: 'EAUTH', command: 'AUTH PLAIN', bytes: false, stage: 'before-data', mapped: 'auth' },
    { code: 'EDNS', command: 'CONN', bytes: false, stage: 'before-data', mapped: 'unreachable' },
    // Provable from the position, when nothing was transmitted. Each of these used to be an
    // `unknown` a human could never resolve, for a wrong port or a firewall.
    { code: 'ECONNECTION', command: 'CONN', bytes: false, stage: 'before-data', mapped: 'unreachable' },
    { code: 'ESOCKET', command: 'CONN', bytes: false, stage: 'before-data', mapped: 'unreachable' },
    { code: 'ETIMEDOUT', command: 'CONN', bytes: false, stage: 'before-data', mapped: 'unreachable' },
    { code: 'ETLS', command: 'STARTTLS', bytes: false, stage: 'before-data', mapped: 'unreachable' },
    { code: 'EPROTOCOL', command: 'CONN', bytes: false, stage: 'before-data', mapped: 'unreachable' },
    { code: 'EMESSAGE', command: 'MAIL FROM', bytes: false, stage: 'before-data', mapped: 'invalid' },
    // The same transient codes with bytes gone: a socket that died mid-body reports exactly what
    // one that never connected does, so this is the half that has to stay unsafe.
    { code: 'ESOCKET', command: 'CONN', bytes: true, stage: 'after-data', mapped: 'unreachable' },
    { code: 'ETIMEDOUT', command: 'CONN', bytes: true, stage: 'after-data', mapped: 'unreachable' },
    // The server received the whole body and then refused it at end-of-data. Nothing about that
    // proves it did not queue a copy first.
    { code: 'EMESSAGE', command: 'DATA', bytes: true, stage: 'after-data', mapped: 'invalid' },
    { code: 'ESTREAM', command: 'API', bytes: true, stage: 'after-data', mapped: 'unreachable' },
    // Nothing to reason from reads as unsafe, deliberately: the cost of guessing the other way is a
    // duplicate mail, and the cost of guessing this way is one extra question in the inbox.
    { bytes: false, stage: 'after-data', mapped: 'unreachable' },
    { code: 'ESOCKET', bytes: false, stage: 'after-data', mapped: 'unreachable' },
  ];

  it.each(stages)('classifies $code at $command with bytes=$bytes as $stage', (row) => {
    const error = new Error('the transport said no') as Error & { code?: string; command?: string };
    if (row.code) error.code = row.code;
    if (row.command) error.command = row.command;
    expect(classify(error, row.bytes)).toMatchObject({ stage: row.stage, code: row.mapped });
  });

  it('reports a rejected login before data, so the base may let a human retry', async () => {
    const sending = await withAccount(undefined, true);
    const refused = new Error('535 authentication failed') as Error & { code: string };
    refused.code = 'EAUTH';
    smtp.failWith = refused;

    await expect(sending.provider.send(ACCOUNT_ID, OUTGOING, { idempotencyKey: 'dr-8:1' }))
      .rejects.toMatchObject({ code: 'auth', stage: 'before-data' });
    expect(smtp.closes).toBe(1);
    await sending.pool.disposeAll();
  });

  it('reports a socket that died mid-message as after-data, and files no Sent copy', async () => {
    const sending = await withAccount(undefined, true);
    wire.listing = [...wire.listing, { path: 'Sent', specialUse: '\\Sent', status: { messages: 0, unseen: 0 } }];
    const dropped = new Error('socket hang up') as Error & { code: string };
    dropped.code = 'ESOCKET';
    smtp.failWith = dropped;
    smtp.streamBeforeFailure = true;

    await expect(sending.provider.send(ACCOUNT_ID, OUTGOING, { idempotencyKey: 'dr-9:1' }))
      .rejects.toMatchObject({ code: 'unreachable', stage: 'after-data' });
    // Nothing is filed for a send whose outcome is unknown: a Sent copy is a claim that the
    // message went, and that is exactly what nobody can say here.
    expect(wire.appends).toEqual([]);
    await sending.pool.disposeAll();
  });

  it('files the SAME bytes in the Sent folder, and only when configured to', async () => {
    const sending = await withAccount(undefined, true);
    wire.listing = [...wire.listing, { path: 'Sent', specialUse: '\\Sent', status: { messages: 0, unseen: 0 } }];

    await sending.provider.send(ACCOUNT_ID, OUTGOING, { idempotencyKey: 'dr-10:1' });
    // SMTP tells the mailbox nothing, so without the APPEND the user's own reply is missing from
    // the thread they read on their phone. The bytes are the ones that went over DATA, not a
    // re-compose: two composes of one mail differ, and a Sent copy that does not match what the
    // recipient got is a small lie in the one place a user checks.
    //
    // POLLED, not asserted straight away: the copy is deliberately detached from the send, because
    // awaiting it can push an accepted message past the base's 30s deadline and report it as
    // `unknown`. See the "does not wait for the Sent copy" test below.
    await expect.poll(() => wire.appends, { timeout: 5_000 }).toEqual([
      { mailbox: 'Sent', bytes: RAW_MIME, flags: ['\\Seen'], hasDate: true },
    ]);

    // Gmail files its own copy, and two copies of every message in Sent is the bug that flag
    // exists to prevent.
    wire.appends.length = 0;
    await sending.patch({ server_saves_sent: true });
    await sending.provider.send(ACCOUNT_ID, OUTGOING, { idempotencyKey: 'dr-10:2' });
    expect(wire.appends).toEqual([]);

    wire.appends.length = 0;
    await sending.patch({ server_saves_sent: false, append_sent: false });
    await sending.provider.send(ACCOUNT_ID, OUTGOING, { idempotencyKey: 'dr-10:3' });
    expect(wire.appends).toEqual([]);
    await sending.pool.disposeAll();
  });

  it('reads the Sent-copy fact from the ACCOUNT, so two accounts can disagree', async () => {
    // The flag used to be plugin wide, which is necessarily wrong for a box holding both a Gmail
    // account (files its own copy) and a self-hosted one (does not). The account's own value wins;
    // the plugin-level flag is only the default for an account that says nothing.
    const sending = await withAccount(undefined, true);
    wire.listing = [...wire.listing, { path: 'Sent', specialUse: '\\Sent', status: { messages: 0, unseen: 0 } }];
    const localId = localIdFor(ADDRESS);
    const stored = sending.config().accounts as Record<string, Record<string, unknown>>;
    await sending.patch({
      server_saves_sent: false,
      accounts: { ...stored, [localId]: { ...stored[localId], server_saves_sent: true } },
    });

    await sending.provider.send(ACCOUNT_ID, OUTGOING, { idempotencyKey: 'dr-10b:1' });
    // Its OWN server files the copy, so this plugin adding one would be the second in Sent.
    await new Promise((resolve) => setTimeout(resolve, 250));
    expect(wire.appends).toEqual([]);

    // And the other way round: the box says "the server saves it", this account says it does not.
    await sending.patch({
      server_saves_sent: true,
      accounts: { ...stored, [localId]: { ...stored[localId], server_saves_sent: false } },
    });
    await sending.provider.send(ACCOUNT_ID, OUTGOING, { idempotencyKey: 'dr-10b:2' });
    await expect.poll(() => wire.appends, { timeout: 5_000 }).toEqual([
      { mailbox: 'Sent', bytes: RAW_MIME, flags: ['\\Seen'], hasDate: true },
    ]);
    await sending.pool.disposeAll();
  });

  it('still reports a successful send when the Sent copy fails', async () => {
    const sending = await withAccount(undefined, true);
    wire.listing = [...wire.listing, { path: 'Sent', specialUse: '\\Sent', status: { messages: 0, unseen: 0 } }];
    wire.failAppendWith = new Error('the server refused the APPEND');

    // The message is already delivered by the time the copy is attempted. Reporting this as a
    // failed send would invite a retry that delivers it twice, for a missing copy.
    const result = await sending.provider.send(ACCOUNT_ID, OUTGOING, { idempotencyKey: 'dr-11:1' });
    expect(result.acceptedAt).toBeGreaterThan(0);
    await expect.poll(() => wire.appends.length, { timeout: 5_000 }).toBe(1);
    await expect.poll(() => logLines.join(' '), { timeout: 5_000 })
      .toContain('could not file a copy in Sent');
    await sending.pool.disposeAll();
  });

  it('does not wait for the Sent copy, so a wedged mailbox cannot manufacture an unknown', async () => {
    const sending = await withAccount(undefined, true);
    wire.listing = [...wire.listing, { path: 'Sent', specialUse: '\\Sent', status: { messages: 0, unseen: 0 } }];
    // The APPEND never answers. Awaited, this is 25s of SMTP plus two 12s IMAP commands, which is
    // past the base's own 30s send deadline: a slow mailbox would turn a delivered message into
    // "Walnut cannot tell whether it went", and `unknown` is the one outcome nobody can resolve.
    wire.hangOn = 'append Sent';

    const startedAt = Date.now();
    const result = await sending.provider.send(ACCOUNT_ID, OUTGOING, { idempotencyKey: 'dr-13:1' });

    expect(result.acceptedAt).toBeGreaterThan(0);
    expect(result.providerMessageId).toBe(messageIdFor('dr-13:1', ADDRESS));
    // Well inside the base's deadline, with the copy still hanging behind it.
    expect(Date.now() - startedAt).toBeLessThan(5_000);
    // The copy really was attempted, it is just still sitting there. Polled, because the whole
    // point is that the send did not wait for this.
    await expect.poll(() => wire.commands, { timeout: 5_000 }).toContain('append Sent');
    // Left hanging on purpose: `disposeAll` would wait for the connection this command is holding,
    // and the detached copy is exactly what nothing is allowed to wait for.
    wire.hangOn = null;
  });

  it('never puts the password in a log line, however the send ends', async () => {
    const sending = await withAccount(undefined, true);
    const refused = new Error('535 nope') as Error & { code: string };
    refused.code = 'EAUTH';
    smtp.failWith = refused;
    await sending.provider.send(ACCOUNT_ID, OUTGOING, { idempotencyKey: 'dr-12:1' }).catch(() => undefined);

    smtp.failWith = null;
    await sending.provider.send(ACCOUNT_ID, OUTGOING, { idempotencyKey: 'dr-12:2' });
    expect(logLines.join(' ')).not.toContain(PASSWORD);
    // It reaches the transport and nowhere else, which is the same rule the IMAP half keeps.
    expect(smtp.options.every((one) => one.auth?.pass === PASSWORD)).toBe(true);
    await sending.pool.disposeAll();
  });
});

describe('the setup probe', () => {
  it('verifies SMTP only when the outgoing fields are given', async () => {
    const readOnly = buildProvider();
    await readOnly.provider.setup.submit({
      address: ADDRESS, password: PASSWORD, imap_host: 'imap.example.invalid', imap_tls: 'tls',
    });
    // No outgoing fields, so no outgoing probe and no stored SMTP block: the account reads mail.
    expect(smtp.verifies).toBe(0);
    const stored = (readOnly.config().accounts as Record<string, Record<string, unknown>>)[localIdFor(ADDRESS)]!;
    expect(stored.smtp_host).toBeUndefined();
    await readOnly.pool.disposeAll();

    const sending = buildProvider();
    await sending.provider.setup.submit({
      address: ADDRESS, password: PASSWORD, imap_host: 'imap.example.invalid', imap_tls: 'tls',
      smtp_host: 'smtp.example.invalid', smtp_tls: 'starttls',
    });
    // Proved while the human is still looking at the form, rather than in a letter whose Send
    // button is guaranteed to fail.
    expect(smtp.verifies).toBe(1);
    expect(smtp.closes).toBeGreaterThan(0);
    const savedSmtp = (sending.config().accounts as Record<string, Record<string, unknown>>)[localIdFor(ADDRESS)]!;
    expect(savedSmtp).toMatchObject({ smtp_host: 'smtp.example.invalid', smtp_port: 587, smtp_tls: 'starttls' });
    await sending.pool.disposeAll();
  });

  it('stores nothing when the outgoing server refuses the credential', async () => {
    const failed = new Error('535 authentication failed') as Error & { code: string };
    failed.code = 'EAUTH';
    smtp.failVerifyWith = failed;
    const wired = buildProvider();

    await expect(wired.provider.setup.submit({
      address: ADDRESS, password: PASSWORD, imap_host: 'imap.example.invalid', imap_tls: 'tls',
      smtp_host: 'smtp.example.invalid', smtp_tls: 'starttls',
    })).rejects.toMatchObject({ code: 'auth' });

    // A half-configured account is worse than none: it would fail every send with a credential
    // the user believes they have already fixed.
    expect(wired.config()).toEqual({});
    expect([...wired.secrets.keys()]).toEqual([]);
    await wired.pool.disposeAll();
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

  /**
   * `Reply-To` decides where a reply GOES (the base prefers it over `From`), and the draft route
   * refuses a recipient that is not an address. So a header that parses to something address-shaped
   * has to be kept, and one that does not has to vanish rather than travel: both headers below are
   * real and legal, and passing either one through turned Reply into a 400 the human never saw a
   * reason for, on a message whose `From` would have worked.
   */
  it('keep only address-shaped Reply-To values, so Reply can fall back to From', () => {
    expect(replyToList('"Doe, Jane" <jane@example.invalid>, desk@example.invalid')).toEqual([
      { name: 'Doe, Jane', address: 'jane@example.invalid' },
      { address: 'desk@example.invalid' },
    ]);
    // A group syntax with no members, and an empty path. Neither is an address.
    expect(replyToList('undisclosed-recipients:;')).toEqual([]);
    expect(replyToList('<>')).toEqual([]);
    expect(replyToList('Some Name')).toEqual([]);
    expect(replyToList(undefined)).toEqual([]);
    // One usable address among the noise still comes through: the fallback is for having none.
    expect(replyToList('undisclosed-recipients:;, desk@example.invalid')).toEqual([
      { address: 'desk@example.invalid' },
    ]);
    // Bounded, because a header is whatever the sender typed.
    const many = Array.from({ length: 30 }, (_, at) => `a${at}@example.invalid`).join(', ');
    expect(replyToList(many)).toHaveLength(10);
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
