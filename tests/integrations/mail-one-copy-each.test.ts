/**
 * A read across folders draws each mail once. Gmail keeps one message in INBOX, `[Gmail]/All Mail`
 * and `[Gmail]/Important`, and the cache stores a row per folder, so a search or a thread listed one
 * mail two or three times (review 2026-11-08, "duplicate search rows"). Graded against the real
 * plugin database (worker-thread SQLite with the real migrations and the real FTS table).
 *
 * The second half is the class guard: every store method that answers cached rows is listed with how
 * it keeps copies apart, so a new cross-folder read fails here until it says.
 */
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { PluginDatabaseClient } from '../../src/core/plugins/plugin-storage.js';
import type { WalnutServerPluginApi } from '../../src/core/plugins/server-api.js';
import { MailDatabase } from '../../src/integrations/mail/db.js';
import { MailStore, type MessageWrite } from '../../src/integrations/mail/store.js';

const ACCOUNT = 'imap:acct-copies';
const AT = Date.UTC(2026, 10, 7, 22, 12, 24);
const open: MailDatabase[] = [];
const roots: string[] = [];

afterEach(async () => {
  for (const db of open.splice(0)) await db.dispose().catch(() => undefined);
  for (const root of roots.splice(0)) await fsp.rm(root, { recursive: true, force: true });
});

async function openStore(): Promise<MailStore> {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'mail-one-copy-'));
  roots.push(root);
  const client = new PluginDatabaseClient(path.join(root, 'plugin.sqlite'));
  const walnut = { storage: { get database() { return client; } } } as unknown as WalnutServerPluginApi;
  const db = new MailDatabase(walnut);
  open.push(db);
  return new MailStore(db);
}

const write = (mailboxId: string, uid: number, over: Partial<MessageWrite> = {}): MessageWrite => ({
  accountId: ACCOUNT, messageId: `${mailboxId}:7:${uid}`, rfcMessageId: '<bill-quartz@utility.example.invalid>',
  mailboxId, threadId: 'thr-quartz', fromAddr: 'billing@utility.example.invalid', subject: 'Your quartz bill is ready',
  snippet: 'Quartz bill', sentAt: AT, receivedAt: AT, flagsJson: '[]', attachmentsJson: '[]', payload: '{}',
  envelopeHash: `hash-${mailboxId}-${uid}`, ...over,
});

async function seed(store: MailStore, one: MessageWrite): Promise<number> {
  const rowid = await store.insertMessage(one, Date.now());
  await store.indexMessage(rowid, { subject: one.subject, fromAddr: one.fromAddr, snippet: one.snippet, bodyText: '' });
  return rowid;
}

describe('one row per mail across folders', () => {
  it('search and a thread draw a Gmail mail held in three folders once, the inbox copy', async () => {
    const store = await openStore();
    await seed(store, write('[Gmail]/All Mail', 81343));
    await seed(store, write('INBOX', 61425));
    await seed(store, write('[Gmail]/Important', 33516));
    const found = await store.searchMessages('quartz', '', 50);
    expect(found.map((row) => row.mailbox_id)).toEqual(['INBOX']);
    expect((await store.searchMessages('quartz', ACCOUNT, 50)).map((row) => row.message_id)).toEqual(['INBOX:7:61425']);
    const thread = await store.threadMessages(ACCOUNT, 'thr-quartz', 50);
    expect(thread.map((row) => row.message_id)).toEqual(['INBOX:7:61425']);
    // A caller that picks the copy itself (the router read guard) still reads every folder's row.
    expect((await store.searchMessages('quartz', '', 50, 'all')).length).toBe(3);
    expect((await store.threadMessages(ACCOUNT, 'thr-quartz', 50, 'all')).length).toBe(3);
  });

  it('keeps two deliveries that reuse a Message-ID, mails with no Message-ID, and other accounts apart', async () => {
    const store = await openStore();
    await seed(store, write('INBOX', 1));
    await seed(store, write('INBOX', 2, { sentAt: AT + 60_000, receivedAt: AT + 60_000 }));
    await seed(store, write('INBOX', 3, { rfcMessageId: '' }));
    await seed(store, write('[Gmail]/All Mail', 4, { rfcMessageId: '' }));
    await seed(store, write('INBOX', 5, { accountId: 'imap:acct-other' }));
    const found = await store.searchMessages('quartz', '', 50);
    expect(found.map((row) => `${row.account_id}|${row.message_id}`).sort()).toEqual([
      'imap:acct-copies|INBOX:7:1', 'imap:acct-copies|INBOX:7:2', 'imap:acct-copies|INBOX:7:3',
      'imap:acct-copies|[Gmail]/All Mail:7:4', 'imap:acct-other|INBOX:7:5',
    ]);
  });

  it('without an inbox copy keeps the one with its body, then a folder of the person before a Gmail one', async () => {
    const store = await openStore();
    await seed(store, write('[Gmail]/Important', 10));
    await seed(store, write('Receipts', 11));
    expect((await store.searchMessages('quartz', '', 50)).map((row) => row.mailbox_id)).toEqual(['Receipts']);
    const withBody = await seed(store, write('[Gmail]/All Mail', 12));
    await store.setMessageBody(withBody, { bodyRef: 'bucket/quartz.json', bodyBytes: 10, snippet: 'Quartz bill', payload: '{}' });
    expect((await store.searchMessages('quartz', '', 50)).map((row) => row.mailbox_id)).toEqual(['[Gmail]/All Mail']);
  });
});

/**
 * Every method answering `MessageRow[]` in the mail store files, and why it cannot draw one mail
 * twice. `oneCopyEach` (through `rowsOf`) is the answer for a read across folders.
 */
const ROW_READERS: Record<string, string> = {
  listMessages: 'one folder, or one folder per account (scope pairs)',
  threadMessages: 'oneCopyEach',
  messagesByIds: 'exact message ids the caller holds',
  bodylessMessages: 'one folder',
  searchMessages: 'oneCopyEach',
  unreadInboxMessages: 'the inbox only',
  // Every copy on purpose: the router's relocate (router-source.ts) picks one copy by its folder's role.
  messagesByRfcId: 'every copy of one Message-ID, for a caller that picks one',
};

describe('the class: every cached-row reader is listed', () => {
  it('names each MessageRow[] reader, and the cross-folder ones use oneCopyEach', () => {
    const dir = path.join(process.cwd(), 'src/integrations/mail');
    const found = new Map<string, string>();
    for (const file of fs.readdirSync(dir).filter((f) => f.endsWith('.ts'))) {
      const text = fs.readFileSync(path.join(dir, file), 'utf8');
      for (const match of text.matchAll(/^ {2}(?:async )?(\w+)\([^)\n]*\)[^{\n]*: Promise<MessageRow\[\]> \{/gm)) {
        const start = match.index! + match[0].length;
        found.set(match[1]!, text.slice(start, text.indexOf('\n  }', start)));
      }
      // A multi-line signature (listMessages) ends its parameter list on a line of its own.
      for (const match of text.matchAll(/^ {2}(\w+)\(query: \{[\s\S]*?\n {2}\}\): Promise<MessageRow\[\]> \{/gm)) {
        const start = match.index! + match[0].length;
        found.set(match[1]!, text.slice(start, text.indexOf('\n  }', start)));
      }
    }
    expect([...found.keys()].sort()).toEqual(Object.keys(ROW_READERS).sort());
    for (const [name, body] of found) {
      // A cross-folder read goes through rowsOf (one per mail unless the caller asks for every copy).
      expect(/\b(rowsOf|oneCopyEach)\(/.test(body), name).toBe(ROW_READERS[name] === 'oneCopyEach');
    }
  });
});
