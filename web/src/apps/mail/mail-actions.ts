/**
 * Everything the mail console DOES: the reads, the open message, search, the refresh, adding an
 * account, and the live-event fan-in.
 *
 * Split from `mail-store.ts` on purpose. That file is the container (the snapshot, the notifier,
 * the one-request-per-key coalescer, the badge); this one is the only place that talks to
 * `@/api/mail` and then patches. Keeping them apart makes the interesting rule visible in one
 * place: NOTHING here mutates the snapshot except through `patch`, and nothing fetches except
 * inside `run`, which is what stops three panes from making the same request three times.
 *
 * The optimistic read flag has its own file (`mail-read-flag.ts`), because moving four numbers
 * together and putting them all back is worth reading in one sitting.
 *
 * One behaviour worth knowing before changing anything here: A LIVE EVENT IS NOT A REASON TO PULL A
 * PAGE. An event that arrives before the console has loaded is answered with the ACCOUNTS read
 * alone, which is all the sidebar badge needs and one small request instead of a page plus a
 * mailbox list nothing is rendering yet. Only an event about the mailbox on screen refetches it.
 */
import {
  createMailAccount,
  fetchMailbox,
  listMailAccounts,
  listMailMessages,
  listMailboxes,
  mailFailure,
  readMailMessage,
  refreshMail,
  searchMail,
  type MailAccountDto,
  type MailMessageDto,
  type MailboxDto,
} from '@/api/mail';
import { log } from '@/utils/log';
import { closeMailComposer, onMailDraftEvent } from './compose/compose-actions';
import { loadMailDrafts } from './compose/compose-drafts';
import { loadProviders } from './mail-providers';
import { bodyQuoteText } from './mail-quote-text';
import { mailFlipsInFlight, markReadIfAllowed } from './mail-read-flag';
import { flipCountedBy, forgetFlipCounted, mailCountsClock } from './mail-seen-clock';
import { noteRecentFolder, readSelectedPref, writeSelectedPref } from './mail-sidebar-prefs';
import { arrivalsAfterOpen, folderLabel, smartPairs, smartRowVisible, type SmartRole } from './mail-smart';
import { applyMessageTask, invalidateLetterList } from './mail-task-actions';
import { onMailUnsubscribed } from './mail-unsubscribe-actions';
import { keepOpenRow, readUnreadOnly, writeUnreadOnly } from './mail-unread-filter';
import { noteUnreadChecking, settleUnreadCheck } from './mail-unread-checking';
import {
  DRAFTS_MAILBOX,
  EMPTY_SEARCH,
  PAGE_SIZE,
  SEEN,
  SMART_ACCOUNT,
  SMART_DRAFTS,
  SMART_INBOX,
  SMART_ROLE,
  SMART_SENT,
  isRunning,
  isSmartSelection,
  noteMailIdentity,
  onMailStoreReset,
  pairKey,
  patch,
  publishBadge,
  run,
  sameSelection,
  clearMailRowNote,
  mailRowLabel,
  selectionKey,
  serverDraftsMailbox,
  setMailPaneNote,
  setMailRowNote,
  standIn,
  store,
  type MailFolderFetch,
  type MailSelection,
  type MailSnapshot,
  type SmartMailboxId,
} from './mail-store';

// ── reads ──

/**
 * Flips this console has made that the server's numbers do not include yet, as deltas.
 *
 * Every server count lands WHOLESALE (`loadMailboxesFor` replaces an account's rows,
 * `listMailAccounts` replaces the totals), and the provider's unread figure only moves on its next
 * mailbox refresh. So a `sync-completed` arriving one second after somebody marked three rows read
 * used to bounce the badge back to the number those three rows were still counted in, and the row
 * they were looking at stayed read: two truths on one screen. Subtracting the flips still in flight
 * is what makes the landing agree with the rows.
 *
 * Resolved through the rows this console holds, because a pending key names a MESSAGE and the count
 * belongs to its mailbox. A flip whose row is no longer held still counts against the account total.
 */
function pendingSeenDeltas(
  accountId: string,
  since: number,
): { byMailbox: Map<string, number>; account: number } {
  const state = store.state;
  const byMailbox = new Map<string, number>();
  let account = 0;
  const pending = Object.entries(state.pendingSeen);
  if (pending.length === 0) return { byMailbox, account };
  const rows = [...state.messages, ...state.search.messages, ...(state.open?.message ? [state.open.message] : [])];
  for (const [pair, seen] of pending) {
    // ALREADY IN THIS NUMBER. `since` is the clock as the request went out, so a flip the server had
    // answered before then is part of the count that just landed and subtracting it again is what made
    // the badge read one low after a refresh (see `mail-seen-clock.ts`).
    if (flipCountedBy(pair, since)) continue;
    const row = rows.find((one) => pairKey(one.accountId, one.messageId) === pair);
    const ownerId = row ? row.accountId : (JSON.parse(pair) as [string, string])[0];
    if (ownerId !== accountId) continue;
    const delta = seen ? -1 : 1;
    account += delta;
    if (row) byMailbox.set(row.mailboxId, (byMailbox.get(row.mailboxId) ?? 0) + delta);
  }
  return { byMailbox, account };
}

/**
 * The server's mailbox rows with this console's in-flight flips taken off them.
 *
 * `since` is the clock reading taken BEFORE the request that produced `rows` (see `mailCountsClock`):
 * a flip the server had already counted by then is in these numbers and must not be subtracted.
 */
function withPendingSeen(accountId: string, rows: MailboxDto[], since: number): MailboxDto[] {
  const { byMailbox } = pendingSeenDeltas(accountId, since);
  if (byMailbox.size === 0) return rows;
  return rows.map((row) => {
    const delta = byMailbox.get(row.mailboxId);
    return delta ? { ...row, unread: Math.max(0, (row.unread || 0) + delta) } : row;
  });
}

/**
 * The same subtraction on the accounts landing.
 *
 * `unreadInbox` moves with it: it is what the badge falls back to before an account's mailbox rows
 * have loaded, so leaving it alone would blink the old number back in exactly that window. A flip is
 * made on the folder somebody is reading, which is their inbox nearly every time.
 */
function accountsWithPendingSeen(accounts: MailAccountDto[], since: number): MailAccountDto[] {
  return accounts.map((account) => {
    const { account: delta } = pendingSeenDeltas(account.accountId, since);
    if (!delta) return account;
    return {
      ...account,
      unread: Math.max(0, (account.unread || 0) + delta),
      ...(typeof account.unreadInbox === 'number'
        ? { unreadInbox: Math.max(0, account.unreadInbox + delta) }
        : {}),
    };
  });
}

function loadAccounts(force = false): Promise<void> {
  return run('accounts', async () => {
    try {
      // Read the flip clock BEFORE the request: what the answer can possibly include is decided here.
      const since = mailCountsClock();
      const answer = await listMailAccounts();
      patch({
        accounts: accountsWithPendingSeen(answer.accounts ?? [], since),
        stand: null,
        error: null,
        loaded: true,
      });
      publishBadge();
    } catch (error) {
      const expected = standIn(error);
      if (expected) patch({ stand: expected, error: null });
      else patch({ error: mailFailure(error).message });
    }
  }, force);
}

/**
 * Mail that ARRIVED in a folder during this session, held until the mailbox rows carrying the same
 * event's unread counts land.
 *
 * Held rather than patched on the spot so both halves of the sidebar move in ONE render: the badge
 * comes from the mailbox rows, the folder's promotion out of the collapsed tail comes from these
 * counts, and drawing a folder's new unread count one frame before the folder itself appears is the
 * flicker this exists to avoid.
 */
const pendingArrivals = new Map<string, number>();

onMailStoreReset(() => { pendingArrivals.clear(); });

function noteArrival(accountId: string | undefined, mailboxId: string | undefined, added: unknown): void {
  const count = typeof added === 'number' ? Math.round(added) : 0;
  if (!accountId || !mailboxId || count <= 0) return;
  const key = pairKey(accountId, mailboxId);
  pendingArrivals.set(key, (pendingArrivals.get(key) ?? 0) + count);
}

/** The held counts as a patch fragment, folded onto what the session already counted. */
function drainArrivals(): Partial<MailSnapshot> {
  if (pendingArrivals.size === 0) return {};
  const arrivals = { ...store.state.arrivals };
  for (const [key, added] of pendingArrivals) arrivals[key] = (arrivals[key] ?? 0) + added;
  pendingArrivals.clear();
  return { arrivals };
}

/**
 * Held while EVERY account's folder list is being read, so exactly one `ensureSelection` decides the row.
 *
 * Mailbox lists land one account at a time, and each one used to pick: the first to answer auto-picked its
 * own inbox and fetched a page for it, and the second made the remembered or defaulted smart row visible,
 * which replaced the selection and fetched again. One cold open therefore issued a per-account page nobody
 * ever saw plus a merged page, and the merged one is the query that trades an index seek for a scan and a
 * temporary sort, on the single event loop every route shares.
 */
let selectionHeld = false;

onMailStoreReset(() => { selectionHeld = false; });

/**
 * Read every account's folders, then let ONE `ensureSelection` run. Returns whether the row changed.
 *
 * `pick: false` reads the folders and picks NOTHING, which is what the badge preload wants: it runs in a
 * tab that never opened Mail, and a selection there means a page read for a pane nobody is looking at.
 */
async function loadEveryMailboxList(force = false, pick = true): Promise<boolean> {
  selectionHeld = true;
  try {
    await Promise.all(store.state.accounts.map((account) => loadMailboxesFor(account.accountId, force)));
  } finally {
    selectionHeld = false;
  }
  return pick ? ensureSelection() : false;
}

function loadMailboxesFor(accountId: string, force = false): Promise<void> {
  return run(`mailboxes:${accountId}`, async () => {
    try {
      // The clock as this request goes out (see `withPendingSeen`): a flip the server counted before
      // now is already in the numbers this answer carries.
      const since = mailCountsClock();
      const answer = await listMailboxes(accountId);
      patch({
        mailboxes: {
          ...store.state.mailboxes,
          [accountId]: withPendingSeen(accountId, answer.mailboxes ?? [], since),
        },
        ...drainArrivals(),
      });
      ensureSelection();
    } catch (error) {
      // The rows did not come, but the arrival is still true: dropping it would leave the folder in
      // the collapsed tail for the rest of the session.
      const held = drainArrivals();
      if (held.arrivals) patch(held);
      log.warn('mail', 'mailbox list failed', { accountId, error: mailFailure(error).message });
    }
  }, force);
}

/**
 * Pick a mailbox when nothing is selected: the just-added account's inbox if there is one,
 * otherwise the first account's inbox, otherwise its first mailbox.
 *
 * A console that opens with three panes and no mailbox chosen would ask the human to click
 * something before it could show anything, on every single visit.
 */
/**
 * Is this selection still a row a person could click?
 *
 * Three kinds, and the two virtual ones are the reason this is a function rather than a lookup. The
 * Drafts row is never in a provider's mailbox list: comparing it against that list said "gone" and
 * moved the human back to the inbox on the next mailbox refresh, which any sync event triggers. A
 * smart row is not in there either, and it is judged by the SAME rule that decides whether it is
 * drawn (`smartRowVisible`), never by a second copy of that rule: `sync-completed` carries an
 * accountId and fires every two minutes, so a smart selection judged dead by a table lookup bounced
 * the human back to the first account's inbox while they were reading.
 *
 * This is also what validates a REMEMBERED selection, for the same reason: the two questions are the
 * same question.
 */
function selectionAlive(selection: MailSelection): boolean {
  const state = store.state;
  if (selection.mailboxId === DRAFTS_MAILBOX) {
    return state.accounts.some((account) => account.accountId === selection.accountId);
  }
  const role = smartRoleOf(selection);
  if (role) return smartRowVisible(state.mailboxes, state.accounts, role);
  return !!state.mailboxes[selection.accountId]?.some((mailbox) => mailbox.mailboxId === selection.mailboxId);
}

/**
 * Whether the row on screen was picked by the CONSOLE rather than by the human or their remembered
 * preference, in which case a better answer arriving later is allowed to replace it.
 *
 * Load-bearing because mailboxes arrive ONE ACCOUNT AT A TIME: the first list to land is enough to
 * auto-pick that account's inbox, and at that moment no smart row is visible yet (visibility needs
 * two accounts holding the role) so a remembered `All Inboxes` fails validation and is discarded.
 * Without this flag the automatic pick would then be final, and the remembered row would be lost on
 * every fresh tab.
 */
let autoPicked = false;

onMailStoreReset(() => { autoPicked = false; });

/** True when this call CHANGED the selection, which means a page for it is already in flight. */
function ensureSelection(): boolean {
  const state = store.state;
  // Every account's folder list is still being read: one caller runs this once at the end instead, so a
  // half-read set cannot pick a row that the rest of the set would immediately replace.
  if (selectionHeld) return false;
  const selected = state.selected;
  const alive = !!selected && selectionAlive(selected);
  if (alive && !autoPicked) return false;
  const before = selected ? selectionKey(selected) : '';
  if (adoptRemembered()) {
    const now = store.state.selected;
    return (now ? selectionKey(now) : '') !== before;
  }
  if (alive) return false;
  const preferred = store.preferAccount;
  const order = preferred
    ? [...state.accounts].sort((a, b) => (a.accountId === preferred ? -1 : b.accountId === preferred ? 1 : 0))
    : state.accounts;
  for (const account of order) {
    const mailboxes = state.mailboxes[account.accountId] ?? [];
    // Never the drafts folder: it has no row of its own any more (the merged Drafts row is what
    // reaches it), so opening on it would leave the folder list with nothing highlighted.
    const target = mailboxes.find((mailbox) => mailbox.role === 'inbox')
      ?? mailboxes.find((mailbox) => mailbox.role !== 'drafts')
      ?? mailboxes[0];
    if (!target) continue;
    if (preferred === account.accountId) store.preferAccount = null;
    applySelection(account.accountId, target.mailboxId, 'auto');
    return selectionKey({ accountId: account.accountId, mailboxId: target.mailboxId }) !== before;
  }
  return false;
}

/**
 * Take up the row this person was last reading, when it is still a row.
 *
 * Validated here rather than in the preference file, which has never seen a mailbox list: a smart
 * pair only when its row is visible, a real pair only when it is still in that account's list (or it
 * is that account's Drafts row). Anything else is discarded and the ordinary automatic pick decides.
 *
 * NOTHING remembered on a fresh install with two accounts means `All Inboxes`, which is the answer to
 * "where is there new mail" and the reason the smart rows exist. A stored row that failed validation
 * is deliberately NOT replaced by that: it falls through to the ordinary order, so a row that
 * disappeared behaves like it was never selected.
 *
 * A just-added account wins over both: that is an explicit action taken seconds ago.
 */
function adoptRemembered(): boolean {
  const state = store.state;
  // No accounts yet means the accounts read has not landed, so nothing can be validated against it.
  if (state.accounts.length === 0 || store.preferAccount) return false;
  const remembered = readSelectedPref(state.accounts.map((one) => one.accountId));
  const wanted = remembered && selectionAlive(remembered)
    ? remembered
    : (!remembered && smartRowVisible(state.mailboxes, state.accounts, 'inbox')
      ? { accountId: SMART_ACCOUNT, mailboxId: SMART_INBOX }
      : null);
  if (!wanted) return false;
  const selected = state.selected;
  if (selected && selected.accountId === wanted.accountId && selected.mailboxId === wanted.mailboxId) {
    // Already on it: the provisional pick turned out to be the wanted row, so stop calling it
    // provisional or every later mailbox list would try to replace it again.
    autoPicked = false;
    return true;
  }
  applySelection(wanted.accountId, wanted.mailboxId, 'restored');
  return true;
}

export function selectMailbox(accountId: string, mailboxId: string): void {
  applySelection(accountId, mailboxId, 'human');
}

/** Select the merged list of one role. The reserved pair is a selection like any other. */
export function selectSmartMailbox(id: SmartMailboxId): void {
  selectMailbox(SMART_ACCOUNT, id);
}

/**
 * Who chose this row, which three different things downstream need to tell apart.
 *
 * - `human`: a click or a keyboard activation, happening now.
 * - `restored`: the row they were last reading, or the default `All Inboxes`, taken up as the console
 *   loads. Written down and final like a human pick, because it IS their row, but nothing they just did.
 * - `auto`: the console picking for them because nothing else resolved. Provisional (see `autoPicked`)
 *   and never written down, because remembering it would overwrite the row they actually chose with
 *   whichever account's mailbox list answered first.
 */
type SelectionSource = 'human' | 'restored' | 'auto';

/** The overlay with every SETTLED flip forgotten, for the two moments its list goes away. */
function settledFlipsDropped(): Record<string, boolean> {
  const pending = store.state.pendingSeen;
  const inFlight = mailFlipsInFlight();
  const held: Record<string, boolean> = {};
  for (const [pair, seen] of Object.entries(pending)) {
    if (inFlight.has(pair)) held[pair] = seen;
    // A dropped flip takes its "the server counts this" mark with it: the map would otherwise hold a
    // pair nothing asks about again.
    else forgetFlipCounted(pair);
  }
  return held;
}

function applySelection(accountId: string, mailboxId: string, source: SelectionSource): void {
  const selected = store.state.selected;
  if (selected && selected.accountId === accountId && selected.mailboxId === mailboxId) return;
  const auto = source === 'auto';
  autoPicked = auto;
  const accountIds = store.state.accounts.map((one) => one.accountId);
  if (!auto) {
    writeSelectedPref(accountIds, { accountId, mailboxId });
    // An ordinary label opened by hand is one of the three the collapse row lifts back out next time.
    const row = (store.state.mailboxes[accountId] ?? []).find((one) => one.mailboxId === mailboxId);
    if (row?.role === 'other') noteRecentFolder(accountIds, accountId, mailboxId);
    // Picking a real folder is using that identity: it is what a compose from a merged list defaults to.
    noteMailIdentity(accountId);
  }
  // A folder picked by hand whose last poll is old gets polled now, on its own, ahead of the sweep: the
  // inbox is polled every tick, every other folder only every fifth, so without this a click landed on a
  // list up to ten minutes old. Only a HUMAN pick, and only a stale one (see `refreshStaleFolder`).
  if (source === 'human') refreshStaleFolder(accountId, mailboxId);
  patch({
    selected: { accountId, mailboxId },
    // Only a HUMAN pick spends the sidebar's aim (see `picks`). The console's own picks, restored or
    // automatic, land as the folder lists answer, which is while a pointer may be resting on a row.
    ...(source === 'human' ? { picks: store.state.picks + 1 } : {}),
    // Opening the folder ENDS its arrival: the `New` mark says "mail arrived here and nobody has looked",
    // and it used to be kept until Mail was remounted, so it came back the moment the person moved to the
    // next folder and said New about mail they had just read.
    arrivals: arrivalsAfterOpen(store.state.arrivals, pairKey(accountId, mailboxId)),
    messages: [],
    nextBefore: null,
    listError: null,
    open: null,
    // The Ask drawer shares the reader's pane, and it is about a mail from the folder just left: the
    // same reason `open` and `rowNote` go. The conversation itself is kept (it is remembered per
    // message), so the same row opens the same chat again.
    ask: null,
    search: EMPTY_SEARCH,
    // A note about a row is about a row that is no longer on screen.
    rowNote: null,
    // Same for the flips this console is holding over the list it just left (G5/G6). They keep a
    // read row on an unread page and keep the badge off it, and both of those are about THAT list;
    // carried across a selection they would go on subtracting from every later landing, so the badge
    // would drift low by the number of rows the human ever flipped. A flip still in flight stays:
    // its rollback has to find the row.
    pendingSeen: settledFlipsDropped(),
    // `folderFetch` is deliberately NOT cleared here: it is keyed by folder, so each entry describes
    // the folder it was asked for and a sidebar row can be fetched without ever being selected. It
    // was a single slot, and then carrying it across a selection said "fetching" over the folder
    // just opened while the request in flight was about the one just left.
  });
  void loadMailMessages();
}

/**
 * Has this folder ever been fetched?
 *
 * `lastSyncAt` is the plugin's stamp, written when a poll of that container completes. Absent means
 * the background sweep has not reached it yet, which on a big account is the normal state of most
 * folders for the first hour: the console's own message list is then EMPTY for a folder whose size
 * it can see, and saying "no mail in this folder" there is a confident wrong answer.
 *
 * An unknown mailbox counts as fetched, so a selection the mailbox list has not caught up with does
 * not trigger a fetch of something nobody can name.
 */
function folderEverFetched(selection: MailSelection): boolean {
  // A merged list is not a folder, so there is nothing to fetch and nothing to say: it reads from
  // folders the sweep stamps on their own, and "Fetching this folder" over a list of several folders
  // would name one that does not exist.
  if (isSmartSelection(selection)) return true;
  const row = (store.state.mailboxes[selection.accountId] ?? [])
    .find((one) => one.mailboxId === selection.mailboxId);
  return !row || row.lastSyncAt !== undefined;
}

/** Which role a smart selection stands for, or null for every real selection. */
function smartRoleOf(selection: MailSelection): SmartRole | null {
  if (!isSmartSelection(selection)) return null;
  return SMART_ROLE[selection.mailboxId as SmartMailboxId] ?? null;
}

/**
 * Fetch the folder on screen now, because the sweep has not reached it.
 *
 * `auto` is the once-per-selection path taken when a page came back empty; a human pressing the
 * retry link passes false and goes around that record. Either way the answer is only applied while
 * the same folder is still selected.
 *
 * Note which way `auto` maps onto `run`'s force flag, because the two are opposite ON PURPOSE. This
 * function awaits a page read, and a page read that comes back empty is what calls it: forcing on
 * the automatic path would put a `want` on this very key, `run` would loop the body again, and the
 * pair would spin. The once-per-folder record is what really prevents that, and the flag agreeing
 * with it means neither one is load-bearing alone.
 */
export function fetchSelectedFolder(auto = false): Promise<void> {
  const selection = store.state.selected;
  if (!selection) return Promise.resolve();
  return fetchFolderPair(selection.accountId, selection.mailboxId, auto ? 'auto' : 'human');
}

/**
 * A folder counts as stale for a click once its last poll is older than this.
 *
 * Longer than one poll interval (the inbox is polled every tick, so an inbox is almost never stale),
 * shorter than the five ticks a non-inbox folder waits for its turn.
 */
export const STALE_FOLDER_MS = 3 * 60_000;

/** The same folder is not re-polled on a click more often than this, however often it is clicked. */
const STALE_REFETCH_MS = 2 * 60_000;

/** When each folder was last polled because a click found it stale. Session memory, keyed by selection. */
const staleFetchedAt = new Map<string, number>();

onMailStoreReset(() => { staleFetchedAt.clear(); });

/**
 * Poll one folder now because a person just opened it and its last poll is old.
 *
 * Quiet by design: the list is already on screen from the cache, the sync line says `Checking…` while
 * this runs, and a failure changes nothing a person can act on (the sweep will come round), so it is
 * logged rather than shown. A folder never polled at all is not this path's business: the empty-page
 * rule (`folderEverFetched`) owns it, with its own sentence.
 */
function refreshStaleFolder(accountId: string, mailboxId: string): void {
  const selection = { accountId, mailboxId };
  if (isSmartSelection(selection) || mailboxId === DRAFTS_MAILBOX) return;
  const row = (store.state.mailboxes[accountId] ?? []).find((one) => one.mailboxId === mailboxId);
  if (!row || row.lastSyncAt === undefined) return;
  const now = Date.now();
  if (now - row.lastSyncAt < STALE_FOLDER_MS) return;
  const key = selectionKey(selection);
  if (now - (staleFetchedAt.get(key) ?? 0) < STALE_REFETCH_MS) return;
  staleFetchedAt.set(key, now);
  void fetchFolderPair(accountId, mailboxId, 'stale');
}

/**
 * Fetch a named folder now, for a row that is not the selection.
 *
 * The same body as above with the pair passed in, and that is the whole difference: a sidebar row's
 * own menu must not have to CHANGE the selection first, because selecting a folder replaces the
 * message list, and "fetch this one" is not "take me there". Same `run` key, so the two cannot send
 * two requests for one folder.
 */
export function fetchMailboxNow(accountId: string, mailboxId: string): Promise<void> {
  return fetchFolderPair(accountId, mailboxId, 'human');
}

/** Every smart row's reserved mailbox id, which no fetch may ever be sent. */
const SMART_IDS = new Set<string>([SMART_INBOX, SMART_SENT, SMART_DRAFTS]);

/**
 * `human`: a person asked (a menu, a retry link), so it always runs and every outcome is shown.
 * `auto`: an empty page of a never-polled folder asked, once per folder.
 * `stale`: a click found the folder's last poll old; quiet about anything but success (see `refreshStaleFolder`).
 */
type FolderFetchMode = 'human' | 'auto' | 'stale';

function fetchFolderPair(accountId: string, mailboxId: string, mode: FolderFetchMode): Promise<void> {
  const auto = mode === 'auto';
  // The route takes a real (accountId, mailboxId). Every virtual row returns here, on the first line,
  // rather than sending a reserved id the provider would have to refuse.
  if (!accountId || !mailboxId) return Promise.resolve();
  if (mailboxId === DRAFTS_MAILBOX || accountId === SMART_ACCOUNT || SMART_IDS.has(mailboxId)) {
    return Promise.resolve();
  }
  const selection = { accountId, mailboxId };
  const key = selectionKey(selection);
  if (auto) {
    if (store.folderFetchAsked.has(key)) return Promise.resolve();
    store.folderFetchAsked.add(key);
  }
  return run(`folder-fetch:${key}`, async () => {
    setFolderFetch(key, { key, state: 'fetching' });
    try {
      const answer = await fetchMailbox(accountId, mailboxId);
      if (mode === 'stale' && !answer.fetched) {
        // Still running (the loop finishes it and its event carries any rows) or refused: either way the
        // cached list on screen stands, and there is nothing a person should be asked to do about it.
        setFolderFetch(key, null);
        if (!answer.running) log.info('mail', 'stale folder poll did not fetch', { accountId, mailboxId, reason: answer.reason });
        return;
      }
      if (answer.running) {
        // A 202: still going, and `sync-completed` will bring the rows. Saying "fetching" is the
        // truth, and it is also what keeps the empty-folder sentence off the screen meanwhile.
        setFolderFetch(key, { key, state: 'running' });
        return;
      }
      if (answer.fetched) {
        setFolderFetch(key, null);
        // The rows are in the cache now; this is the read that puts them on screen, and only when
        // this folder is the one on screen: a fetch fired from a sidebar row must not replace the
        // list somebody is reading. The sync event covers that case.
        if (sameSelection(selection)) await loadMailMessages(true);
        return;
      }
      // The plugin's own reason word and its own detail, stored and not rewritten: the words for a
      // human belong to the pane that draws them, and every one of the five outcomes reads
      // differently (a replica will never answer another way, `failed` is worth pressing again).
      setFolderFetch(key, {
        key,
        state: 'failed',
        ...(answer.reason ? { reason: answer.reason } : {}),
        ...(answer.detail ? { detail: answer.detail } : {}),
      });
    } catch (error) {
      const failure = mailFailure(error);
      if (mode === 'stale') {
        setFolderFetch(key, null);
        log.info('mail', 'stale folder poll failed', { accountId, mailboxId, error: failure.message });
        return;
      }
      // A replica refuses every write with the same 503, and that is not a fault: it will never answer
      // differently and there is nothing to press again. It is one of the five answers the pane has a
      // sentence for, and the read-flag path already tells it apart the same way, so a refusal here
      // said "Walnut could not fetch X" and invited a retry that cannot work.
      const replica = failure.status === 503 && failure.code === 'primary_only';
      setFolderFetch(key, {
        key,
        state: 'failed',
        reason: replica ? 'replica' : 'failed',
        ...(replica ? {} : { detail: failure.message }),
      });
    }
  }, mode === 'human');
}

/** One folder's entry in the map, or its removal. */
function setFolderFetch(key: string, value: MailFolderFetch | null): void {
  const held = { ...store.state.folderFetch };
  if (value) held[key] = value;
  else delete held[key];
  patch({ folderFetch: held });
}

/**
 * Which PROVIDER mailbox a selection reads its page from.
 *
 * Every selection is its own answer except the Drafts row, which is virtual: asking the messages
 * route for `__walnut_drafts__` would be a request for a folder no provider has. That row shows the
 * drafts route's own rows AND, when the provider keeps a drafts folder, that folder's page. Null
 * means there is no page to read, only this console's drafts.
 */
function pageMailboxOf(selection: MailSelection): string | null {
  // A smart selection has no single folder at all: its page is one server query over the pairs of a
  // role, and answering with the reserved id would send it to the route as `mailbox`.
  if (isSmartSelection(selection)) return null;
  if (selection.mailboxId !== DRAFTS_MAILBOX) return selection.mailboxId;
  return serverDraftsMailbox(store.state.mailboxes[selection.accountId])?.mailboxId ?? null;
}

/**
 * The query a page read carries, except the cursor.
 *
 * ONE place on purpose: page 2 has to be identical to page 1 apart from `before`, or it is a
 * different query and the rows it answers with do not continue the list on screen. A smart selection
 * carries `scope` and NEITHER `account` nor `mailbox` (the server refuses the combination), which is
 * also what makes the merged list one query rather than a merge of per-account pages.
 */
function pageQuery(selection: MailSelection, mailboxId: string | null): {
  accountId?: string;
  mailboxId?: string;
  limit: number;
  unread?: true;
  scope?: 'role:inbox' | 'role:sent' | 'role:drafts';
} {
  const role = smartRoleOf(selection);
  return {
    limit: PAGE_SIZE,
    ...(role
      ? { scope: `role:${role}` as const }
      : { accountId: selection.accountId, ...(mailboxId ? { mailboxId } : {}) }),
    ...(unreadOnlyFor(selection) ? { unread: true as const } : {}),
  };
}

/**
 * The next first-page read skips the server's one-minute unread clock (`fresh=1`).
 *
 * A flag rather than a parameter because page reads coalesce by selection (`run`): a Refresh landing while
 * a read is in flight queues one more pass, and that pass is the one that has to carry it.
 */
let freshPageWanted = false;

onMailStoreReset(() => { freshPageWanted = false; });

/** Neither Drafts row carries the unread filter: a draft is not unread mail. */
function unreadFilterable(selection: MailSelection): boolean {
  return selection.mailboxId !== DRAFTS_MAILBOX && selection.mailboxId !== SMART_DRAFTS;
}

/**
 * Whether the page reads for this selection ask the server for unread only.
 *
 * Read from the preference rather than from the pane's state, because the reads that matter most
 * happen with no pane involved: a sync event, a reconnect, a "Load older" fired from a click the
 * pane has already forgotten about. The Drafts row is never filtered (a draft is not unread mail),
 * and neither is search, which is a different route entirely.
 */
function unreadOnlyFor(selection: MailSelection): boolean {
  if (!unreadFilterable(selection)) return false;
  // The reserved pair is a legal key of this store like any other, so a smart row carries its own
  // flag and turning it on leaves every account's own row exactly as it was.
  return readUnreadOnly(selection.accountId, selection.mailboxId);
}

/**
 * Turn "only unread" on or off for the mailbox on screen.
 *
 * A RELOAD, not a re-render, because the filter belongs to the server now: the old chip narrowed the
 * fifty rows a page held, so an inbox with hundreds of unread mails showed whichever few of them
 * happened to be on the first page and offered no way to reach the rest.
 *
 * The rows already on screen are deliberately left in place while the new page is in flight: the
 * pane's own client-side rule renders an instant approximation of the answer (turning it on hides the
 * read rows immediately) and the fuller answer replaces it. `nextBefore` is the one thing that must
 * go, because a cursor issued for the other set would page the wrong list from a click landing in
 * that window.
 *
 * The PAIR is passed in rather than read from the selection, because the sidebar's own row menu can
 * turn the filter on for a folder that is not the one on screen, and reading `state.selected` here
 * made every such click silently act on whatever the middle pane happened to be showing.
 */
export function setMailUnreadOnly(accountId: string, mailboxId: string, on: boolean): Promise<void> {
  const selection = { accountId, mailboxId };
  if (!accountId || !mailboxId || !unreadFilterable(selection)) return Promise.resolve();
  writeUnreadOnly(accountId, mailboxId, on);
  // Only the folder on screen has a page to reload: the preference is what every later read of the
  // other folder will carry.
  //
  // And a folder that is NOT on screen gets a sentence, in the same channel the pane's fetch answers
  // use. Nothing else changed on screen (not one row, not the header, not a single number), so the
  // click was indistinguishable from a miss: the only proof it landed was the item's own label on
  // reopening the menu.
  if (!sameSelection(selection)) {
    setMailPaneNote(unreadOnlyAnswer(accountId, mailboxId, on));
    return Promise.resolve();
  }
  // Toggling the filter is the other moment the overlay's job ends: the page it was holding a read
  // row on is being rebuilt from the other question entirely (see `applySelection`).
  patch({ nextBefore: null, listError: null, pendingSeen: settledFlipsDropped() });
  return loadMailMessages(true);
}

/**
 * What the pane says about a preference written for a folder nobody is looking at.
 *
 * Names the FOLDER, from the live mailbox row, because the whole complaint is that the sentence about
 * "this folder" would be read next to a list of another folder's mail. Falls back to the id, which is
 * the only name a folder the console has not listed yet has.
 */
export function unreadOnlyAnswer(accountId: string, mailboxId: string, on: boolean): string {
  const row = (store.state.mailboxes[accountId] ?? []).find((one) => one.mailboxId === mailboxId);
  const name = row ? folderLabel(row) : mailboxId;
  return on
    ? `${name} now shows only unread messages.`
    : `${name} now shows every message.`;
}

/**
 * The plain text of one message, for a reply or a forward started from a LIST row.
 *
 * The quote builder falls back to the attribution line alone when it is handed no text, and the
 * reader was its only caller (it always has the open body). From a row there is no body at all, so a
 * reply would have saved a draft holding "On <date>, <sender> wrote:" and nothing underneath it, and
 * a draft is written to the server as soon as it opens: the wrong thing would be stored before
 * anybody typed. Null means the composer must not be opened.
 *
 * Deliberately NOT `markReadIfAllowed`, and it does not touch `state.open` or the selection: reading
 * a body to quote it is not opening the message, and this whole menu exists so that a right-click
 * does not mark anything read.
 */
export function loadMessageBodyForQuote(accountId: string, messageId: string): Promise<string | null> {
  const pair = pairKey(accountId, messageId);
  return run(`quote:${pair}`, async () => {
    setMailRowNote('Fetching the message to quote.', pair);
    try {
      const answer = await readMailMessage(accountId, messageId);
      // The HTML half is quoted when the provider sent no text half, which is most newsletters: the
      // attribution line with nothing under it was being SAVED as a draft the moment the composer
      // opened (see `bodyQuoteText`). '' stays null: there is genuinely nothing to quote.
      quoted = { pair, text: bodyQuoteText(answer.body) || null };
      clearMailRowNote();
    } catch (error) {
      const failure = mailFailure(error);
      quoted = { pair, text: null };
      log.warn('mail', 'body read for a quote failed', { accountId, messageId, error: failure.message });
      const row = [...store.state.messages, ...store.state.search.messages]
        .find((one) => one.accountId === accountId && one.messageId === messageId);
      // Names the row: somebody working down a list has just touched several, and no draft was made.
      // TWO SENTENCES, the folder-fetch rule (`folderFetchSentence`): Walnut's sentence ends, then the
      // provider's own text follows as its own, because nothing here can promise its shape.
      setMailRowNote(
        `Walnut could not read ${row ? mailRowLabel(row) : 'that message'}, so no reply was started.`
        + ` ${failure.message}`,
        pair,
      );
    }
  }).then(() => (quoted?.pair === pair ? quoted.text : null));
}

/**
 * The body the last quote read produced, held for the caller that awaited it.
 *
 * `run` hands every caller the same promise and no value, which is what the coalescing is for (a
 * double click on Reply is one read). ONE slot rather than a map, so a six-thousand-word mail is not
 * kept alive by a cache nobody empties; two callers of the same read both see it.
 */
let quoted: { pair: string; text: string | null } | null = null;

onMailStoreReset(() => { quoted = null; });

export function loadMailMessages(force = false, options: { fresh?: boolean } = {}): Promise<void> {
  const selection = store.state.selected;
  if (!selection) return Promise.resolve();
  if (options.fresh) freshPageWanted = true;
  const role = smartRoleOf(selection);
  if (role) {
    const page = loadMessagePage(selection, null, force);
    // All Drafts is the per-account Drafts row's two halves, merged: this console's own drafts (one
    // request already covers every account) above the providers' drafts folders.
    if (role !== 'drafts') return page;
    return Promise.all([loadMailDrafts(force), page]).then(() => undefined);
  }
  if (selection.mailboxId === DRAFTS_MAILBOX) {
    const mailboxId = pageMailboxOf(selection);
    // Two stores, so two reads: the drafts this console wrote, and the provider's drafts folder.
    const local = loadMailDrafts(force);
    if (!mailboxId) {
      // No server folder to show. Any page left from another mailbox has to go, or its rows would
      // appear under a section header that does not describe them.
      if (store.state.messages.length > 0) patch({ messages: [], nextBefore: null });
      return local;
    }
    return Promise.all([local, loadMessagePage(selection, mailboxId, force)]).then(() => undefined);
  }
  return loadMessagePage(selection, selection.mailboxId, force);
}

/**
 * The first page of a mailbox.
 *
 * ONE key per selection, deliberately NOT keyed on the unread flag: two loads of the same mailbox
 * under different filters would both land in `messages` and the slower one would win. A toggle
 * arriving mid-flight therefore rides `force`, which queues exactly one more pass, and the pass
 * re-reads the preference.
 */
function loadMessagePage(selection: MailSelection, mailboxId: string | null, force: boolean): Promise<void> {
  return run(`messages:${selectionKey(selection)}`, async () => {
    patch({ listLoading: true, listError: null });
    const unread = unreadOnlyFor(selection);
    const fresh = freshPageWanted;
    freshPageWanted = false;
    try {
      const askedAt = Date.now();
      const page = await listMailMessages({ ...pageQuery(selection, mailboxId), ...(fresh ? { fresh: true } : {}) });
      // The human may have moved to another mailbox while this was in flight.
      if (!sameSelection(selection)) return;
      // The server is still asking the provider about these folders; the sync line says so until each ends.
      noteUnreadChecking(page.checking, askedAt);
      const rows = page.messages ?? [];
      // Rows on screen retire the fetch note whatever it said: they are the outcome it was waiting
      // for, and a "fetching" line above a full list is the console describing its own past.
      const key = selectionKey(selection);
      const settled = rows.length > 0 && !!store.state.folderFetch[key];
      const held = { ...store.state.folderFetch };
      if (settled) delete held[key];
      patch({
        // The message being read is not in a fresh unread answer any more, because opening it is
        // what marked it read, and neither is a row this console has just flipped from a menu. Both
        // stay until another row is selected; see `keepOpenRow`.
        messages: unread
          ? keepOpenRow(rows, store.state.messages, store.state.open, Object.keys(store.state.pendingSeen))
          : rows,
        nextBefore: page.nextBefore ?? null,
        listLoading: false,
        ...(settled ? { folderFetch: held } : {}),
        ...confirmedPendingSeen(rows),
      });
      // NOTHING CACHED AND NEVER FETCHED is not an empty folder, it is a folder whose turn in the
      // sweep has not come. On an account with 67 folders that turn is an hour away, so the folder
      // somebody just opened asks for itself. Once per selection, and never for the unread filter's
      // empty answer (that page is a question about flags, not about whether the folder is here).
      if (rows.length === 0 && !unread && !folderEverFetched(selection)) {
        void fetchSelectedFolder(true);
      }
    } catch (error) {
      if (!sameSelection(selection)) return;
      const expected = standIn(error);
      patch({
        listLoading: false,
        listError: expected ? expected.detail : mailFailure(error).message,
      });
    }
  }, force);
}

/**
 * Pending flips the server has now agreed with, as a patch fragment that forgets them.
 *
 * A page read is the confirmation: the rows come from the plugin's own cache, so a row that arrives
 * carrying the flag this console guessed means the overlay has nothing left to protect. Kept forever
 * it would keep subtracting one from every later landing, and the badge would drift low by exactly
 * the number of rows the human ever touched.
 */
function confirmedPendingSeen(rows: MailMessageDto[]): Partial<MailSnapshot> {
  const pending = store.state.pendingSeen;
  if (Object.keys(pending).length === 0) return {};
  let changed = false;
  const held = { ...pending };
  for (const row of rows) {
    const pair = pairKey(row.accountId, row.messageId);
    const wanted = held[pair];
    if (wanted === undefined || row.flags.includes(SEEN) !== wanted) continue;
    delete held[pair];
    forgetFlipCounted(pair);
    changed = true;
  }
  return changed ? { pendingSeen: held } : {};
}

export function loadOlderMailMessages(): Promise<void> {
  const selection = store.state.selected;
  const before = store.state.nextBefore;
  if (!selection || before === null) return Promise.resolve();
  const mailboxId = pageMailboxOf(selection);
  if (!mailboxId && !smartRoleOf(selection)) return Promise.resolve();
  return run(`older:${selectionKey(selection)}:${before}`, async () => {
    patch({ olderLoading: true });
    try {
      // The same query as page 1 plus the cursor, from the one builder: the cursor was issued for
      // that query, so a second page assembled from different parameters continues a different list.
      const page = await listMailMessages({ ...pageQuery(selection, mailboxId), before });
      if (!sameSelection(selection)) return;
      // Appending is also what keeps a row the server has stopped returning: a message read while the
      // filter is on is already in this list, and it is not in any later page.
      //
      // Keyed by PAIR, because a merged list is the first place two providers' id spaces share a
      // column: a bare messageId set lets account A's ids silently delete account B's rows.
      const known = new Set(store.state.messages.map((one) => pairKey(one.accountId, one.messageId)));
      patch({
        messages: [
          ...store.state.messages,
          ...(page.messages ?? []).filter((one) => !known.has(pairKey(one.accountId, one.messageId))),
        ],
        nextBefore: page.nextBefore ?? null,
        olderLoading: false,
      });
    } catch (error) {
      patch({ olderLoading: false, listError: mailFailure(error).message });
    }
  });
}

// ── the open message ──

/**
 * Open one message.
 *
 * `retry` is only ever set by a human pressing "Try again" on a body the provider could not hand
 * over: the plugin caches that failure and answers every later read with it until asked to retry.
 * It is part of the coalescer key for the same reason, or a retry arriving while an ordinary read
 * is in flight would be served by that read and change nothing.
 */
export function openMailMessage(
  accountId: string,
  messageId: string,
  opts?: { retry?: boolean },
): Promise<void> {
  const retry = opts?.retry === true;
  // The composer and the reader share ONE pane, so opening a message closes the composer. The draft
  // is already saved and one click away in Drafts; leaving the composer up would make this click
  // look like it did nothing at all.
  if (store.state.composer) void closeMailComposer();
  const seq = ++store.openSeq;
  // Reading a message is using its identity, which is what makes New message from a merged list write
  // as the account whose mail is on screen rather than as whichever account happens to be listed first.
  noteMailIdentity(accountId);
  const known = [...store.state.messages, ...store.state.search.messages]
    .find((one) => one.messageId === messageId && one.accountId === accountId) ?? null;
  patch({
    // The Ask drawer sits in this pane too, so opening a message closes it. The person asked for the
    // message; leaving the drawer up would make the click look like it did nothing.
    ask: null,
    open: {
      accountId,
      messageId,
      message: known,
      body: null,
      bodyError: null,
      loading: true,
      error: null,
      allowRemoteImages: false,
      taskBusy: false,
      taskError: null,
    },
  });
  return run(`message:${pairKey(accountId, messageId)}${retry ? ':retry' : ''}`, async () => {
    try {
      const answer = await readMailMessage(accountId, messageId, { retry });
      if (seq !== store.openSeq) return;
      patch({
        open: {
          accountId,
          messageId,
          message: answer.message,
          body: answer.body ?? null,
          bodyError: answer.bodyError ?? null,
          loading: false,
          error: null,
          allowRemoteImages: store.state.open?.allowRemoteImages ?? false,
          taskBusy: false,
          taskError: null,
        },
      });
      await markReadIfAllowed(answer.message);
    } catch (error) {
      if (seq !== store.openSeq) return;
      const failure = mailFailure(error);
      const open = store.state.open;
      patch({ open: open ? { ...open, loading: false, error: failure.message } : open });
      log.warn('mail', 'message read failed', { accountId, messageId, error: failure.message });
    }
  }, true);
}

export function closeMailMessage(): void {
  store.openSeq += 1;
  patch({ open: null });
}

/** Per message, and never remembered: opening the next body starts blocked again. */
export function allowRemoteImagesForOpenMessage(): void {
  const open = store.state.open;
  if (!open) return;
  patch({ open: { ...open, allowRemoteImages: true } });
}

export function retryOpenMessageBody(): Promise<void> {
  const open = store.state.open;
  if (!open) return Promise.resolve();
  // Only a remembered BODY failure needs the retry flag; a failed envelope read is not cached.
  return openMailMessage(open.accountId, open.messageId, { retry: !!open.bodyError });
}


// ── deep links ──

/**
 * Open one message from a link somewhere else in Walnut (a task's backlink, a digest letter).
 *
 * ONE read, not two: the message is fetched first because its `mailboxId` is what decides which
 * mailbox the middle pane should be showing, and the same answer is then placed as the open message
 * rather than read again. An id that no longer resolves leaves the console on whatever it was
 * showing and says so in one line, because a link from a task made months ago is allowed to point
 * at a message the cache has since dropped.
 */
export function openMailDeepLink(accountId: string, messageId: string): Promise<void> {
  return run(`deep-link:${pairKey(accountId, messageId)}`, async () => {
    const seq = ++store.openSeq;
    try {
      const answer = await readMailMessage(accountId, messageId);
      // `selectMailbox` clears the open message, so it goes FIRST and the reader is filled after.
      selectMailbox(accountId, answer.message.mailboxId);
      if (seq !== store.openSeq) return;
      patch({
        open: {
          accountId,
          messageId,
          message: answer.message,
          body: answer.body ?? null,
          bodyError: answer.bodyError ?? null,
          loading: false,
          error: null,
          allowRemoteImages: false,
          taskBusy: false,
          taskError: null,
        },
      });
      await markReadIfAllowed(answer.message);
    } catch (error) {
      const failure = mailFailure(error);
      log.warn('mail', 'deep link could not be opened', { accountId, messageId, error: failure.message });
      patch({
        refreshNote: failure.status === 404
          ? 'That message is not in the cache any more, so Mail opened without it.'
          : `That link could not be opened: ${failure.message}`,
      });
    }
  }, true);
}

// ── search ──

export function runMailSearch(query: string): Promise<void> {
  const trimmed = query.trim();
  if (!trimmed) { clearMailSearch(); return Promise.resolve(); }
  // A merged list is every account, so its search is too: the route reads a missing `account` as
  // "all of them". Sending the reserved id instead would filter by an account no provider has and
  // answer zero rows under "Nothing matched", which reads as lost mail.
  const selection = store.state.selected;
  const accountId = selection && !isSmartSelection(selection) ? selection.accountId : undefined;
  patch({ search: { ...store.state.search, query: trimmed, active: true, loading: true, error: null } });
  return run(`search:${pairKey(accountId ?? '', trimmed)}`, async () => {
    try {
      const answer = await searchMail({ ...(accountId ? { accountId } : {}), q: trimmed, limit: PAGE_SIZE });
      if (store.state.search.query !== trimmed) return;
      patch({
        search: {
          query: trimmed,
          active: true,
          loading: false,
          source: answer.source,
          messages: answer.messages ?? [],
          error: null,
        },
      });
    } catch (error) {
      if (store.state.search.query !== trimmed) return;
      patch({
        search: { ...store.state.search, loading: false, error: mailFailure(error).message },
      });
    }
  }, true);
}

export function clearMailSearch(): void {
  patch({ search: EMPTY_SEARCH });
}

// ── writes and refresh ──

/**
 * Ask for a sync now.
 *
 * A 202 (`completed: false`) is the honest answer for a big mailbox and not a failure: the note
 * says it is still running and the live events finish the job.
 */
export function requestMailRefresh(accountId?: string): Promise<void> {
  return run(`refresh:${accountId ?? 'all'}`, async () => {
    patch({ refreshing: true, refreshNote: null });
    store.refreshNoteAccount = null;
    try {
      // The list on screen FIRST: each folder it is made of is polled on its own, and the page is read
      // again with its unread check forced. The sweep over everything else comes after, and the loop runs
      // one job at a time, so it cannot overtake these.
      await refreshPageFolders(accountId);
      const answer = await refreshMail(accountId);
      if (!answer.completed) {
        // Remembered so the sync's own event can take the note down again; a note that outlives
        // the sync it describes turns into a permanent "still syncing" nobody believes.
        store.refreshNoteAccount = accountId ?? null;
        patch({ refreshNote: 'Still syncing. New mail lands here as it arrives.' });
      }
      await loadAccounts(true);
      const accounts = accountId ? [accountId] : store.state.accounts.map((one) => one.accountId);
      await Promise.all(accounts.map((one) => loadMailboxesFor(one, true)));
      await loadMailMessages(true);
    } catch (error) {
      const expected = standIn(error);
      patch(expected ? { stand: expected } : { refreshNote: mailFailure(error).message });
    } finally {
      patch({ refreshing: false });
    }
  });
}

/**
 * Poll the folders the page on screen is made of, then read the page again with `fresh`.
 *
 * A failure here is not the refresh's failure: the full sweep that follows polls them too, and its own
 * outcome is what the note reports.
 */
async function refreshPageFolders(accountId: string | undefined): Promise<void> {
  const selection = store.state.selected;
  if (!selection) return;
  const role = smartRoleOf(selection);
  const pairs = role
    ? smartPairs(store.state.mailboxes, store.state.accounts, role)
    : (() => {
      const mailboxId = pageMailboxOf(selection);
      return mailboxId ? [{ accountId: selection.accountId, mailboxId }] : [];
    })();
  const wanted = pairs.filter((pair) => !accountId || pair.accountId === accountId);
  if (wanted.length === 0) return;
  await Promise.all(wanted.map((pair) => fetchMailbox(pair.accountId, pair.mailboxId).catch((error) => {
    log.info('mail', 'refresh could not poll a folder on screen first', {
      accountId: pair.accountId, mailboxId: pair.mailboxId, error: mailFailure(error).message,
    });
  })));
  if (sameSelection(selection)) await loadMailMessages(true, { fresh: true });
}

/**
 * Add an account. THROWS on failure, deliberately: the dialog is the only place that can say
 * "that password was refused" next to the field the human just typed into, so it must see the
 * failure rather than find a message in the store.
 */
export async function addMailAccount(
  providerId: string,
  values: Record<string, string>,
): Promise<string> {
  const answer = await createMailAccount(providerId, values);
  const accountId = answer.account.accountId;
  store.preferAccount = accountId;
  await loadAccounts(true);
  await loadMailboxesFor(accountId, true);
  // Not awaited: the dialog closes now, and the panes fill in as the first sync lands.
  void requestMailRefresh(accountId);
  return accountId;
}

// ── lifecycle ──

/**
 * The numbers the sidebar badge needs, without opening the console.
 *
 * Accounts plus each account's mailboxes, because the badge counts INBOXES (see `publishBadge`)
 * and mailbox unread is where that number lives. These reads share the console's own keys, so a
 * later mount costs nothing and finds the panes already populated.
 *
 * PROVIDERS ride along, even though no badge needs them, to keep one invariant: a store that says
 * `loaded` has asked for its providers. Without it this preload marks the store loaded, the console
 * then takes its "already loaded" path, and the empty state says "install a provider plugin" on a
 * machine with two installed, while `markRead` looks unsupported because the capability is unknown.
 */
export function loadMailBadgeSource(): Promise<void> {
  return run('badge-source', async () => {
    await Promise.all([loadProviders(), loadAccounts(true)]);
    // No pick: this runs in a tab that never opened Mail, and picking a row reads that row's page for a
    // pane nobody is looking at. The console's own open resolves the row (see `openMailConsole`).
    await loadEveryMailboxList(false, false);
  });
}

export function openMailConsole(): Promise<void> {
  // A second mount while the first is still booting JOINS it (`run` coalesces by key). React runs an
  // effect twice in development and the accounts read marks the store loaded before the boot has its page,
  // so the second call used to take the refresh path and read every list and the merged page AGAIN, 38ms
  // after the first: three identical cross-account pages for one open.
  // `force: false`, so a second mount JOINS the refresh the first one started instead of queueing another
  // pass over every list and the page (`run`'s force is "one more pass", which is what a human pressing
  // Refresh mid-flight wants and what a duplicate mount must not do).
  if (store.state.loaded && !isRunning('bootstrap')) return refreshMailAll(false);
  return run('bootstrap', async () => {
    patch({ loading: true });
    try {
      // Drafts ride along with the accounts: the Drafts row's count badge is part of the first
      // paint of the left pane, and every account's drafts arrive in ONE request.
      await Promise.all([loadProviders(), loadAccounts(), loadMailDrafts()]);
      // A selection change has already started this row's page (see `applySelection`), and this call
      // carries no `force`, so it joins that request rather than queueing a second pass over the same
      // rows. It still has to be awaited: with the row unchanged it is the only page read there is.
      await loadEveryMailboxList();
      await loadMailMessages();
    } finally {
      patch({ loading: false });
    }
  });
}

/**
 * Read everything again: accounts, drafts, every folder list, and the page on screen.
 *
 * `force` is what a HUMAN pressing Refresh means (do it again even if one is running) and what a socket
 * reconnect means (the gap lost events). Entering the console passes false: it wants the console fresh, and
 * a refresh already in flight is exactly that.
 */
export function refreshMailAll(force = true): Promise<void> {
  return run('refresh-all', async () => {
    await Promise.all([loadAccounts(true), loadMailDrafts(true)]);
    const changed = await loadEveryMailboxList(true);
    // `force` ONLY when the row is the same one AND no page for it is already on its way: a changed row has
    // a fresh page in flight already, and forcing on top of one queues a second identical read of a
    // cross-account scan (see `isRunning`).
    const selected = store.state.selected;
    const onItsWay = !!selected && isRunning(`messages:${selectionKey(selected)}`);
    await loadMailMessages(!changed && !onItsWay);
  }, force);
}

/**
 * Take down the "still syncing" note once that sync reports in.
 *
 * A note about ONE account is only answered by that account's event; a note from a refresh of
 * everything is answered by the first event of any of them, since there is no per-account note.
 */
function clearRefreshNoteFor(accountId: string | undefined): void {
  if (!store.state.refreshNote) return;
  const owner = store.refreshNoteAccount;
  if (owner && accountId && owner !== accountId) return;
  store.refreshNoteAccount = null;
  patch({ refreshNote: null });
}

/**
 * A `plugin:mail:*` bus event. Names arrive without the prefix.
 *
 * An event that lands before the first load is answered with the ACCOUNTS read alone, which is one
 * small request and is most of what the sidebar badge needs. The subscription is held for the whole
 * session by `mail-live.ts`, so this runs in a tab that never opened Mail: that is what keeps the
 * badge moving, and it is why nothing here pulls a page unless a pane is showing that mailbox.
 */
export function onMailEvent(name: string, data: unknown): void {
  const payload = (data ?? {}) as {
    accountId?: string;
    mailboxId?: string;
    messageId?: string;
    taskId?: string;
    added?: number;
    /** `unsubscribed` carries these two. See the branch below. */
    status?: string;
    method?: string;
    /** `unread-reconciled`: how many cached rows the check marked read. */
    cleared?: number;
  };
  if (name === 'providers-changed') { void loadProviders(true); return; }

  // A task made anywhere (this tab, another tab, an agent). Ahead of the loaded gate and it makes no
  // request at all: it stamps the rows this console is already holding, and a console holding none
  // has nothing to do, since the backlink is derived on every read anyway.
  if (name === 'message-tasked') {
    if (payload.accountId && payload.messageId && payload.taskId) {
      applyMessageTask(payload.accountId, payload.messageId, payload.taskId);
    }
    return;
  }
  // The digest is a LETTER, so nothing in this console changes. What DOES need saying is that the
  // letter list is now out of date: this subscription is session-scoped and runs with the bell shut,
  // and the letter store serves a cached list for 15s to whoever opens next. That is exactly how long
  // it takes to reach for the bell after a digest lands, so the letter it was sent for would be
  // missing from the list. Marking it stale costs one number and no request.
  if (name === 'digest-sent') { invalidateLetterList(); return; }

  // The write path's two events, ahead of the loaded gate on purpose: an open composer's status
  // card is the one screen where staleness reads as "did my mail go or not", and the handler makes
  // no request unless it is about the draft on screen or the console has already loaded its list.
  if (name === 'draft-changed' || name === 'send-settled') { onMailDraftEvent(name, data); return; }

  if (!store.state.loaded) { void loadAccounts(true); return; }

  if (name === 'account-changed' || name === 'account-health') {
    void loadAccounts(true);
    if (payload.accountId) void loadMailboxesFor(payload.accountId, true);
    return;
  }
  // An unsubscribe settled, here or in another tab. The row it names is stamped with no request at all;
  // a `done` also reloads the page, because leaving a LIST turns every other cached message of that list
  // into `done` with `scope: 'list'` and only the server's own ledger query knows which those are.
  if (name === 'unsubscribed') {
    onMailUnsubscribed(payload);
    if (payload.status === 'done') void loadMailMessages(true);
    return;
  }
  // Mail read somewhere else, found out late: an unread check (the poll loop's, or one a page started and
  // outlived) cleared rows that may still be on screen. Not a sync, so no refresh note is retired; the
  // folder counts it moved arrive by their own `mailbox-counts` event once the loop re-lists them.
  //
  // It also ENDS a check a page said was running, whatever it found, which is what takes `Checking…` down.
  // Only a check that cleared rows changed anything worth a request.
  if (name === 'unread-reconciled') {
    settleUnreadCheck(payload.accountId, payload.mailboxId);
    if ((payload.cleared ?? 0) <= 0) return;
    void loadAccounts(true);
    if (eventIsForPageOnScreen(payload.accountId, payload.mailboxId)) void loadMailMessages(true);
    return;
  }
  // A folder's own count moved with no row changing (mail read on a phone lowers the inbox count while
  // the poll lists nothing new), so the sidebar numbers are read again. The list itself did not move.
  if (name === 'mailbox-counts') {
    if (payload.accountId) void loadMailboxesFor(payload.accountId, true);
    return;
  }
  if (name === 'sync-completed' || name === 'messages-received') {
    clearRefreshNoteFor(payload.accountId);
    void loadAccounts(true);
    // Noted BEFORE the mailbox read, so it rides in the same patch as the rows it promotes.
    noteArrival(payload.accountId, payload.mailboxId, payload.added);
    if (payload.accountId) void loadMailboxesFor(payload.accountId, true);
    if (eventIsForPageOnScreen(payload.accountId, payload.mailboxId)) void loadMailMessages(true);
  }
}

/**
 * Whether an event about (account, mailbox) belongs to the list on screen.
 *
 * For a merged list the question is asked of the PAIRS that list is made of, the same pairs the
 * server's scope resolves to: the reserved accountId matches no real account, so comparing it would
 * freeze the merged list while the badges next to it kept moving. A missing half is the loose reading
 * (`messages-received` carries no mailboxId): any account taking part is news for this pane.
 */
function eventIsForPageOnScreen(accountId: string | undefined, mailboxId: string | undefined): boolean {
  const selection = store.state.selected;
  if (!selection) return false;
  const role = smartRoleOf(selection);
  if (role) {
    return smartPairs(store.state.mailboxes, store.state.accounts, role).some((pair) => (
      (!accountId || pair.accountId === accountId) && (!mailboxId || pair.mailboxId === mailboxId)
    ));
  }
  // The page on screen, by the mailbox it was READ from: with the Drafts row open that is the
  // provider's drafts folder, so a sync of that folder is news for this pane too.
  return (!accountId || accountId === selection.accountId)
    && (!mailboxId || mailboxId === pageMailboxOf(selection));
}
