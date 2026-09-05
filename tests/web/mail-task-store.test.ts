/**
 * The console's half of "make a task from this mail", and what the digest event does to the bell.
 *
 * Pure store logic against a stubbed fetch, because every claim here is about state a human sees
 * before or without a server answer:
 *
 * - A double click is ONE request. The server is idempotent too, but a console that fires twice
 *   still costs two of the browser's six connections and shows two spinners.
 * - The button becomes the pill from the ROUTE's answer and from the WS event alike, so the tab that
 *   pressed it and the tab that did not end up showing the same thing.
 * - A 202 says so in words. A spinner that never resolves is the failure this replaces.
 * - A failure is reported next to the button, and the reader stays usable.
 * - `digest-sent` makes NO request. It marks the letter list stale, because this subscription runs
 *   with the bell shut and the letter store would otherwise serve its 15s cache to whoever opens
 *   next, which is exactly the window in which a human reaches for the bell.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { onMailEvent, openMailDeepLink } from '../../web/src/apps/mail/mail-actions';
import {
  applyMessageTask,
  makeTaskFromMessage,
  sendMailDigest,
} from '../../web/src/apps/mail/mail-task-actions';
import { __resetMailStore, getMailSnapshot, patch } from '../../web/src/apps/mail/mail-store';
import {
  ensureLetters,
  loadLetters,
  resetLetterStore,
  subscribeLetters,
} from '../../web/src/components/inbox/letter-store';

const ACCOUNT = 'fake:one';
const MESSAGE = 'INBOX:100:1';
const TASK = 'task-abc123';

interface Call { url: string; method: string; body: string | null }

let calls: Call[] = [];
/** What the task route answers next. `null` means a 202 with no id. */
let taskAnswer: { status: number; body: unknown } = { status: 201, body: { taskId: TASK, created: true } };
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
function openReader(): void {
  patch({
    loaded: true,
    accounts: [{
      accountId: ACCOUNT,
      providerId: 'fake',
      displayName: 'Fixture',
      address: 'alice@example.invalid',
      state: 'active',
      unread: 0,
    }],
    selected: { accountId: ACCOUNT, mailboxId: 'INBOX' },
    messages: [envelope(MESSAGE), envelope('INBOX:100:2')] as never,
    search: {
      query: 'x', active: true, loading: false, source: 'cache',
      messages: [envelope(MESSAGE)] as never, error: null,
    },
    open: {
      accountId: ACCOUNT,
      messageId: MESSAGE,
      message: envelope(MESSAGE) as never,
      body: null,
      bodyError: null,
      loading: false,
      error: null,
      allowRemoteImages: false,
      taskBusy: false,
      taskError: null,
    },
  });
}

beforeEach(() => {
  calls = [];
  taskAnswer = { status: 201, body: { taskId: TASK, created: true } };
  digestAnswer = { status: 200, body: { letterId: 'lt-1', unread: 4, accounts: 2 } };
  __resetMailStore();
  resetLetterStore();
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, method: init?.method ?? 'GET', body: (init?.body as string) ?? null });
    if (url.includes('/task')) return json(taskAnswer.body, taskAnswer.status);
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

function taskCalls(): Call[] {
  return calls.filter((call) => call.url.includes('/task'));
}

describe('making a task from the open message', () => {
  it('stamps the row in every list the console is holding, from one request', async () => {
    openReader();
    await makeTaskFromMessage(ACCOUNT, MESSAGE);

    expect(taskCalls()).toHaveLength(1);
    expect(taskCalls()[0]!.method).toBe('POST');
    // Percent-encoded, because both ids routinely contain a colon.
    expect(taskCalls()[0]!.url).toContain(`${encodeURIComponent(ACCOUNT)}/${encodeURIComponent(MESSAGE)}/task`);

    const state = getMailSnapshot();
    expect(state.open?.message?.taskId).toBe(TASK);
    expect(state.open?.taskBusy).toBe(false);
    expect(state.open?.taskError).toBeNull();
    // The list and the search answer carry the same backlink, so drilling back does not lose the pill.
    expect(state.messages.find((one) => one.messageId === MESSAGE)?.taskId).toBe(TASK);
    expect(state.search.messages[0]?.taskId).toBe(TASK);
    // And no other row was touched.
    expect(state.messages.find((one) => one.messageId === 'INBOX:100:2')?.taskId).toBeUndefined();
  });

  it('answers a double click with one request', async () => {
    openReader();
    await Promise.all([
      makeTaskFromMessage(ACCOUNT, MESSAGE),
      makeTaskFromMessage(ACCOUNT, MESSAGE),
    ]);
    expect(taskCalls()).toHaveLength(1);
    expect(getMailSnapshot().open?.message?.taskId).toBe(TASK);
  });

  it('shows the busy state while the request is out', async () => {
    openReader();
    let release: (() => void) | null = null;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    vi.stubGlobal('fetch', vi.fn(async () => {
      await gate;
      return json({ taskId: TASK, created: true }, 201);
    }));
    const running = makeTaskFromMessage(ACCOUNT, MESSAGE);
    expect(getMailSnapshot().open?.taskBusy).toBe(true);
    release!();
    await running;
    expect(getMailSnapshot().open?.taskBusy).toBe(false);
  });

  it('says a 202 in words rather than spinning forever', async () => {
    openReader();
    taskAnswer = { status: 202, body: { ok: true, pending: true, message: 'still going' } };
    await makeTaskFromMessage(ACCOUNT, MESSAGE);

    const open = getMailSnapshot().open;
    expect(open?.taskBusy).toBe(false);
    expect(open?.taskError).toBe('Still making the task. Try again in a moment.');
    expect(open?.message?.taskId).toBeUndefined();
  });

  it('reports a failure next to the button and leaves the reader alone', async () => {
    openReader();
    taskAnswer = { status: 503, body: { error: 'db_unavailable', message: 'the mail cache is not readable' } };
    await makeTaskFromMessage(ACCOUNT, MESSAGE);

    const open = getMailSnapshot().open;
    expect(open?.taskBusy).toBe(false);
    expect(open?.taskError).toContain('the mail cache is not readable');
    // The message is still on screen: a failed side action must not close the thing being read.
    expect(open?.messageId).toBe(MESSAGE);
  });

  it('ignores an answer for a message the human has since navigated away from', async () => {
    openReader();
    applyMessageTask(ACCOUNT, 'INBOX:100:2', 'task-other');
    // The OPEN message is untouched; only the row that was named moved.
    expect(getMailSnapshot().open?.message?.taskId).toBeUndefined();
    expect(getMailSnapshot().messages.find((one) => one.messageId === 'INBOX:100:2')?.taskId)
      .toBe('task-other');
  });
});

describe('the live event', () => {
  it('stamps the pill for a task another tab or an agent made, with no request', () => {
    openReader();
    onMailEvent('message-tasked', { accountId: ACCOUNT, messageId: MESSAGE, taskId: TASK });
    expect(getMailSnapshot().open?.message?.taskId).toBe(TASK);
    expect(calls).toEqual([]);
  });

  it('does nothing at all on a half-filled payload', () => {
    openReader();
    onMailEvent('message-tasked', { accountId: ACCOUNT, messageId: MESSAGE });
    expect(getMailSnapshot().open?.message?.taskId).toBeUndefined();
    expect(calls).toEqual([]);
  });

  it('runs before the loaded gate, so a console that never opened makes no bootstrap request', () => {
    // `loaded` is false here: every other event kicks `loadAccounts`, and this one must not, because
    // the backlink is derived on every read anyway.
    onMailEvent('message-tasked', { accountId: ACCOUNT, messageId: MESSAGE, taskId: TASK });
    expect(calls).toEqual([]);
  });
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
