/**
 * The console asking for a folder the background sweep has not reached, and asking exactly once.
 *
 * The bug this file exists for: on a Gmail account with 67 folders the poll loop reaches about ten
 * per wide sweep, ten minutes apart, so most folders spend the first hour with a size the mailbox
 * list knows and no messages in the cache. The console read those from two places and drew them
 * together — `SENT MAIL · 1,962 · 2 unread` above "No mail in this folder yet" — with no way for the
 * human to ask for the folder they were looking at.
 *
 * Three properties, each one a way to get this wrong:
 *
 * - ONCE PER FOLDER, automatically. The condition that triggers it ("no rows, never synced") is
 *   still true for the moment between the fetch landing and the mailbox list catching up, so a rule
 *   without a memory asks forever.
 * - NEVER for a folder that HAS been fetched. An empty folder is allowed to be empty, and a poll per
 *   visit to it is a round trip to the mail server for an answer nobody is waiting for.
 * - THE ANSWER BELONGS TO THE FOLDER IT WAS ASKED FOR. A reply that arrives after the human moved on
 *   must not describe the folder now on screen.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  fetchSelectedFolder,
  loadMailMessages,
  selectMailbox,
} from '../../web/src/apps/mail/mail-actions';
import { __resetMailStore, getMailSnapshot, patch, selectionKey } from '../../web/src/apps/mail/mail-store';
import { readUnreadOnly, writeUnreadOnly } from '../../web/src/apps/mail/mail-unread-filter';

const ACCOUNT = 'fake:one';
/** The folder in the state every folder past the tick budget is in: a size, and no stamp. */
const UNFETCHED = 'Sent';
const FETCHED = 'INBOX';

interface Call { url: string; method: string; body: unknown }

let calls: Call[] = [];
/** Messages the server answers with, per mailbox. Empty is the point of this file. */
let pages: Record<string, unknown[]> = {};
/** What POST /mailboxes/fetch answers, and what it does to `pages` when it succeeds. */
let fetchAnswer: { status: number; body: Record<string, unknown> } = {
  status: 200,
  body: { ok: true, fetched: true, added: 1 },
};
let onFetch: (() => void) | null = null;

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

function envelope(messageId: string, mailboxId: string) {
  return {
    messageId,
    accountId: ACCOUNT,
    mailboxId,
    rfcMessageId: `<${messageId}@example.invalid>`,
    from: { address: 'alice@example.invalid' },
    to: [{ address: 'me@example.invalid' }],
    subject: `Subject ${messageId}`,
    snippet: 'a sentence',
    sentAt: Date.parse('2026-09-17T09:00:00Z'),
    flags: ['\\Seen'],
    attachments: [],
    hasBody: true,
  };
}

/** The two folders, one stamped and one never synced, exactly as `/mailboxes` reports them. */
function mailboxRows() {
  return [
    {
      accountId: ACCOUNT,
      mailboxId: FETCHED,
      name: 'Inbox',
      role: 'inbox',
      unread: 0,
      total: 1,
      lastSyncAt: Date.parse('2026-09-17T09:05:00Z'),
    },
    // No `lastSyncAt`: no poll of this container has ever completed. Its `total` is real, which is
    // what made the empty list read as lost mail.
    { accountId: ACCOUNT, mailboxId: UNFETCHED, name: 'Sent Mail', role: 'sent', unread: 2, total: 1962 },
  ];
}

function mailboxOf(url: string): string {
  return new URL(url, 'http://localhost').searchParams.get('mailbox') ?? '';
}

beforeEach(() => {
  calls = [];
  onFetch = null;
  fetchAnswer = { status: 200, body: { ok: true, fetched: true, added: 1 } };
  pages = { [FETCHED]: [envelope('m-1', FETCHED)], [UNFETCHED]: [] };
  __resetMailStore();
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? 'GET';
    let body: unknown = null;
    if (typeof init?.body === 'string') body = JSON.parse(init.body);
    calls.push({ url, method, body });
    if (url.includes('/mail/mailboxes/fetch')) {
      onFetch?.();
      return json(fetchAnswer.body, fetchAnswer.status);
    }
    if (url.includes('/mail/messages')) return json({ messages: pages[mailboxOf(url)] ?? [] });
    if (url.includes('/mail/mailboxes')) return json({ mailboxes: mailboxRows() });
    return json({ error: 'not-found', message: url }, 404);
  }));
  // The mailbox list is what the trigger reads, so it is seeded rather than fetched: this file
  // grades the fetch rule, not the console's boot sequence.
  patch({ loaded: true, mailboxes: { [ACCOUNT]: mailboxRows() } });
});

afterEach(() => {
  vi.unstubAllGlobals();
  __resetMailStore();
});

function fetchCalls(): Call[] {
  return calls.filter((call) => call.url.includes('/mail/mailboxes/fetch'));
}

describe('a folder with a size and no cached mail', () => {
  it('is fetched by itself, and the rows land', async () => {
    // The server fills the folder when asked, the way the plugin's poll does.
    onFetch = () => { pages[UNFETCHED] = [envelope('s-1', UNFETCHED)] };

    selectMailbox(ACCOUNT, UNFETCHED);
    await loadMailMessages();
    // The fetch is fired from inside the page read, so it is one more turn of the loop away.
    await vi.waitFor(() => expect(fetchCalls()).toHaveLength(1));
    await vi.waitFor(() => expect(getMailSnapshot().messages).toHaveLength(1));

    expect(fetchCalls()[0]!.body).toEqual({ accountId: ACCOUNT, mailboxId: UNFETCHED });
    expect(getMailSnapshot().messages[0]!.messageId).toBe('s-1');
    // Nothing left saying "fetching" over a list that has arrived.
    expect(getMailSnapshot().folderFetch).toBeNull();
  });

  it('asks once, however many times the empty page is read', async () => {
    // The folder really is empty, so the condition that triggered the fetch is still true after it.
    // Without the record of having asked, every reload would be another round trip to the server.
    selectMailbox(ACCOUNT, UNFETCHED);
    await loadMailMessages();
    await vi.waitFor(() => expect(fetchCalls()).toHaveLength(1));
    await loadMailMessages(true);
    await loadMailMessages(true);

    expect(fetchCalls()).toHaveLength(1);
  });

  it('is not asked for at all when the folder has been fetched before', async () => {
    pages[FETCHED] = [];

    selectMailbox(ACCOUNT, FETCHED);
    await loadMailMessages();

    // An empty folder that HAS been polled is simply empty. Asking again is a round trip for an
    // answer nobody is waiting for, once per visit.
    expect(fetchCalls()).toEqual([]);
    expect(getMailSnapshot().folderFetch).toBeNull();
  });

  it('is not asked for by the unread filter finding nothing', async () => {
    // "Nothing unread here" is a question about flags, and the server answers it with the unread set
    // of the whole mailbox. Reading that empty answer as "this folder was never fetched" would fire a
    // poll on every mailbox somebody has read all of.
    //
    // The preference lives in `localStorage`, which this tier has none of, so the test brings one:
    // without it `readUnreadOnly` swallows the ReferenceError, returns false, and the case passes
    // while never once taking the branch it is about.
    const kept = new Map<string, string>();
    vi.stubGlobal('window', {
      localStorage: {
        getItem: (key: string) => kept.get(key) ?? null,
        setItem: (key: string, value: string) => { kept.set(key, value) },
        removeItem: (key: string) => { kept.delete(key) },
      },
    });
    writeUnreadOnly(ACCOUNT, UNFETCHED, true);
    expect(readUnreadOnly(ACCOUNT, UNFETCHED), 'the stub has to actually hold the preference').toBe(true);

    selectMailbox(ACCOUNT, UNFETCHED);
    await loadMailMessages();

    expect(fetchCalls()).toEqual([]);
  });
});

describe('the answer to a fetch', () => {
  it('is dropped when the human has already moved to another folder', async () => {
    let release = () => undefined as void;
    const held = new Promise<void>((resolve) => { release = () => resolve() });
    onFetch = () => { void held };

    selectMailbox(ACCOUNT, UNFETCHED);
    const inFlight = fetchSelectedFolder();
    // Move on while it is still out there.
    selectMailbox(ACCOUNT, FETCHED);
    release();
    await inFlight;

    // Nothing about the folder that was left is drawn over the folder that is here now.
    expect(getMailSnapshot().folderFetch).toBeNull();
  });

  it('says what went wrong, in the provider words, and can be asked again', async () => {
    fetchAnswer = {
      status: 200,
      body: { ok: true, fetched: false, reason: 'failed', detail: 'The server answered NO: over quota' },
    };

    selectMailbox(ACCOUNT, UNFETCHED);
    await fetchSelectedFolder();

    expect(getMailSnapshot().folderFetch).toEqual({
      key: selectionKey({ accountId: ACCOUNT, mailboxId: UNFETCHED }),
      state: 'failed',
      detail: 'The server answered NO: over quota',
    });

    // A retry is a human pressing the link, so it goes around the once-per-folder record.
    fetchAnswer = { status: 200, body: { ok: true, fetched: true, added: 2 } };
    await fetchSelectedFolder();
    expect(fetchCalls()).toHaveLength(2);
    expect(getMailSnapshot().folderFetch).toBeNull();
  });

  it('keeps saying "fetching" on a 202, because the rows are still coming', async () => {
    // The plugin answers 202 when a big folder outlives its budget. Reporting that as done would put
    // "no mail in this folder" on screen while the first page is still being fetched.
    fetchAnswer = { status: 202, body: { ok: true, fetched: false, running: true } };

    selectMailbox(ACCOUNT, UNFETCHED);
    await fetchSelectedFolder();

    expect(getMailSnapshot().folderFetch).toEqual({ key: selectionKey({ accountId: ACCOUNT, mailboxId: UNFETCHED }), state: 'running' });
  });

  it('is never asked for the virtual Drafts row, which is no provider folder', async () => {
    selectMailbox(ACCOUNT, '__walnut_drafts__');
    await fetchSelectedFolder();

    expect(fetchCalls()).toEqual([]);
  });
});
