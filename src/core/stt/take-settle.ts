/**
 * Where a take that is still recording may be cut into pieces heard ahead
 * (take-ahead.ts), so the stop only has its tail left to hear.
 *
 * 2026-11-21, measured on the user's own takes: the wait after the stop grew
 * with the take (0.9 s under 30 s, 7.6 s at 2 to 5 minutes, 17.7 s for 4.3
 * minutes), because the final text hears the whole clip again. Cut at quiet
 * spots about every 30 s the same takes read as well as heard whole (7.7% word
 * errors against 7.9%), so the finished part is heard while the user talks.
 *
 * Pure: 16 kHz mono PCM in, sample offsets out.
 */

import { segmentBoundaries, SAMPLE_RATE } from './wav-segment.js';

/** Unsettled audio needed before anything is cut: below it the take waits. */
export const SETTLE_MIN_SEC = 40;
/** Longest piece, and the stretch before that limit a quiet cut is looked for in. */
export const PIECE_MAX_SEC = 30;
export const PIECE_SEARCH_SEC = 15;
/**
 * Never cut this close to the end of what has arrived: the words there may not
 * be finished, and a decoder gives the same samples for a growing file only up
 * to a few seconds before its end (each piece's samples are checked by hash at
 * the stop, take-ahead.ts).
 */
export const KEEP_OPEN_SEC = 5;

/**
 * The ends of the pieces of `pcm` after `settled` that are finished: every
 * segment but the last one (still open), none ending in the last 5 s. Empty
 * while less than 40 s are unsettled, so a short take settles nothing.
 */
export function settleCuts(pcm: Int16Array, settled: number): number[] {
  const open = pcm.length - settled;
  if (open < SETTLE_MIN_SEC * SAMPLE_RATE) return [];
  const bounds = segmentBoundaries(pcm.subarray(settled), { maxSec: PIECE_MAX_SEC, searchSec: PIECE_SEARCH_SEC });
  const lastCut = pcm.length - KEEP_OPEN_SEC * SAMPLE_RATE;
  // The final boundary is the end of the audio, the open segment's end: never a cut.
  return bounds.slice(0, -1).map((b) => settled + b).filter((end) => end <= lastCut);
}
