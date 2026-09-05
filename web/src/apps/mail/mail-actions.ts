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
  listMailAccounts,
  listMailMessages,
  listMailProviders,
  listMailboxes,
  mailFailure,
  readMailMessage,
  refreshMail,
  searchMail,
} from '@/api/mail';
import { log } from '@/utils/log';
import { closeMailComposer, onMailDraftEvent } from './compose/compose-actions';
import { loadMailDrafts } from './compose/compose-drafts';
import { markReadIfAllowed } from './mail-read-flag';
import {
  DRAFTS_MAILBOX,
  EMPTY_SEARCH,
  PAGE_SIZE,
  pairKey,
  patch,
  publishBadge,
  run,
  sameSelection,
  selectionKey,
  standIn,
  store,
} from './mail-store';

// ── reads ──

function loadProviders(force = false): Promise<void> {
  return run('providers', async () => {
    try {
      const answer = await listMailProviders();
      patch({ providers: answer.providers ?? [] });
    } catch (error) {
      log.warn('mail', 'provider list failed', { error: mailFailure(error).message });
    }
  }, force);
}

function loadAccounts(force = false): Promise<void> {
  return run('accounts', async () => {
    try {
      const answer = await listMailAccounts();
      patch({ accounts: answer.accounts ?? [], stand: null, error: null, loaded: true });
      publishBadge();
    } catch (error) {
      const expected = standIn(error);
      if (expected) patch({ stand: expected, error: null });
      else patch({ error: mailFailure(error).message });
    }
  }, force);
}

function loadMailboxesFor(accountId: string, force = false): Promise<void> {
  return run(`mailboxes:${accountId}`, async () => {
    try {
      const answer = await listMailboxes(accountId);
      patch({ mailboxes: { ...store.state.mailboxes, [accountId]: answer.mailboxes ?? [] } });
      ensureSelection();
    } catch (error) {
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
function ensureSelection(): void {
  const state = store.state;
  if (state.selected && state.mailboxes[state.selected.accountId]?.some(
    (mailbox) => mailbox.mailboxId === state.selected!.mailboxId,
  )) return;
  const preferred = store.preferAccount;
  const order = preferred
    ? [...state.accounts].sort((a, b) => (a.accountId === preferred ? -1 : b.accountId === preferred ? 1 : 0))
    : state.accounts;
  for (const account of order) {
    const mailboxes = state.mailboxes[account.accountId] ?? [];
    const target = mailboxes.find((mailbox) => mailbox.role === 'inbox') ?? mailboxes[0];
    if (!target) continue;
    if (preferred === account.accountId) store.preferAccount = null;
    selectMailbox(account.accountId, target.mailboxId);
    return;
  }
}

export function selectMailbox(accountId: string, mailboxId: string): void {
  const selected = store.state.selected;
  if (selected && selected.accountId === accountId && selected.mailboxId === mailboxId) return;
  patch({
    selected: { accountId, mailboxId },
    messages: [],
    nextBefore: null,
    listError: null,
    open: null,
    search: EMPTY_SEARCH,
  });
  void loadMailMessages();
}

export function loadMailMessages(force = false): Promise<void> {
  const selection = store.state.selected;
  if (!selection) return Promise.resolve();
  // The Drafts row is a virtual mailbox: no provider has it, and asking the messages route for it
  // would be a request for a folder that does not exist. Its rows come from the drafts route.
  if (selection.mailboxId === DRAFTS_MAILBOX) return loadMailDrafts(force);
  return run(`messages:${selectionKey(selection)}`, async () => {
    patch({ listLoading: true, listError: null });
    try {
      const page = await listMailMessages({
        accountId: selection.accountId,
        mailboxId: selection.mailboxId,
        limit: PAGE_SIZE,
      });
      // The human may have moved to another mailbox while this was in flight.
      if (!sameSelection(selection)) return;
      patch({
        messages: page.messages ?? [],
        nextBefore: page.nextBefore ?? null,
        listLoading: false,
      });
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

export function loadOlderMailMessages(): Promise<void> {
  const selection = store.state.selected;
  const before = store.state.nextBefore;
  if (!selection || before === null) return Promise.resolve();
  return run(`older:${selectionKey(selection)}:${before}`, async () => {
    patch({ olderLoading: true });
    try {
      const page = await listMailMessages({
        accountId: selection.accountId,
        mailboxId: selection.mailboxId,
        limit: PAGE_SIZE,
        before,
      });
      if (!sameSelection(selection)) return;
      const known = new Set(store.state.messages.map((one) => one.messageId));
      patch({
        messages: [...store.state.messages, ...(page.messages ?? []).filter((one) => !known.has(one.messageId))],
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
  const known = [...store.state.messages, ...store.state.search.messages]
    .find((one) => one.messageId === messageId && one.accountId === accountId) ?? null;
  patch({
    open: {
      accountId,
      messageId,
      message: known,
      body: null,
      bodyError: null,
      loading: true,
      error: null,
      allowRemoteImages: false,
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


// ── search ──

export function runMailSearch(query: string): Promise<void> {
  const trimmed = query.trim();
  if (!trimmed) { clearMailSearch(); return Promise.resolve(); }
  const accountId = store.state.selected?.accountId;
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
    await Promise.all(store.state.accounts.map((account) => loadMailboxesFor(account.accountId)));
  });
}

export function openMailConsole(): Promise<void> {
  if (store.state.loaded) return refreshMailAll();
  return run('bootstrap', async () => {
    patch({ loading: true });
    try {
      // Drafts ride along with the accounts: the Drafts row's count badge is part of the first
      // paint of the left pane, and every account's drafts arrive in ONE request.
      await Promise.all([loadProviders(), loadAccounts(), loadMailDrafts()]);
      await Promise.all(store.state.accounts.map((account) => loadMailboxesFor(account.accountId)));
      ensureSelection();
      await loadMailMessages();
    } finally {
      patch({ loading: false });
    }
  });
}

export function refreshMailAll(): Promise<void> {
  return run('refresh-all', async () => {
    await Promise.all([loadAccounts(true), loadMailDrafts(true)]);
    await Promise.all(store.state.accounts.map((account) => loadMailboxesFor(account.accountId, true)));
    ensureSelection();
    await loadMailMessages(true);
  }, true);
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
  const payload = (data ?? {}) as { accountId?: string; mailboxId?: string };
  if (name === 'providers-changed') { void loadProviders(true); return; }

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
  if (name === 'sync-completed' || name === 'messages-received') {
    clearRefreshNoteFor(payload.accountId);
    void loadAccounts(true);
    if (payload.accountId) void loadMailboxesFor(payload.accountId, true);
    const selection = store.state.selected;
    const mine = selection
      && (!payload.accountId || payload.accountId === selection.accountId)
      && (!payload.mailboxId || payload.mailboxId === selection.mailboxId);
    if (mine) void loadMailMessages(true);
  }
}
