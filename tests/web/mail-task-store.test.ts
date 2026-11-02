/**
 * What the digest event does to the bell.
 *
 * Pure store logic against a stubbed fetch, because every claim here is about state a human sees
 * before or without a server answer:
 *
 * - `digest-sent` makes NO request. It marks the letter list stale, because this subscription runs
 *   with the bell shut and the letter store would otherwise serve its 15s cache to whoever opens
 *   next, which is exactly the window in which a human reaches for the bell.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { onMailEvent, openMailDeepLink } from '../../web/src/apps/mail/mail-actions';
import { sendMailDigest } from '../../web/src/apps/mail/mail-task-actions';
import { __resetMailStore, getMailSnapshot, patch } from '../../web/src/apps/mail/mail-store';
import {
  ensureLetters,
  loadLetters,
  resetLetterStore,
  subscribeLetters,
} from '../../web/src/components/inbox/letter-store';

const ACCOUNT = 'fake:one';
const MESSAGE = 'INBOX:100:1';

interface Call { url: string; method: string; body: string | null }

let calls: Call[] = [];
let digestAnswer: { status: number; body: unknown } = {
  status: 200, body: { letterId: 'lt-1', unread: 4, accounts: 2 },
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

function envelope(messageId: string, over: Record<string, unknown> = {}) {
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
    flags: ['\\Seen'],
    attachments: [],
    hasBody: true,
    ...over,
  };
}

/** The reader open on `MESSAGE`, plus a list and a search answer holding the same row. */

beforeEach(() => {
  calls = [];
  digestAnswer = { status: 200, body: { letterId: 'lt-1', unread: 4, accounts: 2 } };
  __resetMailStore();
  resetLetterStore();
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, method: init?.method ?? 'GET', body: (init?.body as string) ?? null });
    if (url.includes('/digest/send-now')) return json(digestAnswer.body, digestAnswer.status);
    if (url.includes('/human-inbox')) return json({ letters: [] });
    if (url.includes('/mail/messages/')) {
      return json({
        message: envelope(MESSAGE, { mailboxId: 'Archive' }),
        body: { format: 'text', text: 'a body', bytes: 6, truncated: false },
      });
    }
    if (url.includes('/mail/messages')) return json({ messages: [envelope(MESSAGE)] });
    if (url.includes('/mail/mailboxes')) {
      return json({
        mailboxes: [
          { accountId: ACCOUNT, mailboxId: 'INBOX', name: 'Inbox', role: 'inbox', unread: 0, total: 1 },
          { accountId: ACCOUNT, mailboxId: 'Archive', name: 'Archive', role: 'archive', unread: 0, total: 1 },
        ],
      });
    }
    if (url.includes('/mail/accounts')) return json({ accounts: [] });
    if (url.includes('/mail/providers')) return json({ providers: [] });
    return json({ error: 'not-found', message: url }, 404);
  }));
});

afterEach(() => {
  vi.unstubAllGlobals();
  __resetMailStore();
  resetLetterStore();
});

describe('digest-sent invalidates the letter list without fetching it', () => {
  it('lets the next surface re-read instead of serving the 15s cache', async () => {
    // A surface opened and loaded the list, so `ensureLetters` would serve it for 15 more seconds.
    subscribeLetters(() => undefined);
    await loadLetters();
    const before = calls.filter((call) => call.url.includes('/human-inbox')).length;
    expect(before).toBe(1);

    ensureLetters();
    expect(calls.filter((call) => call.url.includes('/human-inbox'))).toHaveLength(before);

    // The digest lands while the bell is shut. No request, and the cache is no longer trusted.
    onMailEvent('digest-sent', { letterId: 'lt-1', unread: 4 });
    expect(calls.filter((call) => call.url.includes('/human-inbox'))).toHaveLength(before);

    ensureLetters();
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(calls.filter((call) => call.url.includes('/human-inbox'))).toHaveLength(before + 1);
  });
});

describe('send the digest now', () => {
  it('says how big the letter was', async () => {
    await sendMailDigest();
    expect(getMailSnapshot().refreshNote).toBe('Digest sent: 4 unread across 2 account(s).');
  });

  it('says nothing was sent when nothing is unread, rather than looking broken', async () => {
    digestAnswer = { status: 200, body: { letterId: null, unread: 0, accounts: 0 } };
    await sendMailDigest();
    expect(getMailSnapshot().refreshNote).toBe('Nothing is unread, so no digest was sent.');
  });

  it('reports a 202 as still building', async () => {
    digestAnswer = { status: 202, body: { ok: true, pending: true } };
    await sendMailDigest();
    expect(getMailSnapshot().refreshNote).toBe('The digest is still being built.');
  });
});

describe('a backlink from somewhere else in Walnut', () => {
  it('opens the message and moves the middle pane to the mailbox that holds it', async () => {
    patch({
      loaded: true,
      accounts: [{
        accountId: ACCOUNT, providerId: 'fake', displayName: 'Fixture',
        address: 'alice@example.invalid', state: 'active', unread: 0,
      }],
      selected: { accountId: ACCOUNT, mailboxId: 'INBOX' },
    });
    await openMailDeepLink(ACCOUNT, MESSAGE);

    const state = getMailSnapshot();
    // The message's own `mailboxId` decides the selection, not the link.
    expect(state.selected).toEqual({ accountId: ACCOUNT, mailboxId: 'Archive' });
    expect(state.open?.messageId).toBe(MESSAGE);
    // ONE read of the message: the answer that decided the mailbox is the one that filled the reader.
    expect(calls.filter((call) => call.url.includes(encodeURIComponent(MESSAGE)))).toHaveLength(1);
  });

  it('previews an unread Inbox source without any mail flag write', async () => {
    patch({ loaded: true, selected: { accountId: ACCOUNT, mailboxId: 'INBOX' } });
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ url: String(input), method: init?.method ?? 'GET', body: (init?.body as string) ?? null });
      return json({ message: envelope(MESSAGE, { mailboxId: 'Archive', flags: [] }),
        body: { format: 'text', text: 'Saved source body', bytes: 17, truncated: false } });
    }));
    await openMailDeepLink(ACCOUNT, MESSAGE, { markRead: false });
    expect(getMailSnapshot().open?.message?.flags).toEqual([]);
    expect(getMailSnapshot().open?.messageId).toBe(MESSAGE);
    expect(calls.filter(call => call.method !== 'GET')).toEqual([]);
  });

  it('says so in one line when the link points at a message the cache dropped', async () => {
    patch({ loaded: true, selected: { accountId: ACCOUNT, mailboxId: 'INBOX' } });
    vi.stubGlobal('fetch', vi.fn(async () => json({ error: 'not-found', message: 'gone' }, 404)));
    await openMailDeepLink(ACCOUNT, MESSAGE);

    expect(getMailSnapshot().refreshNote)
      .toBe('That message is not in the cache any more, so Mail opened without it.');
    // And the console is still on what it was showing, rather than on an empty reader.
    expect(getMailSnapshot().selected).toEqual({ accountId: ACCOUNT, mailboxId: 'INBOX' });
  });
});
