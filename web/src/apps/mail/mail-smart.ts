/**
 * The arithmetic behind the smart rows and the collapsed folder tail. Pure: no React, no fetch.
 *
 * Every number the sidebar shows is derived HERE and from the same mailbox rows the message list
 * header reads, which is the only reason the two cannot disagree. Nothing in this file rounds a total
 * to "9k" or estimates: the rows carry provider-declared counts, so a per-row `Math.round` is the
 * whole of the arithmetic (one non-integer would otherwise render as "3.0001").
 */
import type { MailAccountDto, MailboxDto, MailDraftDto, MailProviderSummary } from '@/api/mail';

import { canSendFrom } from './compose/send-status';
import { formatCount } from './mail-format';
import { pairKey } from './mail-store';

export type SmartRole = 'inbox' | 'sent' | 'drafts';

/**
 * The one place a smart row is NAMED. The sidebar row and the message list's own header both read it,
 * for the same reason the counts are derived here: two literal copies of "All Inboxes" can drift, and
 * a person who clicks a row named one thing and lands under a header named another has been lied to.
 */
export const SMART_LABEL: Record<SmartRole, string> = {
  inbox: 'All Inboxes',
  sent: 'All Sent',
  drafts: 'All Drafts',
};

/** At most three folders are ever lifted out of the tail, and at most three are remembered. */
export const PROMOTED_CAP = 3;
export const RECENT_CAP = 3;

/**
 * The (account, mailbox) pairs one smart row covers, in account order.
 *
 * PAIRS, not mailbox ids: the same role has a different id in every account (two providers here
 * answer `INBOX` and `inbox` for the same folder), so a bare id list both misses rows and collides
 * across accounts. This is the same shape the server's `scope` resolves to, and it is what decides
 * whether a sync event belongs to the list on screen.
 *
 * Driven by `accounts` rather than by the keys of `mailboxes`, so a folder list left behind by an
 * account that has been deleted can never put its mail back into a merged page.
 */
export function smartPairs(
  mailboxes: Record<string, MailboxDto[]>,
  accounts: MailAccountDto[],
  role: SmartRole,
): Array<{ accountId: string; mailboxId: string }> {
  const pairs: Array<{ accountId: string; mailboxId: string }> = [];
  for (const account of accounts) {
    for (const row of mailboxes[account.accountId] ?? []) {
      if (row.role === role) pairs.push({ accountId: account.accountId, mailboxId: row.mailboxId });
    }
  }
  return pairs;
}

/**
 * Whether a smart row is worth showing at all.
 *
 * Two accounts is the whole condition: with one, "All Inboxes" is a second copy of that account's own
 * inbox row, and a duplicate entry is worse than no entry. An account parked in `auth-required` or
 * `disabled` still COUNTS, because its cached mail is real and still belongs in the merged list; the
 * row marks the degradation instead of dropping the account.
 *
 * Drafts is decided by the account count and not by folders, because the Drafts row is Walnut's own:
 * every account has one whether or not the provider keeps a Drafts folder.
 */
export function smartRowVisible(
  mailboxes: Record<string, MailboxDto[]>,
  accounts: MailAccountDto[],
  role: SmartRole,
): boolean {
  if (accounts.length < 2) return false;
  if (role === 'drafts') return true;
  let holders = 0;
  for (const account of accounts) {
    if ((mailboxes[account.accountId] ?? []).some((row) => row.role === role)) holders += 1;
  }
  return holders >= 2;
}

/** Exact sum of the unread the mailbox rows of this role declare. Never capped, never abbreviated. */
export function smartUnread(mailboxes: Record<string, MailboxDto[]>, role: SmartRole): number {
  return sumRole(mailboxes, role, (row) => row.unread);
}

export function smartTotal(mailboxes: Record<string, MailboxDto[]>, role: SmartRole): number {
  return sumRole(mailboxes, role, (row) => row.total);
}

function sumRole(
  mailboxes: Record<string, MailboxDto[]>,
  role: SmartRole,
  of: (row: MailboxDto) => number,
): number {
  let total = 0;
  for (const rows of Object.values(mailboxes)) {
    for (const row of rows) {
      if (row.role === role) total += Math.round(of(row) || 0);
    }
  }
  return total;
}

/**
 * The number on a Drafts row: the drafts WRITTEN HERE, which is the first section of the view it opens.
 *
 * It counted the provider's Drafts folder too, using the folder size the mailbox row declares. That is a
 * number nobody can check: the cache holds only what is inside the retention window, so a badge reading
 * 51 sat over a view whose sections could account for 8, and the merged row summed two such badges into
 * the worst version of it (51 printed a row above the words "No drafts."). The badge is now exactly what
 * the first section lists, which a person can verify by counting rows; the provider's folders are still
 * listed under their own headings, and the view's header still counts every row under it (`sectionOf`).
 */
export function draftsRowCount(local: MailDraftDto[] | undefined): number {
  return local?.length ?? 0;
}

/** The same number over every account, which is what the All Drafts row's badge prints. */
export function draftsTotalCount(
  drafts: Record<string, MailDraftDto[]>,
  accounts: MailAccountDto[],
): number {
  let total = 0;
  for (const account of accounts) total += draftsRowCount(drafts[account.accountId]);
  return total;
}

/**
 * The role rows keep the SERVER's order, which is this account's own order.
 *
 * A previous pass sorted them into one canonical role sequence so two accounts would read alike. That
 * re-ordered the rows of EVERY install, including the single account one this slice promised to leave
 * DOM-identical, and it is not the sidebar's business to disagree with the list the server gave for an
 * account. Two accounts are made scannable by the role glyph each row already carries, not by moving
 * rows. This function stays as the ONE place that decision is written down, so it cannot drift back in.
 */
export function roleRowsInServerOrder(rows: MailboxDto[]): MailboxDto[] {
  return rows;
}

/**
 * What the collapse row is standing over: how many folders hold unread, and how much unread mail.
 *
 * The row's clause prints the FOLDERS and says so in words (`6 with unread`). `6 unread` was worse than
 * the ambiguity it was trying to avoid: on this machine the row stood over 202 unread messages and
 * printed 6, one thirty-third of it, with no unit. The mail count is still returned: it names its unit in
 * the hover text, and it is what the property test checks the row can never hide.
 */
export function hiddenTail(
  accountId: string,
  hidden: MailboxDto[],
  live: Record<string, MailboxDto>,
): { folders: number; unread: number } {
  let folders = 0;
  let unread = 0;
  for (const row of hidden) {
    const now = live[pairKey(accountId, row.mailboxId)] ?? row;
    const count = Math.max(0, Math.round(now.unread || 0));
    if (count > 0) { folders += 1; unread += count; }
  }
  return { folders, unread };
}

/**
 * Opening a folder ENDS its arrival.
 *
 * The `New` mark on a promoted row means "mail arrived here this session and nobody has looked". It used
 * to be cleared only by remounting Mail, so it vanished while the row was selected and came straight back
 * the moment the person moved to the next folder, saying New about mail they had just read. Returns the
 * SAME object when the pair never had an arrival, so a selection cannot cost a render for nothing.
 */
export function arrivalsAfterOpen(
  arrivals: Record<string, number>,
  key: string,
): Record<string, number> {
  if (!(key in arrivals)) return arrivals;
  const next = { ...arrivals };
  delete next[key];
  return next;
}

export const TAIL_TITLE_COLLAPSED = 'Folders you have not opened lately. Anything that just received mail is above this line.';
export const TAIL_TITLE_EXPANDED = 'Hide the folders you have not opened lately.';

/**
 * The collapse row's words. Pure, because every one of them was got wrong once and each is now pinned.
 *
 * `more` stays in both cases: this account has 64 folders and six are drawn above the line, so `58
 * folders` printed a remainder as if it were a total. The second clause NAMES ITS UNIT (`6 with unread`),
 * because a bare `6 unread` beside a first clause counting folders is read as six unread messages while
 * the row in fact stands over 202 of them.
 */
export function tailLabel(hidden: number, expanded: boolean): string {
  if (expanded) return 'Show fewer folders';
  return `${formatCount(hidden)} more folder${Math.round(hidden) === 1 ? '' : 's'}`;
}

/** How many of the hidden folders hold unread mail. Null when none do: no clause at all, not a zero. */
export function tailClause(unreadFolders: number, expanded = false): string | null {
  if (expanded || unreadFolders <= 0) return null;
  return `${formatCount(unreadFolders)} with unread`;
}

export function tailTitle(expanded: boolean, behind: { folders: number; unread: number }): string {
  if (expanded) return TAIL_TITLE_EXPANDED;
  if (behind.folders <= 0) return TAIL_TITLE_COLLAPSED;
  const mail = `${formatCount(behind.unread)} message${Math.round(behind.unread) === 1 ? '' : 's'}`;
  const hold = behind.folders === 1 ? 'holds' : 'hold';
  return `${TAIL_TITLE_COLLAPSED} ${behind.folders} of them ${hold} unread mail (${mail}).`;
}

/**
 * What a folder row is CALLED: the provider's own name, always.
 *
 * A previous pass printed a canonical role name instead (`Archive` over a folder the provider calls
 * something else, `Junk` over `Spam`), which left the real name reachable only on hover, unsearchable by
 * the tail filter, and gave two folders of one role the same label with nothing on screen to tell them
 * apart. The role is already on the row as its glyph, which is a mark and not a rename.
 */
export function folderLabel(mailbox: MailboxDto): string {
  return mailbox.name;
}

/** The role this folder plays, on hover, and only where the provider's name does not already say it. */
const ROLE_NAME: Partial<Record<MailboxDto['role'], string>> = {
  inbox: 'Inbox',
  sent: 'Sent',
  drafts: 'Drafts',
  archive: 'Archive',
  trash: 'Trash',
  spam: 'Junk',
};

export function folderTitle(mailbox: MailboxDto): string | undefined {
  const role = ROLE_NAME[mailbox.role];
  if (!role) return undefined;
  return role.toLocaleLowerCase() === mailbox.name.toLocaleLowerCase() ? undefined : role;
}

/**
 * The accounts a merged list covers that have stopped polling.
 *
 * BOTH signals, because they are written at different times: `state` is what a failed poll parks the
 * account as, while `health` is what the last check said. An account whose health answers
 * `auth-required` is not syncing yet its row can still read `active` (nothing has failed since), and a
 * merged list that quietly leaves that account out of date is the failure this mark exists for.
 */
export function accountsNotSyncing(covered: MailAccountDto[]): MailAccountDto[] {
  return covered.filter((one) => (
    one.state !== 'active' || (one.health !== undefined && one.health.state !== 'ok')
  ));
}

/** The sentence under the list header. On screen, because a title attribute never renders. */
export function degradedLine(stopped: number): string | null {
  if (stopped <= 0) return null;
  return stopped === 1 ? '1 account is not syncing.' : `${formatWhole(stopped)} accounts are not syncing.`;
}

/** The same fact as the smart row's hover text, which also says how many accounts the row covers. */
export function degradedTitle(stopped: number, covered: number): string | null {
  if (stopped <= 0) return null;
  return `${formatWhole(stopped)} of ${formatWhole(covered)} accounts ${stopped === 1 ? 'is' : 'are'} not syncing`;
}

function formatWhole(value: number): string {
  return String(Math.max(0, Math.round(value)));
}

export interface ImportantFolders {
  /** Every row that is not an ordinary label, in SERVER order. The Drafts row is spliced by the pane. */
  shown: MailboxDto[];
  /** Ordinary labels lifted above the collapse row, in server order, at most `PROMOTED_CAP`. */
  promoted: MailboxDto[];
  /** What the collapse row stands for. Expanded, this is the whole tail in server order. */
  hidden: MailboxDto[];
}

export interface ImportantFoldersOpts {
  /** This session's arrival counts, keyed by `pairKey(accountId, mailboxId)`. */
  arrivals: Record<string, number>;
  /** The selected mailbox of THIS account, when one is selected. */
  selectedMailboxId?: string | null;
  /** Ordinary labels this person opened lately, newest first. */
  recent?: string[];
  expanded?: boolean;
}

/**
 * Which of one account's folders stay in view, and which the collapse row stands for.
 *
 * Three reasons lift an ordinary label out of the tail, and the FIRST of them is the load-bearing one:
 * mail that arrived during this session (`added > 0` from a sync event). Not `unread > 0`: on this
 * machine six of one account's 58 labels hold stale unread from archived lists, so an unread rule
 * collapses to nothing useful and answers "keep only the important ones" with six rows of months-old
 * noise. The other two reasons are the row the person is looking at (a selection must never be hidden
 * by its own collapse row) and the last few labels they opened.
 *
 * Promoted rows sit together directly above the collapse row rather than in their alphabetical places:
 * the role rows keep the order the person has memorised, and a promotion cannot make the list reshuffle
 * every time a folder receives mail.
 *
 * Expanded is ONE list: every ordinary label once, in server order, with nothing promoted. A promotion
 * block left in the expanded list would punch holes in 58 alphabetical rows, so somebody scanning for a
 * name would look where it belongs and not find it.
 */
export function importantFolders(
  mailboxes: Record<string, MailboxDto[]>,
  accountId: string,
  opts: ImportantFoldersOpts,
): ImportantFolders {
  const rows = mailboxes[accountId] ?? [];
  // The SERVER's order, untouched (see `roleRowsInServerOrder`): this list is the account's own.
  const shown = roleRowsInServerOrder(rows.filter((row) => row.role !== 'other'));
  const tail = rows.filter((row) => row.role === 'other');
  if (opts.expanded) return { shown, promoted: [], hidden: tail };
  const recent = new Set((opts.recent ?? []).slice(0, RECENT_CAP));
  const wanted = tail.filter((row) => (
    (opts.arrivals[pairKey(accountId, row.mailboxId)] ?? 0) > 0
    || row.mailboxId === opts.selectedMailboxId
    || recent.has(row.mailboxId)
  ));
  // Capped in SERVER order, so which three survive does not depend on why each was wanted: the tail is
  // already ordered, and cutting by "reason" would move rows around between ticks.
  const promoted = wanted.slice(0, PROMOTED_CAP);
  const lifted = new Set(promoted.map((row) => row.mailboxId));
  return { shown, promoted, hidden: tail.filter((row) => !lifted.has(row.mailboxId)) };
}

/**
 * Which account a compose started from a smart row belongs to.
 *
 * The reserved smart account id can never send, and reading it as the compose identity turns the pane's
 * primary button grey in what is now the default view, under a sentence about an account that does not
 * exist. So the identity is resolved to a real, sendable account: the one most recently used when it can
 * still send, otherwise the first that can. Null means no account can send, which is the only case where
 * the button is honestly disabled.
 */
export function sendableAccountFor(
  accounts: MailAccountDto[],
  providers: MailProviderSummary[],
  recent?: string[],
): string | null {
  for (const accountId of recent ?? []) {
    if (accounts.some((one) => one.accountId === accountId) && canSendFrom(providers, accountId, accounts)) {
      return accountId;
    }
  }
  return accounts.find((one) => canSendFrom(providers, one.accountId, accounts))?.accountId ?? null;
}
