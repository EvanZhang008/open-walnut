/**
 * Auto-title a side thread — the same kind of name a task or a session gets, not a
 * truncation of what the user typed.
 *
 * The chip row is the only place a thread is identified, and the client-derived label
 * is the question's first ~48 characters, so a row of asides reads
 * "another quesitons 1. Why EKS …" / "Throttling。 我去压缩前的记录里…". Those share a
 * prefix, carry the typing noise, and cut mid-word: exactly the pile the user has to
 * scan. A real title ("Step function throttling") names the subject instead.
 *
 * WHICH CHANNEL: Walnut's own fast model (`titleViaBackendModel`), never the thread's
 * CLI. A side_question would ride the thread's FIFO and queue behind the very answer
 * the user is waiting for, spend a MAIN-model call, and write into the process whose
 * prompt-cache prefix the fork design goes to some length to keep byte-identical.
 * Titling needs nothing but the question text, so it belongs off that path entirely.
 *
 * Fire-and-forget by contract: the create path must not wait on it, and a thread with
 * no refined title is not broken — it keeps the truncated label, which is why this
 * module never throws and never retries beyond what the backend channel does.
 */

import { log } from '../../logging/index.js';
import { bus, EventNames } from '../event-bus.js';

/**
 * Ask for a better title and, if one comes back, store it and tell the UI.
 *
 * The stored row is the source of truth for the chip label, for "Inject to chat"'s
 * header, and for the task name when the thread is promoted — so one write improves
 * all three. Skipped when the row already carries a hand-written title (a client can
 * send one) or when the answer matches what is already there.
 */
export async function refineSideThreadTitle(
  parentSid: string,
  threadId: string,
  question: string,
  placeholder: string,
): Promise<void> {
  const asked = question.trim();
  if (!asked) return;
  try {
    const { backendTitleAvailable, titleViaBackendModel } = await import('../session-title-backend.js');
    // Same gate every unprompted model call in this repo respects: test servers and
    // constrained deployments make none, and the truncated label is a fine fallback.
    if (!backendTitleAvailable()) return;
    const title = await titleViaBackendModel(asked, placeholder, null);
    if (!title || title === placeholder) return;
    const { setSideThreadTitle } = await import('../side-questions.js');
    const updated = await setSideThreadTitle(parentSid, threadId, title);
    // Gone already (deleted while the model was thinking) — nothing to announce.
    if (!updated) return;
    log.session.info('side thread: title refined', { parentSid, threadId, title });
    // The drawer refreshes its list only when it OPENS, so without this the user
    // watches the truncated label for the whole conversation they just started.
    bus.emit(EventNames.SESSION_SIDE_THREAD_RENAMED, {
      sessionId: parentSid, threadId, title,
    }, ['*'], { source: 'side-thread-title' });
  } catch (err) {
    log.session.warn('side thread: title refine failed (keeping the truncated label)', {
      parentSid, threadId, error: err instanceof Error ? err.message : String(err),
    });
  }
}
