/**
 * The IMAP provider against a REAL mailbox. Skipped unless you point it at one.
 *
 * Mock-green is not working. A fake ImapFlow answers whatever this repo believes ImapFlow does,
 * so the things only a real server can disagree about are exactly the ones no fake can catch: the
 * shape of `list()` on a server with no SPECIAL-USE, whether `uidValidity` arrives as a BigInt,
 * whether `n:*` really does hand back the newest message, what a folder called "Projects/2026"
 * does to a SELECT, and whether the `headers` slice comes back as a Buffer.
 *
 * READ ONLY by default, on purpose. The IMAP half never sets a flag, never deletes, never sends,
 * and never writes to the plugin's config or secret store: it builds its store in memory from the
 * environment. Point it at your own account and nothing about that account changes.
 *
 *   WALNUT_LIVE_IMAP_HOST=imap.example.com \
 *   WALNUT_LIVE_IMAP_ADDRESS=you@example.com \
 *   WALNUT_LIVE_IMAP_PASSWORD='an app password, never the main one' \
 *   WALNUT_LIVE_IMAP_PORT=993 \
 *   WALNUT_LIVE_IMAP_TLS=tls \
 *   WALNUT_LIVE_IMAP_MAILBOX=INBOX \
 *   npm run test:focus tests/integrations/mail-imap-live.test.ts
 *
 * `PORT` defaults to 993 (143 for `starttls`), `TLS` to `tls`, `MAILBOX` to INBOX. With
 * `WALNUT_LIVE_IMAP_HOST` unset the whole file SKIPS, so it costs a normal run nothing.
 *
 * The SMTP block at the bottom is the one part that WRITES, because there is no way to prove a
 * send without sending. Adding `WALNUT_LIVE_SMTP_HOST` turns it on, and it then puts exactly one
 * message in your own INBOX (plus the Sent copy the provider files over IMAP, which is the half a
 * fake transporter can never grade). Leave the variable unset and none of that happens.
 *
 *   WALNUT_LIVE_SMTP_HOST=smtp.example.com \
 *   WALNUT_LIVE_SMTP_PORT=587 \
 *   WALNUT_LIVE_SMTP_TLS=starttls \
 *   npm run test:focus tests/integrations/mail-imap-live.test.ts
 */
import { describe, it, expect, afterAll } from 'vitest';
import { ImapPool } from '../../src/integrations/mail-imap/client.js';
import { accountIdFor, ImapAccountStore, localIdFor } from '../../src/integrations/mail-imap/config.js';
import { decodeMessageId, encodeCursor } from '../../src/integrations/mail-imap/coords.js';
import { createImapProvider } from '../../src/integrations/mail-imap/provider.js';

const HOST = process.env.WALNUT_LIVE_IMAP_HOST ?? '';
const ADDRESS = process.env.WALNUT_LIVE_IMAP_ADDRESS ?? '';
const PASSWORD = process.env.WALNUT_LIVE_IMAP_PASSWORD ?? '';
const TLS = process.env.WALNUT_LIVE_IMAP_TLS === 'starttls' ? 'starttls' : 'tls';
const PORT = Number(process.env.WALNUT_LIVE_IMAP_PORT) || (TLS === 'starttls' ? 143 : 993);
const MAILBOX = process.env.WALNUT_LIVE_IMAP_MAILBOX ?? 'INBOX';
const SMTP_HOST = process.env.WALNUT_LIVE_SMTP_HOST ?? '';
const SMTP_TLS = process.env.WALNUT_LIVE_SMTP_TLS === 'tls'
  ? 'tls'
  : process.env.WALNUT_LIVE_SMTP_TLS === 'none' ? 'none' : 'starttls';
const SMTP_PORT = Number(process.env.WALNUT_LIVE_SMTP_PORT) || (SMTP_TLS === 'tls' ? 465 : 587);

const configured = !!HOST && !!ADDRESS && !!PASSWORD;

/** In memory only: a live run must not leave an account behind on the developer's box. */
function memoryStore(smtp = false): ImapAccountStore {
  const config: Record<string, unknown> = {
    accounts: {
      [localIdFor(ADDRESS)]: {
        address: ADDRESS, imap_host: HOST, imap_port: PORT, imap_tls: TLS, display_name: ADDRESS,
        ...(smtp ? { smtp_host: SMTP_HOST, smtp_port: SMTP_PORT, smtp_tls: SMTP_TLS } : {}),
      },
    },
    // The Sent copy is part of what a live send has to prove: SMTP tells the mailbox nothing, so
    // without the APPEND the message the user just sent is missing from their own Sent folder.
    ...(smtp ? { append_sent: true, server_saves_sent: false } : {}),
  };
  const secrets = new Map([[`password.${localIdFor(ADDRESS)}`, PASSWORD]]);
  return new ImapAccountStore({
    config: {
      get: async () => config,
      patch: async () => { throw new Error('the live test must not write config') },
    },
    secrets: {
      get: async (key: string) => secrets.get(key),
      set: async () => { throw new Error('the live test must not write secrets') },
      delete: async () => { throw new Error('the live test must not write secrets') },
      list: async () => [...secrets.keys()],
    },
  } as never);
}

const quiet = {
  debug: () => undefined,
  info: () => undefined,
  warn: (message: string, meta?: Record<string, unknown>) => {
    // Surfaced because a live failure is almost always in here, and never with the password: the
    // connection logs a truncated transport message, and `logger: false` keeps ImapFlow quiet.
    console.warn(`[mail-imap-live] ${message}`, meta ?? {});
  },
};

const store = configured ? memoryStore() : null;
const pool = configured
  ? new ImapPool({
    settings: (accountId) => store!.settings(accountId),
    password: (accountId) => store!.password(accountId),
    log: quiet,
  })
  : null;

const sendConfigured = configured && !!SMTP_HOST;
const sendStore = sendConfigured ? memoryStore(true) : null;
const sendPool = sendConfigured
  ? new ImapPool({
    settings: (accountId) => sendStore!.settings(accountId),
    password: (accountId) => sendStore!.password(accountId),
    log: quiet,
  })
  : null;

afterAll(async () => {
  await pool?.disposeAll();
  await sendPool?.disposeAll();
});

describe.skipIf(!configured)('a real IMAP account', () => {
  const provider = () => createImapProvider({ store: store!, pool: pool!, log: quiet });
  const accountId = () => accountIdFor(ADDRESS);

  it('lists mailboxes with counts, and finds an inbox', async () => {
    const mailboxes = await provider().listMailboxes(accountId());

    expect(mailboxes.length).toBeGreaterThan(0);
    // The one role every server agrees on. If this fails, the role mapping is reading the wrong
    // field of whatever this server's `list()` actually returns.
    expect(mailboxes.filter((one) => one.role === 'inbox')).toHaveLength(1);
    for (const mailbox of mailboxes) {
      expect(typeof mailbox.mailboxId).toBe('string');
      expect(typeof mailbox.total).toBe('number');
      expect(typeof mailbox.unread).toBe('number');
    }
    console.log(`[mail-imap-live] ${mailboxes.length} mailboxes, roles:`,
      mailboxes.map((one) => `${one.mailboxId}=${one.role}`).join(' '));
  }, 60_000);

  it('polls a page, hands back a cursor, and re-polls it empty', async () => {
    const first = await provider().poll(accountId(), { mailbox: MAILBOX, limit: 3 });

    expect(typeof first.cursor).toBe('string');
    // A UIDVALIDITY the provider wrote itself, so the cursor has to be readable by its own codec.
    expect(first.cursor).toMatch(/^\d+:\d+$/);
    for (const envelope of first.messages) {
      expect(decodeMessageId(envelope.messageId)).toMatchObject({ mailbox: MAILBOX });
      // Epoch milliseconds, not a Date and not a header string.
      expect(Number.isFinite(envelope.sentAt)).toBe(true);
      expect(Array.isArray(envelope.flags)).toBe(true);
      expect(Array.isArray(envelope.attachments)).toBe(true);
    }
    console.log(`[mail-imap-live] polled ${first.messages.length} envelopes, cursor ${first.cursor},`
      + ` more=${first.more}`);

    // The quirk, on the real server: `n:*` answers with the newest message even when nothing is
    // at or above n, and the provider is what has to filter it out. An empty second page is the
    // proof it does.
    const second = await provider().poll(accountId(), { mailbox: MAILBOX, limit: 3, cursor: first.cursor });
    expect(second.messages).toEqual([]);
    expect(second.more).toBe(false);
    expect(second.reset).toBeUndefined();
  }, 120_000);

  it('fetches one body, or says why it cannot', async () => {
    const page = await provider().poll(accountId(), { mailbox: MAILBOX, limit: 1 });
    if (page.messages.length === 0) {
      console.log(`[mail-imap-live] ${MAILBOX} is empty, body fetch skipped`);
      return;
    }
    const target = page.messages[0]!;

    try {
      const body = await provider().getBody(accountId(), target.messageId);
      expect(['text', 'html', 'both']).toContain(body.format);
      expect(body.text ?? body.html).toBeTruthy();
      expect(body.bytes).toBeGreaterThan(0);
      console.log(`[mail-imap-live] body of ${target.messageId}: ${body.format}, ${body.bytes} bytes,`
        + ` ${body.attachments?.length ?? 0} attachments`);
    } catch (error) {
      // `too-large` is a correct answer, not a failure: the newest message may be over the cap,
      // and refusing it is the behavior this provider is supposed to have.
      expect((error as { code?: string }).code).toBe('too-large');
      console.log(`[mail-imap-live] body of ${target.messageId} refused as too-large, which is correct`);
    }
  }, 120_000);

  it('reports a wrong password as auth, against the real server', async () => {
    // A separate pool with a deliberately wrong secret. This is the one case where the mapping
    // has to be right or a user gets told to check their network about a typo'd password, and
    // every server words the rejection differently.
    const wrongPool = new ImapPool({
      settings: (id) => store!.settings(id),
      password: async () => 'certainly-not-the-password',
      log: quiet,
    });
    try {
      await expect(createImapProvider({ store: store!, pool: wrongPool, log: quiet })
        .listMailboxes(accountId())).rejects.toMatchObject({ code: 'auth' });
    } finally {
      await wrongPool.disposeAll();
    }
  }, 60_000);
});

/**
 * A real send, to your own address. The only check that grades SMTP end to end.
 *
 * A fake transporter answers whatever this repo believes nodemailer does, which leaves the two
 * things that actually go wrong on a real server unproven: whether the outgoing server accepts the
 * message at all under these TLS settings, and whether the composed MIME is something a mail
 * client will show. Sending it to the account's own address makes the delivery observable over the
 * same IMAP connection the rest of this file uses.
 */
describe.skipIf(!sendConfigured)('a real SMTP server', () => {
  const provider = () => createImapProvider({ store: sendStore!, pool: sendPool!, log: quiet });
  const accountId = () => accountIdFor(ADDRESS);

  it('reports this account as able to send, and refuses to guess about the read-only one', async () => {
    expect((await provider().accountCapabilities!(accountId())).send).toBe(true);
    // The same address through the store WITHOUT outgoing settings: the capability is per account
    // and answered from config, so a read-only mailbox never gets a Send button.
    const readOnly = createImapProvider({ store: store!, pool: pool!, log: quiet });
    expect((await readOnly.accountCapabilities!(accountId())).send).toBe(false);
  }, 60_000);

  it('sends one message and finds it in the inbox', async () => {
    const nonce = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    const subject = `Walnut live send ${nonce}`;

    // The newest UID BEFORE the send becomes the cursor, so the poll below only ever sees messages
    // that arrived after this line. A cursorless poll reads from the oldest UID and would have to
    // page through the whole mailbox to reach today.
    const before = await (await sendPool!.for(accountId())).run('the newest uid', async (client) => {
      const box = await client.mailboxOpen(MAILBOX);
      let top = 0;
      for await (const one of client.fetch('*:*', { uid: true }, { uid: true })) {
        if (one.uid > top) top = one.uid;
      }
      return encodeCursor(String(box.uidValidity), top);
    });

    const result = await provider().send(
      accountId(),
      {
        to: [{ address: ADDRESS }],
        subject,
        bodyMarkdown: `A live check from the Walnut test suite. Nonce ${nonce}.`,
        bodyHtml: `<p>A live check from the Walnut test suite. Nonce <code>${nonce}</code>.</p>`,
      },
      { idempotencyKey: `live-${nonce}:1` },
    );
    expect(result.acceptedAt).toBeGreaterThan(0);
    // Derived from the ledger key, so a duplicate would be recognisable as one.
    expect(result.providerMessageId).toContain('walnut-');
    console.log(`[mail-imap-live] sent ${result.providerMessageId} to ${ADDRESS}`);

    // Delivery to your own mailbox is usually seconds, but it goes through a real queue, so this
    // waits rather than asserting once.
    const deadline = Date.now() + 60_000;
    let found: string | undefined;
    while (!found && Date.now() < deadline) {
      const page = await provider().poll(accountId(), { mailbox: MAILBOX, limit: 20, cursor: before });
      found = page.messages.find((one) => one.subject === subject)?.messageId;
      if (!found) await new Promise((resolve) => setTimeout(resolve, 3_000));
    }
    expect(found, `the sent message never arrived in ${MAILBOX} within 60s`).toBeTruthy();

    const body = await provider().getBody(accountId(), found!);
    // Both alternatives went out, which is what makes the message readable in a plain-text client
    // and in a rich one. A provider that dropped one half would still pass every mocked check.
    expect(body.format).toBe('both');
    expect(body.text).toContain(nonce);
    expect(body.html).toContain(nonce);
  }, 180_000);
});
