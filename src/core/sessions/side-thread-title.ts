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
/**
 * Is this label just the question, cut short? That is what the client mints when a
 * thread is created, so it doubles as "nobody has named this yet" — no marker field
 * needed, which is what lets threads created BEFORE auto-titling qualify too.
 *
 * Compared prefix-wise on collapsed whitespace with the trailing ellipsis removed, so
 * a real title that happens to start with the same word is not mistaken for one.
 */
export function isDerivedLabel(title: string | undefined | null, question: string): boolean {
  const q = question.replace(/\s+/g, ' ').trim();
  if (!q) return false;
  const t = (title ?? '').replace(/\s+/g, ' ').replace(/[…\s.]+$/, '').trim();
  if (!t) return true;
  return q.startsWith(t);
}

/** Refines per drawer open, and the cooldown that keeps a failing row from being
 *  re-asked on every open. Both bound the cost of a feature the user never asked for
 *  explicitly: a background model call per chip. */
const BACKFILL_PER_OPEN = 3;
const BACKFILL_COOLDOWN_MS = 10 * 60_000;
const lastBackfillAt = new Map<string, number>();

/**
 * Name the chips that are still wearing a truncation.
 *
 * Auto-titling only fires on create, so every thread from before it shipped — and
 * every one whose model call failed — keeps the label the user complained about. The
 * drawer opening is the natural trigger: it is exactly when those chips are read, it
 * is human-paced, and the rename lands on the open row through the same bus event.
 *
 * Fire-and-forget, sequential, and capped: each call is a fast-model call (a CLI spawn
 * on the default provider), and they share one small concurrency pool with the rest of
 * Walnut's background work.
 */
export async function backfillSideThreadTitles(
  parentSid: string,
  rows: Array<{ id: string; title?: string; question: string }>,
): Promise<void> {
  try {
    const { backendTitleAvailable } = await import('../session-title-backend.js');
    if (!backendTitleAvailable()) return;
    const now = Date.now();
    const due = rows.filter((r) => isDerivedLabel(r.title, r.question)
      && now - (lastBackfillAt.get(`${parentSid}:${r.id}`) ?? 0) > BACKFILL_COOLDOWN_MS)
      .slice(0, BACKFILL_PER_OPEN);
    if (due.length === 0) return;
    log.session.info('side thread: back-filling titles for chips that never got one', {
      parentSid, count: due.length, candidates: rows.length,
    });
    for (const row of due) {
      lastBackfillAt.set(`${parentSid}:${row.id}`, Date.now());
      await refineSideThreadTitle(parentSid, row.id, row.question, row.title ?? row.question);
    }
  } catch { /* cosmetic by contract */ }
}

/** Test hook: forget the per-thread backfill cooldown. */
export function _resetBackfillCooldownForTesting(): void {
  lastBackfillAt.clear();
}

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
    if (!title || title === placeholder) {
      // Say WHY the chip kept its truncated label. Without this line the feature's
      // only failure mode was invisible: "auto title still not here" with nothing in
      // the log between "side thread: created" and the user's complaint.
      log.session.warn('side thread: no title from the fast model — keeping the truncated label', {
        parentSid, threadId, reason: title ? 'unchanged' : 'no answer',
      });
      return;
    }
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
