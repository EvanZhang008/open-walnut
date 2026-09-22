/**
 * The mail pane's "Checked N ago" footer, as data (S1).
 *
 * Every case here is one way the line could lie, which is why the whole sentence is derived by a pure
 * function and the component only prints it:
 *
 * - IT SPEAKS FOR THE SELECTION. A folder off the inbox cadence is polled once every five ticks, so a
 *   line that read the newest check anywhere in the mailbox would say "just now" over a nine minute old
 *   list. The smart rows are the opposite case and take the NEWEST member, which is the freshest thing
 *   a merged list can honestly claim.
 * - NEVER FETCHED IS NOT "JUST NOW". A folder with no `lastSyncAt` says so, and a timestamp that cannot
 *   be parsed counts as none: `timeAgo` answers '' for one, and printed straight through that renders
 *   `Checked ` with a trailing space.
 * - AN ACCOUNT THAT STOPPED SYNCING SAYS SO, and being locked out outranks any age: a line reading
 *   `Checked 14 min ago` over an account that has needed a password since then is the failure the
 *   `auth-required` state exists to stop.
 * - A FETCH IN FLIGHT OUTRANKS EVERYTHING, including a stalled account: the age is about to change.
 *
 * The clock is pinned in every case. A relative time graded against `Date.now()` is a test that passes
 * for the wrong reason at 59 seconds and fails at 61.
 */
import { describe, it, expect } from 'vitest';
import type { MailAccountDto, MailboxDto } from '../../web/src/api/mail';
import { syncLineFor, type MailSyncLineInput } from '../../web/src/apps/mail/mail-sync-line';
import {
  DRAFTS_MAILBOX,
  SMART_ACCOUNT,
  SMART_INBOX,
  pairKey,
  type MailFolderFetch,
} from '../../web/src/apps/mail/mail-store';

/** A fixed clock. Nothing in these cases may read the wall time. */
const NOW = Date.UTC(2026, 8, 21, 14, 10, 0);
const MINUTE = 60_000;

const A = 'dense:harbour';
const B = 'dense:marina';
const A_LABEL = 'Harbour mail';
const B_LABEL = 'Marina mail';

function account(accountId: string, displayName: string, extra: Partial<MailAccountDto> = {}): MailAccountDto {
  return {
    accountId,
    providerId: 'dense',
    displayName,
    address: `${accountId.split(':')[1]}@example.invalid`,
    state: 'active',
    unread: 0,
    ...extra,
  };
}

function mailbox(
  accountId: string,
  mailboxId: string,
  role: MailboxDto['role'],
  lastSyncAt?: number,
): MailboxDto {
  return {
    accountId,
    mailboxId,
    name: mailboxId,
    role,
    unread: 0,
    total: 0,
    ...(lastSyncAt === undefined ? {} : { lastSyncAt }),
  };
}

/**
 * The dense install: two accounts, the same roles under different mailbox ids, A polled two minutes ago
 * and B fourteen. A's Archive is deliberately OLDER than its inbox, which is what the non-inbox cadence
 * really looks like.
 */
function dense(): Pick<MailSyncLineInput, 'accounts' | 'mailboxes'> {
  return {
    accounts: [account(A, A_LABEL), account(B, B_LABEL)],
    mailboxes: {
      [A]: [
        mailbox(A, 'INBOX', 'inbox', NOW - 2 * MINUTE),
        mailbox(A, 'Archive', 'archive', NOW - 9 * MINUTE),
        mailbox(A, 'harbour/label/receipts', 'other', NOW - 31 * MINUTE),
      ],
      [B]: [
        mailbox(B, 'inbox', 'inbox', NOW - 14 * MINUTE),
        mailbox(B, 'archive', 'archive', NOW - 47 * MINUTE),
      ],
    },
  };
}

function line(over: Partial<MailSyncLineInput> = {}) {
  return syncLineFor({ ...dense(), selected: null, folderFetch: {}, now: NOW, ...over });
}

function fetchEntry(accountId: string, mailboxId: string, state: MailFolderFetch['state']): Record<string, MailFolderFetch> {
  const key = pairKey(accountId, mailboxId);
  return { [key]: { key, state } };
}

describe('the mail pane sync line', () => {
  it('dates the SELECTED folder and names every account in the title (rule 1)', () => {
    const answer = line({ selected: { accountId: A, mailboxId: 'INBOX' } })!;
    expect(answer.text).toBe('Checked 2 min ago');
    expect(answer.state).toBe('checked');
    expect(answer.at).toBe(NOW - 2 * MINUTE);
    // Absolute first, because a relative age cannot be compared with anything; then one clause per
    // account, because one line cannot say which half of a two account console is stale.
    expect(answer.title).toBe(
      `Last checked ${new Date(NOW - 2 * MINUTE).toLocaleString()}`
      + ` · ${A_LABEL}: 2 min ago · ${B_LABEL}: 14 min ago`,
    );
  });

  it('takes the NEWEST member for a smart row and calls an unfetched member never checked (rule 2)', () => {
    const base = dense();
    const answer = syncLineFor({
      ...base,
      selected: { accountId: SMART_ACCOUNT, mailboxId: SMART_INBOX },
      folderFetch: {},
      now: NOW,
    })!;
    // A's inbox (2 min) over B's (14 min): the merged list on screen is as fresh as its freshest member.
    expect(answer.text).toBe('Checked 2 min ago');
    expect(answer.at).toBe(NOW - 2 * MINUTE);
    expect(answer.title).toBe(
      `Last checked ${new Date(NOW - 2 * MINUTE).toLocaleString()}`
      + ` · ${A_LABEL}: 2 min ago · ${B_LABEL}: 14 min ago`,
    );

    // A member that has never been fetched is LISTED, not skipped and not dated from its sibling.
    const unfetched = syncLineFor({
      ...base,
      mailboxes: { ...base.mailboxes, [B]: [mailbox(B, 'inbox', 'inbox')] },
      selected: { accountId: SMART_ACCOUNT, mailboxId: SMART_INBOX },
      folderFetch: {},
      now: NOW,
    })!;
    expect(unfetched.text).toBe('Checked 2 min ago');
    expect(unfetched.title).toContain(`${B_LABEL}: never checked`);

    // A smart row's detail names its MEMBERS: an account holding no inbox has nothing to say about All
    // Inboxes, so it is absent rather than listed as never checked.
    const oneMember = syncLineFor({
      ...base,
      mailboxes: { ...base.mailboxes, [B]: [mailbox(B, 'archive', 'archive', NOW - 47 * MINUTE)] },
      selected: { accountId: SMART_ACCOUNT, mailboxId: SMART_INBOX },
      folderFetch: {},
      now: NOW,
    })!;
    expect(oneMember.text).toBe('Checked 2 min ago');
    expect(oneMember.title).not.toContain(B_LABEL);
  });

  it('says so when the selected folder has never been fetched (rule 3)', () => {
    const base = dense();
    const answer = syncLineFor({
      ...base,
      mailboxes: { ...base.mailboxes, [A]: [mailbox(A, 'INBOX', 'inbox')] },
      selected: { accountId: A, mailboxId: 'INBOX' },
      folderFetch: {},
      now: NOW,
    })!;
    expect(answer.text).toBe('Not checked yet');
    expect(answer.state).toBe('never');
    expect(answer.at).toBeUndefined();
    expect(answer.title).toContain('Nothing has been checked yet');

    // A timestamp that cannot be parsed is the same answer, never `Checked ` with a trailing space:
    // `timeAgo` returns '' for one, and this is the guard that keeps it out of the sentence.
    for (const broken of [Number.NaN, 0, -1, Number.POSITIVE_INFINITY]) {
      const hostile = syncLineFor({
        ...base,
        mailboxes: { ...base.mailboxes, [A]: [mailbox(A, 'INBOX', 'inbox', broken)] },
        selected: { accountId: A, mailboxId: 'INBOX' },
        folderFetch: {},
        now: NOW,
      })!;
      expect(hostile.text, `lastSyncAt ${String(broken)}`).toBe('Not checked yet');
      expect(hostile.text.endsWith(' ')).toBe(false);
    }
  });

  it('reports a folder off the inbox cadence at its real age (rule 4)', () => {
    // The pane's own honesty rule: `NON_INBOX_EVERY = 5`, so this folder really is nine minutes old and
    // the line must not borrow the inbox's two minutes.
    const answer = line({ selected: { accountId: A, mailboxId: 'Archive' } })!;
    expect(answer.text).toBe('Checked 9 min ago');
    expect(answer.at).toBe(NOW - 9 * MINUTE);

    // Under a minute is `just now`, which is `timeAgo`'s wording and not a rounding of anything older.
    const fresh = line({
      selected: { accountId: A, mailboxId: 'INBOX' },
      now: NOW - 2 * MINUTE + 30_000,
    })!;
    expect(fresh.text).toBe('Checked just now');
  });

  it('asks for a sign-in instead of dating a locked out account (rule 5)', () => {
    const base = dense();
    const locked = {
      ...base,
      accounts: [
        account(A, A_LABEL),
        account(B, B_LABEL, {
          state: 'auth-required',
          health: { state: 'auth-required', checkedAt: NOW - MINUTE },
        }),
      ],
    };
    const answer = syncLineFor({
      ...locked,
      selected: { accountId: B, mailboxId: 'inbox' },
      folderFetch: {},
      now: NOW,
    })!;
    expect(answer.text).toBe('Not syncing · sign in again');
    expect(answer.state).toBe('auth-required');
    // The age is not LOST, it is just not the headline: the title still carries it.
    expect(answer.title).toContain(`${B_LABEL}: 14 min ago (not syncing)`);
    expect(answer.at).toBe(NOW - 14 * MINUTE);

    // A degraded account that is still answering keeps its age and marks the degradation beside it.
    const degraded = syncLineFor({
      ...base,
      accounts: [
        account(A, A_LABEL, { health: { state: 'degraded', checkedAt: NOW - MINUTE } }),
        account(B, B_LABEL),
      ],
      selected: { accountId: A, mailboxId: 'INBOX' },
      folderFetch: {},
      now: NOW,
    })!;
    expect(degraded.text).toBe('Checked 2 min ago · not syncing');
    expect(degraded.state).toBe('degraded');

    // A merged list where only ONE of two members is locked out must not claim the whole thing stopped:
    // the other half is still polling, so the age is real and the mark rides beside it.
    const half = syncLineFor({
      ...locked,
      selected: { accountId: SMART_ACCOUNT, mailboxId: SMART_INBOX },
      folderFetch: {},
      now: NOW,
    })!;
    expect(half.text).toBe('Checked 2 min ago · not syncing');
    expect(half.state).toBe('degraded');
  });

  it('says Checking while a fetch is in flight, and that outranks a stalled account (rule 6)', () => {
    for (const state of ['fetching', 'running'] as const) {
      const answer = line({
        selected: { accountId: A, mailboxId: 'INBOX' },
        folderFetch: fetchEntry(A, 'INBOX', state),
      })!;
      expect(answer.text, state).toBe('Checking…');
      expect(answer.state, state).toBe('fetching');
    }

    // A failed fetch is an ANSWER, not a wait: the pane's strip says what went wrong and this line goes
    // back to dating the folder.
    const failed = line({
      selected: { accountId: A, mailboxId: 'INBOX' },
      folderFetch: fetchEntry(A, 'INBOX', 'failed'),
    })!;
    expect(failed.text).toBe('Checked 2 min ago');

    // Another folder's fetch is not this folder's.
    const elsewhere = line({
      selected: { accountId: A, mailboxId: 'INBOX' },
      folderFetch: fetchEntry(A, 'Archive', 'fetching'),
    })!;
    expect(elsewhere.text).toBe('Checked 2 min ago');

    // A MEMBER of the selected smart row counts, because the merged list is what is being filled.
    const member = line({
      selected: { accountId: SMART_ACCOUNT, mailboxId: SMART_INBOX },
      folderFetch: fetchEntry(B, 'inbox', 'fetching'),
    })!;
    expect(member.text).toBe('Checking…');

    // The mixed case: a stalled account AND a fetch in flight. The fetch wins, because whatever the
    // account's state is, the number the line would print is about to change.
    const mixed = syncLineFor({
      ...dense(),
      accounts: [
        account(A, A_LABEL, {
          state: 'auth-required',
          health: { state: 'auth-required', checkedAt: NOW - MINUTE },
        }),
        account(B, B_LABEL),
      ],
      selected: { accountId: A, mailboxId: 'INBOX' },
      folderFetch: fetchEntry(A, 'INBOX', 'fetching'),
      now: NOW,
    })!;
    expect(mixed.text).toBe('Checking…');
    expect(mixed.state).toBe('fetching');

    // A pane-wide refresh is the same thing said from the other end, which is what makes the line's own
    // click visible rather than a control that looks idle while it works.
    const refreshing = line({ selected: { accountId: A, mailboxId: 'INBOX' }, refreshing: true })!;
    expect(refreshing.text).toBe('Checking…');
    expect(refreshing.state).toBe('fetching');
  });

  it('falls back to the whole mailbox where a folder cannot answer', () => {
    // The virtual Drafts row is Walnut's own and no provider ever syncs it: dating it `Not checked yet`
    // would be a sentence about a folder that has no clock. The account's newest check is the honest
    // answer to "when did Walnut last check".
    const drafts = line({ selected: { accountId: A, mailboxId: DRAFTS_MAILBOX } })!;
    expect(drafts.text).toBe('Checked 2 min ago');

    // A folder list that has not landed yet, and no selection at all, take the same path.
    expect(line({ selected: { accountId: 'dense:gone', mailboxId: 'nowhere' } })!.text)
      .toBe('Checked 2 min ago');
    expect(line({ selected: null })!.text).toBe('Checked 2 min ago');
  });

  it('keeps the title to one fact on a single account install, and says nothing with no accounts', () => {
    const one = syncLineFor({
      accounts: [account(A, A_LABEL)],
      mailboxes: { [A]: [mailbox(A, 'INBOX', 'inbox', NOW - 2 * MINUTE)] },
      selected: { accountId: A, mailboxId: 'INBOX' },
      folderFetch: {},
      now: NOW,
    })!;
    expect(one.text).toBe('Checked 2 min ago');
    // No per-account clause: with one account it would repeat the sentence already on screen.
    expect(one.title).toBe(`Last checked ${new Date(NOW - 2 * MINUTE).toLocaleString()}`);

    // No accounts is no line at all, not an empty sentence with a hairline above it.
    expect(syncLineFor({ accounts: [], mailboxes: {}, selected: null, folderFetch: {}, now: NOW }))
      .toBeNull();
  });

  /**
   * A server clock that runs fast used to make this line read `Checked just now` for ever: `timeAgo`
   * answers 'just now' for any time in the future, so an account that stopped syncing days ago looked
   * like the freshest thing on screen. Jitter is pulled back to now; a real lead is not a time this line
   * can speak about.
   */
  it('does not believe a sync time that is ahead of this reader\'s clock', () => {
    const base = { accounts: [account(A, A_LABEL)], folderFetch: {}, selected: { accountId: A, mailboxId: 'INBOX' } };
    const withLead = (lead: number) => syncLineFor({
      ...base,
      mailboxes: { [A]: [mailbox(A, 'INBOX', 'inbox', NOW + lead)] },
      now: NOW,
    })!;

    // Ordinary two-clock jitter: treated as now, which is what it almost certainly is.
    expect(withLead(5_000).text).toBe('Checked just now');
    expect(withLead(5_000).state).toBe('checked');

    // A day into the future is not jitter. The line refuses to claim an age rather than claiming freshness.
    expect(withLead(24 * 60 * MINUTE).state).toBe('never');
    expect(withLead(24 * 60 * MINUTE).text).toBe('Not checked yet');

    // And a value so far out that it is not a representable date does not reach `toISOString`.
    expect(syncLineFor({
      ...base,
      mailboxes: { [A]: [mailbox(A, 'INBOX', 'inbox', 1e16)] },
      now: NOW,
    })!.title).not.toContain('Invalid Date');
  });

  it('recomputes from the clock alone, with nothing else changed', () => {
    // What the pane's 30 s tick buys: the same snapshot, a later `now`, a later sentence. No request is
    // involved anywhere in this file, which is the point.
    const input = { ...dense(), selected: { accountId: A, mailboxId: 'INBOX' }, folderFetch: {} };
    expect(syncLineFor({ ...input, now: NOW - 2 * MINUTE + 1_000 })!.text).toBe('Checked just now');
    expect(syncLineFor({ ...input, now: NOW - 2 * MINUTE + 90_000 })!.text).toBe('Checked 1 min ago');
    expect(syncLineFor({ ...input, now: NOW + 58 * MINUTE })!.text).toBe('Checked 1 h ago');
    expect(syncLineFor({ ...input, now: NOW + 26 * 60 * MINUTE })!.text).toBe('Checked yesterday');
  });
});
