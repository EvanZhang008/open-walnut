/**
 * Which page a live block of a strict question's turn reads on.
 *
 * A strict question (utils/ask-answer.ts) owns only the text that opens with its
 * answer tag: every other block of its turn (a step, its thinking) reads in the
 * main conversation, because the transcript's split files those rows the same way
 * and a block must land where its persisted row will.
 *
 * A card about the turn itself (a retry, a notice) has no row in the transcript,
 * so no such place to keep: it reads on the page whose turn it belongs to. Sent
 * to Main, it showed there while the question page answered, then vanished once
 * the turn was saved (2026-11-07, the Tree Mode round 7 walk: a Stop hook's
 * card on Main while the middle page answered).
 *
 * A permission prompt stays where it was (Main in such a turn): it must be
 * answered, and a page the reader is not on draws nothing, so moving it could
 * hide the Allow and Deny buttons from a reader who went back to Main.
 *
 * `TRANSCRIPT_TWIN` names every block type, so a new one does not compile until
 * it says whether the transcript keeps a row for it. Pure: tests/web/stream-block-page.test.ts.
 */
import type { StreamingBlock } from '@/stream/stream-reducer';

type BlockOf<T extends StreamingBlock['type']> = Extract<StreamingBlock, { type: T }>;

export const TRANSCRIPT_TWIN: { [T in StreamingBlock['type']]: (b: BlockOf<T>) => boolean } = {
  text: () => true,
  thinking: () => true,
  tool_call: () => true,
  // A taken-line marker draws nothing; its row is the user line.
  user_line: () => true,
  // A notice announcing a real transcript line carries that line's uuid.
  system: (b) => !!b.uuid,
  // A prompt lives in the stream only.
  permission: () => false,
};

export function hasTranscriptTwin(b: StreamingBlock): boolean {
  return (TRANSCRIPT_TWIN[b.type] as (x: StreamingBlock) => boolean)(b);
}

/**
 * The page of a live block: its answer tag's question; else, when the place it
 * would take belongs to a strict question, that place for a card the transcript
 * has no row for and Main for everything else; else its place.
 */
export function pageOfStreamBlock(
  block: StreamingBlock | undefined,
  spanKey: string | null,
  placeKey: string,
  isStrictKey: (key: string) => boolean,
  rootKey: string,
): string {
  if (spanKey !== null) return spanKey;
  if (!isStrictKey(placeKey)) return placeKey;
  return block?.type === 'system' && !hasTranscriptTwin(block) ? placeKey : rootKey;
}
