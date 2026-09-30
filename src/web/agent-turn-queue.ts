/**
 * Console Agent Turn Queue — serializes agent turns per console agent.
 *
 * Each console agent (General, Mentor, custom) has its own queue with
 * concurrency=1 so that Agent B can respond instantly even while Agent A
 * is mid-turn. Different agents have different system prompts, tools, and
 * chat histories, so there's no prompt-cache benefit to sharing a queue.
 *
 * Callers that share a console agent's history must go through this queue:
 * - WS chat (user messages)
 * - Cron main-session jobs (wakeMode: 'now') → General queue
 * - Session/subagent triage (post-result AI processing) → General queue
 *
 * Callers that do NOT need the queue (isolated, independent history):
 * - Cron isolated jobs (empty history, never write chat-history)
 * - Embedded subagents (own history)
 * - Compaction summarizer (empty history)
 *
 * A running turn may give its slot up while it waits on an earlier turn of its
 * own lane (core/turn-slot.ts): the slot is the agent's, and that wait is not the
 * agent's work, so the agent's other conversations run meanwhile.
 */

import { log } from '../logging/index.js';
import { runHoldingTurnSlot, type TurnSlot } from '../core/turn-slot.js';

interface QueueEntry {
  label: string;
  /** Called once the slot is this entry's (`active` already counts it). */
  start: () => void;
  enqueuedAt: number;
  /** A turn taking its slot back after a wait (see TurnSlot.releaseWhile). */
  resume?: boolean;
}

interface AgentQueue {
  queue: QueueEntry[];
  active: number;
}

const queues = new Map<string, AgentQueue>();

const WARN_WAIT_MS = 2_000;

function getOrCreate(agentId: string): AgentQueue {
  let q = queues.get(agentId);
  if (!q) {
    q = { queue: [], active: 0 };
    queues.set(agentId, q);
  }
  return q;
}

/**
 * Try to start the next queued task for a specific agent if the slot is free.
 */
function pump(agentId: string): void {
  const q = queues.get(agentId);
  if (!q) return;

  while (q.active < 1 && q.queue.length > 0) {
    const entry = q.queue.shift()!;
    const waitMs = Date.now() - entry.enqueuedAt;
    if (waitMs > WARN_WAIT_MS) {
      log.agent.warn('agent turn queue: long wait', {
        agentId,
        label: entry.label,
        waitMs,
        queued: q.queue.length,
        ...(entry.resume ? { resume: true } : {}),
      });
    }
    log.agent.info('agent turn queue: dequeue', {
      agentId,
      label: entry.label,
      waitMs,
      queued: q.queue.length,
      ...(entry.resume ? { resume: true } : {}),
    });
    q.active++;
    entry.start();
  }
}

/**
 * Resolves once the agent's slot is the caller's. `front` (a turn taking its slot
 * back after a wait): ahead of every new turn, behind resumers already queued.
 */
function acquireSlot(agentId: string, label: string, front: boolean): Promise<void> {
  const q = getOrCreate(agentId);
  return new Promise<void>((start) => {
    const entry: QueueEntry = { label, start, enqueuedAt: Date.now(), ...(front ? { resume: true } : {}) };
    if (front) {
      // Behind turns already resuming, ahead of new ones: resumers keep the
      // order they were running in (an unshift made four waiters on one gate
      // resume W1, W4, W3, W2).
      const i = q.queue.findIndex((e) => !e.resume);
      q.queue.splice(i === -1 ? q.queue.length : i, 0, entry);
    } else q.queue.push(entry);
    pump(agentId);
  });
}

/**
 * Enqueue a turn for a specific console agent.
 * Each agent has its own concurrency=1 queue — no cross-agent blocking.
 *
 * @param agentId — console agent ID (e.g. 'general', 'mentor')
 * @param label — human-readable label for logging (e.g. 'chat', 'cron:reminder')
 * @param task — async function that runs the agent turn
 *
 * The task runs as the holder of the agent's slot (core/turn-slot.ts), so a
 * wait inside it may give the slot up through `releaseTurnSlotWhile`.
 */
export function enqueueAgentTurn<T>(
  agentId: string,
  label: string,
  task: () => Promise<T>,
): Promise<T> {
  const q = getOrCreate(agentId);
  // Queued synchronously: turns start in the order they were enqueued.
  const acquired = acquireSlot(agentId, label, false);
  log.agent.info('agent turn queue: enqueue', {
    agentId,
    label,
    queueSize: q.queue.length + q.active,
  });
  return (async () => {
    await acquired;
    let held = true;
    let ended = false;
    const give = (): void => {
      held = false;
      q.active--;
      pump(agentId);
    };
    const slot: TurnSlot = {
      releaseWhile: async <W>(wait: Promise<W>): Promise<W> => {
        if (!held || ended) return wait;
        give();
        log.agent.info('agent turn queue: slot released while waiting', { agentId, label, queued: q.queue.length });
        try {
          return await wait;
        } finally {
          await acquireSlot(agentId, label, true);
          if (ended) {
            // The turn finished while this wait was still pending (a detached
            // helper): hand the slot straight back instead of keeping it.
            give();
          } else {
            held = true;
          }
        }
      },
    };
    const startMs = Date.now();
    try {
      const result = await runHoldingTurnSlot(slot, task);
      log.agent.info('agent turn queue: done', {
        agentId,
        label,
        durationMs: Date.now() - startMs,
        queued: q.queue.length,
      });
      return result;
    } catch (err) {
      log.agent.error('agent turn queue: error', {
        agentId,
        label,
        durationMs: Date.now() - startMs,
        error: err instanceof Error ? err.message : String(err),
      });
      throw err;
    } finally {
      ended = true;
      if (held) give();
    }
  })();
}

/**
 * Enqueue a main-agent (General) turn. Backward-compatible alias.
 */
export function enqueueMainAgentTurn<T>(
  label: string,
  task: () => Promise<T>,
): Promise<T> {
  return enqueueAgentTurn('general', label, task);
}

// ─── Per-conversation last-turn exact token count ──────────────────────
// Re-exported from the shared token-truth module. CRITICAL: there must be exactly
// ONE map process-wide — the chat onUsage callback writes the real API token count,
// and BOTH the triage bail AND background-compaction's needsCompaction gate read it.
// Two separate maps would silently drop the ground-truth signal (the original bug
// where neither gate ever fired on a 1M-token conversation). See token-truth.ts.
export { recordLastTurnTokens, getLastTurnTokens } from '../core/token-truth.js';

/**
 * Get the current queue status for a specific agent (or all agents).
 */
export function getQueueStatus(agentId?: string): { active: number; queued: number } {
  if (agentId) {
    const q = queues.get(agentId);
    return q ? { active: q.active, queued: q.queue.length } : { active: 0, queued: 0 };
  }
  // Aggregate across all agents
  let active = 0;
  let queued = 0;
  for (const q of queues.values()) {
    active += q.active;
    queued += q.queue.length;
  }
  return { active, queued };
}
