/**
 * How a refused or parked delivery reaches the bubbles a panel already shows.
 *
 * Review round 2, D08: the first message of a task started before Claude Code was
 * installed was parked under the launch bubble's own id (`launch-<sid>`), so the
 * live panel, which had seeded that bubble as delivered, skipped the parked row
 * as "already shown" and drew no Retry; only a reload showed it. Two rules:
 *   - a queue row the server parked (or holds) replaces a bubble shown under its id
 *     that does not say so yet (the queue read, hooks/queue-reconcile.ts);
 *   - a launch bubble whose delivery was refused is no launch prompt any more: it
 *     reads as the message that was not sent (its Retry, its waiting words), in the
 *     timeline, never as the delivered head of the conversation.
 * Pure, so tests/web pin it (parked-bubbles.test.ts).
 */
import { sendFailureWords } from '@/utils/operation-error-words';
import { clockTime } from '@/utils/time';

export interface ParkableBubble {
  queueId: string;
  status: 'pending' | 'received' | 'delivered' | 'failed';
  launch?: boolean;
  parked?: boolean;
  serverUndelivered?: boolean;
  failedError?: string;
  waitsFor?: string;
  waitsForConnection?: boolean;
  autoTries?: number;
  heldReason?: string;
  autoRetryAt?: string;
}

/** The server reported these rows not delivered (`parked`: set aside; `waitsFor`: until the agent can run). */
export function markBubblesFailed<T extends ParkableBubble>(
  prev: readonly T[], ids: readonly string[], error: string, info?: { parked?: boolean; waitsFor?: string },
): T[] {
  const idSet = new Set(ids);
  return prev.map((m) => {
    if (!idSet.has(m.queueId)) return m;
    // The server answered: no longer a send waiting for the connection (hooks/send-auto-retry.ts).
    // A next try from an earlier park is not this park's: the next queue read says it again or not.
    const { launch: _launch, waitsForConnection: _conn, autoTries: _tries, autoRetryAt: _retry, ...rest } = m;
    return {
      ...rest, status: 'failed' as const, failedError: error, serverUndelivered: true,
      ...(info?.parked ? { parked: true } : {}),
      ...(info?.waitsFor ? { waitsFor: info.waitsFor } : {}),
    } as T;
  });
}

/** Whether a bubble heads the conversation as its launch prompt: a delivered one, never a refused one. */
export function headsAsLaunch(m: ParkableBubble): boolean {
  return !!m.launch && m.status !== 'failed';
}

/**
 * A parked row's words: one the server's clock tries again says so and when (its `autoRetryAt`);
 * any other waits for Retry. Never "Auto-retry stopped" (2026-11-22, the user: "why not keep
 * retrying it"): whether it is tried again is the server's word, not this panel's guess.
 */
export function parkedWords(reason: string | undefined, autoRetryAt: string | undefined): string {
  const why = reason ? ` (${sendFailureWords(reason)})` : '';
  if (autoRetryAt) return `Not delivered yet: Walnut tries it again by itself. ${nextTryLabel(autoRetryAt)}${why}`;
  return `Not delivered${why}. Retry sends it again.`;
}

/** When a row is tried again, in the reader's own clock. */
export function nextTryLabel(iso: string): string {
  const at = Date.parse(iso);
  if (!Number.isFinite(at)) return '';
  if (at <= Date.now()) return 'Trying again now.';
  return `Next try at ${clockTime(at)}.`;
}

/**
 * The earliest time (epoch ms) the server's clock tries one of these parked bubbles again, or null:
 * the panel reads the queue again from then (useQueueSync), so the badge moves on by itself.
 */
export function nextAutoRetryAt(msgs: readonly ParkableBubble[]): number | null {
  let out: number | null = null;
  for (const m of msgs) {
    if (m.status !== 'failed' || !m.parked || !m.autoRetryAt) continue;
    const at = Date.parse(m.autoRetryAt);
    if (Number.isFinite(at) && (out === null || at < out)) out = at;
  }
  return out;
}
