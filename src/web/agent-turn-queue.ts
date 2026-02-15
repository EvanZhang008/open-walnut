/**
 * Main Agent Turn Queue — serializes all main-agent turns to prevent
 * concurrent access to chat-history.json and interleaved UI output.
 *
 * Callers that share the main chat history must go through this queue:
 * - WS chat (user messages)
 * - Cron main-session jobs (wakeMode: 'now')
 * - Session/subagent triage (post-result AI processing)
 *
 * Callers that do NOT need the queue (isolated, independent history):
 * - Cron isolated jobs (empty history, never write chat-history)
 * - Embedded subagents (own history)
 * - Compaction summarizer (empty history)
 */

import { log } from '../logging/index.js';

interface QueueEntry<T> {
  label: string;
  task: () => Promise<T>;
  resolve: (value: T) => void;
  reject: (reason: unknown) => void;
  enqueuedAt: number;
}

const queue: QueueEntry<unknown>[] = [];
let active = 0;

const WARN_WAIT_MS = 2_000;

/**
 * Try to start the next queued task if the slot is free.
 * Called after enqueue and after each task completes (resolve or reject).
 * The `active < 1` check is the sole concurrency guard — no separate
 * "draining" flag is needed because pump() is always re-invoked on
 * task completion, and extra pump() calls with active >= 1 are no-ops.
 */
function pump(): void {
  while (active < 1 && queue.length > 0) {
    const entry = queue.shift()!;
    const waitMs = Date.now() - entry.enqueuedAt;
    if (waitMs > WARN_WAIT_MS) {
      log.agent.warn('agent turn queue: long wait', {
        label: entry.label,
        waitMs,
        queued: queue.length,
      });
    }
    log.agent.info('agent turn queue: dequeue', {
      label: entry.label,
      waitMs,
      queued: queue.length,
    });
    active++;
    void (async () => {
      const startMs = Date.now();
      try {
        const result = await entry.task();
        active--;
        log.agent.info('agent turn queue: done', {
          label: entry.label,
          durationMs: Date.now() - startMs,
          queued: queue.length,
        });
        pump();
        entry.resolve(result);
      } catch (err) {
        active--;
        log.agent.error('agent turn queue: error', {
          label: entry.label,
          durationMs: Date.now() - startMs,
          error: err instanceof Error ? err.message : String(err),
        });
        pump();
        entry.reject(err);
      }
    })();
  }
}

/**
 * Enqueue a main-agent turn for serial execution.
 * Returns a promise that resolves with the task's return value.
 *
 * @param label — human-readable label for logging (e.g. 'chat', 'cron:reminder', 'triage:session')
 * @param task — async function that runs the agent turn
 */
export function enqueueMainAgentTurn<T>(
  label: string,
  task: () => Promise<T>,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    queue.push({
      label,
      task: () => task() as Promise<unknown>,
      resolve: resolve as (value: unknown) => void,
      reject,
      enqueuedAt: Date.now(),
    });
    log.agent.info('agent turn queue: enqueue', {
      label,
      queueSize: queue.length + active,
    });
    pump();
  });
}

/**
 * Get the current queue status for diagnostics.
 */
export function getQueueStatus(): { active: number; queued: number } {
  return { active, queued: queue.length };
}
