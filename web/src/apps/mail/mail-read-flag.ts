/**
 * The optimistic read flag: the one piece of arithmetic this console owns.
 *
 * Server-side, a mailbox's unread count comes from the PROVIDER and only moves on the next mailbox
 * refresh, so nothing on the server can make the badge drop the moment a message is opened. That
 * leaves the browser holding four numbers that have to move together (the row's flags, the open
 * reader's copy of it, the mailbox badge, the account total) and holding all four back when the
 * provider refuses. It is split into its own file because it is the part that is worth reading in
 * one sitting.
 */
import { mailFailure, markMailMessageRead, type MailMessageDto } from '@/api/mail';
import { log } from '@/utils/log';
import { providerFor } from './mail-providers';
import { forgetFlipCounted, noteFlipCounted } from './mail-seen-clock';
import {
  SEEN,
  clearMailRowNote,
  mailRowLabel,
  onMailStoreReset,
  pairKey,
  patch,
  publishBadge,
  run,
  setMailRowNote,
  store,
} from './mail-store';

/**
 * A MESSAGE's identity is (accountId, messageId), never the id alone.
 *
 * The id space belongs to the provider and Walnut may assume nothing about its shape, and the merged
 * smart lists are the first surface where two providers' id spaces share one column. Every match in
 * this file goes through here, the same way `mail-task-actions.ts` and `mail-unread-filter.ts`
 * already do: an id-only match let one account's already-read row make marking the OTHER account's
 * message read a silent no-op, and let a server answer overwrite a row with another account's sender
 * and subject.
 */
function handle(one: { accountId: string; messageId: string }): string {
  return pairKey(one.accountId, one.messageId);
}

/**
 * May this account's read flag be moved? Three answers, and the third is what this bug was about.
 *
 * `true`/`false` come from the provider's declared `capabilities.markRead`, which is DATA: a provider
 * that cannot change the flag answers 409 and the console must not pretend, or the mailbox drifts
 * from what every other mail client shows. But a provider list that never LOADED is not an empty
 * one, and treating the two the same is what made a click do nothing at all, silently, for hours
 * (see mail-providers.ts). When the list still cannot be read, the call goes out and the SERVER
 * decides: its refusal is the same 409 both callers below already roll back.
 */
async function mayMarkRead(accountId: string): Promise<boolean> {
  const { provider, known } = await providerFor(accountId);
  if (provider) return provider.capabilities.markRead === true;
  return !known;
}

/** Mark the opened message read, unless the provider is known not to be able to (`mayMarkRead`). */
export async function markReadIfAllowed(message: MailMessageDto): Promise<void> {
  if (message.flags.includes(SEEN)) return;
  if (!await mayMarkRead(message.accountId)) return;
  // Re-read the row AFTER the await, not the captured copy: while a provider answer was in flight
  // the row may already have been marked read (two opens of the same message, a live event), and
  // applying the badge arithmetic twice would leave the count short.
  if (heldSeen(message)) return;

  applySeen(message, true);
  return markMailMessageRead(message.accountId, message.messageId, true)
    .then((answer) => {
      // The server's own row wins: it carries the provider's flags, not our guess.
      replaceMessage(answer.message);
    })
    .catch((error) => {
      const failure = mailFailure(error);
      applySeen(message, false);
      log.warn('mail', 'read flag refused, rolling the badge back', {
        accountId: message.accountId,
        messageId: message.messageId,
        code: failure.code,
        error: failure.message,
      });
    });
}

/**
 * The reader's own read-flag control: mark the open message read, or unread again.
 *
 * The same four numbers as the automatic path, moved the same way and put back the same way, which
 * is why it shares `applySeen` rather than repeating it. Gated the same way too (`mayMarkRead`).
 *
 * Marking unread does NOT stop the automatic mark: reopening the message reads it again, which is
 * what every mail client does. Unread here means "leave it on my list", and the list is what it
 * changes.
 */
export async function setOpenMessageRead(read: boolean): Promise<void> {
  const opened = store.state.open?.message;
  if (!opened) return;
  if (!await mayMarkRead(opened.accountId)) return;
  // Re-read AFTER the await for the same reason the automatic path does: a second press, or the
  // automatic mark landing in between, would otherwise move the badge twice off a stale copy.
  const open = store.state.open;
  const message = open && handle(open) === handle(opened) ? open.message : undefined;
  if (!message || message.flags.includes(SEEN) === read) return;

  applySeen(message, read);
  return markMailMessageRead(message.accountId, message.messageId, read)
    .then((answer) => { replaceMessage(answer.message); })
    .catch((error) => {
      const failure = mailFailure(error);
      applySeen(message, !read);
      log.warn('mail', 'read flag refused, rolling the badge back', {
        accountId: message.accountId,
        messageId: message.messageId,
        code: failure.code,
        error: failure.message,
      });
    });
}

/**
 * Mark ONE ROW read or unread, from a list, without opening it.
 *
 * The reader's toggle above, aimed at a row instead of at `store.state.open`, which is why it shares
 * `mayMarkRead`, `applySeen` and `replaceMessage` rather than repeating any of them: a second copy of
 * this arithmetic in a component is how the badge and the row start disagreeing.
 *
 * Three things it needs that the reader's toggle does not, all of them because the human is working
 * down a LIST and the row is not the thing they are looking at:
 *
 * - SERIALISED PER ROW (`run`), and the LAST INTENT WINS. Read then immediately unread used to land in
 *   arrival order, and `replaceMessage` let whichever answer came back last win: the row said one
 *   thing and the badge another. One key per pair means the second flip starts from the first one's
 *   outcome. `run` is FORCED, so a flip arriving mid-flight queues exactly one more pass, and the
 *   wanted state is read from `wantedSeen` inside that pass rather than captured: `run` keeps the
 *   FIRST caller's closure, so a captured `read` would replay the intent the human has moved off.
 * - THE COUNTS ARE PUT BACK, not un-deltaed. `applySeen` clamps at 0, so a mailbox that was already
 *   at 0 swallowed the forward step and the rollback then added one unread that never existed. The
 *   two numbers are recorded before the flip and written back verbatim.
 * - A FAILURE IS SAID OUT LOUD, naming the row. A rolled-back row looks exactly like one nobody has
 *   touched, and somebody right-clicking down fifteen rows reads that as a job done.
 */
export function setMailMessageRead(message: MailMessageDto, read: boolean): Promise<void> {
  const pair = handle(message);
  wantedSeen.set(pair, read);
  return run(`read:${pair}`, async () => {
    const want = wantedSeen.get(pair);
    if (want === undefined) return;
    if (!await mayMarkRead(message.accountId)) { forgetWanted(pair, want); return; }
    // Re-read THAT row after the await, the same gate both paths above use: the menu was built from
    // a payload snapshot taken at the right-click, and the row may have been flipped since (the
    // other tab, a sync, the reader). Applying the badge arithmetic off a stale copy is what leaves
    // the count short, so this returns without one `applySeen`.
    const row = heldRow(message);
    if (!row || row.flags.includes(SEEN) === want) { forgetWanted(pair, want); return; }
    const before = countsOf(row);
    markPending(pair, want);
    applySeen(row, want);
    try {
      const answer = await markMailMessageRead(row.accountId, row.messageId, want);
      // The server counts the flip from here on, so no later landing may subtract it again: that double
      // subtraction is what left the sidebar badge one unread low after the next refresh.
      noteFlipCounted(pair);
      // The server's own row wins: it carries the provider's flags, not our guess.
      //
      // The overlay is deliberately NOT retired here. A 200 means the FLAG was written; a mailbox's
      // unread count still comes from the provider's last refresh, and the `unread=1` page still
      // comes from the plugin's cache. Retiring it on the answer took the row off the filtered list
      // at the next `sync-completed` (two minutes) and bounced the badge back to the number that
      // still counted this row. It is retired by `confirmedPendingSeen` when a page read shows the
      // server agrees, and by a selection change or a filter toggle (`mail-actions.ts`), which is
      // when the list it was protecting stops being on screen.
      replaceMessage(answer.message);
    } catch (error) {
      const failure = mailFailure(error);
      applySeen(row, !want, before);
      clearPending(pair);
      patch({ flagFailed: { ...store.state.flagFailed, [pair]: flagFailureTitle(want, failure) } });
      // STICKY: a refusal is the one sentence somebody working down a list has to act on, and it used
      // to retire itself 12 seconds in while they were still going. It goes when this row's flip is
      // started again (`markPending`), when the selection changes, or when it is dismissed.
      setMailRowNote(flagFailureNote(row, want, failure), pair, { sticky: true });
      log.warn('mail', 'row read flag refused, rolling the badge back', {
        accountId: row.accountId,
        messageId: row.messageId,
        code: failure.code,
        error: failure.message,
      });
    }
    forgetWanted(pair, want);
    // Forced: a flip that arrives while this one is out queues exactly ONE more pass, which is what
    // makes the second intent land at all (`run` hands a mid-flight caller the running promise).
  }, true);
}

/**
 * The state each row is being flipped TO, newest intent only.
 *
 * Read inside the `run` body rather than captured, because `run` keeps the first caller's closure: a
 * captured `read` would make the queued second pass replay the intent the human has already moved
 * off, so pressing Mark as read and then Mark as unread ended up read.
 */
const wantedSeen = new Map<string, boolean>();

/**
 * The pairs whose flip is still out there, for the two places that retire the overlay.
 *
 * A selection change and a filter toggle drop the rows the overlay was protecting, so they drop the
 * overlay with them. An entry whose request has not answered yet is not theirs to drop: the rollback
 * still has to find that row and put it back where it was.
 */
export function mailFlipsInFlight(): ReadonlySet<string> {
  return new Set(wantedSeen.keys());
}

/** Forget an intent, unless a newer one has replaced it (that pass is already queued). */
function forgetWanted(pair: string, want: boolean): void {
  if (wantedSeen.get(pair) === want) wantedSeen.delete(pair);
}

// Module state the snapshot does not hold, so a reset has to clear it: an intent left behind would
// make the next case's first flip run against the last case's wanted state.
onMailStoreReset(() => { wantedSeen.clear(); });

/** The row this console is holding for that message, from whichever list holds it. */
function heldRow(message: MailMessageDto): MailMessageDto | null {
  const state = store.state;
  const key = handle(message);
  return state.messages.find((one) => handle(one) === key)
    ?? state.search.messages.find((one) => handle(one) === key)
    ?? (state.open?.message && handle(state.open) === key ? state.open.message : null);
}

/** The two numbers a flip moves, as they stand now. Written back verbatim on a refusal. */
function countsOf(message: MailMessageDto): { mailbox: number | null; account: number | null } {
  const state = store.state;
  const mailbox = (state.mailboxes[message.accountId] ?? [])
    .find((one) => one.mailboxId === message.mailboxId);
  const account = state.accounts.find((one) => one.accountId === message.accountId);
  return {
    mailbox: mailbox ? mailbox.unread : null,
    account: account ? account.unread : null,
  };
}

function markPending(pair: string, read: boolean): void {
  const held = { ...store.state.flagFailed };
  delete held[pair];
  patch({ pendingSeen: { ...store.state.pendingSeen, [pair]: read }, flagFailed: held });
  // The PREVIOUS answer about this row goes with the mark it retracted. A refused flip leaves a
  // sentence that stays up (refusals do not retire, see `setMailRowNote`), so retrying the same row
  // left "Walnut could not mark it read" standing over a row the retry had just marked read: the toast
  // contradicted the row it was about. Only this row's own note, because a note about another row is
  // still true.
  const note = store.state.rowNote;
  if (note && note.pair === pair) clearMailRowNote();
}

function clearPending(pair: string): void {
  forgetFlipCounted(pair);
  const held = { ...store.state.pendingSeen };
  if (!(pair in held)) return;
  delete held[pair];
  patch({ pendingSeen: held });
}

/** Is the row this console is holding for that message already read? */
function heldSeen(message: MailMessageDto): boolean {
  const state = store.state;
  const key = handle(message);
  const held = state.messages.find((one) => handle(one) === key)
    ?? state.search.messages.find((one) => handle(one) === key)
    ?? (state.open && handle(state.open) === key ? state.open.message : undefined)
    ?? message;
  return held.flags.includes(SEEN);
}

function withSeen(message: MailMessageDto, seen: boolean): MailMessageDto {
  const flags = message.flags.filter((flag) => flag !== SEEN);
  return { ...message, flags: seen ? [...flags, SEEN] : flags };
}

function mapMessage(
  list: MailMessageDto[],
  target: { accountId: string; messageId: string },
  fn: (one: MailMessageDto) => MailMessageDto,
) {
  const key = handle(target);
  return list.some((one) => handle(one) === key)
    ? list.map((one) => (handle(one) === key ? fn(one) : one))
    : list;
}

/**
 * The row, the open reader, the search results, the mailbox badge and the account total.
 *
 * The ONE place in this console that writes a `\Seen` flag, which is what keeps the four numbers
 * moving together. `restore` is the exact pair of counts recorded before a flip: on a rollback the
 * numbers are written back rather than un-deltaed, because the deltas clamp at 0 and a mailbox
 * already at 0 would come back one unread heavier than it started.
 */
function applySeen(
  message: MailMessageDto,
  seen: boolean,
  restore?: { mailbox: number | null; account: number | null },
): void {
  const state = store.state;
  const delta = seen ? -1 : 1;
  const unreadOf = (current: number, kept: number | null) => (
    restore ? (kept ?? current) : Math.max(0, current + delta)
  );
  const mailboxes = state.mailboxes[message.accountId];
  patch({
    messages: mapMessage(state.messages, message, (one) => withSeen(one, seen)),
    search: {
      ...state.search,
      messages: mapMessage(state.search.messages, message, (one) => withSeen(one, seen)),
    },
    open: state.open && handle(state.open) === handle(message) && state.open.message
      ? { ...state.open, message: withSeen(state.open.message, seen) }
      : state.open,
    ...(mailboxes ? {
      mailboxes: {
        ...state.mailboxes,
        [message.accountId]: mailboxes.map((mailbox) => (
          mailbox.mailboxId === message.mailboxId
            ? { ...mailbox, unread: unreadOf(mailbox.unread, restore?.mailbox ?? null) }
            : mailbox
        )),
      },
    } : {}),
    accounts: state.accounts.map((account) => (
      account.accountId === message.accountId
        ? { ...account, unread: unreadOf(account.unread, restore?.account ?? null) }
        : account
    )),
  });
  publishBadge();
}

/**
 * What the human is told when a flip did not stick, naming the ROW.
 *
 * "That message could not be marked read" is nobody, and somebody triaging a list has just touched
 * a dozen rows. A replica's refusal gets its own sentence: it is not a fault and it will never
 * answer differently, so wording it as something Walnut failed at invites a retry that cannot work.
 */
function flagFailureNote(
  row: MailMessageDto,
  read: boolean,
  failure: { status: number; code: string; message: string },
): string {
  const named = mailRowLabel(row);
  if (failure.status === 503 && failure.code === 'primary_only') {
    return `This copy of Walnut only reads mail. ${named} is still ${read ? 'unread' : 'read'}.`;
  }
  // TWO SENTENCES, the same rule the folder fetch already follows (`folderFetchSentence`): Walnut's
  // sentence ENDS, then the provider's own text follows as its own. A plugin writes that string and
  // nothing here can promise it starts with a capital or ends with a stop, so run on after a colon it
  // read as one broken sentence with no closing stop.
  return `Walnut could not mark ${named} ${read ? 'read' : 'unread'}. ${failure.message}`;
}

/**
 * The ROW's hover text for a refused flip.
 *
 * The provider's words alone were a fragment with no subject ("the provider refused"), hovering over a
 * glyph whose meaning is the whole question. Walnut says what failed, the provider says why, two
 * sentences, same rule as the note.
 */
function flagFailureTitle(
  read: boolean,
  failure: { status: number; code: string; message: string },
): string {
  const what = `Walnut could not mark this message ${read ? 'read' : 'unread'}.`;
  return failure.message ? `${what} ${failure.message}` : what;
}

function replaceMessage(message: MailMessageDto): void {
  const state = store.state;
  patch({
    messages: mapMessage(state.messages, message, () => message),
    search: {
      ...state.search,
      messages: mapMessage(state.search.messages, message, () => message),
    },
    open: state.open && handle(state.open) === handle(message) ? { ...state.open, message } : state.open,
  });
}
