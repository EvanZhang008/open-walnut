/**
 * The sidebar's arithmetic: which smart rows exist, what their badges say, and which folders stay in
 * view when one account has 64 of them.
 *
 * Pure functions, graded at the density they were designed for. What each case is defending:
 *
 * - A smart row needs TWO accounts holding the role. With one account "All Inboxes" is a second copy of
 *   that account's own inbox row, and a duplicate entry is worse than no entry.
 * - The badges are EXACT sums of the same mailbox rows the message list header reads, so the sidebar and
 *   the header cannot disagree. No abbreviation, no estimate, and a per-row round so a provider's
 *   non-integer cannot render as "3.0001".
 * - A folder is lifted out of the collapsed tail because mail ARRIVED in it during this session, not
 *   because it holds unread. Six of the real account's 58 labels hold 200 unread between them and are
 *   months dead: an unread rule promotes all six, every day, and answers "keep the important ones" with
 *   the noise the collapse exists to remove.
 * - Promotion is capped at three and taken in SERVER order, so which three survive does not depend on
 *   why each was wanted.
 * - Expanded is ONE list: every label exactly once, no promotion block, no holes.
 * - Compose from a smart row resolves to a real, sendable account, because the reserved smart id can
 *   never send and reading it as the identity greys out the pane's primary button in the default view.
 * - The second page of a merged list is the first request plus a cursor, and nothing else (C54).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { MailAccountDto, MailboxDto, MailDraftDto, MailProviderSummary } from '../../web/src/api/mail';
import { listMailMessages } from '../../web/src/api/mail';
import {
  draftsTotalCount,
  importantFolders,
  sendableAccountFor,
  smartPairs,
  smartRowVisible,
  smartTotal,
  smartUnread,
  PROMOTED_CAP,
} from '../../web/src/apps/mail/mail-smart';
import { pairKey } from '../../web/src/apps/mail/mail-store';

const A = 'dense:harbour';
const B = 'dense:marina';

/** The 58 ordinary labels, named so the role folders sort between them, as the real account does. */
const LABELS = Array.from({ length: 58 }, (_, index) => `Label ${String(index + 1).padStart(2, '0')}`);

function account(accountId: string, extra: Partial<MailAccountDto> = {}): MailAccountDto {
  return {
    accountId,
    providerId: accountId.split(':')[0]!,
    displayName: accountId,
    address: `${accountId}@example.invalid`,
    state: 'active',
    unread: 0,
    ...extra,
  } as MailAccountDto;
}

function mailbox(accountId: string, mailboxId: string, role: MailboxDto['role'], extra: Partial<MailboxDto> = {}): MailboxDto {
  return { accountId, mailboxId, name: mailboxId, role, unread: 0, total: 0, ...extra };
}

/**
 * Account A the way the server orders it: inbox first, then by name, so the five other role folders sit
 * scattered among the 58 labels rather than in a block.
 */
function denseA(opts: { staleUnread?: number[] } = {}): MailboxDto[] {
  const roles: MailboxDto[] = [
    mailbox(A, 'INBOX', 'inbox'),
    mailbox(A, 'Archive', 'archive'),
    mailbox(A, 'Drafts', 'drafts'),
    mailbox(A, 'Sent', 'sent'),
    mailbox(A, 'Spam', 'spam'),
    mailbox(A, 'Trash', 'trash'),
  ];
  const stale = opts.staleUnread ?? [];
  const labels = LABELS.map((name, index) => mailbox(A, `harbour/label/${index}`, 'other', {
    name,
    unread: stale[index] ?? 0,
  }));
  return [...roles, ...labels];
}

/** Account B: six folders, every role id spelled differently from A's. */
function denseB(): MailboxDto[] {
  return [
    mailbox(B, 'inbox', 'inbox', { unread: 7 }),
    mailbox(B, 'archive', 'archive'),
    mailbox(B, 'marina/drafts', 'drafts'),
    mailbox(B, 'marina/sent', 'sent'),
    mailbox(B, 'junk', 'spam'),
    mailbox(B, 'bin', 'trash'),
  ];
}

function draft(accountId: string, draftId: string, state: MailDraftDto['state']): MailDraftDto {
  return { draftId, accountId, state, subject: 'x', updatedAt: 1 } as MailDraftDto;
}

function provider(id: string, send: boolean): MailProviderSummary {
  return { id, label: id, capabilities: { send } } as MailProviderSummary;
}

describe('a smart row appears only when two accounts hold the role', () => {
  it('shows nothing at all on a one-account install', () => {
    const mailboxes = { [A]: denseA() };
    const accounts = [account(A)];
    for (const role of ['inbox', 'sent', 'drafts'] as const) {
      expect(smartRowVisible(mailboxes, accounts, role), role).toBe(false);
    }
  });

  it('shows inbox and sent when both accounts have that role, and drafts on the account count alone', () => {
    const mailboxes = { [A]: denseA(), [B]: denseB() };
    const accounts = [account(A), account(B)];
    expect(smartRowVisible(mailboxes, accounts, 'inbox')).toBe(true);
    expect(smartRowVisible(mailboxes, accounts, 'sent')).toBe(true);
    // Drafts is Walnut's own row, one per account, so the provider folder is not the judge.
    const noProviderDrafts = { [A]: denseA(), [B]: denseB().filter((row) => row.role !== 'drafts') };
    expect(smartRowVisible(noProviderDrafts, accounts, 'drafts')).toBe(true);
    // Sent in only one account is a duplicate of that account's own row, so the row stays away.
    const oneSent = { [A]: denseA(), [B]: denseB().filter((row) => row.role !== 'sent') };
    expect(smartRowVisible(oneSent, accounts, 'sent')).toBe(false);
  });

  it('counts an account that is parked or disabled, because its cached mail is still real', () => {
    const mailboxes = { [A]: denseA(), [B]: denseB() };
    const parked = [account(A, { state: 'auth-required' }), account(B, { state: 'disabled' })];
    expect(smartRowVisible(mailboxes, parked, 'inbox')).toBe(true);
    expect(smartRowVisible(mailboxes, parked, 'drafts')).toBe(true);
  });
});

describe('the pairs a smart row covers', () => {
  it('resolves by role in account order and keeps the two colliding ids apart', () => {
    const mailboxes = { [A]: denseA(), [B]: denseB() };
    expect(smartPairs(mailboxes, [account(A), account(B)], 'inbox')).toEqual([
      { accountId: A, mailboxId: 'INBOX' },
      { accountId: B, mailboxId: 'inbox' },
    ]);
  });

  it('ignores folder rows left behind by an account that is gone', () => {
    const mailboxes = { [A]: denseA(), [B]: denseB() };
    // B was deleted; its folder rows have not been swept yet. Its mail must not come back.
    expect(smartPairs(mailboxes, [account(A)], 'inbox')).toEqual([{ accountId: A, mailboxId: 'INBOX' }]);
  });
});

describe('badges are exact sums of the mailbox rows', () => {
  it('adds the unread and total of every row with that role, rounding each row', () => {
    const mailboxes = {
      [A]: [mailbox(A, 'INBOX', 'inbox', { unread: 0, total: 1594 })],
      [B]: [mailbox(B, 'inbox', 'inbox', { unread: 7, total: 2396 })],
    };
    expect(smartUnread(mailboxes, 'inbox')).toBe(7);
    expect(smartTotal(mailboxes, 'inbox')).toBe(3990);
    // Never abbreviated: a four-figure count is the number, not "4k".
    const big = { [A]: [mailbox(A, 'INBOX', 'inbox', { unread: 12_345, total: 12_345 })] };
    expect(smartUnread(big, 'inbox')).toBe(12_345);
    // Per ROW rounding: two provider-declared fractions must not add up to 6.000000001.
    const fractions = {
      [A]: [mailbox(A, 'INBOX', 'inbox', { unread: 3.4 })],
      [B]: [mailbox(B, 'inbox', 'inbox', { unread: 2.6 })],
    };
    expect(smartUnread(fractions, 'inbox')).toBe(6);
    // Only that role: spam and trash are never part of an inbox badge.
    expect(smartUnread({ [A]: [mailbox(A, 'Spam', 'spam', { unread: 99 })] }, 'inbox')).toBe(0);
  });

  // The All Drafts badge is the view's FIRST SECTION across accounts: the drafts written in this console,
  // which a person can check by counting rows. It counted each provider's Drafts folder as well, using the
  // folder size the mailbox row declares, and that size counts drafts outside this cache's retention
  // window: the row badged 51 sat over sections adding up to 8. Every draft state counts, including one
  // already on its way, because the section lists them all.
  it('counts every draft written here, across accounts, and no provider folder', () => {
    const drafts = {
      [A]: [draft(A, 'd1', 'composing'), draft(A, 'd2', 'sent'), draft(A, 'd3', 'failed')],
      [B]: [draft(B, 'd4', 'pending_approval'), draft(B, 'd5', 'discarded')],
    };
    const accounts = [account(A), account(B)];
    expect(draftsTotalCount(drafts, accounts)).toBe(5);
    expect(draftsTotalCount({}, accounts)).toBe(0);
    expect(draftsTotalCount(drafts, [account(A)])).toBe(3);
  });
});

describe('which folders stay out of the collapsed tail', () => {
  const mailboxes = () => ({ [A]: denseA(), [B]: denseB() });

  it('keeps every role row and collapses all 58 labels when nothing has arrived', () => {
    const folders = importantFolders(mailboxes(), A, { arrivals: {} });
    expect(folders.shown.map((row) => row.mailboxId)).toEqual(['INBOX', 'Archive', 'Drafts', 'Sent', 'Spam', 'Trash']);
    expect(folders.promoted).toEqual([]);
    expect(folders.hidden).toHaveLength(58);
  });

  it('does NOT promote a label that only holds stale unread (C56)', () => {
    // The real numbers: six archived labels, 200 unread between them, nothing arriving.
    const stale: number[] = [];
    [0, 7, 19, 26, 33, 44].forEach((index, at) => { stale[index] = [55, 47, 40, 28, 28, 2][at]!; });
    const rows = { [A]: denseA({ staleUnread: stale }) };
    const folders = importantFolders(rows, A, { arrivals: {} });
    expect(folders.promoted).toEqual([]);
    expect(folders.hidden).toHaveLength(58);
    // The count the collapse row has to own up to, and the sum it is standing in front of.
    const withUnread = folders.hidden.filter((row) => row.unread > 0);
    expect(withUnread).toHaveLength(6);
    expect(withUnread.reduce((sum, row) => sum + row.unread, 0)).toBe(200);
    // Six roles plus the collapse row: the segment stays inside the ten-row budget.
    expect(folders.shown.length + folders.promoted.length + 1).toBeLessThanOrEqual(10);
  });

  it('promotes a label that received mail this session, capped at three in server order', () => {
    const rows = mailboxes();
    // Four arrivals, deliberately named out of order, so the cap cannot be "the first three seen".
    const arrivals = {
      [pairKey(A, 'harbour/label/40')]: 2,
      [pairKey(A, 'harbour/label/3')]: 1,
      [pairKey(A, 'harbour/label/17')]: 5,
      [pairKey(A, 'harbour/label/9')]: 1,
      // Zero added is not an arrival, and an arrival in ANOTHER account is not this account's.
      [pairKey(A, 'harbour/label/50')]: 0,
      [pairKey(B, 'harbour/label/3')]: 9,
    };
    const folders = importantFolders(rows, A, { arrivals });
    expect(folders.promoted.map((row) => row.mailboxId))
      .toEqual(['harbour/label/3', 'harbour/label/9', 'harbour/label/17']);
    expect(folders.promoted).toHaveLength(PROMOTED_CAP);
    expect(folders.hidden).toHaveLength(55);
    // The fourth stays in the tail rather than growing the promotion block.
    expect(folders.hidden.some((row) => row.mailboxId === 'harbour/label/40')).toBe(true);
    expect(folders.hidden.some((row) => row.mailboxId === 'harbour/label/50')).toBe(true);
  });

  it('never hides the row that is selected, and remembers at most three recent labels (C16)', () => {
    const rows = mailboxes();
    const selected = importantFolders(rows, A, { arrivals: {}, selectedMailboxId: 'harbour/label/57' });
    expect(selected.promoted.map((row) => row.mailboxId)).toEqual(['harbour/label/57']);
    expect(selected.hidden).toHaveLength(57);

    // Newest first, and only the first three are honoured: a fourth entry is back in the tail.
    const recent = ['harbour/label/2', 'harbour/label/11', 'harbour/label/30', 'harbour/label/44'];
    const remembered = importantFolders(rows, A, { arrivals: {}, recent });
    expect(remembered.promoted.map((row) => row.mailboxId))
      .toEqual(['harbour/label/2', 'harbour/label/11', 'harbour/label/30']);
    expect(remembered.hidden.some((row) => row.mailboxId === 'harbour/label/44')).toBe(true);
  });

  it('expanded is one list in server order with no promotion block and no repeats', () => {
    const rows = mailboxes();
    const arrivals = { [pairKey(A, 'harbour/label/3')]: 4 };
    const folders = importantFolders(rows, A, { arrivals, expanded: true, selectedMailboxId: 'harbour/label/57' });
    expect(folders.promoted).toEqual([]);
    expect(folders.hidden).toHaveLength(58);
    const ids = [...folders.shown, ...folders.hidden].map((row) => row.mailboxId);
    expect(new Set(ids).size).toBe(64);
    // Server order preserved, so somebody scanning alphabetically finds a name where it belongs.
    expect(folders.hidden.map((row) => row.name)).toEqual(LABELS);
  });

  it('answers with nothing for an account whose folders have not loaded', () => {
    const folders = importantFolders({}, A, { arrivals: {} });
    expect(folders).toEqual({ shown: [], promoted: [], hidden: [] });
  });
});

describe('compose from a smart row lands on a real account', () => {
  const providers = [provider('dense', true)];

  it('prefers the account last used, falls back to the first that can send, and refuses honestly', () => {
    const accounts = [account(A), account(B)];
    expect(sendableAccountFor(accounts, providers, [B, A])).toBe(B);
    expect(sendableAccountFor(accounts, providers, [])).toBe(A);
    // A remembered account that has been deleted is skipped rather than returned.
    expect(sendableAccountFor(accounts, providers, ['dense:gone'])).toBe(A);
    // The per-account answer wins over the provider's, which is why one IMAP account can send and
    // another cannot.
    const mixed = [
      account(A, { capabilities: { send: false } }),
      account(B, { capabilities: { send: true } }),
    ];
    expect(sendableAccountFor(mixed, providers, [A])).toBe(B);
    // Nobody can send: null, which is the only case where the button is honestly disabled.
    const none = [account(A, { capabilities: { send: false } })];
    expect(sendableAccountFor(none, providers, [A])).toBeNull();
    expect(sendableAccountFor([], providers, [])).toBeNull();
  });
});

describe('the merged list second page is the first request plus a cursor (C54)', () => {
  const urls: string[] = [];

  beforeEach(() => {
    urls.length = 0;
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      urls.push(String(url));
      return new Response(JSON.stringify({ messages: [] }), {
        status: 200, headers: { 'Content-Type': 'application/json' },
      });
    }));
  });

  afterEach(() => { vi.unstubAllGlobals(); });

  it('sends scope and the opaque token, and never account or mailbox', async () => {
    await listMailMessages({ scope: 'role:inbox', limit: 50 });
    await listMailMessages({ scope: 'role:inbox', limit: 50, before: 'MTc1OAB0aWU' });
    const [first, older] = urls;
    expect(first).toBe('/api/plugins/mail/messages?limit=50&scope=role%3Ainbox');
    // Byte for byte the first request with one parameter added: no account, no mailbox, same scope.
    expect(older).toBe('/api/plugins/mail/messages?limit=50&before=MTc1OAB0aWU&scope=role%3Ainbox');
    expect(older!.replace('&before=MTc1OAB0aWU', '')).toBe(first);
    for (const url of urls) {
      expect(url).not.toContain('account=');
      expect(url).not.toContain('mailbox=');
    }
    // The token is passed through verbatim, never parsed or re-encoded as a number.
    await listMailMessages({ scope: 'role:sent', before: 'not-a-number' });
    expect(urls[2]).toContain('before=not-a-number');
  });
});
