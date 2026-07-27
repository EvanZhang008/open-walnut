/**
 * Collapse runs of adjacent agent/session error entries into a single chat row.
 *
 * Pure + dependency-free so it's directly unit-testable (no React, no WS).
 * Mirrors mergeAdjacentThinking() in ChatMessage.tsx, one level up: that merges
 * BLOCKS inside a message, this merges MESSAGES inside the timeline.
 */

/** Minimal shape needed to merge — the real ChatMessage is a superset. */
export interface MergeableMessage {
  content: string;
  role?: 'user' | 'assistant';
  source?: string;
  timestamp?: string;
}

/** Error entries carry a repeat count once merged, so the row can read "×6". */
export type WithErrorCount<T> = T & { errorCount?: number };

/** True for the two synthetic "a turn failed" entries. */
export function isErrorMessage(m: { source?: string }): boolean {
  return m.source === 'agent-error' || m.source === 'session-error';
}

/**
 * Merge a RUN of adjacent error messages into one, de-duplicating identical
 * texts within that run into a count.
 *
 * Adjacency (rather than global) is deliberate: it keeps the timeline honest
 * about WHEN things broke, the most useful signal during an outage — the
 * 2026-07-26 incident was 36 consecutive identical 403s and "where did it start"
 * was the question that mattered.
 *
 * A run is broken by another ASSISTANT message (the agent recovered, so the next
 * failure is genuinely new) but NOT by the user's own messages: while auth is
 * down every prompt you type fails, and letting your prompts split the run would
 * render exactly the every-other-row stack this merge exists to prevent.
 */
export function mergeAdjacentErrors<T extends MergeableMessage>(
  messages: readonly T[],
): WithErrorCount<T>[] {
  const out: WithErrorCount<T>[] = [];
  for (const m of messages) {
    // Walk back past the user's own turns to find the last agent-side entry.
    let i = out.length - 1;
    while (i >= 0 && out[i].role === 'user' && !isErrorMessage(out[i])) i--;
    const prev = i >= 0 ? out[i] : undefined;
    if (isErrorMessage(m) && prev && isErrorMessage(prev)) {
      const merged: WithErrorCount<T> = { ...prev, errorCount: (prev.errorCount ?? 1) + 1 };
      // Identical text → count only. New text → keep it as an extra line.
      if (!prev.content.includes(m.content)) merged.content = `${prev.content}\n${m.content}`;
      // Keep the LATEST timestamp so the row reads as "still happening".
      if (m.timestamp) merged.timestamp = m.timestamp;
      out[i] = merged;   // NOT out.length-1 — `prev` may sit behind user messages
      continue;
    }
    out.push(m);
  }
  return out;
}
