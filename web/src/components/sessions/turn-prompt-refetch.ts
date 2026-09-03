/**
 * Turn-start history refetch — when a running turn shows NO prompt.
 *
 * The launch prompt of a fresh session is written by the CLI to its own
 * transcript ~3 s after spawn (the CLI has to boot first), while the panel
 * opens and fetches history within ~1 s of spawn. Both opening fetches come
 * back empty, and nothing re-fetches until the turn ENDS (batch-completed /
 * isStreaming true→false), so the user's first message was invisible for the
 * whole first turn — minutes on a real task — and only appeared with the
 * final answer (inc: first-message-hidden-until-turn-ends). "Sometimes it
 * shows" = the panel happened to (re)open after the CLI had written the line.
 *
 * There is no optimistic bubble for the launch prompt (the server sent it at
 * spawn, not the composer), so persisted history is the ONLY thing that can
 * show it. The same gap covers prompts sent from another browser, the phone,
 * or Walnut itself when the `session:message-queued` bubble was missed.
 *
 * The trigger is the CLI's own ordering guarantee, not a timer: Claude Code
 * appends the user message to the transcript BEFORE it calls the model, so the
 * first model-produced block of a turn (text / thinking / tool call / permission
 * ask) proves the prompt is on disk. `system` blocks do NOT qualify — hook and
 * init notifications stream ~20 ms before the user line lands (measured), which
 * is exactly the race this file exists to close. Refetching there would just
 * move the race.
 */
import type { StreamingBlock } from '@/stream/stream-reducer';

/** History row shape this predicate needs (SessionHistoryMessage subset). */
export interface PromptRow {
  role: 'user' | 'assistant' | 'system';
  text?: string;
  injected?: boolean;
}

/** A block the MODEL produced this turn — proof the CLI committed the prompt. */
export function isModelOutputBlock(block: StreamingBlock): boolean {
  return block.type === 'text' || block.type === 'thinking'
    || block.type === 'tool_call' || block.type === 'permission';
}

/** Does the live turn (blocks past the completed boundary) contain model output yet? */
export function liveTurnHasModelOutput(blocks: readonly StreamingBlock[], completedLen: number): boolean {
  for (let i = Math.max(0, completedLen); i < blocks.length; i++) {
    if (isModelOutputBlock(blocks[i])) return true;
  }
  return false;
}

/**
 * True when nothing on screen stands for the current turn's prompt: no typed
 * user row at or after the turn watermark, and no optimistic bubble. Injected
 * rows (skill dumps, image metadata) are not the prompt — the CLI writes them
 * next to it, never instead of it.
 */
export function turnPromptMissing(
  messages: readonly PromptRow[],
  watermark: number,
  optimisticCount: number,
): boolean {
  if (optimisticCount > 0) return false;
  for (let i = Math.max(0, Math.min(watermark, messages.length)); i < messages.length; i++) {
    const m = messages[i];
    if (m.role === 'user' && !m.injected && (m.text?.trim().length ?? 0) > 0) return false;
  }
  return true;
}

/** Bounded safety net after the first refetch still shows no prompt (remote
 *  daemon stat lag). Two retries, then give up — the turn-end refetch covers it. */
export const PROMPT_REFETCH_RETRY_DELAYS_MS: readonly number[] = [2000, 4000];

/**
 * Should this render bump historyVersion for the turn prompt? Fires once per
 * turn, on the edge where the live turn gains its first model-output block
 * while the prompt is still missing. The caller owns the per-turn latch
 * (`alreadyFiredThisTurn`), reset when the turn ends.
 */
export function shouldRefetchForTurnPrompt(input: {
  blocks: readonly StreamingBlock[];
  completedLen: number;
  messages: readonly PromptRow[];
  watermark: number;
  optimisticCount: number;
  alreadyFiredThisTurn: boolean;
}): boolean {
  if (input.alreadyFiredThisTurn) return false;
  if (!liveTurnHasModelOutput(input.blocks, input.completedLen)) return false;
  return turnPromptMissing(input.messages, input.watermark, input.optimisticCount);
}
