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
import { senderLabel } from './mail-format';
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

/**
 * The reserved pair a SMART row selects: one list across every account holding a role.
 *
 * Same reasoning as `DRAFTS_MAILBOX`, and deliberately the same shape: a smart row is a
 * `MailSelection` like any other, so `selectionKey`, `pairKey`, `sameSelection`, the narrow-viewport
 * drill and every existing action keep working with no second selection concept threaded through
 * them. The leading underscores are not an account id or a mailbox name any provider would hand back,
 * and `ensureSelection` only ever auto-picks a row it found in a provider's own list.
 *
 * What the reserved ids must NEVER reach: `POST /mailboxes/fetch`, the read-flag route and the
 * make-a-task route all take a real (accountId, mailboxId). Actions inside a merged list use the
 * ROW's own accountId; the reserved pair only ever names the list.
 */
export const SMART_ACCOUNT = '__walnut_smart__';
export const SMART_INBOX = '__smart_inbox__';
export const SMART_SENT = '__smart_sent__';
export const SMART_DRAFTS = '__smart_drafts__';

export type SmartMailboxId = typeof SMART_INBOX | typeof SMART_SENT | typeof SMART_DRAFTS;

/** Which role each smart row resolves to, which is also the `scope` the page request carries. */
export const SMART_ROLE: Record<SmartMailboxId, 'inbox' | 'sent' | 'drafts'> = {
  [SMART_INBOX]: 'inbox',
  [SMART_SENT]: 'sent',
  [SMART_DRAFTS]: 'drafts',
};

export function isSmartSelection(selection: MailSelection | null): boolean {
  return !!selection && selection.accountId === SMART_ACCOUNT;
}

/**
 * The provider's OWN drafts mailbox, when it keeps one.
 *
 * There is one Drafts row per account and it shows both kinds: the drafts composed in this console
 * (the plugin's database, with their approval state) and, underneath them, the folder a phone or a
 * webmail tab wrote into. Two rows both called Drafts, one glyph apart, was the console asking the
 * human to remember which was which.
 *
 * Only the FIRST such mailbox: the role is single by contract, and a provider that reported two
 * would otherwise put a second Drafts row back in the folder list.
 */
export function serverDraftsMailbox(rows: MailboxDto[] | undefined): MailboxDto | null {
  return rows?.find((one) => one.role === 'drafts') ?? null;
}

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
  /** A "make a task" request is in flight for this message. */
  taskBusy: boolean;
  /**
   * Why the last "make a task" did not work, in words, next to the button that failed.
   *
   * Kept on the OPEN MESSAGE rather than in a global notice, because that is where the human is
   * looking, and because it has to disappear when they move to another message: a failure about a
   * mail they have left is noise on the one they are reading now.
   */
  taskError: string | null;
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
  /**
   * What the human asked for, for the card's title alone.
   *
   * A forward is not a reply and deliberately carries no `replyTo` (it must not inherit the
   * original's threading headers), so the title cannot be derived from the fields: a forward and a
   * blank message look identical from here, and calling a forward "New message" hides which of the
   * two the click produced. Absent means a new message.
   */
  intent?: 'forward';
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
  /**
   * A `/providers` answer LANDED, so `providers` is the truth and `[]` means there are none.
   *
   * The distinction is load-bearing. A tab that opened while the mail plugin was still starting got
   * `Not found: GET /api/plugins/mail/providers`, kept `providers: []`, and every capability gate
   * then read "this account cannot mark read" — so clicking a message did nothing at all, silently,
   * for the life of the tab (2026-09-16). A failed read is not an empty list.
   */
  providersKnown: boolean;
  accounts: MailAccountDto[];
  mailboxes: Record<string, MailboxDto[]>;
  selected: MailSelection | null;
  messages: MailMessageDto[];
  /** The opaque token the last page handed back. Never parsed here; fed straight back as `before`. */
  nextBefore: string | null;
  listLoading: boolean;
  olderLoading: boolean;
  listError: string | null;
  search: MailSearchState;
  /**
   * The first fetch of a folder the background sweep has never reached, and how each one went.
   *
   * Keyed by `selectionKey`, one entry per folder, because the fetch is no longer only about the
   * folder on screen: a sidebar row's own menu can ask for a folder nobody has selected, and a single
   * slot made the second ask overwrite the first one's outcome (two rows, one sentence, describing
   * whichever answered last). An absent key means there is nothing to say about that folder: it has
   * been fetched before, or this console has not asked.
   */
  folderFetch: Record<string, MailFolderFetch>;
  /**
   * ONE sentence about a row that is not the open message, and which row it is about.
   *
   * Everything that can fail from a LIST (a read flag the provider refused, a body that would not
   * load, a task the server could not make) used to report itself through the open reader's own
   * fields, which is a silent dead end for a row nobody opened. `pair` is `pairKey(accountId,
   * messageId)` so the row itself can carry a mark as well as the sentence; null means the note is
   * about no single row (a folder, a selection).
   */
  rowNote: { text: string; pair: string | null; sticky?: boolean } | null;
  /**
   * ONE sentence about a FOLDER, for the left pane.
   *
   * The pane already answers a fetch by naming the folder; a preference written for a folder that is
   * not on screen had no answer at all, so the click was indistinguishable from a miss (the only proof
   * was the label when the menu was reopened). Same channel, same wording rules, and the middle pane is
   * deliberately not it: the folder being spoken about is usually not the one whose rows are showing.
   */
  paneNote: { text: string; sticky?: boolean } | null;
  /**
   * Read flips this console has made and the server has not confirmed yet, by `pairKey`, to the
   * intended `seen`.
   *
   * Two things read it. The unread filter keeps a row this console just flipped on the page it is
   * on (a row vanishing out from under the pointer is how a triage pass loses its place), and every
   * server count that lands while a flip is in flight has these subtracted before it is published,
   * because `loadMailboxesFor` replaces an account's mailbox rows wholesale: a `sync-completed`
   * arriving mid-flight would otherwise bounce the badge back to the provider's older number.
   */
  pendingSeen: Record<string, boolean>;
  /**
   * Rows whose last flip the provider refused, by `pairKey`, holding the PROVIDER's own reason.
   *
   * A rolled-back row looks exactly like a row nobody has touched, so somebody working down a list
   * reads their own failure as a job done. The row keeps a mark and this is its `title`.
   */
  flagFailed: Record<string, string>;
  open: MailOpenMessage | null;
  refreshing: boolean;
  /** What a 202 refresh left behind: a sentence, not an error. */
  refreshNote: string | null;
  /** Drafts per account, newest edit first. Loaded in ONE request for every account. */
  drafts: Record<string, MailDraftDto[]>;
  draftsLoading: boolean;
  /** The open composer, which replaces the reader pane. */
  composer: MailComposer | null;
  /**
   * How much mail ARRIVED in each folder during this session, keyed by `pairKey(accountId, mailboxId)`.
   *
   * The sidebar keeps an ordinary label out of sight only while nothing new has landed in it, and
   * "new" has to mean `added > 0` from a sync event rather than `unread > 0`: an archived label that
   * stopped months ago can hold hundreds of unread and is exactly the noise the collapse exists to
   * remove, while a folder that just received mail must never be hidden. Session-scoped on purpose,
   * so it is not a preference and never persisted: reopening Mail starts the day's arrivals again.
   */
  arrivals: Record<string, number>;
  /**
   * The accounts this session has read from or sent as, newest first (see `noteMailIdentity`).
   *
   * What a compose started from a merged list goes out as. Session-scoped and never persisted: it is
   * the answer to "which of my identities am I using now", which a stored preference would outlive.
   */
  identities: string[];
  /**
   * How many times a PERSON has picked a row, which is the only thing that spends the sidebar's aim.
   *
   * The pane holds its row shape still while somebody is pointing at it, and a pick releases the hold
   * (they have just said what they wanted, so the row under them has to be real). The selection key
   * cannot be that signal: the console also picks for them (`applySelection(auto)`) as the folder lists
   * land, and that arrives while the pointer is resting on a row, which released the hold and let rows
   * move under it. A COUNT rather than a boolean, so two picks of the same row are two releases.
   */
  picks: number;
}

/**
 * A folder being fetched on demand, for the one folder on screen.
 *
 * `running` is the plugin's 202: the fetch outlived its budget and the sync event will finish it, so
 * the pane keeps saying "fetching" rather than claiming the folder is empty.
 */
export interface MailFolderFetch {
  key: string;
  state: 'fetching' | 'running' | 'failed';
  /**
   * The plugin's OWN reason word, never renamed here (`web/src/api/mail.ts`, `MailboxFetchResult`).
   *
   * The five outcomes do not mean the same thing to a person: a replica will never answer
   * differently, an unknown mailbox is a folder the server has stopped listing, and only `failed` is
   * worth pressing again. Renaming them in this layer is how the words drift from the plugin's.
   */
  reason?: 'replica' | 'stopped' | 'unknown-mailbox' | 'failed';
  detail?: string;
}

/** What this console knows about one folder's on-demand fetch, or null. */
export function folderFetchFor(snapshot: MailSnapshot, key: string): MailFolderFetch | null {
  return snapshot.folderFetch[key] ?? null;
}

/**
 * Say one thing about one row.
 *
 * In the store rather than in the pane, because the failures it reports come from the actions layer
 * and the pane that showed the row may be a merged list, a search result or nothing at all.
 */
export function setMailRowNote(
  text: string,
  pair: string | null = null,
  options: { sticky?: boolean } = {},
): void {
  const sticky = options.sticky === true;
  patch({ rowNote: { text, pair, ...(sticky ? { sticky: true } : {}) } });
  // A SUCCESS is retired on a timer, which is half of why it can be an overlay: a sentence that answers
  // one right-click has no business sitting over the list for the rest of the session, and the triage
  // loop is dozens of right-clicks.
  //
  // A REFUSAL is not, and that difference is the rule both answer channels now share (see the pane's
  // fetch notes): the one sentence somebody needs during a triage pass used to vanish on its own 12
  // seconds in, while they were still working down the list. It goes when the same action is started on
  // that row again, when the selection changes, or when it is dismissed.
  if (rowNoteTimer) clearTimeout(rowNoteTimer);
  rowNoteTimer = null;
  if (sticky) return;
  rowNoteTimer = setTimeout(() => {
    rowNoteTimer = null;
    if (store.state.rowNote?.text === text) patch({ rowNote: null });
  }, ANSWER_MS);
}

/**
 * Long enough to read two sentences, short enough that the next right-click has a clean pane.
 *
 * ONE constant for both channels: the row toast lived 12s and the pane's fetch sentences 30s, so two
 * answers to the same gesture disagreed about how long an answer lasts.
 */
export const ANSWER_MS = 12_000;

let rowNoteTimer: ReturnType<typeof setTimeout> | null = null;

/**
 * Say one thing about a FOLDER, in the left pane.
 *
 * Same two rules as the row note above: a plain answer retires itself, and anything the person may have
 * to act on stays until they dismiss it or the console changes what is on screen.
 */
export function setMailPaneNote(text: string, options: { sticky?: boolean } = {}): void {
  const sticky = options.sticky === true;
  patch({ paneNote: { text, ...(sticky ? { sticky: true } : {}) } });
  if (paneNoteTimer) clearTimeout(paneNoteTimer);
  paneNoteTimer = null;
  if (sticky) return;
  paneNoteTimer = setTimeout(() => {
    paneNoteTimer = null;
    if (store.state.paneNote?.text === text) patch({ paneNote: null });
  }, ANSWER_MS);
}

export function clearMailPaneNote(): void {
  if (paneNoteTimer) { clearTimeout(paneNoteTimer); paneNoteTimer = null; }
  if (store.state.paneNote) patch({ paneNote: null });
}

let paneNoteTimer: ReturnType<typeof setTimeout> | null = null;

/**
 * How a sentence names one row: its subject, shortened, and who it is from.
 *
 * ONE wording, because every note about a row comes from a different file (a refused read flag, a
 * body that would not load, a task the server could not make) and "that message" is nobody when the
 * human has just right-clicked their way down fifteen rows.
 */
export function mailRowLabel(
  message: Pick<MailMessageDto, 'subject' | 'from'>,
  style: 'from' | 'paren' = 'from',
): string {
  const subject = (message.subject || '(no subject)').replace(/\s+/g, ' ').trim();
  const short = subject.length > 48 ? `${subject.slice(0, 47)}…` : subject;
  // `paren` is for a sentence that already spends a "from" on its own verb: `Task made from "X" from
  // Keeper Reports.` put two of them in nine words.
  return style === 'paren'
    ? `"${short}" (${senderLabel(message.from)})`
    : `"${short}" from ${senderLabel(message.from)}`;
}

export function clearMailRowNote(): void {
  if (rowNoteTimer) { clearTimeout(rowNoteTimer); rowNoteTimer = null; }
  if (store.state.rowNote) patch({ rowNote: null });
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
    providersKnown: false,
    accounts: [],
    mailboxes: {},
    selected: null,
    messages: [],
    nextBefore: null,
    listLoading: false,
    olderLoading: false,
    listError: null,
    search: EMPTY_SEARCH,
    folderFetch: {},
    rowNote: null,
    paneNote: null,
    pendingSeen: {},
    flagFailed: {},
    open: null,
    refreshing: false,
    refreshNote: null,
    drafts: {},
    draftsLoading: false,
    composer: null,
    arrivals: {},
    identities: [],
    picks: 0,
  };
}

/** How many identities are worth remembering: a compose default only ever reads the first that can send. */
const IDENTITY_MEMORY = 4;

/**
 * Remember an account as one this session has just used, newest first.
 *
 * A compose started from a merged list has no account of its own, and it used to resolve to the FIRST
 * sendable account whatever the human had been doing: reading the second account's mail and pressing
 * New message wrote as the first one. Reading and sending are both "using an identity", so both are
 * recorded here. Session memory, not a preference: it answers "what am I doing right now".
 */
export function noteMailIdentity(accountId: string): void {
  if (!accountId || accountId === SMART_ACCOUNT) return;
  const prev = store.state.identities;
  if (prev[0] === accountId) return;
  patch({ identities: [accountId, ...prev.filter((one) => one !== accountId)].slice(0, IDENTITY_MEMORY) });
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
  /**
   * Selections this console has already asked the plugin to fetch on demand, ONCE each.
   *
   * The trigger is "the page came back empty and this folder has never been synced", and a folder
   * that is genuinely empty answers empty again after the fetch. Without a record of having asked,
   * every reload of that page would ask again: the mailbox list's `lastSyncAt` is what ends the
   * condition and it arrives in a separate request, so there is a window where the answer is still
   * "never synced". Session-scoped on purpose, and never a reason not to try: the Refresh button
   * and the retry link both go around it.
   */
  folderFetchAsked: Set<string>;
} = {
  state: initialState(),
  openSeq: 0,
  preferAccount: null,
  refreshNoteAccount: null,
  folderFetchAsked: new Set(),
};

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
/**
 * Is a read under this key still in flight?
 *
 * Asked by a caller deciding whether to FORCE another pass. `force` on an inflight key queues exactly one
 * more identical request, which is right for a live event (the data changed) and pure waste for a refresh
 * that arrived 30ms after the read it wants: one open of Mail issued the same cross-account page three
 * times that way, and that query is a scan plus a temporary sort on the one event loop every route shares.
 */
export function isRunning(key: string): boolean {
  return inflight.has(key);
}

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
 * ignore it.
 *
 * Three sources, and the ORDER is load bearing. The mailbox rows come first because they are the
 * only one the optimistic read flag can move: opening a message decrements that row locally and puts
 * it back if the provider refuses, and a badge fed from a server-sent total would sit still while
 * the human watched the message turn read. `unreadInbox` is the server's own inbox-only sum and is
 * the fallback for an account whose mailboxes have not loaded yet, which is the whole first paint of
 * a fresh tab: before it existed that window fell through to the account TOTAL and counted Spam and
 * Trash. `unread` stays as the last resort, because counting an account as zero would blank a badge
 * that is genuinely not zero.
 *
 * Rounded because these are provider-declared numbers: one non-integer would render as "3.0001".
 */
export function publishBadge(): void {
  const state = store.state;
  let total = 0;
  for (const account of state.accounts) {
    const mailboxes = state.mailboxes[account.accountId];
    if (mailboxes) {
      total += mailboxes.reduce((sum, mailbox) => sum + (mailbox.role === 'inbox' ? mailbox.unread || 0 : 0), 0);
      continue;
    }
    total += typeof account.unreadInbox === 'number' ? account.unreadInbox : account.unread || 0;
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
  // `initialState()` is what clears the four cross-row maps (`folderFetch`, `rowNote`,
  // `pendingSeen`, `flagFailed`): each one outlives a single row on purpose, so a case that leaked
  // any of them would grade the next case's arithmetic against the last case's pending flip.
  store.state = initialState();
  // The row note's retire timer is module state, so a case that left one armed would blank the next
  // case's note mid-assertion.
  if (rowNoteTimer) { clearTimeout(rowNoteTimer); rowNoteTimer = null; }
  if (paneNoteTimer) { clearTimeout(paneNoteTimer); paneNoteTimer = null; }
  store.openSeq = 0;
  store.preferAccount = null;
  store.refreshNoteAccount = null;
  // Session-scoped, so a test that forgot this would carry "already asked for that folder" into the
  // next case and the automatic fetch would silently not happen.
  store.folderFetchAsked.clear();
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
