// Pure width math for the home-page session column strip.
// Extracted from MainPage.tsx so it can be unit-tested without React.
//
// WHY THIS EXISTS (the bug it fixes at the root):
//
// Column widths used to be ONE scalar, `colSplitPct` — column 0 got `pct`% and
// "the rest" got `100 - pct`%. That is only coherent for EXACTLY two columns:
// with three, every non-first column is handed `100 - pct`% each, so the strip
// sums past 100% (50 → 50/50/50 = 150%) and overflows. Any "3 panels" option
// built on the scalar ships a broken layout.
//
// So widths are now per-column WEIGHTS (percentages summing to 100). Any column
// count works, and dragging a divider is a local trade between its two
// neighbours only — every other column keeps its share, which is how every
// other splitter in the app behaves.

/**
 * Floor (%) a single column may shrink to on a drag, for a strip of `count` columns.
 *
 * It MUST scale with the count. A fixed 20% (the old 20/80 scalar clamp) is
 * unsatisfiable from 5 columns up — 5 × 20 = 100 leaves zero room to trade, and
 * 6 × 20 = 120 is not even reachable — so a fixed floor silently turns every
 * drag into a no-op once the user picks a custom count that high. Half the even
 * share is always satisfiable (count × floor < 100 for any count) and keeps the
 * familiar 20% floor for the 2-column case.
 */
export function minColPct(count: number): number {
  if (count <= 1) return 100;
  return Math.min(20, (100 / count) * 0.5);
}

const STORE_KEY = 'open-walnut-col-weights';
/** Pre-3-panel scalar: column 0's share of a two-column strip. */
const LEGACY_SCALAR_KEY = 'open-walnut-col-split';

type ReadableStorage = Pick<Storage, 'getItem'>;
type WritableStorage = Pick<Storage, 'getItem' | 'setItem'>;

/** Equal shares summing to exactly 100 — the remainder goes to the first column. */
export function evenWeights(count: number): number[] {
  if (count <= 0) return [];
  const base = Math.floor(100 / count);
  const weights = new Array<number>(count).fill(base);
  weights[0] += 100 - base * count;
  return weights;
}

/**
 * Coerce arbitrary stored data into exactly `count` weights summing to 100.
 *
 * A stored layout that is the wrong length, non-numeric, or violates the
 * per-column floor is reset rather than salvaged column-by-column: it can only
 * come from a hand-edited or older-schema value, and an even split is a
 * predictable recovery.
 */
export function normalizeWeights(input: unknown, count: number): number[] {
  if (count <= 0) return [];
  if (!Array.isArray(input) || input.length !== count) return evenWeights(count);
  const nums: number[] = [];
  for (const v of input) {
    if (typeof v !== 'number' || !Number.isFinite(v) || v <= 0) return evenWeights(count);
    nums.push(v);
  }
  const sum = nums.reduce((a, b) => a + b, 0);
  const scaled = nums.map((n) => (n / sum) * 100);
  const floor = minColPct(count);
  if (scaled.some((n) => n < floor - 0.01)) return evenWeights(count);
  return scaled;
}

/**
 * Drag the divider between column `boundary` and `boundary + 1` by `deltaPct`
 * of the strip's width. Only those two columns trade width; the total stays 100.
 * `deltaPct` is measured from the grab point (not per-frame), so a drag is
 * always recomputed from the weights captured at pointerdown.
 */
export function resizeAtBoundary(weights: number[], boundary: number, deltaPct: number): number[] {
  if (boundary < 0 || boundary + 1 >= weights.length) return weights;
  const left = weights[boundary];
  const right = weights[boundary + 1];
  const floor = minColPct(weights.length);
  // Nothing to trade: the pair is already at (or under) twice the floor.
  if (left + right - floor * 2 <= 0) return weights;
  const delta = Math.min(right - floor, Math.max(floor - left, deltaPct));
  const out = [...weights];
  out[boundary] = left + delta;
  out[boundary + 1] = right - delta;
  return out;
}

function parseStore(raw: string | null): Record<string, unknown> {
  if (!raw) return {};
  try {
    const parsed: unknown = JSON.parse(raw);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

/**
 * Read the saved layout for a `count`-column strip. Layouts are stored PER COUNT
 * so opening a third panel doesn't stretch (and then permanently lose) the
 * two-column layout the user tuned — closing it restores the old one verbatim.
 */
export function loadColWeights(count: number, storage: ReadableStorage): number[] {
  if (count <= 0) return [];
  let saved: unknown;
  try {
    saved = parseStore(storage.getItem(STORE_KEY))[String(count)];
  } catch {
    saved = undefined;
  }
  if (saved !== undefined) return normalizeWeights(saved, count);
  if (count === 2) {
    // Migrate the scalar: it held column 0's share, column 1 got the remainder.
    try {
      const legacy = parseFloat(storage.getItem(LEGACY_SCALAR_KEY) ?? '');
      if (!Number.isNaN(legacy)) return normalizeWeights([legacy, 100 - legacy], 2);
    } catch { /* fall through to an even split */ }
  }
  return evenWeights(count);
}

/** Persist one count's layout, leaving the other counts' saved layouts intact. */
export function saveColWeights(weights: number[], storage: WritableStorage): void {
  if (weights.length === 0) return;
  try {
    const store = parseStore(storage.getItem(STORE_KEY));
    store[String(weights.length)] = weights.map((w) => Math.round(w * 10) / 10);
    storage.setItem(STORE_KEY, JSON.stringify(store));
  } catch { /* storage unavailable (private mode / quota) — layout just won't persist */ }
}
