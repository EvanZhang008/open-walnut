/**
 * Per-process cost watermark — the single source of truth for converting a CLI's
 * cumulative `total_cost_usd` into a billable per-result INCREMENT.
 *
 * Why this exists: Claude Code (and the Agent SDK) report `total_cost_usd` as a
 * RUNNING TOTAL for the current process/query, not a per-turn delta. A long-lived
 * session emits a result every turn carrying the ever-growing total. Recording that
 * total each turn re-bills the entire history every turn — the bug that inflated
 * `session` usage 6–13× (a real ~$36K showed as $223K). Replayed JSONL result
 * events (daemon restarts / stale FIFO echoes) compound it by re-sending the whole
 * ascending series.
 *
 * The fix: keep a watermark = the highest cumulative total already billed for the
 * CURRENT process. Bill only `total - watermark` when it rises; bill 0 when the
 * total is unchanged (replay) or lower (a --resume started a fresh process whose
 * total restarts at 0 — the caller resets the watermark to 0 on spawn/resume, so
 * the new process is then billed in full from 0).
 */

/** Pure increment calculation. Returns the billable delta and the new watermark. */
export function costIncrement(
  cumulativeTotal: number | undefined,
  watermark: number,
): { delta: number; watermark: number } {
  if (cumulativeTotal === undefined || !(cumulativeTotal > 0)) {
    return { delta: 0, watermark };
  }
  const delta = cumulativeTotal - watermark;
  if (delta <= 0) {
    // Unchanged (replay) or dropped below watermark without a reset → already billed.
    return { delta: 0, watermark };
  }
  return { delta, watermark: cumulativeTotal };
}

/**
 * Stateful watermark for one session/query. Reset to 0 whenever the underlying
 * process restarts (spawn / --resume), because its `total_cost_usd` restarts at 0.
 */
export class CostWatermark {
  private watermark = 0;

  /** Forget billed cost — call on every process spawn/resume (fresh total at 0). */
  reset(): void {
    this.watermark = 0;
  }

  /** Bill the increment since the last result; advances the watermark. */
  bill(cumulativeTotal: number | undefined): number {
    const r = costIncrement(cumulativeTotal, this.watermark);
    this.watermark = r.watermark;
    return r.delta;
  }
}
