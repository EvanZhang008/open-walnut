/**
 * What the store DOES while a smart row is selected: it stays selected, it reads one merged page, and
 * it never treats the reserved pair as a folder.
 *
 * Every case here is a way the reserved pair used to fall through a comparison written for a real
 * (accountId, mailboxId) and come out silently wrong:
 *
 * - `ensureSelection` judged aliveness by looking the selection up in `state.mailboxes`, where the
 *   reserved account has no key at all. A `sync-completed` arrives every couple of minutes and
 *   reloads a mailbox list, so the merged list a person had chosen was replaced by the first
 *   account's inbox while they were reading it.
 * - the sync handler compared the event's accountId against the selection's, so no real account's
 *   event ever matched: the badges beside the list moved and the list itself froze.
 * - `POST /mailboxes/fetch`, the read-flag route and the task route all take a real pair. The merged
 *   list must reach none of them with a reserved id.
 * - page 2 deduped by messageId alone, which in a two-account list lets one account's ids delete the
 *   other account's rows.
 *
 * Driven through the real `mail-actions` with `fetch` stubbed, so the assertions are about the
 * requests that actually leave and the snapshot that actually lands.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  fetchSelectedFolder,
  loadMailMessages,
  loadOlderMailMessages,
  onMailEvent,
  refreshMailAll,
  runMailSearch,
  selectMailbox,
  selectSmartMailbox,
  setMailUnreadOnly,
} from '../../web/src/apps/mail/mail-actions';
import {
  SMART_ACCOUNT,
  SMART_DRAFTS,
  SMART_INBOX,
  __resetMailStore,
  getMailSnapshot,
  pairKey,
  patch,
} from '../../web/src/apps/mail/mail-store';
import { readUnreadOnly } from '../../web/src/apps/mail/mail-unread-filter';

/** Two accounts whose inbox ids differ for the same role, which is the whole reason for pairs. */
const A = 'fake:one';
const B = 'fake:two';
const A_INBOX = 'INBOX';
const B_INBOX = 'inbox';
const A_LABEL = 'Lists/Weekly';

interface Call { url: string; method: string; body: unknown }

let calls: Call[] = [];
/** Pages the server answers with, keyed by what the request asked for. */
let scopePage: { messages: unknown[]; nextBefore?: string } = { messages: [] };
let scopeOlder: { messages: unknown[] } = { messages: [] };
let accountRows = [A, B];

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
  if (accountId === A) {
    return [
      { accountId, mailboxId: A_INBOX, name: 'Inbox', role: 'inbox', unread: 0, total: 12, lastSyncAt: stamp },
      { accountId, mailboxId: 'Sent', name: 'Sent', role: 'sent', unread: 0, total: 4, lastSyncAt: stamp },
      { accountId, mailboxId: A_LABEL, name: 'Weekly', role: 'other', unread: 2, total: 9, lastSyncAt: stamp },
    ];
  }
  return [
    { accountId, mailboxId: B_INBOX, name: 'Inbox', role: 'inbox', unread: 7, total: 30, lastSyncAt: stamp },
    { accountId, mailboxId: 'sent', name: 'Sent', role: 'sent', unread: 0, total: 3, lastSyncAt: stamp },
  ];
}

function envelope(accountId: string, messageId: string, mailboxId: string, sentAt: string) {
  return {
    messageId,
    accountId,
    mailboxId,
    rfcMessageId: `<${messageId}@example.invalid>`,
    from: { address: 'sender@example.invalid' },
    to: [{ address: 'me@example.invalid' }],
    subject: `Subject ${messageId}`,
    snippet: 'a sentence',
    sentAt: Date.parse(sentAt),
    flags: ['\\Seen'],
    attachments: [],
    hasBody: true,
  };
}

function query(url: string): URLSearchParams {
  return new URL(url, 'http://localhost').searchParams;
}

/**
 * The preference blob lives in `localStorage`, which this tier has none of. Without a real one the
 * guarded reads swallow a ReferenceError and every preference case would pass while never taking the
 * branch it is about (the same trap `mail-folder-fetch.test.ts` documents).
 */
function installStorage(): Map<string, string> {
  const kept = new Map<string, string>();
  vi.stubGlobal('window', {
    localStorage: {
      getItem: (key: string) => kept.get(key) ?? null,
      setItem: (key: string, value: string) => { kept.set(key, value) },
      removeItem: (key: string) => { kept.delete(key) },
    },
  });
  return kept;
}

beforeEach(() => {
  calls = [];
  accountRows = [A, B];
  scopePage = { messages: [] };
  scopeOlder = { messages: [] };
  __resetMailStore();
  // FETCH FIRST, then the window stub. `vi.stubGlobal` assigns onto `globalThis.window` when one
  // exists, so stubbing `window` first sends every later stub onto that fake object: the real `fetch`
  // stayed live, every request failed on a relative URL, and the whole file passed anyway.
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? 'GET';
    let body: unknown = null;
    if (typeof init?.body === 'string') body = JSON.parse(init.body);
    calls.push({ url, method, body });
    if (url.includes('/mail/mailboxes/fetch')) return json({ ok: true, fetched: true, added: 1 });
    if (url.includes('/mail/messages')) {
      const params = query(url);
      if (params.get('scope')) return json(params.get('before') ? scopeOlder : scopePage);
      const mailbox = params.get('mailbox') ?? '';
      const account = params.get('account') ?? '';
      return json({ messages: [envelope(account, `own-${mailbox}`, mailbox, '2026-09-17T08:00:00Z')] });
    }
    if (url.includes('/mail/mailboxes')) return json({ mailboxes: mailboxRows(query(url).get('account') ?? '') });
    if (url.includes('/mail/accounts')) return json({ accounts: accounts() });
    if (url.includes('/mail/providers')) {
      return json({ providers: [{ id: 'fake', label: 'Fake', capabilities: { markRead: true, send: true }, setupFields: [] }] });
    }
    if (url.includes('/mail/search')) {
      return json({
        source: 'cache',
        messages: [
          envelope(A, 'a-hit', A_INBOX, '2026-09-17T09:00:00Z'),
          envelope(B, 'b-hit', B_INBOX, '2026-09-17T08:30:00Z'),
        ],
      });
    }
    if (url.includes('/mail/drafts')) return json({ drafts: [] });
    return json({ error: 'not-found', message: url }, 404);
  }));
  installStorage();
  // Seeded rather than fetched: these cases grade what the actions do with the rows, not the boot
  // sequence that reads them.
  patch({
    loaded: true,
    accounts: accounts() as never,
    mailboxes: { [A]: mailboxRows(A) as never, [B]: mailboxRows(B) as never },
  });
});

afterEach(async () => {
  // A live event answers with fire-and-forget reads (`void loadAccounts(true)`), and one of them can
  // still be in flight when the case ends. Draining before the stub comes down keeps this tier off the
  // real network: an undrained one reaches the real `fetch` with a relative path and logs a failure
  // against whichever case is running.
  await drain();
  vi.unstubAllGlobals();
  __resetMailStore();
});

function messageCalls(): Call[] {
  return calls.filter((call) => call.url.includes('/mail/messages'));
}

function fetchFolderCalls(): Call[] {
  return calls.filter((call) => call.url.includes('/mail/mailboxes/fetch'));
}

function mailboxCalls(): Call[] {
  return calls.filter((call) => call.url.includes('/mail/mailboxes?'));
}

/** Let the fire-and-forget work a live event starts actually finish. */
async function drain(): Promise<void> {
  for (let turn = 0; turn < 5; turn += 1) await new Promise((resolve) => { setTimeout(resolve, 0) });
}

const SMART: { accountId: string; mailboxId: string } = { accountId: SMART_ACCOUNT, mailboxId: SMART_INBOX };

describe('a smart selection survives what a real one survives', () => {
  it('is not thrown away by three sync events for a real account (C42)', async () => {
    scopePage = {
      messages: [
        envelope(B, 'b-1', B_INBOX, '2026-09-17T09:00:00Z'),
        envelope(A, 'a-1', A_INBOX, '2026-09-17T08:00:00Z'),
      ],
    };
    selectSmartMailbox(SMART_INBOX);
    await loadMailMessages();
    expect(getMailSnapshot().selected).toEqual(SMART);
    // Proof the stub answered and the merged page really landed: without this the case would pass on
    // a failed request, since a selection nobody touched is also a selection nothing loaded.
    expect(getMailSnapshot().messages.map((one) => one.messageId)).toEqual(['b-1', 'a-1']);

    // Every one of these reloads a mailbox list, and it is the LANDING of that list that calls
    // `ensureSelection`: waiting for anything cheaper (the rows are already seeded) asserts before the
    // code under test has run, and the case passes with the aliveness rule removed.
    for (const _ of [0, 1, 2]) {
      const before = mailboxCalls().length;
      onMailEvent('sync-completed', { accountId: A, mailboxId: A_INBOX, added: 0 });
      await vi.waitFor(() => expect(mailboxCalls().length).toBeGreaterThan(before));
      await drain();
    }

    expect(getMailSnapshot().selected).toEqual(SMART);
    expect(getMailSnapshot().messages.map((one) => one.messageId)).toEqual(['b-1', 'a-1']);
  });

  it('is still selected after leaving Mail and coming back (C43)', async () => {
    selectSmartMailbox(SMART_INBOX);
    await loadMailMessages();

    // The reopen path: `openMailConsole` on a loaded store is exactly this.
    await refreshMailAll();

    expect(getMailSnapshot().selected).toEqual(SMART);
  });

  it('is dropped for a real inbox when only one account is left, with a page (C44)', async () => {
    selectSmartMailbox(SMART_INBOX);
    await loadMailMessages();

    // Account B is gone: `All Inboxes` would now be a second copy of A's own inbox row, so the row
    // stops existing and the selection has to land somewhere real.
    accountRows = [A];
    patch({ mailboxes: { [A]: mailboxRows(A) as never } });
    await refreshMailAll();

    expect(getMailSnapshot().selected).toEqual({ accountId: A, mailboxId: A_INBOX });
    // Not an empty list under a dead selection: the fallback read its page.
    await vi.waitFor(() => expect(getMailSnapshot().messages).toHaveLength(1));
    expect(getMailSnapshot().messages[0]!.mailboxId).toBe(A_INBOX);
  });
});

describe('a sync event and the merged list', () => {
  it('reloads the page for a pair the list is made of, and counts the arrival (C45)', async () => {
    selectSmartMailbox(SMART_INBOX);
    await loadMailMessages();
    const before = messageCalls().length;
    // The new mail account B just received.
    scopePage = { messages: [envelope(B, 'b-new', B_INBOX, '2026-09-17T10:00:00Z')] };

    onMailEvent('sync-completed', { accountId: B, mailboxId: B_INBOX, added: 1 });

    await vi.waitFor(() => expect(getMailSnapshot().messages).toHaveLength(1));
    expect(getMailSnapshot().messages[0]!.messageId).toBe('b-new');
    expect(messageCalls().length).toBeGreaterThan(before);
    // The badge source and the promotion count arrive together: the sidebar draws one frame with the
    // folder's new unread AND the folder itself, rather than the count a render early.
    expect(getMailSnapshot().arrivals[pairKey(B, B_INBOX)]).toBe(1);
    expect(getMailSnapshot().mailboxes[B]).toBeDefined();
  });

  it('leaves the page alone for a pair that is not in the list (C45)', async () => {
    selectSmartMailbox(SMART_INBOX);
    await loadMailMessages();
    const before = messageCalls().length;

    // An ordinary label of account A: it holds no inbox-role mail, so it is not part of All Inboxes.
    onMailEvent('sync-completed', { accountId: A, mailboxId: A_LABEL, added: 3 });
    await vi.waitFor(() => expect(getMailSnapshot().arrivals[pairKey(A, A_LABEL)]).toBe(3));

    expect(messageCalls().length).toBe(before);
  });

  it('counts an account-only event as its own, since it carries no mailbox', async () => {
    selectSmartMailbox(SMART_INBOX);
    await loadMailMessages();
    const before = messageCalls().length;
    scopePage = { messages: [envelope(A, 'a-new', A_INBOX, '2026-09-17T10:00:00Z')] };

    // `messages-received` carries only an accountId, so the loose reading has to stand: A takes part
    // in this role, therefore this is news for the pane.
    onMailEvent('messages-received', { accountId: A });

    await vi.waitFor(() => expect(messageCalls().length).toBeGreaterThan(before));
    await vi.waitFor(() => expect(getMailSnapshot().messages[0]?.messageId).toBe('a-new'));
  });
});

/**
 * Mail read somewhere else, corrected AFTER the page on screen was answered (2026-09-23).
 *
 * The server's smart list waits only a moment for the provider's unread answer, so the correction
 * usually lands later. `unread-reconciled` is the only thing that can take the stale rows off the open
 * list; without it they stayed until an unrelated refresh.
 */
describe('a late unread correction and the merged list', () => {
  it('re-reads the page for a pair the list is made of, and drops the rows read elsewhere', async () => {
    scopePage = {
      messages: [
        envelope(B, 'b-read-on-phone', B_INBOX, '2026-09-17T10:00:00Z'),
        envelope(B, 'b-still-unread', B_INBOX, '2026-09-17T09:00:00Z'),
      ],
    };
    selectSmartMailbox(SMART_INBOX);
    await loadMailMessages();
    expect(getMailSnapshot().messages).toHaveLength(2);
    const pages = messageCalls().length;
    const folders = mailboxCalls().length;
    // What the server holds once the correction has landed.
    scopePage = { messages: [envelope(B, 'b-still-unread', B_INBOX, '2026-09-17T09:00:00Z')] };

    onMailEvent('unread-reconciled', { accountId: B, mailboxId: B_INBOX, cleared: 1 });

    await vi.waitFor(() => expect(getMailSnapshot().messages.map((one) => one.messageId)).toEqual(['b-still-unread']));
    expect(messageCalls().length).toBe(pages + 1);
    await drain();
    // Not a sync: the folder badges are the provider's own count and did not move, so no folder list
    // is read again for it.
    expect(mailboxCalls().length, 'a correction is not a sync').toBe(folders);
  });

  it('leaves the page alone for a pair that is not in the list', async () => {
    selectSmartMailbox(SMART_INBOX);
    await loadMailMessages();
    const before = messageCalls().length;

    onMailEvent('unread-reconciled', { accountId: A, mailboxId: A_LABEL, cleared: 2 });
    await drain();

    expect(messageCalls().length).toBe(before);
  });

  it('re-reads a real folder on screen when the correction is about that folder', async () => {
    selectMailbox(B, B_INBOX);
    await loadMailMessages();
    const before = messageCalls().length;

    onMailEvent('unread-reconciled', { accountId: B, mailboxId: B_INBOX, cleared: 1 });

    await vi.waitFor(() => expect(messageCalls().length).toBe(before + 1));
  });
});

describe('a merged list is never treated as a folder', () => {
  it('never asks the fetch route for it, however empty the page is (C6, C7)', async () => {
    // The trigger for an on-demand fetch is "nothing cached and never synced", and the reserved pair
    // is in no mailbox list, so a lookup-based rule reads it as never synced on every read.
    scopePage = { messages: [] };
    selectSmartMailbox(SMART_INBOX);
    await loadMailMessages();
    await loadMailMessages(true);
    onMailEvent('sync-completed', { accountId: A, mailboxId: A_INBOX, added: 0 });
    await vi.waitFor(() => expect(getMailSnapshot().listLoading).toBe(false));
    // The human pressing the retry link too: that path goes around the once-per-folder record, so it
    // is the one that would put a reserved pair in the request body.
    await fetchSelectedFolder();
    await fetchSelectedFolder(true);

    expect(fetchFolderCalls()).toEqual([]);
    // And nothing on screen claims a folder is being fetched, because no folder is. The outcomes are
    // keyed by folder now, so "nothing to say" is an empty map.
    expect(getMailSnapshot().folderFetch).toEqual({});
  });

  it('sends neither account nor mailbox, only the scope (C54 page 1)', async () => {
    selectSmartMailbox(SMART_INBOX);
    await loadMailMessages();

    const params = query(messageCalls().at(-1)!.url);
    expect(params.get('scope')).toBe('role:inbox');
    expect(params.get('account')).toBeNull();
    expect(params.get('mailbox')).toBeNull();
  });
});

describe('search from a merged list', () => {
  it('omits the account, so every account answers (C47)', async () => {
    selectSmartMailbox(SMART_INBOX);
    await runMailSearch('invoice');

    const search = calls.find((call) => call.url.includes('/mail/search'))!;
    expect(query(search.url).get('account')).toBeNull();
    expect(getMailSnapshot().search.messages.map((one) => one.accountId)).toEqual([A, B]);
  });

  it('still searches one account when a real folder is selected', async () => {
    selectMailbox(A, A_INBOX);
    await runMailSearch('invoice');

    const search = calls.find((call) => call.url.includes('/mail/search'))!;
    expect(query(search.url).get('account')).toBe(A);
  });
});

describe('only unread, on the reserved pair', () => {
  it('is the smart row own flag and leaves every account row alone (C68)', async () => {
    selectSmartMailbox(SMART_INBOX);
    await loadMailMessages();

    // The PAIR is passed in now: the sidebar's own row menu can filter a folder that is not the one
    // on screen, so this no longer reads the selection.
    await setMailUnreadOnly(SMART_ACCOUNT, SMART_INBOX, true);

    // Remembered under the reserved pair, so a reload reads it back.
    expect(readUnreadOnly(SMART_ACCOUNT, SMART_INBOX)).toBe(true);
    expect(readUnreadOnly(A, A_INBOX)).toBe(false);
    expect(readUnreadOnly(B, B_INBOX)).toBe(false);
    // And it rides the request, together with the scope.
    const params = query(messageCalls().at(-1)!.url);
    expect(params.get('unread')).toBe('1');
    expect(params.get('scope')).toBe('role:inbox');
  });
});

describe('the second page of a merged list', () => {
  it('repeats page 1 with a cursor, and keeps a duplicated id from the other account (C53, C54)', async () => {
    // The same messageId in both accounts. It is one row per account and both belong on screen: a
    // dedupe set holding bare ids deletes the second one with no error anywhere.
    scopePage = {
      messages: [envelope(A, 'shared-1', A_INBOX, '2026-09-17T09:00:00Z')],
      nextBefore: 'cursor-1',
    };
    scopeOlder = { messages: [envelope(B, 'shared-1', B_INBOX, '2026-09-17T08:00:00Z')] };

    selectSmartMailbox(SMART_INBOX);
    await loadMailMessages();
    const first = query(messageCalls().at(-1)!.url);
    await loadOlderMailMessages();
    const second = query(messageCalls().at(-1)!.url);

    // Byte identical apart from the cursor: same scope, same limit, and still no account or mailbox.
    expect(second.get('before')).toBe('cursor-1');
    first.append('before', 'cursor-1');
    expect([...second.entries()].sort()).toEqual([...first.entries()].sort());

    const rows = getMailSnapshot().messages;
    expect(rows.map((one) => pairKey(one.accountId, one.messageId))).toEqual([
      pairKey(A, 'shared-1'),
      pairKey(B, 'shared-1'),
    ]);
  });

  it('still drops a row the same account already handed over', async () => {
    scopePage = {
      messages: [envelope(A, 'shared-1', A_INBOX, '2026-09-17T09:00:00Z')],
      nextBefore: 'cursor-1',
    };
    // An overlapping window, which a cursor at a tie can legitimately produce.
    scopeOlder = {
      messages: [
        envelope(A, 'shared-1', A_INBOX, '2026-09-17T09:00:00Z'),
        envelope(B, 'other-2', B_INBOX, '2026-09-17T07:00:00Z'),
      ],
    };

    selectSmartMailbox(SMART_INBOX);
    await loadMailMessages();
    await loadOlderMailMessages();

    expect(getMailSnapshot().messages.map((one) => pairKey(one.accountId, one.messageId))).toEqual([
      pairKey(A, 'shared-1'),
      pairKey(B, 'other-2'),
    ]);
  });
});

describe('All Drafts', () => {
  it('reads this console drafts AND the providers drafts folders', async () => {
    selectSmartMailbox(SMART_DRAFTS);
    await loadMailMessages();

    // Two halves, the same two the per-account Drafts row shows: one drafts request covers every
    // account, and one scoped page covers every provider drafts folder.
    expect(calls.some((call) => call.url.includes('/mail/drafts'))).toBe(true);
    expect(query(messageCalls().at(-1)!.url).get('scope')).toBe('role:drafts');
  });

  it('carries no unread filter, because a draft is not unread mail', async () => {
    selectSmartMailbox(SMART_DRAFTS);
    await loadMailMessages();

    await setMailUnreadOnly(SMART_ACCOUNT, SMART_DRAFTS, true);

    expect(readUnreadOnly(SMART_ACCOUNT, SMART_DRAFTS)).toBe(false);
    expect(query(messageCalls().at(-1)!.url).get('unread')).toBeNull();
  });
});

/**
 * Which selections spend the sidebar's aim.
 *
 * The pane holds its row shape still while a pointer rests inside it and releases the hold when the
 * person picks a row. It keyed that release on the SELECTION, and the console also selects by itself
 * as the folder lists land (`ensureSelection` -> `applySelection(auto)`), so an automatic pick
 * arriving mid-hover released the hold and let a row move under the pointer. `picks` counts the human
 * ones only, and the pane reads that instead.
 */
describe('a pick that spends the aim is a HUMAN pick (picks)', () => {
  it('counts a folder chosen by hand, once per pick', async () => {
    expect(getMailSnapshot().picks).toBe(0);
    selectMailbox(A, A_LABEL);
    expect(getMailSnapshot().picks).toBe(1);
    selectMailbox(B, B_INBOX);
    expect(getMailSnapshot().picks).toBe(2);
    // The same row twice is two releases: the second click is still somebody telling the pane what
    // they want, and a boolean here would swallow it.
    selectMailbox(A, A_LABEL);
    expect(getMailSnapshot().picks).toBe(3);
    await drain();
  });

  it('counts a smart row the same way', async () => {
    selectSmartMailbox(SMART_INBOX);
    expect(getMailSnapshot().picks).toBe(1);
    await drain();
  });

  it('does NOT count the pick the console makes while reading the folder lists', async () => {
    // The boot shape: accounts known, nothing selected, and the mailbox reads landing. Whatever the
    // console lands on, the counter has to stand still, because a pointer may be resting on a row.
    __resetMailStore();
    patch({ loaded: true, accounts: accounts() as never });
    await refreshMailAll();
    await drain();

    expect(getMailSnapshot().selected, 'the console did pick something').not.toBeNull();
    expect(getMailSnapshot().picks).toBe(0);
  });

  it('a selection the console replaces later still does not count', async () => {
    __resetMailStore();
    patch({ loaded: true, accounts: accounts() as never });
    await refreshMailAll();
    await drain();
    const auto = getMailSnapshot().selected;

    // A sync event reloads a mailbox list, which runs the automatic pick again.
    onMailEvent('plugin:mail:sync-completed', { accountId: B, mailboxId: B_INBOX, added: 2, updated: 0 });
    await drain();

    expect(getMailSnapshot().picks, 'still nothing the person did').toBe(0);
    expect(getMailSnapshot().selected, 'and the console has not lost its own pick').toEqual(auto);
  });
});
