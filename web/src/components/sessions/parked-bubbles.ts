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

export interface ParkableBubble {
  queueId: string;
  status: 'pending' | 'received' | 'delivered' | 'failed';
  launch?: boolean;
  parked?: boolean;
  serverUndelivered?: boolean;
  failedError?: string;
  waitsFor?: string;
  heldReason?: string;
}

/** The server reported these rows not delivered (`parked`: set aside; `waitsFor`: until the agent can run). */
export function markBubblesFailed<T extends ParkableBubble>(
  prev: readonly T[], ids: readonly string[], error: string, info?: { parked?: boolean; waitsFor?: string },
): T[] {
  const idSet = new Set(ids);
  return prev.map((m) => {
    if (!idSet.has(m.queueId)) return m;
    const { launch: _launch, ...rest } = m;
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
