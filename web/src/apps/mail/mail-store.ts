/**
 * ONE in-browser truth for the mail console: accounts, their mailboxes, the open page, the open
 * message, and the sidebar badge. This file is the CONTAINER; `mail-actions.ts` holds everything
 * that fetches and then patches.
 *
 * A store rather than component state, for the reasons the calendar store exists: the console has
 * three panes that all read the same records, the WS pushes changes nobody asked for, and the
 * sidebar badge has to keep working while the pane that fetched the numbers is unmounted.
 *
 * The one rule this half enforces is ONE REQUEST PER KEY. Opening the console asks for the same
 * page from three places in the same frame (the mount effect, the mailbox selection, the first
 * `sync-completed`), and a mail page is the most expensive read here. `run()` shares the in-flight
 * promise and, when a caller wanted FRESH data mid-flight, queues exactly one refetch behind it
 * instead of racing.
 *
 * Deliberately React-free and WS-free: `useMailConsole` adapts it with `useSyncExternalStore` and
 * feeds it bus events. That is also what lets the node test tier drive it.
 */
import { mailFailure, type MailAccountDto, type MailBodyDto, type MailMessageDto, type MailProviderSummary, type MailboxDto } from '@/api/mail';

/** One page of the list. The plugin caps a request at 200. */
export const PAGE_SIZE = 50;

export const SEEN = '\\Seen';

export interface MailStand {
  title: string;
  detail: string;
  /** Whether trying again could change the answer. A replica's refusal never will. */
  retryable: boolean;
}

export interface MailSelection {
  accountId: string;
  mailboxId: string;
}

export interface MailOpenMessage {
  accountId: string;
  messageId: string;
  message: MailMessageDto | null;
  body: MailBodyDto | null;
  /** A body the provider could not hand over. The envelope above is still real. */
  bodyError: string | null;
  loading: boolean;
  error: string | null;
  /** Per MESSAGE, never remembered: the human opted this one body into remote images. */
  allowRemoteImages: boolean;
}

export interface MailSearchState {
  query: string;
  /** True while the middle pane shows results instead of the mailbox. */
  active: boolean;
  loading: boolean;
  source: 'provider' | 'cache' | null;
  messages: MailMessageDto[];
  error: string | null;
}

export interface MailSnapshot {
  loading: boolean;
  /** The first accounts+providers answer landed. `[]` is an answer. */
  loaded: boolean;
  /** An expected 503 the console explains in words. */
  stand: MailStand | null;
  error: string | null;
  providers: MailProviderSummary[];
  accounts: MailAccountDto[];
  mailboxes: Record<string, MailboxDto[]>;
  selected: MailSelection | null;
  messages: MailMessageDto[];
  nextBefore: number | null;
  listLoading: boolean;
  olderLoading: boolean;
  listError: string | null;
  search: MailSearchState;
  open: MailOpenMessage | null;
  refreshing: boolean;
  /** What a 202 refresh left behind: a sentence, not an error. */
  refreshNote: string | null;
}

export const EMPTY_SEARCH: MailSearchState = {
  query: '', active: false, loading: false, source: null, messages: [], error: null,
};

function initialState(): MailSnapshot {
  return {
    loading: false,
    loaded: false,
    stand: null,
    error: null,
    providers: [],
    accounts: [],
    mailboxes: {},
    selected: null,
    messages: [],
    nextBefore: null,
    listLoading: false,
    olderLoading: false,
    listError: null,
    search: EMPTY_SEARCH,
    open: null,
    refreshing: false,
    refreshNote: null,
  };
}

/**
 * The mutable half, in one object so `mail-actions.ts` can reach it without a live binding.
 *
 * `state` is replaced wholesale by `patch` (never mutated in place), which is what makes
 * `useSyncExternalStore` see a change. The other two are bookkeeping no pane renders.
 */
export const store: {
  state: MailSnapshot;
  /** Bumped on every open, so a slow read cannot land on a message the human moved off. */
  openSeq: number;
  /** The account whose inbox should win the next automatic selection (a just-added account). */
  preferAccount: string | null;
  /** Whose sync the "still syncing" note is about, so the right event can clear it. */
  refreshNoteAccount: string | null;
} = { state: initialState(), openSeq: 0, preferAccount: null, refreshNoteAccount: null };

const listeners = new Set<() => void>();
const inflight = new Map<string, Promise<void>>();
const wants = new Set<string>();

export interface MailBadgeHandle {
  setBadge(value: number | null): void;
}

let badge: MailBadgeHandle | null = null;

export function subscribeMail(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

export function getMailSnapshot(): MailSnapshot {
  return store.state;
}

export function patch(next: Partial<MailSnapshot>): void {
  store.state = { ...store.state, ...next };
  for (const listener of [...listeners]) listener();
}

/**
 * Both 503s this plugin answers are EXPECTED, so they get sentences rather than error text.
 *
 * `primary_only` is the normal reading on a cloud replica: the plugin is active there (so the
 * sidebar row shows), and it refuses every route on purpose, because two boxes polling one
 * mailbox double every fetch and every write. `db_unavailable` is the cache still opening.
 */
export function standIn(error: unknown): MailStand | null {
  const failure = mailFailure(error);
  if (failure.status !== 503) return null;
  if (failure.code === 'primary_only') {
    return {
      title: 'Mail runs on your primary Walnut box',
      detail: 'This is a cloud companion, and it stays out of the mailbox so nothing gets fetched'
        + ' or sent twice. Open Mail on your primary box.',
      // Retrying here can only ever get the same refusal, so the console does not offer it.
      retryable: false,
    };
  }
  if (failure.code === 'db_unavailable') {
    return {
      title: 'The mail cache is not answering yet',
      detail: 'It opens on first use and retries by itself, and you can ask again now.',
      retryable: true,
    };
  }
  return null;
}

/**
 * One request per key.
 *
 * `force` from a caller that arrives mid-flight queues exactly ONE more pass, so a live event
 * during a page load still ends with fresh data and never with two overlapping fetches.
 * `work` must handle its own failures: a throw here would skip the queued pass.
 */
export function run(key: string, work: () => Promise<void>, force = false): Promise<void> {
  const running = inflight.get(key);
  if (running) {
    if (force) wants.add(key);
    return running;
  }
  const promise = (async () => {
    try {
      do {
        wants.delete(key);
        await work();
      } while (wants.has(key));
    } finally {
      inflight.delete(key);
      wants.delete(key);
    }
  })();
  inflight.set(key, promise);
  return promise;
}

/**
 * A coalescer key for a pair of ids.
 *
 * JSON rather than a joining character: an id is a provider's string and may contain anything, so
 * `a:b` + `c` and `a` + `b:c` have to stay two keys. It also keeps the source plain ASCII, which a
 * separator byte did not: one raw control character makes the whole file read as binary to grep.
 */
export function pairKey(first: string, second: string): string {
  return JSON.stringify([first, second]);
}

export function selectionKey(selection: MailSelection): string {
  return pairKey(selection.accountId, selection.mailboxId);
}

export function sameSelection(selection: MailSelection | null): boolean {
  const selected = store.state.selected;
  return !!selection && !!selected && selectionKey(selected) === selectionKey(selection);
}

/**
 * The sidebar badge: unread in the INBOXES, not unread everywhere.
 *
 * An account's `unread` is the sum over all its mailboxes, so it counts Spam, Trash and Archive.
 * A badge fed from that says "12" for a mailbox whose inbox is empty, which trains the human to
 * ignore it. Per-mailbox numbers are what the pane already loads, so the inbox rows are the
 * source; an account whose mailboxes are not loaded yet falls back to its own total, because
 * counting it as zero would blank a badge that is genuinely not zero.
 *
 * Rounded because these are provider-declared numbers: one non-integer would render as "3.0001".
 */
export function publishBadge(): void {
  const state = store.state;
  let total = 0;
  for (const account of state.accounts) {
    const mailboxes = state.mailboxes[account.accountId];
    total += mailboxes
      ? mailboxes.reduce((sum, mailbox) => sum + (mailbox.role === 'inbox' ? mailbox.unread || 0 : 0), 0)
      : account.unread || 0;
  }
  const unread = Math.round(total);
  badge?.setBadge(unread > 0 ? unread : null);
}

/** Set by `mail-live.ts`, which owns the registry handle and the live wiring around it. */
export function setMailBadgeHandle(handle: MailBadgeHandle): void {
  badge = handle;
  publishBadge();
}

/**
 * Tests only: forget everything, including the badge handle.
 *
 * The LISTENERS are deliberately left alone: they belong to whoever subscribed (a mounted
 * `useSyncExternalStore`), not to the data, and clearing them leaves a live component wired to a
 * store that can never notify it again.
 */
export function __resetMailStore(): void {
  store.state = initialState();
  store.openSeq = 0;
  store.preferAccount = null;
  store.refreshNoteAccount = null;
  inflight.clear();
  wants.clear();
  badge = null;
  for (const listener of [...listeners]) listener();
}
