/**
 * A fork's SESSION title follows its TASK title.
 *
 * Two titles describe one fork, and only the task's is curated: the fork task is
 * born `Fork of <source>` and a background pass refines it to
 * `<2-4 word label> - fork of <source>` (session-controls.createForkSiblingTask).
 * The session record used to be titled independently and then never revisited,
 * so the two drifted — and the SESSION title is the one that becomes the
 * `Title [8hex]` handle `session_list` prints and `session_send` accepts. On
 * 2026-09-11 that handle was a Chinese-and-English prompt fragment 100+ chars
 * long, and another session picked the wrong recipient off that list.
 *
 * This module is the one writer that repairs the drift. It reads the TASK as the
 * authority, which makes it idempotent and order-independent: whether the
 * background refine lands before or after the session record is seeded, the last
 * call wins with the same value. It NEVER overwrites a title it was not told it
 * may replace (`overwritable`) — a name a human typed, or one another channel
 * derived, is not this function's to change.
 */

import { log } from '../../logging/index.js';

/**
 * Point every session of `taskId` at the task's current title.
 *
 * `overwritable` = the exact titles this may replace (the placeholder(s) the fork
 * was seeded with). An empty/absent session title is always replaceable; anything
 * else outside the list is left alone. Never throws — a cosmetic rename must not
 * fail a fork or a promote.
 *
 * Returns how many session rows were renamed.
 */
export async function adoptForkTaskTitle(
  taskId: string,
  overwritable: readonly string[],
): Promise<number> {
  try {
    const { getTask } = await import('../task-manager.js');
    const task = await getTask(taskId);
    const next = (task.title ?? '').trim();
    if (!next) return 0;

    const { getSessionsForTask, updateSessionRecord, emitSessionStatusChanged } =
      await import('../session-tracker.js');
    const allowed = new Set(overwritable.map((t) => (t ?? '').trim()).filter(Boolean));
    let renamed = 0;
    for (const session of await getSessionsForTask(taskId)) {
      // An archived row is history; renaming it only churns the store.
      if (session.archived) continue;
      const current = (session.title ?? '').trim();
      if (current === next) continue;
      if (current && !allowed.has(current)) continue;
      try {
        const updated = await updateSessionRecord(session.claudeSessionId, { title: next });
        // The session tree/panel header reads the record's title, so a silent
        // write would only show up on the next full reload.
        emitSessionStatusChanged(updated, {}, ['*']);
        renamed++;
        log.session.info('fork session title now follows its task', {
          sessionId: session.claudeSessionId, taskId, from: current, to: next,
        });
      } catch (err) {
        log.session.warn('fork session title sync failed for one session', {
          sessionId: session.claudeSessionId, taskId,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
    return renamed;
  } catch (err) {
    log.session.warn('fork session title sync failed', {
      taskId, error: err instanceof Error ? err.message : String(err),
    });
    return 0;
  }
}
