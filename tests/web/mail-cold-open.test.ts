/**
 * How many pages ONE open of Mail reads.
 *
 * Measured on the fixture at real density, a cold open issued FOUR `/messages` requests for a single
 * merged page: an account page for `dense:harbour/INBOX` that nobody ever saw, then the cross-account
 * scope query three times. The cause is that mailbox lists land ONE ACCOUNT AT A TIME and each landing
 * used to pick a selection: the first list was enough to auto-pick that account's inbox (and fetch it),
 * and the second made the remembered or defaulted smart row visible, which replaced the selection and
 * fetched again, on top of the boot sequence's own forced read.
 *
 * The cross-account query is the expensive one (it trades an index seek for a scan plus a temporary sort)
 * and it runs on the single event loop every route in this server shares, so this is graded in requests,
 * not in milliseconds.
 *
 * Driven through the real `mail-actions` with `fetch` stubbed, and deliberately with an UNSEEDED store:
 * the boot sequence is the subject here, not what the actions do once the rows are in.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  loadMailBadgeSource,
  openMailConsole,
  refreshMailAll,
} from '../../web/src/apps/mail/mail-actions';
import {
  SMART_ACCOUNT,
  SMART_INBOX,
  __resetMailStore,
  getMailSnapshot,
} from '../../web/src/apps/mail/mail-store';

const A = 'fake:one';
const B = 'fake:two';
const A_INBOX = 'INBOX';
const B_INBOX = 'inbox';
const PREF_KEY = 'walnut.mail.sidebar.v1';

interface Call { url: string; method: string }

let calls: Call[] = [];
let accountRows = [A, B];
let stored = new Map<string, string>();

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

function accounts() {
  return accountRows.map((accountId) => ({
    accountId,
    providerId: 'fake',
    displayName: accountId === A ? 'Personal' : 'Work',
    address: `${accountId === A ? 'me' : 'work'}@example.invalid`,
    state: 'ready',
    unread: 1,
    unreadInbox: 1,
  }));
}

function mailboxRows(accountId: string) {
  const stamp = Date.parse('2026-09-17T09:05:00Z');
  const inbox = accountId === A ? A_INBOX : B_INBOX;
  return [
    { accountId, mailboxId: inbox, name: 'Inbox', role: 'inbox', unread: 0, total: 12, lastSyncAt: stamp },
    { accountId, mailboxId: `${accountId}:sent`, name: 'Sent', role: 'sent', unread: 0, total: 4, lastSyncAt: stamp },
  ];
}

function query(url: string): URLSearchParams {
  return new URL(url, 'http://localhost').searchParams;
}

/** The preference blob lives in `localStorage`, which this tier has none of (see mail-folder-fetch). */
function installStorage(): void {
  vi.stubGlobal('window', {
    localStorage: {
      getItem: (key: string) => stored.get(key) ?? null,
      setItem: (key: string, value: string) => { stored.set(key, value) },
      removeItem: (key: string) => { stored.delete(key) },
    },
  });
}

/** Answers every read the boot sequence makes, one account's folder list at a time. */
function installFetch(delayFor?: string): void {
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, method: init?.method ?? 'GET' });
    if (url.includes('/mail/messages')) return json({ messages: [] });
    if (url.includes('/mail/mailboxes')) {
      const accountId = query(url).get('account') ?? '';
      // One account answering LATER is the shape that broke this: the first list to land is enough to
      // auto-pick, and the second changes the answer.
      if (delayFor && accountId === delayFor) await new Promise((resolve) => { setTimeout(resolve, 5) });
      return json({ mailboxes: mailboxRows(accountId) });
    }
    if (url.includes('/mail/accounts')) return json({ accounts: accounts() });
    if (url.includes('/mail/providers')) {
      return json({ providers: [{ id: 'fake', label: 'Fake', capabilities: { markRead: true }, setupFields: [] }] });
    }
    if (url.includes('/mail/drafts')) return json({ drafts: [] });
    return json({ error: 'not-found', message: url }, 404);
  }));
}

function messageCalls(): Call[] {
  return calls.filter((call) => call.url.includes('/mail/messages'));
}

/** Let every fire-and-forget read the boot sequence started actually finish. */
async function drain(): Promise<void> {
  for (let turn = 0; turn < 8; turn += 1) await new Promise((resolve) => { setTimeout(resolve, 1) });
}

beforeEach(() => {
  calls = [];
  accountRows = [A, B];
  stored = new Map();
  __resetMailStore();
  // FETCH FIRST, then the window stub: `vi.stubGlobal` assigns onto `globalThis.window` when one exists,
  // so stubbing `window` first would send the fetch stub onto that fake object and leave the real one live.
  installFetch(B);
  installStorage();
});

afterEach(async () => {
  await drain();
  vi.unstubAllGlobals();
  __resetMailStore();
});

describe('one open of Mail reads one page (F7)', () => {
  it('resolves the row BEFORE the first page, so no per-account page is thrown away', async () => {
    await openMailConsole();
    await drain();
    const pages = messageCalls();
    expect(pages).toHaveLength(1);
    const params = query(pages[0]!.url);
    // The default with two accounts holding an inbox is the merged list, and it is asked for ONCE.
    expect(params.get('scope')).toBe('role:inbox');
    expect(params.get('account')).toBeNull();
    expect(params.get('mailbox')).toBeNull();
    expect(getMailSnapshot().selected).toEqual({ accountId: SMART_ACCOUNT, mailboxId: SMART_INBOX });
  });

  it('reads each account folder list once, and never fetches a folder to open the console', async () => {
    await openMailConsole();
    await drain();
    const lists = calls.filter((call) => call.url.includes('/mail/mailboxes?'));
    expect(lists.map((call) => query(call.url).get('account')).sort()).toEqual([A, B]);
    expect(calls.filter((call) => call.url.includes('/mailboxes/fetch'))).toHaveLength(0);
  });

  it('opens a remembered real folder with one page, and not the merged one', async () => {
    stored.set(PREF_KEY, JSON.stringify({ selected: { accountId: B, mailboxId: B_INBOX } }));
    await openMailConsole();
    await drain();
    const pages = messageCalls();
    expect(pages).toHaveLength(1);
    const params = query(pages[0]!.url);
    expect(params.get('account')).toBe(B);
    expect(params.get('mailbox')).toBe(B_INBOX);
    expect(params.get('scope')).toBeNull();
  });

  it('opens a single account install on its own inbox, with one page', async () => {
    accountRows = [A];
    await openMailConsole();
    await drain();
    expect(messageCalls()).toHaveLength(1);
    expect(query(messageCalls()[0]!.url).get('mailbox')).toBe(A_INBOX);
    expect(getMailSnapshot().selected).toEqual({ accountId: A, mailboxId: A_INBOX });
  });

  it('refreshes with one page: the row is unchanged, so exactly one forced read goes out', async () => {
    await openMailConsole();
    await drain();
    calls = [];
    await refreshMailAll();
    await drain();
    expect(messageCalls()).toHaveLength(1);
    expect(query(messageCalls()[0]!.url).get('scope')).toBe('role:inbox');
  });

  it('leaves the remembered row selected across a refresh, still on one page', async () => {
    stored.set(PREF_KEY, JSON.stringify({ selected: { accountId: A, mailboxId: A_INBOX } }));
    await openMailConsole();
    await drain();
    calls = [];
    await refreshMailAll();
    await drain();
    expect(messageCalls()).toHaveLength(1);
    expect(getMailSnapshot().selected).toEqual({ accountId: A, mailboxId: A_INBOX });
  });
});

describe('a tab that never opened Mail reads no page (F7)', () => {
  it('preloads the badge source without selecting or fetching a page', async () => {
    await loadMailBadgeSource();
    await drain();
    // The badge counts inbox unread, which lives on the mailbox rows: accounts and folders, no page. It
    // used to pick a row as each folder list landed, and a pick reads that row's page for a pane nobody is
    // looking at.
    expect(messageCalls()).toHaveLength(0);
    expect(getMailSnapshot().selected).toBeNull();
    expect(calls.filter((call) => call.url.includes('/mail/mailboxes?'))).toHaveLength(2);
  });

  it('opens the console on one page afterwards, with the row the preload never picked', async () => {
    await loadMailBadgeSource();
    await drain();
    calls = [];
    await openMailConsole();
    await drain();
    expect(messageCalls()).toHaveLength(1);
    expect(query(messageCalls()[0]!.url).get('scope')).toBe('role:inbox');
  });

  it('joins a boot that is still running instead of refreshing on top of it', async () => {
    // Two mounts, which is what React does in development: the accounts read marks the store loaded
    // before the boot has its page, so the second call used to take the refresh path and read everything
    // again 38ms later.
    const first = openMailConsole();
    const second = openMailConsole();
    await Promise.all([first, second]);
    await drain();
    expect(messageCalls()).toHaveLength(1);
    expect(calls.filter((call) => call.url.includes('/mail/drafts')), 'and one drafts read').toHaveLength(1);
  });
});
