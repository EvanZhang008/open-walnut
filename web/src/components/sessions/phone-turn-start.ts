/**
 * The phone's open-time landing (spec 4.5, C69): a latest turn taller than the
 * timeline opens at its start, a turn that fits stays bottom aligned.
 *
 * The decision is about the transcript AS OPENED. It is re-checked for up to
 * two seconds only because the loaded rows finish laying out over a few frames
 * (markdown, run rows). Content that ARRIVES in those seconds is not the open:
 * a reply streaming in them grew the turn past the screen and the view jumped
 * away from the live words the reader was following, back up to the turn's
 * start (2026-11-03, phone-touch-scroll-while-streaming.spec.ts flaked on CI
 * with the view 53 to 240px above the bottom before any touch). So every check
 * compares what the timeline holds now with what it held at the open, and any
 * arrival ends the window where it is. The rows are counted from when the
 * window opens (the full history replacing the first quick read is the load),
 * the live output from when the transcript first showed: the window waits for
 * the full history, seconds on a slow host, and a reply that streamed in the
 * meantime is one the reader watched arrive.
 */
import type { StreamingBlock } from '@/stream/stream-reducer';

/** How long the open's rows may take to lay out before the landing gives up. */
export const PHONE_TURN_START_WINDOW_MS = 2000;

/** What the timeline holds: grows with every row, live block and streamed character. */
export interface TimelineContent { rows: number; live: number }

/** Live output's size: one per block plus every character it streamed. */
export function liveOutputSize(blocks: readonly StreamingBlock[]): number {
  let n = blocks.length;
  for (const b of blocks) {
    if (b.type === 'text' || b.type === 'thinking') n += b.content.length;
    else if (b.type === 'tool_call') n += (b.result?.length ?? 0) + (b.input ? 1 : 0);
  }
  return n;
}

export interface TurnStartLook {
  /** Following the bottom (no reader scroll since the open). */
  atBottom: boolean;
  elapsedMs: number;
  /** What the timeline held when the window opened, and holds now. */
  opened: TimelineContent;
  now: TimelineContent;
  /** The timeline ends in an unanswered prompt. */
  pendingPrompt: boolean;
  /** Where the latest user message starts in the content (null: none). */
  turnTop: number | null;
  scrollHeight: number;
  clientHeight: number;
}

export type TurnStartStep =
  | { act: 'apply' }
  | { act: 'wait' }
  | { act: 'done'; why: 'reader' | 'late' | 'arrived' | 'prompt' };

/** One check of the landing: land at the turn start, check again later, or stop for good. */
export function phoneTurnStartStep(look: TurnStartLook): TurnStartStep {
  if (!look.atBottom) return { act: 'done', why: 'reader' };
  if (look.now.rows !== look.opened.rows || look.now.live !== look.opened.live) return { act: 'done', why: 'arrived' };
  if (look.elapsedMs > PHONE_TURN_START_WINDOW_MS) return { act: 'done', why: 'late' };
  // R3-01: an unanswered prompt needs the tap, so a timeline that ends in one
  // stays on it (bottom aligned, its buttons above the composer).
  if (look.pendingPrompt) return { act: 'done', why: 'prompt' };
  if (look.turnTop === null || look.scrollHeight - look.turnTop <= look.clientHeight + 1) return { act: 'wait' };
  return { act: 'apply' };
}
