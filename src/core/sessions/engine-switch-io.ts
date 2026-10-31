/**
 * The engine switch's reads and writes (engine-switch.ts): the task's whole transcript
 * written on the target host, and the old session's waiting queue rows taken off and
 * put back.
 */
import type { SessionRecord, Task } from '../types.js';
import { engineCaps } from '../agents/engine-registry.js';
import { LOCAL_HOST, normalizeHost } from '../transfer/planner.js';

/** A path on the old session's host, as the new session reads it (another host's path says where it lives). */
export function hostPath(p: string, fromHost: string, toHost: string): string {
  return fromHost === toHost ? p : `${p} (on ${fromHost === LOCAL_HOST ? 'this Mac' : fromHost})`;
}

/** The task's whole conversation, every session oldest first, as one markdown file on `host`. */
export async function writeTaskTranscript(task: Task, rows: SessionRecord[], host: string, switchId: string): Promise<string | undefined> {
  const { readProviderSessionHistory } = await import('./session-lifecycle.js');
  const { renderTranscriptMarkdownChunked } = await import('../transfer/transcript.js');
  const transfer = await import('../transfer/transfer.js');
  const { transfersDir } = await import('../transfer/workspace.js');
  const ordered = [...rows].sort((a, b) => (a.startedAt ?? '').localeCompare(b.startedAt ?? ''));
  const parts: string[] = [];
  for (const [i, r] of ordered.entries()) {
    const { messages } = await readProviderSessionHistory(r.claudeSessionId, r, r.host, true).catch(() => ({ messages: [] }));
    if (messages.length === 0) continue;
    parts.push(await renderTranscriptMarkdownChunked(messages, {
      title: `${task.title} (session ${i + 1} of ${ordered.length})`, engine: engineCaps(r.engine).displayName,
      host: transfer.hostLabel(normalizeHost(r.host)), ...(r.cwd ? { cwd: r.cwd } : {}),
    }));
  }
  if (parts.length === 0) return undefined;
  const path = `${transfersDir(host)}/${switchId}/transcript.md`;
  await transfer.writeTargetFile(host, path, parts.join('\n\n---\n\n'));
  return path;
}

export type HeldRow = import('../session-queue-store.js').QueuedMessage;

/** Why a message waits on a session its task is moving away from (never auto-delivered while parked). */
export const MOVE_HELD_REASON = 'Held while its task moves to another host';

/** A row held for a move, deliverable again. */
export function releaseMoveHeld(r: HeldRow): HeldRow {
  if (r.status !== 'parked' || r.parkedReason !== MOVE_HELD_REASON) return r;
  const { parkedAt: _a, parkedReason: _r, ...rest } = r;
  return { ...rest, status: 'pending' };
}

/** Release the rows held for a move on `sessionId`, in place. How many were released. */
export async function releaseMoveHeldRows(sessionId: string): Promise<number> {
  const { mutateStore } = await import('../session-queue-store.js');
  return mutateStore((s) => {
    const rows = s.queues[sessionId];
    if (!rows) return 0;
    let n = 0;
    s.queues[sessionId] = rows.map((r) => {
      const out = releaseMoveHeld(r);
      if (out !== r) n++;
      return out;
    });
    return n;
  }, false, true);
}

/** Take the old session's waiting rows out of its queue (a row already in a CLI stays). */
export async function takeQueuedRows(sessionId: string): Promise<HeldRow[]> {
  const { mutateStore } = await import('../session-queue-store.js');
  return mutateStore((s) => {
    const rows = s.queues[sessionId] ?? [];
    const take = rows.filter((r) => r.status !== 'processing' && !r.lineInDoubt);
    if (take.length === 0) return [];
    s.queues[sessionId] = rows.filter((r) => !take.includes(r));
    if (s.queues[sessionId].length === 0) delete s.queues[sessionId];
    return take;
  }, false, true);
}

export async function putQueuedRows(sessionId: string, rows: HeldRow[]): Promise<void> {
  if (rows.length === 0) return;
  const { mutateStore } = await import('../session-queue-store.js');
  await mutateStore((s) => {
    // Idempotent: a restart that resumes a switch may put the same rows again.
    const have = new Set((s.queues[sessionId] ?? []).map((r) => r.id));
    const moved = rows.filter((r) => !have.has(r.id)).map((r) => {
      const { lineUuid: _l, lineTries: _t, lineTracked: _k, ...rest } = r;
      return { ...rest, sessionId };
    });
    s.queues[sessionId] = [...(s.queues[sessionId] ?? []), ...moved];
  }, false, true);
}
