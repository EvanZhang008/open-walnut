/**
 * What a row menu and a folder menu ASK FOR, and the three things they must not do.
 *
 * - A RESERVED ROW IS NOT A FOLDER. The virtual Drafts row and the three smart rows name lists, not
 *   provider mailboxes, so "Fetch this folder now" has to refuse them on its first line rather than
 *   send an id the plugin would have to answer 404 for.
 * - A REPLY STARTED FROM A ROW HAS A QUOTE OR NO DRAFT. The quote builder falls back to the
 *   attribution line alone when it is handed no text, and a draft is written to the server the moment
 *   the composer opens: the wrong thing would be stored before anybody typed.
 * - A SERVER LANDING CARRYING OLD COUNTS MUST NOT BOUNCE THE BADGE. The provider's unread figure only
 *   moves on its next refresh, so a `sync-completed` one second after three rows were flipped used to
 *   put the number those three rows were still counted in back on screen.
 *
 * Plus the shared menu's own Tab rule, which is a decision rather than a DOM: focus leaving the menu
 * has to end it, or an `inset: 0` backdrop stays over the page swallowing the next click.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  fetchMailboxNow,
  loadMessageBodyForQuote,
  onMailEvent,
} from '../../web/src/apps/mail/mail-actions';
import { setMailMessageRead } from '../../web/src/apps/mail/mail-read-flag';
import { quoteMarkdown } from '../../web/src/apps/mail/compose/reply-draft';
import { closeContextMenuOnBlur, contextMenuStep } from '../../web/src/components/common/ContextMenu';
import {
  DRAFTS_MAILBOX,
  SEEN,
  SMART_ACCOUNT,
  SMART_DRAFTS,
  SMART_INBOX,
  SMART_SENT,
  __resetMailStore,
  folderFetchFor,
  getMailSnapshot,
  pairKey,
  patch,
  selectionKey,
  setMailBadgeHandle,
} from '../../web/src/apps/mail/mail-store';
import type { MailMessageDto } from '../../web/src/api/mail';

const ACCOUNT = 'fake:one';
const MAILBOX = 'INBOX';

interface Call { url: string; method: string; body: unknown }

let calls: Call[] = [];
let published: (number | null)[] = [];
/** What `GET /messages/:a/:m` answers with. A case makes it fail to grade the no-draft rule. */
let bodyAnswer: () => Promise<Response>;
/** What `POST …/read` answers, held by a case that needs the flips still in flight. */
let readAnswer: () => Promise<Response>;
/** The STALE numbers the server is still reporting, which is what a mid-flight landing carries. */
let staleUnread = 5;

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

function envelope(messageId: string, over: Partial<MailMessageDto> = {}): MailMessageDto {
  return {
    messageId,
    accountId: ACCOUNT,
    mailboxId: MAILBOX,
    rfcMessageId: `<${messageId}@example.invalid>`,
    from: { name: 'Ferry Notices', address: 'notices@example.invalid' },
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

function mailboxRow(unread: number) {
  return {
    accountId: ACCOUNT,
    mailboxId: MAILBOX,
    name: 'Inbox',
    role: 'inbox',
    unread,
    total: 40,
    lastSyncAt: Date.parse('2026-09-17T09:05:00Z'),
  };
}

function seed(rows: MailMessageDto[], unread: number): void {
  patch({
    loaded: true,
    providersKnown: true,
    providers: [{ id: 'fake', label: 'Fixture', capabilities: { markRead: true, send: true } }] as never,
    accounts: [{ accountId: ACCOUNT, displayName: 'one', unread, unreadInbox: unread }] as never,
    mailboxes: { [ACCOUNT]: [mailboxRow(unread)] as never },
    selected: { accountId: ACCOUNT, mailboxId: MAILBOX },
    messages: rows,
  });
}

function fetchCalls(): Call[] {
  return calls.filter((call) => call.url.includes('/mailboxes/fetch'));
}

beforeEach(() => {
  calls = [];
  published = [];
  staleUnread = 5;
  bodyAnswer = async () => json({
    message: envelope('INBOX:1:1'),
    body: { format: 'text', text: 'The north pontoon is closed.\n\nSecond line.' },
  });
  readAnswer = async () => json({ ok: true, message: envelope('INBOX:1:1', { flags: [SEEN] }) });
  __resetMailStore();
  vi.stubGlobal('window', { localStorage: { getItem: () => null, setItem: () => {}, removeItem: () => {} } });
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? 'GET';
    let body: unknown = null;
    if (typeof init?.body === 'string') body = JSON.parse(init.body);
    calls.push({ url, method, body });
    if (url.includes('/read')) return readAnswer();
    if (url.includes('/mailboxes/fetch')) return json({ ok: true, fetched: true, added: 1 });
    // The provider's own numbers, which only move on its next refresh: that staleness is the whole
    // point of the landing case below. The names mark these rows as the SERVER's, so a case where the
    // landing silently never happened cannot pass by leaving the seeded numbers in place.
    if (url.includes('/mail/mailboxes')) {
      return json({ mailboxes: [{ ...mailboxRow(staleUnread), name: 'Inbox as the server has it' }] });
    }
    if (url.includes('/mail/accounts')) {
      return json({
        accounts: [{
          accountId: ACCOUNT,
          displayName: 'one as the server has it',
          unread: staleUnread,
          unreadInbox: staleUnread,
        }],
      });
    }
    if (url.includes('/mail/drafts')) return json({ drafts: [] });
    if (url.includes('/mail/messages/')) return bodyAnswer();
    if (url.includes('/mail/messages')) return json({ messages: getMailSnapshot().messages });
    if (url.includes('/mail/providers')) {
      return json({ providers: [{ id: 'fake', label: 'Fixture', capabilities: { markRead: true, send: true } }] });
    }
    return json({ error: 'not-found', message: url }, 404);
  }));
  setMailBadgeHandle({ setBadge: (value) => { published.push(value) } });
  published = [];
});

afterEach(() => {
  vi.unstubAllGlobals();
  __resetMailStore();
});

describe('fetch this folder now, aimed at a row', () => {
  it('refuses every reserved id without a request (C59)', async () => {
    seed([], 0);

    await fetchMailboxNow(ACCOUNT, DRAFTS_MAILBOX);
    await fetchMailboxNow(ACCOUNT, SMART_INBOX);
    await fetchMailboxNow(ACCOUNT, SMART_SENT);
    await fetchMailboxNow(ACCOUNT, SMART_DRAFTS);
    await fetchMailboxNow(SMART_ACCOUNT, SMART_INBOX);
    await fetchMailboxNow('', MAILBOX);
    await fetchMailboxNow(ACCOUNT, '');

    // The route takes a real (accountId, mailboxId): a reserved id names a LIST, and sending one
    // would be a request the plugin can only refuse.
    expect(fetchCalls()).toEqual([]);
    // Nothing said about them either: a folder that was never asked for has no outcome.
    expect(getMailSnapshot().folderFetch).toEqual({});
  });

  it('asks for a real folder that is not the one on screen (C59)', async () => {
    seed([], 0);
    const other = 'Archive';

    await fetchMailboxNow(ACCOUNT, other);

    expect(fetchCalls()).toHaveLength(1);
    expect(fetchCalls()[0]!.body).toEqual({ accountId: ACCOUNT, mailboxId: other });
    // The selection is untouched: "fetch this one" is not "take me there".
    expect(getMailSnapshot().selected).toEqual({ accountId: ACCOUNT, mailboxId: MAILBOX });
    // A fetch that worked leaves nothing to say about that folder.
    expect(folderFetchFor(getMailSnapshot(), selectionKey({ accountId: ACCOUNT, mailboxId: other }))).toBeNull();
  });
});

describe('a reply started from a row', () => {
  it('quotes real body text, never the attribution on its own (C53)', async () => {
    const row = envelope('INBOX:1:1');
    seed([row], 1);

    const text = await loadMessageBodyForQuote(ACCOUNT, 'INBOX:1:1');
    expect(text).toBe('The north pontoon is closed.\n\nSecond line.');

    const quote = quoteMarkdown({ message: row, ...(text ? { text } : {}) });
    const lines = quote.split('\n');
    expect(lines.some((line) => line.startsWith('> '))).toBe(true);
    // The bare attribution is what the builder answers with when it is handed nothing, and it is what
    // a draft must never be saved holding.
    expect(quote).not.toBe(quoteMarkdown({ message: row }));
    expect(quote).toContain('> The north pontoon is closed.');

    // Reading a body to quote it is not opening the message: no read flag was touched, nothing was
    // opened, the selection stands.
    expect(calls.filter((call) => call.url.includes('/read'))).toEqual([]);
    expect(getMailSnapshot().open).toBeNull();
    expect(getMailSnapshot().selected).toEqual({ accountId: ACCOUNT, mailboxId: MAILBOX });
    // And the in-flight sentence is gone once it landed.
    expect(getMailSnapshot().rowNote).toBeNull();
  });

  it('hands back null and names the row when the body will not load (C53)', async () => {
    const row = envelope('INBOX:1:2', { subject: 'Timetable from the winter' });
    seed([row], 1);
    bodyAnswer = async () => json({ error: 'no_body', message: 'The provider kept no copy of this body.' }, 502);

    const text = await loadMessageBodyForQuote(ACCOUNT, 'INBOX:1:2');

    // Null is the gate: the caller must not open a composer, so no draft is written at all.
    expect(text).toBeNull();
    const note = getMailSnapshot().rowNote;
    expect(note?.pair).toBe(pairKey(ACCOUNT, 'INBOX:1:2'));
    // Walnut's sentence ENDS, then the provider's own sentence follows: a plugin writes that string and
    // nothing here can promise it starts with a capital or ends with a stop (the folder-fetch rule).
    expect(note?.text).toBe(
      'Walnut could not read "Timetable from the winter" from Ferry Notices, so no reply was started.'
      + ' The provider kept no copy of this body.',
    );
  });
});

describe('a server landing that arrives mid-flip', () => {
  it('keeps the flipped counts in all three numbers (C61)', async () => {
    const rows = [envelope('INBOX:1:1'), envelope('INBOX:1:2'), envelope('INBOX:1:3')];
    // No selection: this is the shape a tab that never opened the pane is in, and it keeps the case
    // about the COUNTS rather than about a page read.
    seed(rows, 5);
    patch({ selected: null });
    let release = () => undefined as void;
    const held = new Promise<void>((resolve) => { release = () => resolve() });
    readAnswer = async () => {
      await held;
      return json({ ok: true, message: envelope('INBOX:1:1', { flags: [SEEN] }) });
    };

    const flips = rows.map((row) => setMailMessageRead(row, true));
    await vi.waitFor(() => expect(Object.keys(getMailSnapshot().pendingSeen)).toHaveLength(3));
    expect(getMailSnapshot().mailboxes[ACCOUNT]![0]!.unread).toBe(2);
    expect(getMailSnapshot().accounts[0]!.unread).toBe(2);

    // The sync lands, carrying the provider's older figure: five unread, because its own refresh has
    // not run since.
    published = [];
    onMailEvent('sync-completed', { accountId: ACCOUNT, mailboxId: MAILBOX });
    await vi.waitFor(() => expect(calls.some((call) => call.url.includes('/mail/accounts'))).toBe(true));
    await vi.waitFor(() => expect(calls.some((call) => call.url.includes('/mail/mailboxes'))).toBe(true));

    // Both landings really replaced their rows, so the numbers below are the server's own answer with
    // the flips taken off and not the seeded state left untouched.
    expect(getMailSnapshot().mailboxes[ACCOUNT]![0]!.name).toBe('Inbox as the server has it');
    expect(getMailSnapshot().accounts[0]!.displayName).toBe('one as the server has it');
    // All three stop at the flipped value. Before the subtraction the badge bounced back to 5 while
    // the rows on screen stayed read: two truths on one screen.
    expect(getMailSnapshot().mailboxes[ACCOUNT]![0]!.unread).toBe(2);
    expect(getMailSnapshot().accounts[0]!.unread).toBe(2);
    expect(getMailSnapshot().accounts[0]!.unreadInbox).toBe(2);
    expect(published).not.toContain(5);
    expect(published.at(-1)).toBe(2);

    release();
    await Promise.all(flips);
    expect(getMailSnapshot().mailboxes[ACCOUNT]![0]!.unread).toBe(2);
    expect(getMailSnapshot().accounts[0]!.unread).toBe(2);
  });
});

describe('the shared menu and the Tab key (C78)', () => {
  /** A menu element whose `contains` answers for a fixed set of children. */
  function menu(children: Node[]): { contains(node: Node): boolean } {
    return { contains: (node: Node) => children.includes(node) };
  }

  it('closes when focus lands on something outside it', () => {
    const outside = {} as Node;
    // Tab is not handled by the menu, so focus walks into the page behind. Leaving the menu mounted
    // there is the state this rule forbids: a full-viewport backdrop swallowing the next click while
    // the arrow keys steer a menu nothing is focused in.
    expect(closeContextMenuOnBlur(outside, menu([]))).toBe(true);
  });

  it('stays open while focus moves between its own items', () => {
    const item = {} as Node;
    expect(closeContextMenuOnBlur(item, menu([item]))).toBe(false);
  });

  it('stays open when focus goes nowhere', () => {
    // WebKit does not focus a <button> on mousedown, so `relatedTarget` is null on the press of every
    // item: closing on that would unmount the menu between the press and the click.
    expect(closeContextMenuOnBlur(null, menu([]))).toBe(false);
  });

  it('closes when the menu element has gone', () => {
    expect(closeContextMenuOnBlur({} as Node, null)).toBe(true);
  });

  /**
   * ONE FOCUS MODEL (N1). Tab used to be left to the browser: the items are real buttons, so DOM focus
   * walked them while the arrow-key highlight stood still, and Enter then ran the item the browser had
   * focused rather than the one lit up. On a mail row's menu that is a provider write against another
   * message, which is the one thing this menu exists to prevent. Captured, Tab is a step of the same
   * index the highlight and `aria-activedescendant` are read from, and the two engines stop disagreeing
   * (WebKit's first Tab used to blur the menu and close it).
   */
  it('answers Tab with the same step the arrow keys take', () => {
    expect(contextMenuStep('Tab', false)).toBe(1);
    expect(contextMenuStep('Tab', true)).toBe(-1);
    expect(contextMenuStep('ArrowDown', false)).toBe(1);
    expect(contextMenuStep('ArrowUp', false)).toBe(-1);
    // Shift does not turn a plain arrow around, and nothing else is claimed: Home, End, Enter and every
    // ordinary key are answered elsewhere or left to the page.
    expect(contextMenuStep('ArrowDown', true)).toBe(1);
    for (const key of ['Home', 'End', 'Enter', ' ', 'Escape', 'a', 'ArrowLeft']) {
      expect(contextMenuStep(key, false), key).toBe(0);
    }
  });
});
