/**
 * What the vector backfill writes to the log (wiring.ts drives the batches).
 *
 * 2026-10-06: the progress line fired on almost every batch of almost every
 * pass, always with a small `embedded` count, so the log read like a loop that
 * never advanced while the embed worker sat at 140 to 180% CPU for 90 minutes.
 * It was a run of slow batches, but the log could not say so: no batch carried
 * its own size or duration. Now each batch that ran inference writes one line
 * with its doc count and elapsed time, and the progress line fires only when
 * the pass total crosses a multiple of VEC_PROGRESS_EVERY.
 */

import type { BackfillVectorsResult } from '../../lib/hybrid-search/index.js';

export const VEC_PROGRESS_EVERY = 800;

/**
 * True when one batch carried the pass total across a multiple of `every`.
 * The old test, `total % 800 < 16`, was meant to catch the batch that lands
 * just past a multiple, but it also held for every total from 1 to 15, so a
 * pass that embedded a handful of docs (most passes) logged on each batch.
 */
export function crossedProgressMilestone(
  before: number,
  after: number,
  every: number = VEC_PROGRESS_EVERY,
): boolean {
  return after > before && Math.floor(after / every) > Math.floor(before / every);
}

export interface BatchLogContext {
  phase: 'light' | 'all';
  /** Docs embedded so far in this pass, this batch included. */
  passEmbedded: number;
  fullPass: boolean;
}

/**
 * Fields of a batch's log line, or null for a call that ran no inference. Most
 * calls are scan-only steps of the walk (about 190 for the hourly full pass,
 * each a few ms), and while someone searches the walk yields to each query
 * before it starts (retried every 25 ms on an idle machine): a line for each
 * would bury the batches that did work.
 */
export function backfillBatchLogFields(
  result: BackfillVectorsResult,
  elapsedMs: number,
  ctx: BatchLogContext,
): Record<string, unknown> | null {
  if (!result.docs || !result.passages) return null;
  return {
    phase: ctx.phase,
    docs: result.docs,
    embedded: result.embedded,
    passages: result.passages,
    ms: Math.round(elapsedMs),
    yielded: result.yielded ?? null,
    passEmbedded: ctx.passEmbedded,
    fullPass: ctx.fullPass,
  };
}
