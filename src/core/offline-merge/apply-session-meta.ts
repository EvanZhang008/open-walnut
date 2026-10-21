/**
 * The journal v2 kind `session-meta` on the Mac (docs/plan/walnut-companion-unified-replica.md,
 * stage 3, slice 3b): a session metadata patch the cloud companion took while this Mac was
 * away (its v1 PATCH /sessions/:id: title, archived, human_note, output_mode, thread_anchors,
 * thread_meta; never `mode`, which acts on the live CLI).
 *
 * Applied with the call the same patch makes online (session-lifecycle.ts patchSession, the
 * relay's `patch`), so its checks hold: a refusal there (a bad value, a session gone, an
 * archive of a running session) is the RefusedWrite the batch letters, where the old queue
 * dropped it with a log line. A store failure is thrown as is (retried). Last write wins by
 * arrival, as the queue did: patchSession is idempotent by value, so a redrain is harmless.
 */

import { RefusedWrite } from './patch-check.js';
import type { V2Context, V2Record } from './apply-v2.js';

const SID_RE = /^[A-Za-z0-9_-]{1,128}$/;
const FIELDS = new Set(['title', 'archived', 'human_note', 'output_mode', 'thread_anchors', 'thread_meta']);

export async function applySessionMeta(ctx: V2Context, record: V2Record): Promise<void> {
  const sid = typeof record.sid === 'string' ? record.sid : '';
  if (!SID_RE.test(sid)) throw new RefusedWrite('a session change without a session id');
  const patch = record.patch && typeof record.patch === 'object' && !Array.isArray(record.patch) ? record.patch as Record<string, unknown> : null;
  const keys = patch ? Object.keys(patch) : [];
  if (!patch || keys.length === 0) throw new RefusedWrite('a session change with nothing in it');
  const bad = keys.filter((k) => !FIELDS.has(k));
  if (bad.length) throw new RefusedWrite(`a session change can not set ${bad.join(', ')} while the Mac is away; nothing of it was applied`);
  const { patchSession } = await import('../sessions/session-lifecycle.js');
  const { SessionControlError } = await import('../sessions/session-controls.js');
  try {
    await patchSession(sid, patch);
  } catch (err) {
    if (err instanceof SessionControlError && err.statusCode < 500) throw new RefusedWrite(`${await sessionName(sid, patch)} (${keys.join(', ')}): ${err.message}`);
    throw err;
  }
  ctx.result.replayed++;
}

/** How the letter names the session: its title, else its task's (never its id). */
async function sessionName(sid: string, patch: Record<string, unknown>): Promise<string> {
  try {
    const { getSessionByClaudeId } = await import('../session-tracker.js');
    const rec = await getSessionByClaudeId(sid);
    if (rec?.title) return `the session "${rec.title}"`;
    if (rec?.taskId) {
      const { getTask } = await import('../task-manager.js');
      const t = await getTask(rec.taskId).catch(() => null);
      if (t?.title) return `the session of "${t.title}"`;
    }
  } catch { /* named below */ }
  return typeof patch.title === 'string' && patch.title ? `the session "${patch.title}"` : 'a session no longer on this Mac';
}
