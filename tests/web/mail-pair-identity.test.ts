/**
 * A message's identity is (accountId, messageId), and the merged smart lists are the first surface
 * that puts two providers' id spaces in one column.
 *
 * The reason is identity, not collision statistics: the id space belongs to the provider, so Walnut
 * may assume nothing about its shape, and a key that is right only while two providers happen to
 * disagree about id length is not right. What an id-only match actually did, given a duplicated id:
 *
 * - `heldSeen` found the OTHER account's already-read row and returned early, so clicking the unread
 *   message did nothing at all, with no request and nothing on screen to explain it.
 * - `replaceMessage` wrote the server's answer over the other account's row, so one account's list
 *   showed another account's sender and subject.
 * - `mapMessage` / `applySeen` moved the wrong row's flags and the wrong mailbox's unread count.
 *
 * The last case here is the committed grep gate: every `messageId ===` under `web/src/apps/mail` has to
 * name `accountId` in the same expression.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { markReadIfAllowed, setOpenMessageRead } from '../../web/src/apps/mail/mail-read-flag';
import { SEEN, __resetMailStore, getMailSnapshot, patch, store } from '../../web/src/apps/mail/mail-store';
import { keepOpenRow } from '../../web/src/apps/mail/mail-unread-filter';

const A = 'fake:one';
const B = 'fake:two';
const A_INBOX = 'INBOX';
const B_INBOX = 'inbox';
/** ONE id, two accounts. Both rows are real mail and both belong on screen. */
const DUP = 'dup-1';

interface Call { url: string; method: string; body: unknown }

let calls: Call[] = [];
let onProviders: (() => void) | null = null;

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

function envelope(accountId: string, seen: boolean) {
  return {
    messageId: DUP,
    accountId,
    mailboxId: accountId === A ? A_INBOX : B_INBOX,
    rfcMessageId: `<${DUP}.${accountId}@example.invalid>`,
    from: { address: accountId === A ? 'first@example.invalid' : 'second@example.invalid' },
    to: [{ address: 'me@example.invalid' }],
    subject: accountId === A ? 'Roof inspection' : 'Quarterly plan',
    snippet: 'a sentence',
    sentAt: Date.parse('2026-09-17T09:00:00Z'),
    flags: seen ? [SEEN] : [],
    attachments: [],
    hasBody: true,
  };
}

function accounts() {
  return [A, B].map((accountId) => ({
    accountId,
    providerId: 'fake',
    displayName: accountId === A ? 'Personal' : 'Work',
    address: `${accountId === A ? 'me' : 'work'}@example.invalid`,
    state: 'ready',
    unread: 3,
    unreadInbox: 3,
  }));
}

function mailboxRows(accountId: string) {
  return [{
    accountId,
    mailboxId: accountId === A ? A_INBOX : B_INBOX,
    name: 'Inbox',
    role: 'inbox',
    unread: 3,
    total: 20,
    lastSyncAt: Date.parse('2026-09-17T09:05:00Z'),
  }];
}

function readCalls(): Call[] {
  return calls.filter((call) => call.url.includes('/read'));
}

function rowOf(accountId: string) {
  return getMailSnapshot().messages.find((one) => one.accountId === accountId)!;
}

function mailboxUnread(accountId: string): number {
  return getMailSnapshot().mailboxes[accountId]![0]!.unread;
}

/** What the read route answers with: the server's own row, which is what `replaceMessage` installs. */
let readAnswer: (accountId: string) => unknown = (accountId) => envelope(accountId, true);

beforeEach(() => {
  calls = [];
  onProviders = null;
  readAnswer = (accountId) => envelope(accountId, true);
  __resetMailStore();
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? 'GET';
    let body: unknown = null;
    if (typeof init?.body === 'string') body = JSON.parse(init.body);
    calls.push({ url, method, body });
    if (url.includes('/read')) {
      // `/messages/<account>/<id>/read`, so the account is in the path and this is where a write to
      // the WRONG account would show up.
      const account = decodeURIComponent(url.split('/messages/')[1]!.split('/')[0]!);
      return json({ ok: true, message: readAnswer(account) });
    }
    if (url.includes('/mail/providers')) {
      onProviders?.();
      return json({ providers: [{ id: 'fake', label: 'Fake', capabilities: { markRead: true, send: true }, setupFields: [] }] });
    }
    return json({ error: 'not-found', message: url }, 404);
  }));
  patch({
    loaded: true,
    providers: [{ id: 'fake', label: 'Fake', capabilities: { markRead: true, send: true }, setupFields: [] }] as never,
    providersKnown: true,
    accounts: accounts() as never,
    mailboxes: { [A]: mailboxRows(A) as never, [B]: mailboxRows(B) as never },
    // A's copy is ALREADY READ. That is the row an id-only lookup finds first.
    messages: [envelope(A, true), envelope(B, false)] as never,
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
  __resetMailStore();
});

describe('two accounts holding the same message id', () => {
  it('marks the B copy read even though the A copy is already read (C52)', async () => {
    await markReadIfAllowed(envelope(B, false) as never);

    // The whole point: not a silent no-op. One request, for account B.
    expect(readCalls()).toHaveLength(1);
    expect(readCalls()[0]!.url).toContain(encodeURIComponent(B));
    expect(readCalls()[0]!.body).toEqual({ read: true });
    expect(rowOf(B).flags).toContain(SEEN);
  });

  it('leaves the A row and its counts exactly as they were (C28)', async () => {
    const before = rowOf(A);

    await markReadIfAllowed(envelope(B, false) as never);

    // Same flags, same sender, same subject: nothing about A moved.
    expect(rowOf(A).flags).toEqual(before.flags);
    expect(rowOf(A).from.address).toBe('first@example.invalid');
    expect(rowOf(A).subject).toBe('Roof inspection');
    expect(mailboxUnread(A)).toBe(3);
    expect(mailboxUnread(B)).toBe(2);
    expect(getMailSnapshot().accounts.find((one) => one.accountId === A)!.unread).toBe(3);
    expect(getMailSnapshot().accounts.find((one) => one.accountId === B)!.unread).toBe(2);
  });

  it('does not let the server answer for B overwrite the A row (C52)', async () => {
    // BOTH unread here, so nothing short-circuits and the write really reaches `replaceMessage`: with
    // the A copy already read the run stops at `heldSeen` and this case would pass without ever
    // exercising the row that gets replaced.
    patch({ messages: [envelope(A, false), envelope(B, false)] as never });

    await markReadIfAllowed(envelope(B, false) as never);

    expect(rowOf(B).subject).toBe('Quarterly plan');
    expect(rowOf(A).subject).toBe('Roof inspection');
    expect(rowOf(A).from.address).toBe('first@example.invalid');
    // And still two rows: neither replaced the other.
    expect(getMailSnapshot().messages).toHaveLength(2);
  });

  it('keeps the open reader on its own copy', async () => {
    patch({
      // Unread again, so the write goes out and the answer is folded back: that fold is what used to
      // install B's row into the reader showing A's message.
      messages: [envelope(A, false), envelope(B, false)] as never,
      open: {
        accountId: A,
        messageId: DUP,
        message: envelope(A, true) as never,
        body: null,
        bodyError: null,
        loading: false,
        error: null,
        allowRemoteImages: false,
        taskBusy: false,
        taskError: null,
      },
    });

    await markReadIfAllowed(envelope(B, false) as never);

    // The reader is showing A's message, and B's write must not rewrite it.
    expect(getMailSnapshot().open!.message!.subject).toBe('Roof inspection');
    expect(getMailSnapshot().open!.accountId).toBe(A);
  });
});

describe('the reader control re-reads the open message after its await', () => {
  it('refuses to write when the reader moved to the other account copy', async () => {
    // The re-read exists because a second press, or the automatic mark, can land during the provider
    // round trip. With an id-only comparison the re-read accepts a DIFFERENT account's message of the
    // same id and writes the flag there: the human pressed "mark unread" on the work copy and the
    // personal copy changed.
    patch({
      providersKnown: false,
      providers: [] as never,
      open: {
        accountId: B,
        messageId: DUP,
        message: envelope(B, true) as never,
        body: null,
        bodyError: null,
        loading: false,
        error: null,
        allowRemoteImages: false,
        taskBusy: false,
        taskError: null,
      },
    });
    // The provider read is the await, so the swap happens exactly inside it.
    onProviders = () => {
      store.openSeq += 1;
      patch({
        open: {
          ...getMailSnapshot().open!,
          accountId: A,
          message: envelope(A, true) as never,
        },
      });
    };

    await setOpenMessageRead(false);

    expect(readCalls()).toEqual([]);
  });
});

describe('the committed gate', () => {
  it('allows no messageId comparison without accountId in the same expression (C51)', () => {
    const dir = join(import.meta.dirname, '../../web/src/apps/mail');
    const offenders: string[] = [];
    for (const file of walk(dir)) {
      const lines = readFileSync(file, 'utf8').split('\n');
      lines.forEach((line, index) => {
        if (!line.includes('messageId ===')) return;
        // Deliberately ONE LINE rather than a parsed expression: a widened window would let an
        // `accountId` from the statement above launder a bare comparison below it, which is the exact
        // shape `heldSeen` had. Keep the pair on the line, or reach for `pairKey`.
        if (line.includes('accountId')) return;
        offenders.push(`${file.slice(dir.length + 1)}:${index + 1}: ${line.trim()}`);
      });
    }
    expect(offenders, 'a message is (accountId, messageId); see spec 9.2').toEqual([]);
  });
});

function walk(dir: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) found.push(...walk(path));
    else if (path.endsWith('.ts') || path.endsWith('.tsx')) found.push(path);
  }
  return found;
}

describe('a held row spliced back into a fresh unread page', () => {
  const AT = Date.parse('2026-09-17T09:00:00Z');

  it('lands where the servers three-segment order would have put it', () => {
    // A tie on both the timestamp and the id, which is exactly what a merged list produces. The
    // account breaks it (`sent_at DESC, message_id DESC, account_id DESC`), so the held row of the
    // higher account id goes ABOVE the page row that ties with it; a two-segment comparison found no
    // row that sorts after it and appended it to the end of the page instead.
    const page = [
      { ...envelope(A, false), sentAt: AT },
      { ...envelope(A, false), messageId: 'older-1', sentAt: AT - 60_000 },
    ];
    const sticky = { ...envelope(B, false), sentAt: AT };

    const rows = keepOpenRow(page as never, [sticky] as never, { accountId: B, messageId: DUP });

    expect(rows.map((one) => `${one.accountId}/${one.messageId}`)).toEqual([
      `${B}/${DUP}`,
      `${A}/${DUP}`,
      `${A}/older-1`,
    ]);
  });

  it('still lands at the end when it is older than the whole page', () => {
    const page = [{ ...envelope(A, false), sentAt: AT }];
    const sticky = { ...envelope(B, false), messageId: 'older-2', sentAt: AT - 60_000 };

    const rows = keepOpenRow(page as never, [sticky] as never, { accountId: B, messageId: 'older-2' });

    expect(rows.map((one) => one.messageId)).toEqual([DUP, 'older-2']);
  });

  it('is never invented for a row this list never held', () => {
    const page = [{ ...envelope(A, false), sentAt: AT }];

    // A message opened from a deep link belongs to another mailbox: adding it here would put foreign
    // mail in this folder's column.
    expect(keepOpenRow(page as never, [] as never, { accountId: B, messageId: DUP })).toHaveLength(1);
  });
});
