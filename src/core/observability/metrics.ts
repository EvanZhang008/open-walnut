/**
 * Forensic Observability — in-process metrics registry.
 *
 * Every latency in the app (HTTP requests, LLM round-trips, tool executions,
 * searches, turn durations, event-loop lag) funnels into ONE registry as named
 * histograms/counters, so "is X slow?" is a query, not an archaeology dig
 * through ad-hoc log lines.
 *
 * Design constraints (each is a shipped incident in this repo):
 *  - ZERO hot-path cost: `observe()` is a Map lookup + integer adds + a bounded
 *    reservoir push. No I/O, no serialization, no Date.toISOString on the hot
 *    path. Anything heavier would itself become the next event-loop stall.
 *  - Never throws: a metrics bug must not break the operation being measured.
 *  - Bounded memory: label cardinality is capped (MAX_SERIES); the percentile
 *    reservoir is capped per series (RESERVOIR_CAP) with random replacement,
 *    so a busy series stays a uniform sample instead of growing forever.
 *  - Two sinks, same data: a periodic flush emits one wide `obs` log line per
 *    window (greppable forever, survives restarts), and GET /api/metrics reads
 *    the live registry (real-time, includes the current partial window).
 *
 * Naming: dot-separated lowercase (`llm.roundtrip`, `search.memory`), with a
 * small `labels` object for dimensions (model, route, tool). Keep label VALUES
 * low-cardinality — route templates not URLs, tool names not arguments.
 */

import { log } from '../../logging/index.js';

/** Max distinct (name + labels) series before new ones are dropped (guard
 *  against a label-cardinality explosion eating memory silently). */
const MAX_SERIES = 500;
/** Per-series sample reservoir for percentiles. 256 gives p99 ±1% at the
 *  volumes this app sees; beyond that, uniform random replacement. */
const RESERVOIR_CAP = 256;
/** Flush cadence. One wide log line per non-empty series per window. */
const FLUSH_INTERVAL_MS = 60_000;

interface Series {
  name: string;
  labels: Record<string, string> | undefined;
  /** Stable key: name + canonicalized labels. */
  key: string;
  // Lifetime aggregates (since process start) — cheap, never reset.
  count: number;
  sum: number;
  min: number;
  max: number;
  // Current window (reset at each flush).
  windowCount: number;
  windowSum: number;
  windowMin: number;
  windowMax: number;
  /** Uniform sample of window values for percentiles. */
  reservoir: number[];
  /** Total window observations seen (for reservoir replacement probability). */
  windowSeen: number;
}

const series = new Map<string, Series>();
let droppedSeries = 0;
let flushTimer: ReturnType<typeof setInterval> | null = null;

/** Canonical series key — label order must not create duplicate series. */
function seriesKey(name: string, labels?: Record<string, string>): string {
  if (!labels) return name;
  const parts = Object.keys(labels).sort().map((k) => `${k}=${labels[k]}`);
  return parts.length > 0 ? `${name}{${parts.join(',')}}` : name;
}

function getOrCreate(name: string, labels?: Record<string, string>): Series | null {
  const key = seriesKey(name, labels);
  let s = series.get(key);
  if (s) return s;
  if (series.size >= MAX_SERIES) {
    // Cardinality guard: count drops (surfaced in snapshot()) instead of
    // growing without bound. First 500 series always win — stable, debuggable.
    droppedSeries++;
    return null;
  }
  s = {
    name, labels, key,
    count: 0, sum: 0, min: Infinity, max: -Infinity,
    windowCount: 0, windowSum: 0, windowMin: Infinity, windowMax: -Infinity,
    reservoir: [], windowSeen: 0,
  };
  series.set(key, s);
  return s;
}

/**
 * Record one observation (usually a duration in ms) into a named histogram.
 * Hot-path safe: no I/O, never throws.
 */
export function observe(name: string, value: number, labels?: Record<string, string>): void {
  try {
    if (!Number.isFinite(value)) return;
    const s = getOrCreate(name, labels);
    if (!s) return;
    s.count++; s.sum += value;
    if (value < s.min) s.min = value;
    if (value > s.max) s.max = value;
    s.windowCount++; s.windowSum += value;
    if (value < s.windowMin) s.windowMin = value;
    if (value > s.windowMax) s.windowMax = value;
    s.windowSeen++;
    if (s.reservoir.length < RESERVOIR_CAP) {
      s.reservoir.push(value);
    } else {
      // Uniform reservoir sampling: replace a random slot with probability cap/seen.
      const idx = Math.floor(Math.random() * s.windowSeen);
      if (idx < RESERVOIR_CAP) s.reservoir[idx] = value;
    }
  } catch { /* metrics must never break the measured operation */ }
}

/**
 * Increment a named counter (token totals, cache hits, error counts).
 * Counters reuse the histogram storage — `sum` is the running total, `count`
 * the number of increments; percentiles are meaningless and omitted for them
 * by convention (they're still harmless if read).
 */
export function count(name: string, delta = 1, labels?: Record<string, string>): void {
  observe(name, delta, labels);
}

/**
 * Time an async operation and record it. Sugar for the common wrap pattern:
 *   const rows = await timed('search.memory', () => store.search(...), {store: 'memory'})
 * Failures are recorded under `<name>.error` (count) and re-thrown untouched.
 */
export async function timed<T>(
  name: string,
  fn: () => Promise<T>,
  labels?: Record<string, string>,
): Promise<T> {
  const start = performance.now();
  try {
    const out = await fn();
    observe(name, performance.now() - start, labels);
    return out;
  } catch (err) {
    observe(name, performance.now() - start, labels);
    count(`${name}.error`, 1, labels);
    throw err;
  }
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[Math.max(0, idx)];
}

export interface SeriesSnapshot {
  name: string;
  labels?: Record<string, string>;
  /** Lifetime (since process start). */
  count: number;
  sum: number;
  min: number;
  max: number;
  avg: number;
  /** Current window (since last flush). */
  window: {
    count: number;
    sum: number;
    min: number;
    max: number;
    avg: number;
    p50: number;
    p90: number;
    p99: number;
  } | null;
}

/** Live snapshot of every series — feeds GET /api/metrics. Read-only, cheap. */
export function snapshot(): { series: SeriesSnapshot[]; droppedSeries: number; sinceMs: number } {
  const out: SeriesSnapshot[] = [];
  for (const s of series.values()) {
    const sorted = [...s.reservoir].sort((a, b) => a - b);
    out.push({
      name: s.name,
      ...(s.labels && { labels: s.labels }),
      count: s.count,
      sum: round2(s.sum),
      min: s.count > 0 ? round2(s.min) : 0,
      max: s.count > 0 ? round2(s.max) : 0,
      avg: s.count > 0 ? round2(s.sum / s.count) : 0,
      window: s.windowCount > 0 ? {
        count: s.windowCount,
        sum: round2(s.windowSum),
        min: round2(s.windowMin),
        max: round2(s.windowMax),
        avg: round2(s.windowSum / s.windowCount),
        p50: round2(percentile(sorted, 50)),
        p90: round2(percentile(sorted, 90)),
        p99: round2(percentile(sorted, 99)),
      } : null,
    });
  }
  out.sort((a, b) => a.name.localeCompare(b.name) || seriesKey(a.name, a.labels).localeCompare(seriesKey(b.name, b.labels)));
  return { series: out, droppedSeries, sinceMs: processStartMs };
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

const processStartMs = Date.now();

/**
 * Flush the current window: one wide `obs` log line per active series, then
 * reset window state. The log line is the durable record — queryable later via
 * `walnut-logs.sh metrics` / jq even after the process restarts.
 */
export function flush(): void {
  try {
    for (const s of series.values()) {
      if (s.windowCount === 0) continue;
      const sorted = [...s.reservoir].sort((a, b) => a - b);
      log.obs.info('metric', {
        metric: s.name,
        ...(s.labels && { labels: s.labels }),
        count: s.windowCount,
        sum: round2(s.windowSum),
        min: round2(s.windowMin),
        max: round2(s.windowMax),
        avg: round2(s.windowSum / s.windowCount),
        p50: round2(percentile(sorted, 50)),
        p90: round2(percentile(sorted, 90)),
        p99: round2(percentile(sorted, 99)),
        totalCount: s.count,
      });
      s.windowCount = 0; s.windowSum = 0;
      s.windowMin = Infinity; s.windowMax = -Infinity;
      s.reservoir.length = 0; s.windowSeen = 0;
    }
    if (droppedSeries > 0) {
      log.obs.warn('metric series dropped (cardinality cap)', { droppedSeries, cap: MAX_SERIES });
    }
  } catch (err) {
    log.obs.warn('metrics flush failed', { error: err instanceof Error ? err.message : String(err) });
  }
}

/** Start the periodic flush loop (server startup). Safe to call twice. */
export function startMetricsFlush(): void {
  if (flushTimer) return;
  flushTimer = setInterval(flush, FLUSH_INTERVAL_MS);
  flushTimer.unref(); // never keep the process alive just for metrics
}

/** Stop the flush loop + clear state (tests / shutdown). */
export function stopMetricsFlush(): void {
  if (flushTimer) { clearInterval(flushTimer); flushTimer = null; }
}

/** Test-only: wipe all series. */
export function resetMetrics(): void {
  series.clear();
  droppedSeries = 0;
}

/** Grouped export for call sites that prefer one import. */
export const metrics = { observe, count, timed, snapshot, flush };
