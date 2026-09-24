/**
 * The console's half of "the list is ready when you open it, and says so while it is not" (2026-09-24).
 *
 * The server now asks the provider what is unread on every tick and on every first page, and a page that
 * outlived its short wait names the checks still running (`checking`). What is graded here is what the
 * console does with that, through the real `mail-actions` with `fetch` stubbed:
 *
 * - `Checking…` shows while a named check runs and goes when its `unread-reconciled` arrives, including
 *   the order where the event beats the page, and a lost event does not leave it up for ever.
 * - Only a check that CLEARED rows costs a request; a quiet end only takes the mark down.
 * - `mailbox-counts` reads that account's folder list again, and nothing else.
 * - A folder opened by hand whose last poll is old is polled on its own, once, and quietly.
 * - Refresh polls the folders on screen first, then reads the page with `fresh=1`, then refreshes the rest.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  loadMailMessages,
  onMailEvent,
  requestMailRefresh,
  selectMailbox,
  selectSmartMailbox,
  STALE_FOLDER_MS,
} from '../../web/src/apps/mail/mail-actions';
import {
  SMART_INBOX,
  __resetMailStore,
  getMailSnapshot,
  pairKey,
  patch,
} from '../../web/src/apps/mail/mail-store';
import { syncLineFor } from '../../web/src/apps/mail/mail-sync-line';
import { UNREAD_CHECK_SAFETY_MS } from '../../web/src/apps/mail/mail-unread-checking';

const A = 'fake:one';
const B = 'fake:two';
const A_INBOX = 'INBOX';
const B_INBOX = 'inbox';
const A_LABEL = 'Lists/Weekly';

interface Call { url: string; method: string; body: unknown }

let calls: Call[] = [];
/** What the next page answers with, and which folders it names as still being checked. */
let page: { messages: unknown[]; checking?: Array<{ accountId: string; mailboxId: string }> } = { messages: [] };
/** Held open until the test lets it go, to put an event in front of the page answer. */
let pageGate: Promise<void> | null = null;
let labelSyncedAt = Date.now();
const order: string[] = [];

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

function accounts() {
  return [A, B].map((accountId) => ({
    accountId, providerId: 'fake', displayName: accountId, address: `${accountId}@example.invalid`,
    state: 'ready', unread: 1, unreadInbox: 1,
  }));
}

function mailboxRows(accountId: string) {
  const fresh = Date.now();
  if (accountId === A) {
    return [
      { accountId, mailboxId: A_INBOX, name: 'Inbox', role: 'inbox', unread: 0, total: 12, lastSyncAt: fresh },
      { accountId, mailboxId: A_LABEL, name: 'Weekly', role: 'other', unread: 2, total: 9, lastSyncAt: labelSyncedAt },
    ];
  }
  return [{ accountId, mailboxId: B_INBOX, name: 'Inbox', role: 'inbox', unread: 7, total: 30, lastSyncAt: fresh }];
}

function envelope(accountId: string, messageId: string, mailboxId: string) {
  return {
    messageId, accountId, mailboxId, rfcMessageId: `<${messageId}@example.invalid>`,
    from: { address: 'sender@example.invalid' }, to: [{ address: 'me@example.invalid' }],
    subject: `Subject ${messageId}`, snippet: 'a sentence', sentAt: Date.parse('2026-09-17T09:00:00Z'),
    flags: [], attachments: [], hasBody: true,
  };
}

function installStorage(): void {
  const kept = new Map<string, string>();
  vi.stubGlobal('window', {
    localStorage: {
      getItem: (key: string) => kept.get(key) ?? null,
      setItem: (key: string, value: string) => { kept.set(key, value) },
      removeItem: (key: string) => { kept.delete(key) },
    },
  });
}

beforeEach(() => {
  calls = [];
  order.length = 0;
  page = { messages: [] };
  pageGate = null;
  labelSyncedAt = Date.now();
  __resetMailStore();
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? 'GET';
    const body = typeof init?.body === 'string' ? JSON.parse(init.body) : null;
    calls.push({ url, method, body });
    if (url.includes('/mail/mailboxes/fetch')) {
      order.push(`fetch:${(body as { mailboxId: string }).mailboxId}`);
      return json({ ok: true, fetched: true, added: 0, updated: 0 });
    }
    if (url.includes('/mail/refresh')) { order.push('refresh'); return json({ ok: true, completed: true }); }
    if (url.includes('/mail/messages')) {
      order.push(new URL(url, 'http://localhost').searchParams.get('fresh') === '1' ? 'page:fresh' : 'page');
      if (pageGate) await pageGate;
      return json(page);
    }
    if (url.includes('/mail/mailboxes')) {
      return json({ mailboxes: mailboxRows(new URL(url, 'http://localhost').searchParams.get('account') ?? '') });
    }
    if (url.includes('/mail/accounts')) return json({ accounts: accounts() });
    if (url.includes('/mail/providers')) return json({ providers: [{ id: 'fake', label: 'Fake', capabilities: { markRead: true }, setupFields: [] }] });
    if (url.includes('/mail/drafts')) return json({ drafts: [] });
    return json({ error: 'not-found', message: url }, 404);
  }));
  installStorage();
  patch({
    loaded: true,
    accounts: accounts() as never,
    mailboxes: { [A]: mailboxRows(A) as never, [B]: mailboxRows(B) as never },
  });
});

afterEach(async () => {
  // Real timers FIRST: `drain` waits on setTimeout, which never fires under the fake clock.
  vi.useRealTimers();
  await drain();
  vi.unstubAllGlobals();
  __resetMailStore();
});

async function drain(): Promise<void> {
  for (let turn = 0; turn < 6; turn += 1) await new Promise((resolve) => { setTimeout(resolve, 0) });
}

const count = (part: string) => calls.filter((call) => call.url.includes(part)).length;

function lineText(): string | undefined {
  const snapshot = getMailSnapshot();
  return syncLineFor({
    selected: snapshot.selected, accounts: snapshot.accounts, mailboxes: snapshot.mailboxes,
    folderFetch: snapshot.folderFetch, unreadChecking: snapshot.unreadChecking, refreshing: snapshot.refreshing,
    now: Date.now(),
  })?.text;
}

describe('Checking… follows the checks a page named', () => {
  it('shows while the check runs, and a quiet end takes it down without a request', async () => {
    page = { messages: [envelope(B, 'b-1', B_INBOX)], checking: [{ accountId: B, mailboxId: B_INBOX }] };
    selectSmartMailbox(SMART_INBOX);
    await loadMailMessages();
    expect(getMailSnapshot().unreadChecking[pairKey(B, B_INBOX)]).toBeDefined();
    expect(lineText()).toBe('Checking…');

    const pages = count('/mail/messages');
    onMailEvent('unread-reconciled', { accountId: B, mailboxId: B_INBOX, cleared: 0 });
    await drain();
    expect(getMailSnapshot().unreadChecking).toEqual({});
    expect(lineText()).not.toBe('Checking…');
    expect(count('/mail/messages'), 'nothing changed, so nothing is read again').toBe(pages);
  });

  it('a check that cleared rows reads the page again', async () => {
    page = { messages: [envelope(B, 'b-1', B_INBOX)], checking: [{ accountId: B, mailboxId: B_INBOX }] };
    selectSmartMailbox(SMART_INBOX);
    await loadMailMessages();
    const pages = count('/mail/messages');
    page = { messages: [] };
    onMailEvent('unread-reconciled', { accountId: B, mailboxId: B_INBOX, cleared: 1 });
    await vi.waitFor(() => expect(count('/mail/messages')).toBe(pages + 1));
    await vi.waitFor(() => expect(getMailSnapshot().messages).toEqual([]));
    expect(getMailSnapshot().unreadChecking).toEqual({});
  });

  it('an end that arrives before its page does not let the page put the mark back', async () => {
    page = { messages: [envelope(B, 'b-1', B_INBOX)], checking: [{ accountId: B, mailboxId: B_INBOX }] };
    let release: () => void = () => undefined;
    pageGate = new Promise<void>((resolve) => { release = resolve; });
    selectSmartMailbox(SMART_INBOX);
    const loading = loadMailMessages();
    await vi.waitFor(() => expect(count('/mail/messages')).toBeGreaterThan(0));
    // The socket is faster than the HTTP answer: the end is heard while the page is still on its way.
    onMailEvent('unread-reconciled', { accountId: B, mailboxId: B_INBOX, cleared: 0 });
    release();
    await loading;
    await drain();
    expect(getMailSnapshot().unreadChecking, 'the page is older news than the end').toEqual({});
  });

  it('retires a mark whose end never arrives', async () => {
    page = { messages: [], checking: [{ accountId: B, mailboxId: B_INBOX }] };
    selectSmartMailbox(SMART_INBOX);
    await loadMailMessages();
    await drain();
    // Faked only once the page has landed: the page read itself runs on real promises and timers.
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    page = { messages: [], checking: [{ accountId: B, mailboxId: B_INBOX }] };
    await loadMailMessages(true);
    expect(getMailSnapshot().unreadChecking[pairKey(B, B_INBOX)]).toBeDefined();
    vi.advanceTimersByTime(UNREAD_CHECK_SAFETY_MS - 1);
    expect(getMailSnapshot().unreadChecking[pairKey(B, B_INBOX)], 'not before its time').toBeDefined();
    vi.advanceTimersByTime(2);
    expect(getMailSnapshot().unreadChecking).toEqual({});
    vi.useRealTimers();
  });

  it('a mark for another list does not say Checking… over this one', async () => {
    page = { messages: [], checking: [{ accountId: B, mailboxId: B_INBOX }] };
    selectMailbox(B, B_INBOX);
    await loadMailMessages();
    page = { messages: [] };
    selectMailbox(A, A_INBOX);
    await loadMailMessages();
    expect(lineText()).not.toBe('Checking…');
  });
});

describe('a count that moved with no row changing', () => {
  it('reads that account\'s folder list again, and only that', async () => {
    selectSmartMailbox(SMART_INBOX);
    await loadMailMessages();
    await drain();
    const before = calls.length;
    onMailEvent('mailbox-counts', { accountId: B });
    await drain();
    const after = calls.slice(before).map((call) => call.url);
    expect(after).toHaveLength(1);
    expect(after[0]).toContain(`/mail/mailboxes?account=${encodeURIComponent(B)}`);
  });
});

describe('opening a folder whose last poll is old', () => {
  it('polls that folder on its own, once, without a sentence', async () => {
    labelSyncedAt = Date.now() - STALE_FOLDER_MS - 60_000;
    patch({ mailboxes: { [A]: mailboxRows(A) as never, [B]: mailboxRows(B) as never } });
    selectMailbox(A, A_LABEL);
    await vi.waitFor(() => expect(count('/mail/mailboxes/fetch')).toBe(1));
    expect(calls.find((call) => call.url.includes('/mail/mailboxes/fetch'))!.body).toEqual({ accountId: A, mailboxId: A_LABEL });
    await drain();
    expect(getMailSnapshot().folderFetch, 'a quiet poll leaves no note behind').toEqual({});

    // Away and back inside two minutes: not polled again.
    selectMailbox(A, A_INBOX);
    selectMailbox(A, A_LABEL);
    await drain();
    expect(count('/mail/mailboxes/fetch')).toBe(1);
  });

  it('leaves a folder polled a moment ago, and the inbox, alone', async () => {
    selectMailbox(A, A_LABEL);
    selectMailbox(A, A_INBOX);
    await drain();
    expect(count('/mail/mailboxes/fetch')).toBe(0);
  });
});

describe('Refresh does the list on screen first', () => {
  it('polls each folder of the merged list, reads the page fresh, then refreshes everything else', async () => {
    selectSmartMailbox(SMART_INBOX);
    await loadMailMessages();
    order.length = 0;
    await requestMailRefresh();
    const firstRefresh = order.indexOf('refresh');
    expect(order.slice(0, 2).sort()).toEqual([`fetch:${A_INBOX}`, `fetch:${B_INBOX}`].sort());
    expect(order.indexOf('page:fresh'), 'the page is read with fresh=1 before the full sweep').toBe(2);
    expect(firstRefresh).toBeGreaterThan(2);
  });

  it('for a real folder, polls just that folder first', async () => {
    selectMailbox(A, A_LABEL);
    await loadMailMessages();
    await drain();
    order.length = 0;
    await requestMailRefresh();
    expect(order[0]).toBe(`fetch:${A_LABEL}`);
    expect(order[1]).toBe('page:fresh');
    expect(order).toContain('refresh');
  });
});
