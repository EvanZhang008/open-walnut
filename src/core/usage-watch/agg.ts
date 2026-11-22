/**
 * One hour of one tool op, route or page-error kind: counts, sizes and times, no content. Sizes
 * go into a log-scale histogram (ratio 1.25, so a percentile read from it is within about 12%).
 */

export type UsageKind = 'op' | 'http' | 'page'

/** How a call ended: refused and bad_args are the caller's to fix; error, timeout and unreachable are not. */
export type OutcomeClass = 'ok' | 'refused' | 'bad_args' | 'error' | 'timeout' | 'unreachable'

export interface Agg {
  calls: number
  fails: number
  refused: number
  badArgs: number
  errors: number
  timeouts: number
  unreachable: number
  /** Answers over 10,000 characters. */
  over10k: number
  /** Answers over the limit of the client that asked (answerSize): measured, not seen cut. */
  overLimit: number
  /** Answers Claude Code itself said it saved to a file instead of passing on (session hook). */
  cut: number
  /** MCP answers past fitToolAnswer's cap: Walnut's MCP server saved them to a file and sent a note. */
  spilled: number
  charsSum: number
  charsMax: number
  msSum: number
  msMax: number
  /** Requests: reads over 5 s. Pages: unused. */
  slow: number
  /** Log-scale size buckets: bucket index → count. */
  hist: Record<string, number>
  /** Log-scale time buckets (ms), for a latency percentile. */
  msHist: Record<string, number>
  /** Error code → count (refusals and errors). */
  codes: Record<string, number>
  /** Requests: server errors (5xx). */
  serverErrors: number
}

export const BIG_CHARS = 10_000
const RATIO = Math.log(1.25)

export function emptyAgg(): Agg {
  return { calls: 0, fails: 0, refused: 0, badArgs: 0, errors: 0, timeouts: 0, unreachable: 0, over10k: 0, overLimit: 0, cut: 0, spilled: 0, charsSum: 0, charsMax: 0, msSum: 0, msMax: 0, slow: 0, hist: {}, msHist: {}, codes: {}, serverErrors: 0 }
}

export function bucketOf(chars: number): number {
  return chars <= 0 ? 0 : Math.floor(Math.log(chars + 1) / RATIO)
}

/** The upper edge of a bucket in characters. */
export function bucketTop(bucket: number): number {
  return Math.round(Math.exp((bucket + 1) * RATIO) - 1)
}

export function mergeAgg(a: Agg, b: Agg): Agg {
  const out = emptyAgg()
  for (const key of ['calls', 'fails', 'refused', 'badArgs', 'errors', 'timeouts', 'unreachable', 'over10k', 'overLimit', 'cut', 'spilled', 'charsSum', 'msSum', 'slow', 'serverErrors'] as const) {
    out[key] = (a[key] ?? 0) + (b[key] ?? 0)
  }
  out.charsMax = Math.max(a.charsMax ?? 0, b.charsMax ?? 0)
  out.msMax = Math.max(a.msMax ?? 0, b.msMax ?? 0)
  for (const [k, v] of [...Object.entries(a.hist ?? {}), ...Object.entries(b.hist ?? {})]) out.hist[k] = (out.hist[k] ?? 0) + v
  for (const [k, v] of [...Object.entries(a.msHist ?? {}), ...Object.entries(b.msHist ?? {})]) out.msHist[k] = (out.msHist[k] ?? 0) + v
  for (const [k, v] of [...Object.entries(a.codes ?? {}), ...Object.entries(b.codes ?? {})]) out.codes[k] = (out.codes[k] ?? 0) + v
  return out
}

function percentile(hist: Record<string, number>, p: number, max: number): number | null {
  const entries = Object.entries(hist).map(([k, v]) => [Number(k), v] as const).sort((x, y) => x[0] - y[0])
  const total = entries.reduce((s, [, v]) => s + v, 0)
  if (!total) return null
  const want = Math.max(1, Math.ceil((p / 100) * total))
  let seen = 0
  for (const [bucket, n] of entries) {
    seen += n
    if (seen >= want) return Math.min(bucketTop(bucket), max || bucketTop(bucket))
  }
  return max || null
}

/** The answer size at percentile `p` (0..100), as its bucket's upper edge (within about 12%); null with no calls. */
export function sizePercentile(agg: Agg, p: number): number | null {
  return percentile(agg.hist, p, agg.charsMax)
}

/** The time in ms at percentile `p`, the same way. */
export function msPercentile(agg: Agg, p: number): number | null {
  return percentile(agg.msHist ?? {}, p, agg.msMax)
}

/** A call's outcome into an hour: one call, its class, size and time. */
export function addCall(agg: Agg, c: { cls: OutcomeClass; code?: string; chars: number; ms: number }): void {
  agg.calls++
  if (c.cls !== 'ok') {
    agg.fails++
    if (c.cls === 'refused') agg.refused++
    else if (c.cls === 'bad_args') agg.badArgs++
    else if (c.cls === 'error') agg.errors++
    else if (c.cls === 'timeout') agg.timeouts++
    else agg.unreachable++
  }
  if (c.code) agg.codes[c.code] = (agg.codes[c.code] ?? 0) + 1
  if (c.chars > BIG_CHARS) agg.over10k++
  agg.charsSum += c.chars
  if (c.chars > agg.charsMax) agg.charsMax = c.chars
  const b = String(bucketOf(c.chars))
  agg.hist[b] = (agg.hist[b] ?? 0) + 1
  agg.msSum += c.ms
  if (c.ms > agg.msMax) agg.msMax = c.ms
  const m = String(bucketOf(c.ms))
  agg.msHist[m] = (agg.msHist[m] ?? 0) + 1
}
