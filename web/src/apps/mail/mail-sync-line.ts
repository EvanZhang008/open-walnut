/**
 * The folder pane's last line: when this console last heard from the mail it is showing.
 *
 * Pure on purpose. Every rule below was decided as a sentence first, and a sentence is only gradable
 * away from React: the pane hands in a snapshot and a clock, this hands back the text, the `title` and
 * one state word, and the component does nothing but print them.
 *
 * Four rules it encodes, each of them a way the line could lie:
 *
 * - IT SPEAKS FOR THE SELECTION, not for the mailbox as a whole. A folder off the inbox cadence is
 *   polled once every five ticks (`NON_INBOX_EVERY`), so a line reading the newest check anywhere would
 *   say "just now" over a list that is nine minutes old. A smart row is the other way round: it stands
 *   for several folders, so it takes the NEWEST of its members, which is the freshest thing the merged
 *   list on screen can claim.
 * - NOTHING IS ROUNDED UP. `timeAgo` decides the words, and a folder nobody has ever fetched says so
 *   (`Not checked yet`) rather than borrowing another folder's clock.
 * - AN ACCOUNT THAT STOPPED SYNCING SAYS SO. Reusing `accountsNotSyncing` rather than re-deriving it,
 *   because the merged list header already prints that same fact and two derivations drift.
 * - A FETCH IN FLIGHT OUTRANKS EVERY AGE. While the folder is being fetched the age is about to change,
 *   so the line says `Checking…` and waits.
 *
 * The `title` carries what one line cannot: the absolute local time, and one clause per account. The
 * per-account clauses only appear when there are two or more accounts, because with one they repeat the
 * sentence that is already on screen.
 */
import type { MailAccountDto, MailboxDto } from '@/api/mail';
import { timeAgo } from '@/utils/time';
import { accountsNotSyncing, smartPairs } from './mail-smart';
import {
  SMART_ROLE,
  isSmartSelection,
  pairKey,
  type MailFolderFetch,
  type MailSelection,
  type SmartMailboxId,
} from './mail-store';

/**
 * What the line is saying, as one word, mirrored onto the element as `data-state`.
 *
 * `auth-required` is the only one that asks the human for something, which is why it outranks a real
 * age: a line reading `Checked 14 min ago` over an account that has been locked out since then is the
 * failure this state exists to stop.
 */
export type MailSyncState = 'checked' | 'never' | 'fetching' | 'auth-required' | 'degraded';

/**
 * How far ahead of this reader's clock a `lastSyncAt` may be and still be believed.
 *
 * Two clocks are involved (the browser's and whichever host wrote the row) and they do drift by a second
 * or two. Past this the value is not jitter, and `timeAgo` would read it as 'just now' for ever.
 */
const MAX_CLOCK_LEAD_MS = 60_000;

export interface MailSyncLine {
  /** One short sentence. Never ends in a space, never carries a bare number. */
  text: string;
  title: string;
  state: MailSyncState;
  /** The instant `text` is about, when there is one. Epoch ms, for a test to pin. */
  at?: number;
}

export interface MailSyncLineInput {
  selected: MailSelection | null;
  accounts: MailAccountDto[];
  mailboxes: Record<string, MailboxDto[]>;
  folderFetch: Record<string, MailFolderFetch>;
  /**
   * A pane-wide refresh is on the wire (`snapshot.refreshing`).
   *
   * Counted as a fetch for the same reason a folder's own fetch is: the age is about to change. It is
   * also what makes the line's click visible, since clicking it starts exactly that refresh.
   */
  refreshing?: boolean;
  /** Reference clock (ms since epoch). The pane re-renders every 30 s and passes `Date.now()`. */
  now: number;
}

type Pair = { accountId: string; mailboxId: string };

/**
 * Which folders the line speaks for, and whose accounts they are.
 *
 * `smart` is kept because it decides the `title`'s scope: a merged row's detail names its MEMBER
 * accounts (an account with no inbox has nothing to say about All Inboxes), while an ordinary folder's
 * detail names every account, which is the one place this line answers "and the others?".
 */
interface SyncScope {
  pairs: Pair[];
  accounts: MailAccountDto[];
  smart: boolean;
}

function scopeFor(input: MailSyncLineInput): SyncScope {
  const { selected, accounts, mailboxes } = input;
  const everything: SyncScope = {
    pairs: accounts.flatMap((account) => (
      (mailboxes[account.accountId] ?? []).map((row) => ({
        accountId: account.accountId, mailboxId: row.mailboxId,
      }))
    )),
    accounts,
    smart: false,
  };
  if (!selected) return everything;
  if (isSmartSelection(selected)) {
    const role = SMART_ROLE[selected.mailboxId as SmartMailboxId];
    const pairs = role ? smartPairs(mailboxes, accounts, role) : [];
    if (pairs.length === 0) return everything;
    const members = new Set(pairs.map((pair) => pair.accountId));
    return { pairs, accounts: accounts.filter((one) => members.has(one.accountId)), smart: true };
  }
  const account = accounts.find((one) => one.accountId === selected.accountId);
  const row = (mailboxes[selected.accountId] ?? []).find((one) => one.mailboxId === selected.mailboxId);
  // No row is NOT "never checked": the virtual Drafts row is Walnut's own and the provider never syncs
  // it, and a folder list that has not landed yet has no row either. Both fall back to the whole
  // mailbox, which is the honest answer to "when did Walnut last check".
  if (!account || !row) return everything;
  return { pairs: [{ accountId: account.accountId, mailboxId: row.mailboxId }], accounts: [account], smart: false };
}

/**
 * The newest real `lastSyncAt` among these rows, or undefined when none of them has one.
 *
 * A timestamp AHEAD of the reader's clock is not usable, and it cannot simply be printed: `timeAgo`
 * answers 'just now' for anything in the future, so a server whose clock runs fast (a VM without NTP, a
 * remote host's daemon) would make this line read `Checked just now` for ever, about an account that
 * stopped syncing days ago. A small lead is ordinary clock jitter and is pulled back to now; a large one
 * is not a time this line can speak about, and saying nothing is the honest answer. The same bound
 * discards a value so far out that `new Date(at)` is unrepresentable.
 */
function newestSyncAt(rows: MailboxDto[], now: number): number | undefined {
  let best: number | undefined;
  for (const row of rows) {
    const at = row.lastSyncAt;
    if (typeof at !== 'number' || !Number.isFinite(at) || at <= 0) continue;
    if (at > now + MAX_CLOCK_LEAD_MS) continue;
    const usable = Math.min(at, now);
    if (best === undefined || usable > best) best = usable;
  }
  return best;
}

/**
 * The relative words, or '' when there is nothing to say.
 *
 * `timeAgo` answers '' for a date it cannot parse, and every caller here treats that exactly like an
 * absent timestamp: printed straight through it would render `Checked ` with a trailing space.
 */
function agoOf(at: number | undefined, now: number): string {
  if (at === undefined) return '';
  const date = new Date(at);
  if (Number.isNaN(date.getTime())) return '';
  return timeAgo(date.toISOString(), { long: true, now });
}

function rowsOf(mailboxes: Record<string, MailboxDto[]>, pairs: Pair[]): MailboxDto[] {
  const byKey = new Map<string, MailboxDto>();
  for (const [accountId, rows] of Object.entries(mailboxes)) {
    for (const row of rows) byKey.set(pairKey(accountId, row.mailboxId), row);
  }
  const found: MailboxDto[] = [];
  for (const pair of pairs) {
    const row = byKey.get(pairKey(pair.accountId, pair.mailboxId));
    if (row) found.push(row);
  }
  return found;
}

function accountLabel(account: MailAccountDto): string {
  return account.displayName || account.address;
}

function needsSignIn(account: MailAccountDto): boolean {
  return account.state === 'auth-required' || account.health?.state === 'auth-required';
}

/** Whether a fetch this console started is still running for any of these folders. */
function fetching(folderFetch: Record<string, MailFolderFetch>, keys: string[]): boolean {
  return keys.some((key) => {
    const entry = folderFetch[key];
    return !!entry && (entry.state === 'fetching' || entry.state === 'running');
  });
}

export function syncLineFor(input: MailSyncLineInput): MailSyncLine | null {
  if (input.accounts.length === 0) return null;
  const scope = scopeFor(input);
  const at = newestSyncAt(rowsOf(input.mailboxes, scope.pairs), input.now);
  const ago = agoOf(at, input.now);
  const base = ago ? `Checked ${ago}` : 'Not checked yet';

  // A smart row's own reserved pair can carry a fetch entry, and so can each member row: the merged
  // list is being filled either way, so both count.
  const watched = [
    ...(input.selected ? [pairKey(input.selected.accountId, input.selected.mailboxId)] : []),
    ...scope.pairs.map((pair) => pairKey(pair.accountId, pair.mailboxId)),
  ];
  const stalled = accountsNotSyncing(scope.accounts);
  const lockedOut = scope.accounts.filter(needsSignIn);

  let state: MailSyncState;
  let text: string;
  if (input.refreshing === true || fetching(input.folderFetch, watched)) {
    state = 'fetching';
    text = 'Checking…';
  } else if (lockedOut.length > 0 && lockedOut.length === scope.accounts.length) {
    // Every account behind this list is locked out, so there is nothing to date and one thing to do.
    state = 'auth-required';
    text = 'Not syncing · sign in again';
  } else if (stalled.length > 0) {
    // Some of them are still polling, so the age is real and the degradation rides beside it.
    state = 'degraded';
    text = `${base} · not syncing`;
  } else {
    state = ago ? 'checked' : 'never';
    text = base;
  }

  return { text, title: titleFor(input, scope, at), state, ...(at === undefined ? {} : { at }) };
}

/**
 * The hover text: the absolute local instant, then one clause per account.
 *
 * Absolute because a relative age cannot be compared with anything (a person checking whether a poll
 * ran before or after they sent something needs the clock), and per-account because a merged list's one
 * line cannot say which half of it is stale.
 */
function titleFor(input: MailSyncLineInput, scope: SyncScope, at: number | undefined): string {
  const head = at === undefined
    ? 'Nothing has been checked yet'
    : `Last checked ${new Date(at).toLocaleString()}`;
  const detailAccounts = scope.smart ? scope.accounts : input.accounts;
  if (detailAccounts.length < 2) return head;
  const clauses = detailAccounts.map((account) => {
    const pairs = scope.smart
      ? scope.pairs.filter((pair) => pair.accountId === account.accountId)
      : (input.mailboxes[account.accountId] ?? []).map((row) => ({
        accountId: account.accountId, mailboxId: row.mailboxId,
      }));
    const ago = agoOf(newestSyncAt(rowsOf(input.mailboxes, pairs), input.now), input.now);
    const age = ago || 'never checked';
    // Parenthesised rather than another ` · ` clause: the separator already joins the accounts, so a
    // third one inside a clause would read as a fourth account. `accountsNotSyncing` covers the
    // locked-out case too (it is the wider of the two conditions), so this is one check, not two.
    const mark = accountsNotSyncing([account]).length > 0 ? ' (not syncing)' : '';
    return `${accountLabel(account)}: ${age}${mark}`;
  });
  return [head, ...clauses].join(' · ');
}
