/**
 * Two small gates the console decides on its own, and both of them used to be decided wrongly.
 *
 * `canSendFrom` is what puts a Send button on screen. The PROVIDER's `send` flag is a claim about a
 * transport; the ACCOUNT's is the answer for this mailbox, and IMAP is why they differ (reading needs
 * a host and a password, sending needs SMTP settings a human may never have filled in). A button
 * that was only ever going to fail is worse than no button.
 *
 * `publishBadge` is the number on the sidebar row. It counts INBOX only: an account whose Spam
 * folder holds four hundred unread messages would otherwise wear a badge that never goes down, and
 * the human learns to ignore it. Mailbox rows win when the console has them (they are what the
 * optimistic read flag moves), and `unreadInbox` is the answer for an account whose folders this
 * browser has not listed yet.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { MailAccountDto, MailProviderSummary, MailboxDto } from '../../web/src/api/mail';
import { canSendFrom } from '../../web/src/apps/mail/compose/send-status';
import { __resetMailStore, patch, publishBadge, setMailBadgeHandle } from '../../web/src/apps/mail/mail-store';

const ONE = 'imap:one';
const TWO = 'imap:two';

function provider(send: boolean): MailProviderSummary {
  return {
    id: 'imap',
    label: 'IMAP',
    capabilities: {
      search: false, watch: true, drafts: false, markRead: true, flags: false,
      threads: false, send, sendAsReply: false, bodies: 'both', attachments: 'metadata',
    },
    setupFields: [],
  } as never;
}

function account(accountId: string, over: Partial<MailAccountDto> = {}): MailAccountDto {
  return {
    accountId,
    providerId: 'imap',
    displayName: accountId,
    address: `${accountId}@example.invalid`,
    state: 'active',
    unread: 0,
    ...over,
  } as MailAccountDto;
}

function mailbox(accountId: string, mailboxId: string, role: string, unread: number): MailboxDto {
  return { accountId, mailboxId, name: mailboxId, role, unread, total: unread } as never;
}

describe('who may be offered a Send button', () => {
  it('prefers the account capability over the provider block, in both directions', () => {
    const providers = [provider(false)];
    // The provider cannot send; THIS account can, because it has SMTP settings.
    expect(canSendFrom(providers, ONE, [account(ONE, { capabilities: { send: true } })])).toBe(true);
    // And the other way: a provider that can send, an account that cannot.
    expect(canSendFrom([provider(true)], ONE, [account(ONE, { capabilities: { send: false } })])).toBe(false);
  });

  it('falls back to the provider when the server sent no per-account answer', () => {
    // A provider with no `accountCapabilities`, and a tab that was open across the deploy which
    // added the field: both look like this, and both must keep working.
    expect(canSendFrom([provider(true)], ONE, [account(ONE)])).toBe(true);
    expect(canSendFrom([provider(false)], ONE, [account(ONE)])).toBe(false);
    expect(canSendFrom([provider(true)], ONE)).toBe(true);
  });

  it('answers no for no account, an unknown account and an unknown provider', () => {
    expect(canSendFrom([provider(true)], undefined)).toBe(false);
    // An account the list does not carry falls through to the provider, which is the honest guess.
    expect(canSendFrom([provider(true)], TWO, [account(ONE, { capabilities: { send: false } })])).toBe(true);
    expect(canSendFrom([], ONE, [account(ONE)])).toBe(false);
  });
});

describe('the sidebar badge counts the inbox and only the inbox', () => {
  let published: Array<number | null> = [];

  beforeEach(() => {
    __resetMailStore();
    published = [];
    setMailBadgeHandle({ setBadge: (value) => published.push(value) });
  });

  afterEach(() => { __resetMailStore(); });

  it('sums the inbox mailbox rows and ignores every other folder', () => {
    patch({
      accounts: [account(ONE, { unread: 999, unreadInbox: 5 }), account(TWO, { unread: 999 })],
      mailboxes: {
        [ONE]: [mailbox(ONE, 'INBOX', 'inbox', 3), mailbox(ONE, 'Spam', 'spam', 400)],
        [TWO]: [mailbox(TWO, 'INBOX', 'inbox', 2), mailbox(TWO, 'Archive', 'archive', 90)],
      },
    });
    publishBadge();
    // 3 + 2, and neither the 400 in Spam nor the account totals which include it.
    expect(published.at(-1)).toBe(5);
  });

  it('uses unreadInbox for an account whose folders this browser has not listed', () => {
    patch({
      accounts: [account(ONE, { unread: 412, unreadInbox: 7 })],
      mailboxes: {},
    });
    publishBadge();
    // The server already counted the inbox; `unread` counts every folder and would badge 412.
    expect(published.at(-1)).toBe(7);
  });

  it('falls back to the account total only when the server sent no inbox count', () => {
    patch({ accounts: [account(ONE, { unread: 4 })], mailboxes: {} });
    publishBadge();
    expect(published.at(-1)).toBe(4);
  });

  it('mixes the two sources, one account each', () => {
    patch({
      accounts: [account(ONE, { unread: 999, unreadInbox: 6 }), account(TWO, { unread: 999 })],
      mailboxes: { [TWO]: [mailbox(TWO, 'INBOX', 'inbox', 1), mailbox(TWO, 'Spam', 'spam', 50)] },
    });
    publishBadge();
    expect(published.at(-1)).toBe(7);
  });

  it('clears the badge rather than showing a zero', () => {
    patch({
      accounts: [account(ONE, { unread: 0, unreadInbox: 0 })],
      mailboxes: { [ONE]: [mailbox(ONE, 'INBOX', 'inbox', 0), mailbox(ONE, 'Spam', 'spam', 12)] },
    });
    publishBadge();
    expect(published.at(-1)).toBeNull();
  });
});
