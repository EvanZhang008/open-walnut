/**
 * Flipping ONE ROW's read flag from a menu, which is the same four numbers the reader's own toggle
 * moves and three new ways to get them wrong, because the row is not the thing the human is looking
 * at.
 *
 * Every case here is arithmetic a person sees before any server answers:
 *
 * - THE MENU IS A SNAPSHOT. It was built at the right-click and the row may have been flipped since
 *   (another tab, a sync, the reader). Marking it read again must move nothing at all.
 * - THE COUNTS ARE PUT BACK, not un-deltaed. The forward step clamps at 0, so a mailbox already at 0
 *   swallowed it and the rollback then invented one unread.
 * - THE LAST INTENT WINS. Read then unread in one tick used to land in arrival order.
 * - A ROW THIS CONSOLE FLIPPED STAYS ON AN UNREAD PAGE, and comes back to its own index when the
 *   provider refuses.
 * - ONE PLACE WRITES `\Seen`. Anything else drifts the row from the badge.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { setMailMessageRead } from '../../web/src/apps/mail/mail-read-flag';
import { loadMailMessages, selectMailbox, setMailUnreadOnly } from '../../web/src/apps/mail/mail-actions';
import {
  SEEN,
  __resetMailStore,
  getMailSnapshot,
  pairKey,
  patch,
  setMailBadgeHandle,
} from '../../web/src/apps/mail/mail-store';
import { readUnreadOnly, writeUnreadOnly } from '../../web/src/apps/mail/mail-unread-filter';
import type { MailMessageDto } from '../../web/src/api/mail';

const MAIL_DIR = 'web/src/apps/mail';
const ACCOUNT = 'fake:one';
const MAILBOX = 'INBOX';

interface Call { url: string; method: string; body: unknown }

let calls: Call[] = [];
/** Published badge values, newest last. The sidebar's own number, not a derived one. */
let published: (number | null)[] = [];
/** What `POST …/read` answers, per message id. A function so a case can delay one of them. */
let readAnswer: (messageId: string, read: boolean) => Promise<Response>;
/** The unread page the server would answer with next, when a case reloads one. */
let unreadPage: MailMessageDto[] = [];

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

/** The provider that CAN mark read, and the account it is behind. */
function seed(rows: MailMessageDto[], unread: { mailbox: number; account: number }): void {
  patch({
    loaded: true,
    providersKnown: true,
    providers: [{
      id: 'fake',
      label: 'Fixture',
      capabilities: { markRead: true, send: true },
    }] as never,
    accounts: [{
      accountId: ACCOUNT, displayName: 'one', unread: unread.account, unreadInbox: unread.account,
    }] as never,
    mailboxes: {
      [ACCOUNT]: [{
        accountId: ACCOUNT, mailboxId: MAILBOX, name: 'Inbox', role: 'inbox',
        unread: unread.mailbox, total: 40, lastSyncAt: Date.parse('2026-09-17T09:05:00Z'),
      }] as never,
    },
    selected: { accountId: ACCOUNT, mailboxId: MAILBOX },
    messages: rows,
  });
}

function rowOf(messageId: string): MailMessageDto | undefined {
  return getMailSnapshot().messages.find((one) => one.messageId === messageId);
}

function isRead(messageId: string): boolean {
  return !!rowOf(messageId)?.flags.includes(SEEN);
}

function mailboxUnread(): number {
  return getMailSnapshot().mailboxes[ACCOUNT]![0]!.unread;
}

function accountUnread(): number {
  return getMailSnapshot().accounts[0]!.unread;
}

function readCalls(): Call[] {
  return calls.filter((call) => call.url.includes('/read'));
}

beforeEach(() => {
  calls = [];
  published = [];
  unreadPage = [];
  readAnswer = async (messageId, read) => json({
    ok: true,
    message: envelope(messageId, { flags: read ? [SEEN] : [] }),
  });
  __resetMailStore();
  // The unread filter lives in `localStorage`, which this tier has none of: without a stub
  // `readUnreadOnly` swallows the ReferenceError and every filtered case silently grades the
  // unfiltered path.
  const kept = new Map<string, string>();
  vi.stubGlobal('window', {
    localStorage: {
      getItem: (key: string) => kept.get(key) ?? null,
      setItem: (key: string, value: string) => { kept.set(key, value) },
      removeItem: (key: string) => { kept.delete(key) },
    },
  });
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? 'GET';
    let body: unknown = null;
    if (typeof init?.body === 'string') body = JSON.parse(init.body);
    calls.push({ url, method, body });
    if (url.includes('/read')) {
      const messageId = decodeURIComponent(url.split('/messages/')[1]!.split('/')[1]!);
      return readAnswer(messageId, !!(body as { read?: boolean }).read);
    }
    if (url.includes('/mail/messages')) return json({ messages: unreadPage });
    if (url.includes('/mail/mailboxes')) return json({ mailboxes: getMailSnapshot().mailboxes[ACCOUNT] ?? [] });
    return json({ error: 'not-found', message: url }, 404);
  }));
  setMailBadgeHandle({ setBadge: (value) => { published.push(value) } });
  published = [];
});

afterEach(() => {
  vi.unstubAllGlobals();
  __resetMailStore();
});

describe('a menu built before the row changed', () => {
  it('moves the badge once, not twice, when the row is already read (C55)', async () => {
    const stale = envelope('INBOX:1:1');
    seed([stale], { mailbox: 3, account: 3 });
    // What the menu holds is the payload from the right-click. The STORE has moved on: the other tab
    // marked it read, so the console's own row already counts as read and the badge already dropped.
    patch({
      messages: [envelope('INBOX:1:1', { flags: [SEEN] })],
      mailboxes: {
        [ACCOUNT]: [{ ...getMailSnapshot().mailboxes[ACCOUNT]![0]!, unread: 2 }],
      },
      accounts: [{ ...getMailSnapshot().accounts[0]!, unread: 2, unreadInbox: 2 }],
    });
    published = [];

    await setMailMessageRead(stale, true);

    // One drop in total, from the change that really happened. `applySeen` is the only thing in this
    // file that publishes the badge, so zero publishes IS zero calls to it.
    expect(published).toEqual([]);
    expect(mailboxUnread()).toBe(2);
    expect(accountUnread()).toBe(2);
    expect(isRead('INBOX:1:1')).toBe(true);
    // Nothing to ask the server for either: the flag already says what the click wanted.
    expect(readCalls()).toEqual([]);
    expect(getMailSnapshot().pendingSeen).toEqual({});
  });
});

describe('a mailbox that is already at zero unread', () => {
  it('stays at zero when the flip fails, in all three numbers (C62)', async () => {
    // The row is unread and the counts say 0, which is an ordinary disagreement: the provider's
    // number is from its last refresh. The forward step clamps at 0, so un-deltaing the rollback
    // invented an unread that never existed and the badge lit up over a mailbox nobody had mail in.
    const row = envelope('INBOX:1:2');
    seed([row], { mailbox: 0, account: 0 });
    readAnswer = async () => json({ error: 'unsupported', message: 'This provider cannot mark mail read.' }, 409);
    published = [];

    await setMailMessageRead(row, true);

    expect(mailboxUnread()).toBe(0);
    expect(accountUnread()).toBe(0);
    expect(published.at(-1)).toBeNull();
    expect(published).not.toContain(1);
    // The row is back to unread, it says why, and it is marked so a rolled-back row is not read as
    // a job done.
    expect(isRead('INBOX:1:2')).toBe(false);
    const pair = pairKey(ACCOUNT, 'INBOX:1:2');
    // TWO SENTENCES in both places, the folder-fetch rule: Walnut's sentence ends, then the provider's
    // own text follows as its own. The ROW's hover text says what failed rather than quoting a
    // subjectless fragment ("the provider refused" on its own answered nothing).
    expect(getMailSnapshot().flagFailed[pair])
      .toBe('Walnut could not mark this message read. This provider cannot mark mail read.');
    // `sticky`, because a refusal WAITS to be read: it used to retire itself 12 seconds in, while the
    // person was still working down the list (R2-14).
    expect(getMailSnapshot().rowNote).toEqual({
      pair,
      sticky: true,
      text: 'Walnut could not mark "Subject INBOX:1:2" from Harbour Notices read.'
        + ' This provider cannot mark mail read.',
    });
    expect(getMailSnapshot().pendingSeen).toEqual({});
  });
});

describe('two flips of one row in the same tick', () => {
  it('ends at the last intent, with the first answer arriving late (C65)', async () => {
    const row = envelope('INBOX:1:3');
    seed([row, envelope('INBOX:1:4')], { mailbox: 3, account: 3 });
    let release = () => undefined as void;
    const held = new Promise<void>((resolve) => { release = () => resolve() });
    const answers: boolean[] = [];
    readAnswer = async (messageId, read) => {
      answers.push(read);
      // Only the FIRST answer is delayed, which is the arrival order that used to decide the outcome.
      if (answers.length === 1) await held;
      return json({ ok: true, message: envelope(messageId, { flags: read ? [SEEN] : [] }) });
    };
    published = [];

    const first = setMailMessageRead(row, true);
    const second = setMailMessageRead(row, false);
    release();
    await Promise.all([first, second]);

    // The row is what the human asked for LAST, not what answered last.
    expect(isRead('INBOX:1:3')).toBe(false);
    expect(answers).toEqual([true, false]);
    // Serialised, so the second request went out after the first had answered.
    expect(readCalls().map((call) => call.body)).toEqual([{ read: true }, { read: false }]);
    // One step down and one step back: the counts are where they started, and neither number ever
    // moved twice in one direction.
    expect(mailboxUnread()).toBe(3);
    expect(accountUnread()).toBe(3);
    expect(published).toEqual([2, 3]);
    // The overlay holds the LAST intent, not nothing: a 200 moved the flag, and the counts and the
    // `unread=1` page still come from the provider's last refresh. It is retired by a page read that
    // agrees (`confirmedPendingSeen`), and this round trip is agreed with by the very next one.
    expect(getMailSnapshot().pendingSeen).toEqual({ [pairKey(ACCOUNT, 'INBOX:1:3')]: false });
  });

  it('moves the badge by exactly one when only the second intent has work to do (C65)', async () => {
    // The same pair of clicks on a row that is ALREADY read: the first is a no-op (nothing to ask
    // for), the second is the only real flip, and the badge nets exactly one unread more.
    const row = envelope('INBOX:1:5', { flags: [SEEN] });
    seed([row], { mailbox: 1, account: 1 });
    published = [];

    await setMailMessageRead(row, true);
    await setMailMessageRead(row, false);

    expect(isRead('INBOX:1:5')).toBe(false);
    expect(readCalls().map((call) => call.body)).toEqual([{ read: false }]);
    expect(mailboxUnread()).toBe(2);
    expect(accountUnread()).toBe(2);
    expect(published).toEqual([2]);
  });
});

describe('a refused flip under the unread filter', () => {
  /** Three unread rows in the server's own order, newest first. */
  function page(): MailMessageDto[] {
    return [
      envelope('INBOX:1:30', { sentAt: Date.parse('2026-09-17T12:00:00Z') }),
      envelope('INBOX:1:20', { sentAt: Date.parse('2026-09-17T11:00:00Z') }),
      envelope('INBOX:1:10', { sentAt: Date.parse('2026-09-17T10:00:00Z') }),
    ];
  }

  function ids(): string[] {
    return getMailSnapshot().messages.map((one) => one.messageId);
  }

  beforeEach(() => {
    writeUnreadOnly(ACCOUNT, MAILBOX, true);
    expect(readUnreadOnly(ACCOUNT, MAILBOX), 'the localStorage stub has to hold the preference').toBe(true);
  });

  it('puts the row back unread at its own index (C60)', async () => {
    const rows = page();
    seed(rows, { mailbox: 3, account: 3 });
    readAnswer = async () => json({ error: 'unsupported', message: 'This provider cannot mark mail read.' }, 409);

    await setMailMessageRead(rows[1]!, true);

    // Not moved to the end, not dropped: the row a person is working down a list must be findable
    // where they left it.
    expect(ids()).toEqual(['INBOX:1:30', 'INBOX:1:20', 'INBOX:1:10']);
    expect(isRead('INBOX:1:20')).toBe(false);
    expect(mailboxUnread()).toBe(3);
    expect(getMailSnapshot().flagFailed[pairKey(ACCOUNT, 'INBOX:1:20')]).toBeTruthy();
  });

  it('splices the row back first when the page had already dropped it (C60)', async () => {
    const rows = page();
    seed(rows, { mailbox: 3, account: 3 });
    let release = () => undefined as void;
    const held = new Promise<void>((resolve) => { release = () => resolve() });
    readAnswer = async () => {
      await held;
      return json({ error: 'unsupported', message: 'This provider cannot mark mail read.' }, 409);
    };
    // The server's next unread answer no longer holds the flipped row, which is what an `unread=1`
    // page is: the flip took it out of the set the query asks for. The snippet marks these rows as
    // the SERVER's, so a case where the reload silently did nothing cannot pass.
    unreadPage = [rows[0]!, rows[2]!].map((one) => ({ ...one, snippet: 'reloaded' }));

    const flip = setMailMessageRead(rows[1]!, true);
    // A sync event reloads the page while the flip is still out there.
    selectMailbox(ACCOUNT, MAILBOX);
    await loadMailMessages(true);
    // Spliced back at its own place by `keepOpenRow`, read, because this console's guess still stands.
    expect(ids()).toEqual(['INBOX:1:30', 'INBOX:1:20', 'INBOX:1:10']);
    expect(isRead('INBOX:1:20')).toBe(true);
    // The reload really landed: the two rows around it are the server's copies.
    expect(getMailSnapshot().messages.map((one) => one.snippet))
      .toEqual(['reloaded', 'a sentence', 'reloaded']);

    release();
    await flip;

    // And the refusal finds it there: unread again, at the same index, saying why.
    expect(ids()).toEqual(['INBOX:1:30', 'INBOX:1:20', 'INBOX:1:10']);
    expect(isRead('INBOX:1:20')).toBe(false);
    expect(mailboxUnread()).toBe(3);
    expect(getMailSnapshot().pendingSeen).toEqual({});
    expect(getMailSnapshot().rowNote?.pair).toBe(pairKey(ACCOUNT, 'INBOX:1:20'));
  });
});

describe('the one place that writes a read flag (C21)', () => {
  /** Every source file of the mail console, by path. */
  function mailSources(): string[] {
    return readdirSync(MAIL_DIR, { recursive: true, encoding: 'utf8' })
      .filter((one) => one.endsWith('.ts') || one.endsWith('.tsx'))
      .map((one) => `${MAIL_DIR}/${one}`);
  }

  it('is the only caller of the read route', () => {
    const callers = mailSources().filter((path) => readFileSync(path, 'utf8').includes('markMailMessageRead'));
    // A component calling the route directly gets the row right and the two counts wrong, which is
    // how a badge and a list start disagreeing with no failing test anywhere.
    expect(callers).toEqual([`${MAIL_DIR}/mail-read-flag.ts`]);
  });

  it('is the only writer of the flag itself', () => {
    const writers = mailSources().filter((path) => {
      const source = readFileSync(path, 'utf8');
      // An object literal carrying `flags`, or a mutation of one. A type annotation
      // (`isUnread(flags: string[])`) is not a write, which is why the property has to follow a
      // brace or a comma.
      return /[{,]\s*flags:|\.flags\s*=[^=]|\.flags\.(push|splice|pop|shift)/.test(source);
    });
    expect(writers).toEqual([`${MAIL_DIR}/mail-read-flag.ts`]);
  });
});

/**
 * The overlay a flip leaves behind, and the two moments it is allowed to go away (C19).
 *
 * A 200 from the read route moves the FLAG. It does not move the mailbox's unread count (that is the
 * provider's number, from its last refresh) and it does not change what an `unread=1` page answers
 * (that is the plugin's cache). Retiring the overlay on the answer is why the row used to evaporate
 * one `sync-completed` after somebody marked it read, which is the one thing the filter promised not
 * to do.
 */
describe('the overlay a successful flip leaves behind (C19)', () => {
  const page = () => [
    envelope('INBOX:1:30', { sentAt: Date.parse('2026-09-17T09:30:00Z') }),
    envelope('INBOX:1:20', { sentAt: Date.parse('2026-09-17T09:20:00Z') }),
    envelope('INBOX:1:10', { sentAt: Date.parse('2026-09-17T09:10:00Z') }),
  ];

  it('keeps the row on an unread page across two reloads, then lets a selection change retire it', async () => {
    const rows = page();
    seed(rows, { mailbox: 3, account: 3 });
    writeUnreadOnly(ACCOUNT, MAILBOX, true);
    expect(readUnreadOnly(ACCOUNT, MAILBOX)).toBe(true);
    // The server's unread answer no longer holds the flipped row: the flip took it out of the set the
    // query asks for. The snippet is the SERVER's, so a reload that silently did nothing cannot pass.
    unreadPage = [rows[0]!, rows[2]!].map((one) => ({ ...one, snippet: 'reloaded' }));
    // The answer carries the row's own `sentAt`: the splice is by the server's sort order, and a
    // fixture that answered with a different timestamp would grade the sort, not the overlay.
    readAnswer = async (messageId, read) => json({
      ok: true,
      message: { ...rows.find((one) => one.messageId === messageId)!, flags: read ? [SEEN] : [] },
    });

    await setMailMessageRead(rows[1]!, true);
    const pair = pairKey(ACCOUNT, 'INBOX:1:20');
    expect(getMailSnapshot().pendingSeen).toEqual({ [pair]: true });

    // Two reloads, because the bug survived the first one: `sync-completed` fires about every two
    // minutes and the row has to be there after each of them.
    await loadMailMessages(true);
    expect(getMailSnapshot().messages.map((one) => one.snippet))
      .toEqual(['reloaded', 'a sentence', 'reloaded']);
    await loadMailMessages(true);
    expect(getMailSnapshot().messages.map((one) => one.messageId))
      .toEqual(['INBOX:1:30', 'INBOX:1:20', 'INBOX:1:10']);
    expect(isRead('INBOX:1:20')).toBe(true);
    expect(getMailSnapshot().pendingSeen).toEqual({ [pair]: true });

    // Another folder: the list it was protecting is gone, so the subtraction stops with it. Kept, it
    // would take one off every later landing and the badge would drift low by every row ever flipped.
    unreadPage = [];
    selectMailbox(ACCOUNT, 'Archive');
    expect(getMailSnapshot().pendingSeen).toEqual({});
  });

  it('is retired by turning the filter off as well', async () => {
    const rows = page();
    seed(rows, { mailbox: 3, account: 3 });
    writeUnreadOnly(ACCOUNT, MAILBOX, true);
    unreadPage = [rows[0]!, rows[2]!];

    await setMailMessageRead(rows[1]!, true);
    expect(Object.keys(getMailSnapshot().pendingSeen)).toHaveLength(1);

    unreadPage = rows.map((one) => ({ ...one, snippet: 'unfiltered' }));
    await setMailUnreadOnly(ACCOUNT, MAILBOX, false);

    expect(readUnreadOnly(ACCOUNT, MAILBOX)).toBe(false);
    expect(getMailSnapshot().pendingSeen).toEqual({});
  });

  it('keeps an entry whose request is still out there, because the rollback needs that row', async () => {
    const rows = page();
    seed(rows, { mailbox: 3, account: 3 });
    let release = () => undefined as void;
    const held = new Promise<void>((resolve) => { release = () => resolve() });
    readAnswer = async () => {
      await held;
      return json({ error: 'unsupported', message: 'This provider cannot mark mail read.' }, 409);
    };

    const flip = setMailMessageRead(rows[1]!, true);
    const pair = pairKey(ACCOUNT, 'INBOX:1:20');
    // The overlay is written inside the run body, after the capability answer: waited for, not
    // assumed, or this case would grade an empty map on both sides of the selection change.
    await vi.waitFor(() => expect(getMailSnapshot().pendingSeen).toEqual({ [pair]: true }));

    // A selection change retires SETTLED flips only: this one has not answered, and its rollback has
    // still to put the row and both counts back.
    selectMailbox(ACCOUNT, 'Archive');
    expect(getMailSnapshot().pendingSeen).toEqual({ [pair]: true });

    release();
    await flip;

    expect(mailboxUnread()).toBe(3);
    expect(accountUnread()).toBe(3);
    expect(getMailSnapshot().pendingSeen).toEqual({});
  });
});
