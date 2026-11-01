/**
 * A push of a synced task that carries one of the user's private words, or text the fast model
 * judges private or cannot judge, is stopped (sync-guard.ts refused that push): the task turns local in the same project, with all of its
 * content, its outside copy keeps the text it had before the edit, and the user decides in one
 * letter (sync-gate.ts tellKeptLocal) whether to keep it local, archive or neutralize the copy,
 * or send it anyway.
 */
import { log } from '../../logging/index.js';
import { flushKeptLocalLetters, tellKeptLocal } from './sync-gate.js';
import { startingStops, type PushStop } from './sync-guard.js';

const stopping = new Map<string, Promise<void>>();

export function stopSyncedTask(taskId: string, stop: PushStop): Promise<void> {
  const running = stopping.get(taskId);
  if (running) return running;
  const work = (async () => {
    const tm = await import('../task-manager.js');
    const task = await tm.getTask(taskId).catch(() => null);
    if (!task || task.source === 'local') return;
    const made = await tm.makeTaskLocal(taskId, {
      state: stop.state, by: stop.by, reason: stop.reason, at: new Date().toISOString(),
    }, 'keep');
    log.task.warn('private tasks: a push was stopped, the task was made local', { taskId, from: made.from, by: stop.by, state: stop.state, entry: stop.entry });
    await tellKeptLocal(taskId, stop.state === 'unjudged' ? 'edit-unjudged' : 'edited');
  })().catch((err) => log.task.warn('private tasks: edit stop failed', { taskId, error: err instanceof Error ? err.message : String(err) }))
    .finally(() => stopping.delete(taskId));
  stopping.set(taskId, work);
  return work;
}

/** Wait for every running stop (tests). */
export async function settleEditStops(): Promise<void> {
  while (stopping.size || startingStops.size) await Promise.allSettled([...stopping.values(), ...startingStops]);
  await flushKeptLocalLetters();
}
