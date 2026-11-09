/**
 * What a bubble does after the person's Delete or Edit of a queued message, from
 * the server's answer (src/core/sessions/queued-change.ts). Pure.
 *
 * 2026-11-09, the user pressed Delete on a bubble that read Queued while the
 * session had already taken the message, and got a red error toast. A row that
 * is taken or gone is a state: the bubble says it in place, in plain words, and
 * the panel re-reads the queue so the bubble shows where the message really is.
 */
export type QueuedChangeKind = 'delete' | 'edit';

export interface QueuedChangeAnswer { ok?: boolean; outcome?: 'taken' | 'held' | 'gone' | 'unavailable'; error?: string }

export interface QueuedChangeResult {
  /** Take the bubble away (deleted, or the queue no longer has it). */
  remove: boolean;
  /** The edit did not apply: show the words the row still has. */
  revertText: boolean;
  /** The message is on its way to the session. */
  delivered: boolean;
  /** The line under the bubble, or none. */
  notice?: string;
}

/** An older server answered a refusal by throwing these words. */
const OLD_REFUSAL = /not (?:deletable|editable) \(already processing or not found\)/i;

export function queuedChangeResult(kind: QueuedChangeKind, answer: QueuedChangeAnswer | undefined, thrown?: string): QueuedChangeResult {
  const outcome = thrown !== undefined
    ? (OLD_REFUSAL.test(thrown) ? 'refused' : 'unavailable')
    : answer?.ok === false ? (answer.outcome ?? 'unavailable') : 'ok';
  const error = thrown ?? answer?.error;
  const why = error ? ` (${error})` : '';
  if (kind === 'delete') {
    switch (outcome) {
      case 'ok': case 'gone': return { remove: true, revertText: false, delivered: false };
      case 'taken': return { remove: false, revertText: false, delivered: true, notice: 'Already sent to the session, so it can’t be deleted now.' };
      case 'held': return { remove: false, revertText: false, delivered: false, notice: 'It waits behind an earlier message that is still being confirmed, so it can’t be deleted yet. Try again in a moment.' };
      case 'refused': return { remove: false, revertText: false, delivered: false, notice: 'It could not be deleted: it is already on its way to the session, or no longer queued.' };
      default: return { remove: false, revertText: false, delivered: false, notice: `Couldn’t delete it: Walnut’s queue did not answer${why}. It is still queued; try again in a moment.` };
    }
  }
  switch (outcome) {
    case 'ok': return { remove: false, revertText: false, delivered: false };
    case 'taken': return { remove: false, revertText: true, delivered: true, notice: 'Already sent to the session, so the edit did not apply.' };
    case 'gone': return { remove: false, revertText: true, delivered: false, notice: 'This message is no longer queued, so the edit did not apply.' };
    case 'held': return { remove: false, revertText: true, delivered: false, notice: 'It waits behind an earlier message that is still being confirmed, so the edit did not apply. Try again in a moment.' };
    case 'refused': return { remove: false, revertText: true, delivered: false, notice: 'The edit did not apply: the message is already on its way to the session, or no longer queued.' };
    default: return { remove: false, revertText: true, delivered: false, notice: `Couldn’t save the edit: Walnut’s queue did not answer${why}. Try again in a moment.` };
  }
}
