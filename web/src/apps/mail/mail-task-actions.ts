/**
 * Where mail leaves the console: the digest letter. A message never becomes a task here: the reader
 * and the row menu offer the content actions instead (utils/content-actions.ts).
 *
 * Split from `mail-actions.ts` because that file is the console's OWN reads (mailboxes, pages, the
 * open message, search, refresh) and this is its edge. It shares the same two rules as
 * everything else in this directory: nothing mutates the snapshot except through `patch`, and
 * nothing fetches except inside `run`, so a double click is one request.
 *
 * The deep link (`openMailDeepLink`, the return path of a task's backlink) deliberately stayed in
 * mail-actions.ts even though it belongs to the same feature: it drives `selectMailbox`, and moving
 * it here made the two modules import each other for no gain.
 */
import {
  mailFailure,
  sendMailDigestNow,
} from '@/api/mail';
import { markLettersStale } from '@/components/inbox/letter-store';
import { patch, run, standIn, store } from './mail-store';

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
