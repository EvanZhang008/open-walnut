/**
 * The arithmetic behind six sidebar defects found in review, each pinned by the case that found it.
 *
 * - ONE NUMBER PER ROW. The All Drafts badge counted only the drafts written in this console while the
 *   header over the very same view counted those plus the provider's Drafts folder: three drafts on the
 *   server showed a BLANK row above a header reading 3, and a row badged 1 opened onto 4. One function
 *   answers for the badge, the per-account rows and the header (`draftsRowCount`).
 * - THE COLLAPSE ROW'S SECOND NUMBER COUNTS MAIL. Every other figure in that pane is a message count, so
 *   "6 with unread" over six folders holding 200 unread was the one number that counted something else.
 * - A ROLE ROW CARRIES THE ROLE'S NAME. One provider answers the raw identifier `INBOX` and the other
 *   `Inbox` for the same folder, directly under a group naming the same roles uniformly.
 * - THE DEGRADED LINE IS A SENTENCE, not a title attribute (the title never renders).
 * - COMPOSE FOLLOWS THE IDENTITY IN USE. `sendableAccountFor` always took the first sendable account
 *   because its only call site never passed the recent list.
 */
import { describe, it, expect } from 'vitest';
import type { MailAccountDto, MailboxDto, MailDraftDto, MailProviderSummary } from '../../web/src/api/mail';
import {
  accountsNotSyncing,
  degradedLine,
  degradedTitle,
  draftsRowCount,
  draftsTotalCount,
  folderLabel,
  folderTitle,
  hiddenTail,
  sendableAccountFor,
} from '../../web/src/apps/mail/mail-smart';
import { pairKey } from '../../web/src/apps/mail/mail-store';

const A = 'dense:harbour';
const B = 'dense:marina';

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

function mailbox(
  accountId: string,
  mailboxId: string,
  role: MailboxDto['role'],
  extra: Partial<MailboxDto> = {},
): MailboxDto {
  return { accountId, mailboxId, name: mailboxId, role, unread: 0, total: 0, ...extra };
}

function draft(accountId: string, draftId: string, state: MailDraftDto['state']): MailDraftDto {
  return { draftId, accountId, state, subject: 'x', updatedAt: 1 } as MailDraftDto;
}

function provider(id: string, send: boolean): MailProviderSummary {
  return { id, label: id, capabilities: { send } } as MailProviderSummary;
}

/** The measured production shape: A spells its folders one way and B another, and A keeps 2 drafts. */
function denseMailboxes(opts: { serverDrafts?: boolean } = {}): Record<string, MailboxDto[]> {
  return {
    [A]: [
      mailbox(A, 'INBOX', 'inbox', { name: 'INBOX', total: 60 }),
      mailbox(A, 'Drafts', 'drafts', { name: 'Drafts', total: 2 }),
      mailbox(A, 'Sent', 'sent', { name: 'Sent', total: 8 }),
    ],
    [B]: [
      mailbox(B, 'inbox', 'inbox', { name: 'Inbox', total: 70, unread: 7 }),
      ...(opts.serverDrafts === false ? [] : [mailbox(B, 'marina/drafts', 'drafts', { name: 'Drafts', total: 1 })]),
      mailbox(B, 'marina/all-mail/sent', 'sent', { name: 'Sent Mail', total: 6 }),
    ],
  };
}

/**
 * REVISED in round two (F1). The badge counted the provider's Drafts folder as the mailbox row declares
 * it, which is a number nobody can check: that folder holds drafts older than the window this cache keeps,
 * so a row badged 23 opened onto a section of four and All Drafts summed two of them into 51 printed above
 * the words "No drafts." The badge is the FIRST SECTION now, which a person can verify by counting rows,
 * and the view's header counts every row under it (`sectionOf`, pinned in the browser spec).
 */
describe('the drafts badge is what its own first section lists (F1)', () => {
  it('is the drafts written here, never the provider folder the cache cannot list', () => {
    const mailboxes = denseMailboxes();
    // Nothing written in this console yet, and both providers hold drafts: the badge is silent, because
    // the section it names is empty. This is the exact state that shipped "51" over "No drafts."
    expect(mailboxes[A]!.some((one) => one.role === 'drafts')).toBe(true);
    expect(draftsRowCount([])).toBe(0);
    expect(draftsRowCount(undefined)).toBe(0);
    expect(draftsTotalCount({}, [account(A), account(B)])).toBe(0);
  });

  it('adds one written here to the account that owns it, and to the total, and to nothing else', () => {
    const drafts = { [A]: [draft(A, 'd1', 'composing')] };
    expect(draftsRowCount(drafts[A])).toBe(1);
    expect(draftsRowCount(drafts[B])).toBe(0);
    expect(draftsTotalCount(drafts, [account(A), account(B)])).toBe(1);
  });

  it('counts every draft, including one already on its way, because the section lists it', () => {
    const drafts = { [A]: [draft(A, 'd1', 'composing'), draft(A, 'd2', 'sending')] };
    expect(draftsRowCount(drafts[A])).toBe(2);
    expect(draftsTotalCount(drafts, [account(A), account(B)])).toBe(2);
  });

  it('counts only the accounts that still exist, so a removed account cannot inflate the row', () => {
    const drafts = { [A]: [draft(A, 'd1', 'composing')], [B]: [draft(B, 'd2', 'composing')] };
    expect(draftsTotalCount(drafts, [account(A)])).toBe(1);
  });
});

describe('the collapse row admits how many folders hold unread (F11, F2)', () => {
  it('sums the unread in the hidden set and counts the folders holding it', () => {
    const hidden = [
      mailbox(A, 'l1', 'other', { unread: 55 }),
      mailbox(A, 'l2', 'other', { unread: 47 }),
      mailbox(A, 'l3', 'other', { unread: 0 }),
      mailbox(A, 'l4', 'other', { unread: 2 }),
    ];
    expect(hiddenTail(A, hidden, {})).toEqual({ folders: 3, unread: 104 });
  });

  it('reads THIS frame’s numbers, so reading a mail moves the clause in that frame', () => {
    const hidden = [mailbox(A, 'l1', 'other', { unread: 5 })];
    const live = { [pairKey(A, 'l1')]: mailbox(A, 'l1', 'other', { unread: 4 }) };
    expect(hiddenTail(A, hidden, live)).toEqual({ folders: 1, unread: 4 });
  });

  it('is zero for an empty tail and for a tail whose unread has all been read', () => {
    expect(hiddenTail(A, [], {})).toEqual({ folders: 0, unread: 0 });
    expect(hiddenTail(A, [mailbox(A, 'l1', 'other')], {})).toEqual({ folders: 0, unread: 0 });
  });
});

/**
 * REVERSED in round 3 (N10, C9). F16 printed a canonical role name over every role row, which left the
 * provider's own name reachable only on hover, invisible to the tail filter, and gave two folders of one
 * role the same label with nothing on screen to tell them apart. The row's glyph already marks the role.
 */
describe('a folder row carries the provider’s own name, the role on hover (N10)', () => {
  it('prints what the provider calls it, even when two accounts call one role different things', () => {
    const mailboxes = denseMailboxes();
    expect(mailboxes[A]!.map(folderLabel)).toEqual(['INBOX', 'Drafts', 'Sent']);
    expect(mailboxes[B]!.map(folderLabel)).toEqual(['Inbox', 'Drafts', 'Sent Mail']);
  });

  it('says the ROLE on hover, and only where the name does not already say it', () => {
    expect(folderTitle(mailbox(A, 'INBOX', 'inbox', { name: 'INBOX' }))).toBeUndefined();
    expect(folderTitle(mailbox(B, 'inbox', 'inbox', { name: 'Inbox' }))).toBeUndefined();
    expect(folderTitle(mailbox(B, 'x', 'sent', { name: 'Sent Mail' }))).toBe('Sent');
    expect(folderTitle(mailbox(A, 'junk', 'spam', { name: 'Spam' }))).toBe('Junk');
    expect(folderTitle(mailbox(A, 'all', 'archive', { name: 'All Mail' }))).toBe('Archive');
  });

  it('leaves an ordinary label alone: it has no role to add', () => {
    const label = mailbox(A, 'harbour/label/berths', 'other', { name: 'Berths' });
    expect(folderLabel(label)).toBe('Berths');
    expect(folderTitle(label)).toBeUndefined();
  });

  it('never renames two folders of one role into one label', () => {
    const all = mailbox(A, 'all', 'archive', { name: 'All Mail' });
    const archive = mailbox(A, 'Archive', 'archive', { name: 'Archive' });
    expect(folderLabel(all)).not.toBe(folderLabel(archive));
  });
});

describe('the degraded state is a sentence, not a tooltip (C35)', () => {
  it('counts a parked account and one whose health says it has stopped', () => {
    const covered = [
      account(A),
      account(B, { state: 'auth-required' }),
    ];
    expect(accountsNotSyncing(covered).map((one) => one.accountId)).toEqual([B]);
    const failing = [account(A, { health: { state: 'auth-required', checkedAt: 1 } } as Partial<MailAccountDto>)];
    expect(accountsNotSyncing(failing as MailAccountDto[])).toHaveLength(1);
  });

  it('is the exact spec string, singular and plural, and absent when everything syncs', () => {
    expect(degradedLine(1)).toBe('1 account is not syncing.');
    expect(degradedLine(2)).toBe('2 accounts are not syncing.');
    expect(degradedLine(0)).toBeNull();
    expect(degradedTitle(1, 2)).toBe('1 of 2 accounts is not syncing');
    expect(degradedTitle(2, 2)).toBe('2 of 2 accounts are not syncing');
    expect(degradedTitle(0, 2)).toBeNull();
  });
});

describe('compose from a merged list follows the identity in use (F5)', () => {
  const accounts = [account(A), account(B)];
  const providers = [provider('dense', true)];

  it('prefers the account just read or just sent from over the first in the list', () => {
    expect(sendableAccountFor(accounts, providers, [B])).toBe(B);
    expect(sendableAccountFor(accounts, providers, [B, A])).toBe(B);
    expect(sendableAccountFor(accounts, providers, [A, B])).toBe(A);
  });

  it('skips a remembered account that is gone or cannot send, and falls back to the first that can', () => {
    expect(sendableAccountFor(accounts, providers, ['dense:ghost', B])).toBe(B);
    // The account's OWN capability outranks its provider's, which is how one inbound-only account sits
    // beside a sending one under the same provider.
    const cannotSend = [account(A), account(B, { capabilities: { send: false } } as Partial<MailAccountDto>)];
    expect(sendableAccountFor(cannotSend as MailAccountDto[], providers, [B])).toBe(A);
    expect(sendableAccountFor(accounts, providers, [])).toBe(A);
    expect(sendableAccountFor(accounts, providers)).toBe(A);
  });

  it('is null only when no account can send, which is the one honest disabled state', () => {
    const none = [account(A, { capabilities: { send: false } } as Partial<MailAccountDto>)];
    expect(sendableAccountFor(none as MailAccountDto[], providers, [A])).toBeNull();
  });
});
