/**
 * The mail console's store: one fetch per key, and an optimistic read that can be taken back.
 *
 * Why coalescing is a test and not a detail. Three call sites ask for the same page in the same
 * frame on a normal open (the mount effect, the mailbox selection, and the first live event),
 * and a mail page is the most expensive read the console makes. Without a single in-flight
 * promise per key that is three identical requests, three of the browser's six connections, and
 * three renders of the same list.
 *
 * Why the read flag is a test. Marking a message read touches three numbers that live in
 * different places (the row's flags, the mailbox badge, the account total, which is what the
 * sidebar badge sums), and the server cannot help: mailbox unread counts come from the provider
 * and only move on the next mailbox refresh. So the console owns the optimistic move AND owns
 * putting all three back when the provider refuses.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  loadMailBadgeSource,
  loadMailMessages,
  openMailConsole,
  openMailMessage,
  retryOpenMessageBody,
  selectMailbox,
} from '../../web/src/apps/mail/mail-actions';
import { __resetMailStore, getMailSnapshot } from '../../web/src/apps/mail/mail-store';

const ACCOUNT = 'fake:one';

interface Call { url: string; method: string }

let calls: Call[] = [];
let readStatus = 200;
/** When set, the message route answers with an envelope and a remembered body failure. */
let bodyError: string | null = null;

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

const PROVIDERS = {
  providers: [{
    id: 'fake',
    label: 'Fixture Mail',
    capabilities: {
      search: false, watch: false, drafts: false, markRead: true, flags: false,
      threads: false, send: false, sendAsReply: false, bodies: 'both', attachments: 'metadata',
    },
    setupFields: [{ name: 'address', label: 'Address', kind: 'text', required: true }],
  }],
};

const ACCOUNTS = {
  accounts: [{
    accountId: ACCOUNT,
    providerId: 'fake',
    displayName: 'Fixture',
    address: 'alice@example.invalid',
    state: 'active',
    unread: 2,
  }],
};

const MAILBOXES = {
  mailboxes: [
    { accountId: ACCOUNT, mailboxId: 'INBOX', name: 'Inbox', role: 'inbox', unread: 2, total: 3 },
    { accountId: ACCOUNT, mailboxId: 'Archive', name: 'Archive', role: 'archive', unread: 0, total: 1 },
  ],
};

function envelope(messageId: string, seen: boolean) {
  return {
    messageId,
    accountId: ACCOUNT,
    mailboxId: 'INBOX',
    rfcMessageId: `<${messageId}@example.invalid>`,
    from: { name: 'Alice', address: 'alice@example.invalid' },
    to: [{ address: 'me@example.invalid' }],
    subject: `Subject ${messageId}`,
    snippet: 'a sentence',
    sentAt: Date.parse('2026-09-05T09:00:00Z'),
    flags: seen ? ['\\Seen'] : [],
    attachments: [],
    hasBody: true,
  };
}

const MESSAGES = { messages: [envelope('m-unread', false), envelope('m-read', true)] };

beforeEach(() => {
  calls = [];
  readStatus = 200;
  bodyError = null;
  __resetMailStore();
  vi.stubGlobal('fetch', vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, method: init?.method ?? 'GET' });
    if (url.includes('/read')) {
      return Promise.resolve(readStatus === 200
        ? json({ ok: true, message: { ...envelope('m-unread', true) } })
        : json({ error: 'unsupported', message: 'this provider cannot change the read flag' }, readStatus));
    }
    if (url.includes('/mail/messages/')) {
      // The plugin's own shape: an envelope plus EITHER a body or the remembered failure, and it
      // only tries the provider again when the caller asked for a retry.
      if (bodyError && !url.includes('retry=1')) {
        return Promise.resolve(json({ message: envelope('m-unread', false), body: null, bodyError }));
      }
      return Promise.resolve(json({
        message: envelope('m-unread', false),
        body: { format: 'text', text: 'a body', bytes: 6, truncated: false },
      }));
    }
    if (url.includes('/mail/messages')) return Promise.resolve(json(MESSAGES));
    if (url.includes('/mail/mailboxes')) return Promise.resolve(json(MAILBOXES));
    if (url.includes('/mail/accounts')) return Promise.resolve(json(ACCOUNTS));
    if (url.includes('/mail/providers')) return Promise.resolve(json(PROVIDERS));
    return Promise.resolve(json({ error: 'not-found', message: url }, 404));
  }));
});

afterEach(() => {
  vi.unstubAllGlobals();
  __resetMailStore();
});

function countOf(fragment: string): number {
  return calls.filter((call) => call.url.includes(fragment)).length;
}

describe('one request per key', () => {
  it('serves three callers asking for the same page from one fetch', async () => {
    selectMailbox(ACCOUNT, 'INBOX');
    const first = loadMailMessages();
    const second = loadMailMessages();
    await Promise.all([first, second]);

    expect(countOf('/mail/messages')).toBe(1);
    expect(getMailSnapshot().messages.map((one) => one.messageId)).toEqual(['m-unread', 'm-read']);
    expect(getMailSnapshot().listLoading).toBe(false);
  });

  it('still refetches when a caller asks for fresh data after the first landed', async () => {
    selectMailbox(ACCOUNT, 'INBOX');
    await loadMailMessages();
    await loadMailMessages(true);
    expect(countOf('/mail/messages')).toBe(2);
  });

  it('knows its providers after the badge preload, not just after a cold open', async () => {
    // The preload marks the store `loaded`, so the console takes its "already loaded" path and
    // never runs the bootstrap that fetches providers. Without providers the empty state tells a
    // machine with two installed to go install one, and every markRead capability reads as absent.
    await loadMailBadgeSource();
    await openMailConsole();

    const snapshot = getMailSnapshot();
    expect(snapshot.providers.map((one) => one.id)).toEqual(['fake']);
    expect(snapshot.mailboxes[ACCOUNT]).toHaveLength(2);
    expect(countOf('/mail/providers')).toBe(1);
  });

  it('opens the console with one request per route and selects the inbox', async () => {
    await openMailConsole();

    expect(countOf('/mail/providers')).toBe(1);
    expect(countOf('/mail/accounts')).toBe(1);
    expect(countOf('/mail/mailboxes')).toBe(1);
    const snapshot = getMailSnapshot();
    expect(snapshot.selected).toEqual({ accountId: ACCOUNT, mailboxId: 'INBOX' });
    expect(snapshot.messages).toHaveLength(2);
    expect(snapshot.loaded).toBe(true);
  });
});

describe('the optimistic read flag', () => {
  it('clears the row and both badges as soon as the message opens', async () => {
    await openMailConsole();
    await openMailMessage(ACCOUNT, 'm-unread');

    const snapshot = getMailSnapshot();
    expect(snapshot.messages.find((one) => one.messageId === 'm-unread')!.flags).toContain('\\Seen');
    expect(snapshot.mailboxes[ACCOUNT]!.find((one) => one.mailboxId === 'INBOX')!.unread).toBe(1);
    expect(snapshot.accounts[0]!.unread).toBe(1);
    expect(calls.some((call) => call.method === 'POST' && call.url.includes('/read'))).toBe(true);
  });

  it('puts all three back when the provider refuses', async () => {
    readStatus = 409;
    await openMailConsole();
    await openMailMessage(ACCOUNT, 'm-unread');

    const snapshot = getMailSnapshot();
    expect(snapshot.messages.find((one) => one.messageId === 'm-unread')!.flags).not.toContain('\\Seen');
    expect(snapshot.mailboxes[ACCOUNT]!.find((one) => one.mailboxId === 'INBOX')!.unread).toBe(2);
    expect(snapshot.accounts[0]!.unread).toBe(2);
    // The body still opened: a read flag the provider will not change is not a failed read.
    expect(snapshot.open?.body?.text).toBe('a body');
  });

  it('reopens a body error with ?retry=1, and an ordinary open without it', async () => {
    // The plugin remembers a body it could not fetch and answers every later read with the same
    // notice, so a "Try again" that omits the flag asks for the cached failure: the human presses
    // it, nothing changes, and the console looks broken.
    bodyError = 'too-large';
    await openMailConsole();
    await openMailMessage(ACCOUNT, 'm-unread');
    expect(getMailSnapshot().open?.bodyError).toBe('too-large');
    const before = calls.filter((call) => call.url.includes('retry=1')).length;
    expect(before).toBe(0);

    bodyError = null;
    await retryOpenMessageBody();

    const retried = calls.filter((call) => call.url.includes('/mail/messages/') && call.url.includes('retry=1'));
    expect(retried).toHaveLength(1);
    expect(getMailSnapshot().open?.bodyError).toBe(null);
    expect(getMailSnapshot().open?.body?.text).toBe('a body');
  });

  it('does not send retry when the body was fine and the human reopened it', async () => {
    await openMailConsole();
    await openMailMessage(ACCOUNT, 'm-unread');
    await retryOpenMessageBody();
    expect(calls.some((call) => call.url.includes('retry=1'))).toBe(false);
  });

  it('asks nothing of a provider that cannot change the flag', async () => {
    PROVIDERS.providers[0]!.capabilities.markRead = false;
    try {
      await openMailConsole();
      await openMailMessage(ACCOUNT, 'm-unread');
      expect(calls.some((call) => call.url.includes('/read'))).toBe(false);
      expect(getMailSnapshot().mailboxes[ACCOUNT]!.find((one) => one.mailboxId === 'INBOX')!.unread).toBe(2);
    } finally {
      PROVIDERS.providers[0]!.capabilities.markRead = true;
    }
  });
});
