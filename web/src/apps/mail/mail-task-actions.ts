/**
 * The two places mail leaves the console: a message becoming a task, and the digest letter.
 *
 * Split from `mail-actions.ts` because that file is the console's OWN reads (mailboxes, pages, the
 * open message, search, refresh) and these two are its edges. They share the same two rules as
 * everything else in this directory: nothing mutates the snapshot except through `patch`, and
 * nothing fetches except inside `run`, so a double click is one request.
 *
 * The deep link (`openMailDeepLink`, the return path of a task's backlink) deliberately stayed in
 * mail-actions.ts even though it belongs to the same feature: it drives `selectMailbox`, and moving
 * it here made the two modules import each other for no gain.
 */
import {
  createMailMessageTask,
  mailFailure,
  sendMailDigestNow,
  type MailMessageDto,
} from '@/api/mail';
import { markLettersStale } from '@/components/inbox/letter-store';
import { log } from '@/utils/log';
import { mailRowLabel, pairKey, patch, run, setMailRowNote, standIn, store } from './mail-store';

/**
 * The letter list is out of date, without making a request.
 *
 * Named here so `mail-actions.ts`'s bus handler does not have to import the letter store to say one
 * thing about one of its own events. `ensureLetters` serves a cached list for 15s, and reaching for
 * the bell after a digest lands takes about that long, so the letter it was sent for would be
 * missing from the list it opened.
 */
export function invalidateLetterList(): void {
  markLettersStale();
}

// ── message to task ──

/**
 * Write a task id onto every copy of one message the console is holding.
 *
 * The list, the search results and the open reader are three copies of the same row, and the pill
 * has to appear on all of them: the reader shows it instead of the button, and the list row shows it
 * so triage does not offer the same message twice. Also the handler for the live event, which is
 * what makes a task made in another tab (or by an agent) appear here without a refetch.
 */
export function applyMessageTask(accountId: string, messageId: string, taskId: string): void {
  const state = store.state;
  const stamp = (one: MailMessageDto) => (
    one.accountId === accountId && one.messageId === messageId && one.taskId !== taskId
      ? { ...one, taskId }
      : one
  );
  const open = state.open;
  patch({
    messages: state.messages.map(stamp),
    search: { ...state.search, messages: state.search.messages.map(stamp) },
    open: open && open.accountId === accountId && open.messageId === messageId
      ? {
        ...open,
        ...(open.message ? { message: stamp(open.message) } : {}),
        taskBusy: false,
        taskError: null,
      }
      : open,
  });
}

/**
 * Make a task out of the open message.
 *
 * Coalesced per message, so a double click is ONE request; the server is idempotent as well, which
 * is the half that actually guarantees one task. A failure is reported next to the button rather
 * than thrown: the reader is still perfectly usable, and the human's next move is to try again.
 */
export function makeTaskFromMessage(accountId: string, messageId: string): Promise<void> {
  return run(`task:${pairKey(accountId, messageId)}`, async () => {
    const open = store.state.open;
    if (open && open.accountId === accountId && open.messageId === messageId) {
      patch({ open: { ...open, taskBusy: true, taskError: null } });
    }
    try {
      const answer = await createMailMessageTask(accountId, messageId);
      if (answer.taskId) {
        applyMessageTask(accountId, messageId, answer.taskId);
        reportTaskMade(accountId, messageId);
        return;
      }
      // A 202: the write is still running. Saying so beats a spinner that never resolves, and the
      // retry is safe because the server answers the second ask with the task it made.
      reportTaskTrouble(accountId, messageId, 'Still making the task. Try again in a moment.');
    } catch (error) {
      const failure = mailFailure(error);
      log.warn('mail', 'make task from message failed', { accountId, messageId, error: failure.message });
      reportTaskTrouble(accountId, messageId, failure.message);
    }
  });
}

/**
 * A task WAS made, said in a sentence naming the row.
 *
 * The glyph on the row is the durable mark, and it is enough while the row is on screen: somebody
 * right-clicking down a list has usually scrolled past by the time the write lands, and then the only
 * answer to `Make a task` was a mark they could not see. The same slot the failure and the copied link
 * write into, so success and failure are said in the same place.
 */
function reportTaskMade(accountId: string, messageId: string): void {
  const row = [...store.state.messages, ...store.state.search.messages]
    .find((one) => one.accountId === accountId && one.messageId === messageId);
  setMailRowNote(
    `Task made from ${row ? mailRowLabel(row, 'paren') : 'that message'}.`,
    pairKey(accountId, messageId),
  );
}

/**
 * Where an outcome is said, which depends on WHICH message it is about.
 *
 * The open reader has a slot beside its own button and that is where somebody reading is looking.
 * A row in the list has no such slot: this used to be `patchOpenTask` alone, so a task started from
 * anywhere else failed in complete silence. The row note names the row, because a person right-
 * clicking their way down a list has just asked for several.
 */
function reportTaskTrouble(accountId: string, messageId: string, detail: string): void {
  const open = store.state.open;
  if (open && open.accountId === accountId && open.messageId === messageId) {
    patch({ open: { ...open, taskBusy: false, taskError: detail } });
    return;
  }
  const row = [...store.state.messages, ...store.state.search.messages]
    .find((one) => one.accountId === accountId && one.messageId === messageId);
  setMailRowNote(
    `No task was made from ${row ? mailRowLabel(row) : 'that message'}: ${detail}`,
    pairKey(accountId, messageId),
  );
}

// ── the digest ──

/**
 * Send the digest letter now.
 *
 * The answer is reported through the accounts pane's one-line note, because that is where the menu
 * item lives and because every outcome is worth saying out loud: a letter went, nothing was unread
 * so nothing was sent, or the server could not finish reading and it is worth another press. A
 * digest that silently does nothing looks like a broken menu item.
 */
export function sendMailDigest(): Promise<void> {
  return run('digest', async () => {
    patch({ refreshNote: 'Building the digest…' });
    store.refreshNoteAccount = null;
    try {
      const answer = await sendMailDigestNow();
      if (answer.pending) { patch({ refreshNote: 'The digest is still being built.' }); return; }
      // The server's own sentence wins when it sent one. It is the only side that knows whether a
      // zero means "nothing is unread" or "the cache read ran out of time", and inventing a second
      // wording here is how the two answers end up disagreeing.
      patch({
        refreshNote: answer.message
          ?? (answer.letterId
            ? `Digest sent: ${answer.unread ?? 0} unread across ${answer.accounts ?? 0} account(s).`
            : 'Nothing is unread, so no digest was sent.'),
      });
    } catch (error) {
      const expected = standIn(error);
      patch(expected ? { stand: expected, refreshNote: null } : { refreshNote: mailFailure(error).message });
    }
  }, true);
}
