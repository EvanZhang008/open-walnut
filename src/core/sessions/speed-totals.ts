/**
 * A session's average speed per model: running sums of the counted turns' output tokens and
 * generation time (SessionRecord.speedTotals). One turn swings widely (a short tool-call message
 * is mostly fixed latency), so the readout shows the token-weighted average over the session.
 *
 * Pure and import-free (types only): the server folds each final turn in under the session
 * lock (session-tracker), and the browser (`@open-walnut/speed-totals`) folds a final it already
 * holds live into a record read before that final landed, by the same rule, so both count a
 * turn once. The rule is a forward-only watermark: the latest `endedAt` the totals counted (the
 * newest entry's `lastAt`, which the cap never drops), never the record's `lastTurnSpeed`, which
 * any write may set back (an ACP journal replay re-finishes older turns, keyed by the model the
 * session runs now).
 */
import type { SessionSpeedTotal, SessionTurnSpeed } from '../types.js';

export type SpeedTotals = Record<string, SessionSpeedTotal>;

/** A rate over a shorter window than this is noise (computeReadout leaves its slot empty). */
export const MIN_RATE_WINDOW_MS = 500;
/** Models kept per session; past it the one used longest ago is dropped. */
export const MAX_SPEED_TOTAL_MODELS = 8;

type TurnFacts = Pick<SessionTurnSpeed, 'final' | 'model' | 'outputTokens' | 'generationMs' | 'endedAt'>;

/** A turn the readout gives a rate: final, on a named model, counted tokens over half a second or more. */
export function countsTowardAverage(speed: TurnFacts): boolean {
  return speed.final && !!speed.model && speed.outputTokens > 0 && speed.generationMs >= MIN_RATE_WINDOW_MS;
}

/** The latest turn end the totals counted (0: none). */
export function countedThrough(totals: SpeedTotals | null | undefined): number {
  let through = 0;
  for (const t of Object.values(totals ?? {})) if (typeof t?.lastAt === 'number' && t.lastAt > through) through = t.lastAt;
  return through;
}

/**
 * Did `next` end after every turn the totals counted? A final is frozen, so the same turn written
 * again (Claude Code re-writes it when a backgrounded agent ends) has the same `endedAt`, and a
 * replay of older turns has earlier ones: neither counts twice. A final without `endedAt` cannot
 * be placed and never counts.
 */
export function laterTurn(next: TurnFacts, totals: SpeedTotals | null | undefined): boolean {
  return typeof next.endedAt === 'number' && next.endedAt > countedThrough(totals);
}

/** The totals with `next` added when it is a countable turn after every counted one; otherwise `totals` as given. */
export function foldTurnSpeed(totals: SpeedTotals | undefined, next: TurnFacts): SpeedTotals | undefined {
  if (!countsTowardAverage(next) || !laterTurn(next, totals)) return totals;
  const key = next.model!;
  const was = totals?.[key];
  const out: SpeedTotals = {
    ...(totals ?? {}),
    [key]: {
      outputTokens: (was?.outputTokens ?? 0) + next.outputTokens,
      generationMs: (was?.generationMs ?? 0) + next.generationMs,
      turns: (was?.turns ?? 0) + 1,
      lastAt: next.endedAt!,
    },
  };
  const keys = Object.keys(out);
  if (keys.length > MAX_SPEED_TOTAL_MODELS) {
    const oldest = keys.filter((k) => k !== key)
      .sort((a, b) => (out[a]!.lastAt ?? 0) - (out[b]!.lastAt ?? 0))
      .slice(0, keys.length - MAX_SPEED_TOTAL_MODELS);
    for (const k of oldest) delete out[k];
  }
  return out;
}

/** The sums over the models `match` picks, as tokens per second; null when nothing counted. */
export function averageOf(
  totals: SpeedTotals | null | undefined,
  match: (model: string) => boolean,
): { tps: number; turns: number; outputTokens: number; generationMs: number } | null {
  if (!totals) return null;
  let outputTokens = 0;
  let generationMs = 0;
  let turns = 0;
  for (const [model, t] of Object.entries(totals)) {
    if (!t || !match(model)) continue;
    if (!(t.outputTokens > 0) || !(t.generationMs > 0)) continue;
    outputTokens += t.outputTokens;
    generationMs += t.generationMs;
    turns += t.turns > 0 ? t.turns : 0;
  }
  if (outputTokens <= 0 || generationMs < MIN_RATE_WINDOW_MS) return null;
  return { tps: outputTokens / (generationMs / 1000), turns, outputTokens, generationMs };
}
