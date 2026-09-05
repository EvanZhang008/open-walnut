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
import { mailFailure, type MailAccountDto, type MailBodyDto, type MailDraftDto, type MailMessageDto, type MailProviderSummary, type MailboxDto } from '@/api/mail';
import type { AddressChip } from './compose/mail-address';
import type { SendStatus } from './compose/send-status';

/** One page of the list. The plugin caps a request at 200. */
export const PAGE_SIZE = 50;

export const SEEN = '\\Seen';

/**
 * The mailbox id of the virtual Drafts row.
 *
 * A sentinel inside the existing selection, rather than a second selection concept: the panes, the
 * narrow-viewport drill and the "which account am I in" question all already read `selected`, and a
 * parallel `viewingDrafts` flag would have to be threaded through every one of them. No provider
 * can collide with it (the leading underscores are not an IMAP mailbox name we would ever get, and
 * `ensureSelection` only ever auto-picks a mailbox it found in a provider's own list).
 */
export const DRAFTS_MAILBOX = '__walnut_drafts__';

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

/**
 * How the footer describes the autosave.
 *
 * `retrying` is the only one that asks for patience, and `blocked` is the only one the HUMAN has to
 * clear (a recipient the server would refuse): a draft is never written with an address that cannot
 * be sent to, because a saved-and-silently-dropped recipient is how a mail reaches three of the
 * four people it was addressed to.
 */
export type MailSaveState = 'clean' | 'saving' | 'saved' | 'retrying' | 'failed' | 'blocked';

/**
 * What the human has typed, chip by chip.
 *
 * The text lives in the STORE rather than in the panel's own state, and that is deliberate: the
 * autosave has to be able to flush the current value from outside React (a send button flushes
 * before it asks anybody to approve anything), and the panel unmounts on a narrow-viewport drill.
 * One truth means neither of those can save a version of the text nobody was looking at.
 */
export interface MailComposerFields {
  to: AddressChip[];
  cc: AddressChip[];
  bcc: AddressChip[];
  subject: string;
  /** The typed body only. The reply quote is appended when the draft is saved. */
  body: string;
}

export interface MailComposer {
  /**
   * Which composer this is, bumped on every open, discard and close.
   *
   * A create that is already in flight cannot be aborted (the request may sit in the fetch queue
   * for seconds), and when it lands the pane may be showing a DIFFERENT message, possibly on
   * another account. Without an identity to compare, the answer binds to whatever is on screen: the
   * reply then PATCHes the first draft's row, or sends from the wrong account. Every write that
   * folds a server answer back checks this first and drops a stale one.
   */
  epoch: number;
  accountId: string;
  /** Null until the first keystroke creates the row. */
  draftId: string | null;
  draft: MailDraftDto | null;
  fields: MailComposerFields;
  /** The original, quoted: shown read-only and appended to the body on every save. */
  quote: string | null;
  /** The message being answered, by cache handle. The SERVER copies the threading headers. */
  replyTo: { accountId: string; messageId: string } | null;
  showCc: boolean;
  showBcc: boolean;
  /**
   * Which half of the pane is on screen, owned by the CLIENT rather than derived from the draft.
   *
   * Editing a frozen draft makes the server withdraw the letter and issue a fresh one, so the
   * draft is `pending_approval` again 800ms after a keystroke. Deriving the mode from that would
   * yank the form away from somebody who is still typing; the card comes back when they ask for it
   * or when a send actually starts.
   */
  mode: 'edit' | 'status';
  status: SendStatus;
  save: MailSaveState;
  /** A request that must not be double-fired (a send, a discard, a retry) is in flight. */
  busy: boolean;
  /** One sentence for the human: a stale draft, a refused account, a save that failed. */
  notice: string | null;
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
  /** Drafts per account, newest edit first. Loaded in ONE request for every account. */
  drafts: Record<string, MailDraftDto[]>;
  draftsLoading: boolean;
  /** The open composer, which replaces the reader pane. */
  composer: MailComposer | null;
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
    drafts: {},
    draftsLoading: false,
    composer: null,
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
  for (const hook of [...resetHooks]) hook();
  for (const listener of [...listeners]) listener();
}

/**
 * Module state a reset has to clear that does not live in the snapshot: the composer's autosave timer
 * and its one in-flight create (`compose/compose-autosave.ts`), and the set of drafts this client has
 * deleted (`compose/compose-drafts.ts`). Each file registers its own, because each owns its state.
 *
 * The store cannot import that file (it imports this one), and a test that forgot the second reset
 * would carry a pending 800ms save into the next case.
 */
const resetHooks = new Set<() => void>();

export function onMailStoreReset(hook: () => void): void {
  resetHooks.add(hook);
}
