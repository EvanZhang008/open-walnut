/**
 * The badge after a row flip, and the answer a row gives after a retry: two reports about state that
 * only shows up when a SERVER LANDING meets this console's own optimistic overlay.
 *
 * - R2-02. The overlay exists because a mailbox's unread count lands wholesale and the provider's figure
 *   lags. Once `POST …/read` has answered, though, the server's own count already includes that flip, so
 *   every later landing was having it subtracted a SECOND time: measured badge 1 where the truth was 2,
 *   healed only by a page read that happened to confirm the row.
 * - R2-04. A refusal writes a sentence that now WAITS to be read. Retrying the same row therefore left
 *   "Walnut could not mark it read" standing over a row the retry had just marked read.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { setMailMessageRead } from '../../web/src/apps/mail/mail-read-flag';
import { refreshMailAll } from '../../web/src/apps/mail/mail-actions';
import {
  SEEN,
  __resetMailStore,
  getMailSnapshot,
  patch,
  setMailBadgeHandle,
} from '../../web/src/apps/mail/mail-store';
import type { MailMessageDto, MailboxDto } from '../../web/src/api/mail';

const ACCOUNT = 'fake:one';
const MAILBOX = 'INBOX';

let published: (number | null)[] = [];
/** What the SERVER answers with, which is the whole point: it is not the store's optimistic copy. */
let serverUnread = { mailbox: 2, account: 2 };
/** The page the server answers with. Deliberately a LAGGING cache in the flip cases. */
let serverRows: MailMessageDto[] = [];
/** Injected refusal for the next read write, cleared by the case that retries. */
let refuse = false;

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

function envelope(messageId: string, over: Partial<MailMessageDto> = {}): MailMessageDto {
  return {
    messageId,
    accountId: ACCOUNT,
    mailboxId: MAILBOX,
    rfcMessageId: `<${messageId}@example.invalid>`,
    from: { name: 'Harbour Notices', address: 'harbour@example.invalid' },
    to: [{ address: 'me@example.invalid' }],
    subject: `Subject ${messageId}`,
    snippet: 'a sentence',
    sentAt: Date.parse('2026-09-17T09:00:00Z'),
    flags: [],
    attachments: [],
    hasBody: true,
    ...over,
  } as MailMessageDto;
}

function mailboxRow(unread: number): MailboxDto {
  return {
    accountId: ACCOUNT, mailboxId: MAILBOX, name: 'Inbox', role: 'inbox',
    unread, total: 40, lastSyncAt: Date.parse('2026-09-17T09:05:00Z'),
  } as MailboxDto;
}

function seed(rows: MailMessageDto[]): void {
  patch({
    loaded: true,
    providersKnown: true,
    providers: [{ id: 'fake', label: 'Fixture', capabilities: { markRead: true, send: true } }] as never,
    accounts: [{
      accountId: ACCOUNT, displayName: 'one',
      unread: serverUnread.account, unreadInbox: serverUnread.account,
    }] as never,
    mailboxes: { [ACCOUNT]: [mailboxRow(serverUnread.mailbox)] },
    selected: { accountId: ACCOUNT, mailboxId: MAILBOX },
    messages: rows,
  });
}

function mailboxUnread(): number {
  return getMailSnapshot().mailboxes[ACCOUNT]![0]!.unread;
}

function accountUnread(): number {
  return getMailSnapshot().accounts[0]!.unread;
}

beforeEach(() => {
  published = [];
  refuse = false;
  serverUnread = { mailbox: 2, account: 2 };
  serverRows = [];
  __resetMailStore();
  const kept = new Map<string, string>();
  vi.stubGlobal('window', {
    localStorage: {
      getItem: (key: string) => kept.get(key) ?? null,
      setItem: (key: string, value: string) => { kept.set(key, value); },
      removeItem: (key: string) => { kept.delete(key); },
    },
  });
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    let body: unknown = null;
    if (typeof init?.body === 'string') body = JSON.parse(init.body);
    if (url.includes('/read')) {
      if (refuse) return json({ error: 'unsupported', message: 'This account cannot change read flags (Fixture).' }, 409);
      const messageId = decodeURIComponent(url.split('/messages/')[1]!.split('/')[1]!);
      // The server counts the flip as it writes it, which is what every later landing already includes.
      serverUnread = {
        mailbox: Math.max(0, serverUnread.mailbox - 1),
        account: Math.max(0, serverUnread.account - 1),
      };
      return json({ ok: true, message: envelope(messageId, { flags: (body as { read?: boolean }).read ? [SEEN] : [] }) });
    }
    if (url.includes('/mail/messages')) return json({ messages: serverRows });
    if (url.includes('/mail/mailboxes')) return json({ mailboxes: [mailboxRow(serverUnread.mailbox)] });
    if (url.includes('/mail/accounts')) {
      return json({ accounts: [{
        accountId: ACCOUNT, displayName: 'one',
        unread: serverUnread.account, unreadInbox: serverUnread.account,
      }] });
    }
    if (url.includes('/mail/drafts')) return json({ drafts: [] });
    if (url.includes('/refresh')) return json({ ok: true });
    return json({ error: 'not-found', message: url }, 404);
  }));
  setMailBadgeHandle({ setBadge: (value) => { published.push(value); } });
  published = [];
});

afterEach(() => {
  vi.unstubAllGlobals();
  __resetMailStore();
});

describe('R2-02: the badge after a flip and a refresh', () => {
  it('equals the server\'s number, with no refresh during which it reads one low', async () => {
    const one = envelope('INBOX:1:1');
    const two = envelope('INBOX:1:2');
    serverRows = [one, two];
    seed([one, two]);

    await setMailMessageRead(one, true);
    // The flip is on screen and counted once: 2 unread became 1.
    expect(mailboxUnread()).toBe(1);
    expect(accountUnread()).toBe(1);
    expect(serverUnread).toEqual({ mailbox: 1, account: 1 });

    // A LAGGING page: the plugin's cache still returns the row unread, so the overlay is not retired by
    // a confirmation and the landing is judged on the clock alone.
    serverRows = [envelope('INBOX:1:1'), two];
    await refreshMailAll(true);
    expect(mailboxUnread(), 'the flip is not subtracted from a count that already includes it').toBe(1);
    expect(accountUnread()).toBe(1);

    // And it stays: a second refresh used to be what healed it.
    await refreshMailAll(true);
    expect(mailboxUnread()).toBe(1);
    expect(accountUnread()).toBe(1);
    expect(published.every((value) => value === 1 || value === null)).toBe(true);
  });

  it('still holds a flip back from a landing that PREDATES its answer', async () => {
    const one = envelope('INBOX:1:1');
    serverRows = [one];
    seed([one]);
    // The mailbox list leaves first and answers with the number that still counts this row; the flip is
    // written while it is in flight. The subtraction is what keeps the row and the badge agreeing.
    const landing = refreshMailAll(true);
    await setMailMessageRead(one, true);
    await landing;
    // Never one HIGH: the older landing's number still counted this row, and the overlay is what takes
    // it off. The overlay is also still held, because the lagging page has not confirmed the flag yet.
    expect(mailboxUnread()).toBeLessThanOrEqual(1);
    expect(Object.keys(getMailSnapshot().pendingSeen)).toHaveLength(1);
  });

  it('does not move at all when nothing was flipped', async () => {
    const one = envelope('INBOX:1:1');
    serverRows = [one, envelope('INBOX:1:2')];
    seed(serverRows);
    await refreshMailAll(true);
    await refreshMailAll(true);
    expect(mailboxUnread()).toBe(2);
    expect(accountUnread()).toBe(2);
  });
});

describe('R2-04: a retry clears the answer it is retrying', () => {
  it('leaves no refusal on screen above a row the retry marked read', async () => {
    const one = envelope('INBOX:1:1');
    serverRows = [one];
    seed([one]);

    refuse = true;
    await setMailMessageRead(one, true);
    const refused = getMailSnapshot();
    expect(refused.rowNote?.text).toContain('Walnut could not mark');
    // It waits to be read rather than retiring on a timer, which is exactly why the retry has to clear it.
    expect(refused.rowNote?.sticky).toBe(true);
    expect(Object.keys(refused.flagFailed)).toHaveLength(1);

    refuse = false;
    await setMailMessageRead(one, true);
    const after = getMailSnapshot();
    expect(after.messages[0]!.flags, 'the row really is read now').toContain(SEEN);
    expect(after.rowNote, 'and nothing on screen still says it failed').toBeNull();
    expect(Object.keys(after.flagFailed)).toHaveLength(0);
  });

  it('keeps a note about ANOTHER row, which is still true', async () => {
    const one = envelope('INBOX:1:1');
    const two = envelope('INBOX:1:2');
    serverRows = [one, two];
    seed([one, two]);

    refuse = true;
    await setMailMessageRead(one, true);
    expect(getMailSnapshot().rowNote?.text).toContain('Subject INBOX:1:1');

    refuse = false;
    await setMailMessageRead(two, true);
    // The refusal was about row one; flipping row two does not answer it.
    expect(getMailSnapshot().rowNote?.text).toContain('Subject INBOX:1:1');
  });
});
