/**
 * One hour of one tool op, route or page-error kind: counts, sizes and times, no content. Sizes
 * go into a log-scale histogram (ratio 1.25, so a percentile read from it is within about 12%).
 */

export type UsageKind = 'op' | 'http' | 'page'

/**
 * How a call ended. Walnut's own faults are `error` and `timeout`: only they make a failure rate.
 * `bad_args` (the caller sent arguments the tool cannot take) and `refused` (a rule said no by
 * design: same_ask, reply_language, user_kind, a conflict, a stopped trigger) are the caller's
 * side, counted and reported apart (2026-11-25: a watch failed task_report_set at 21.7% and
 * human_inbox_send at 33.3% on agents' wrong arguments alone, with no fault of Walnut's).
 * `unreachable` (a host or the Mac away, a sleep) is neither.
 */
export type OutcomeClass = 'ok' | 'refused' | 'bad_args' | 'error' | 'timeout' | 'unreachable'

/** Whose each failed class is. A new class must say it here before anything counts it. */
export const OUTCOME_SIDE: Record<Exclude<OutcomeClass, 'ok'>, 'own' | 'caller' | 'neither'> = {
  error: 'own', timeout: 'own', bad_args: 'caller', refused: 'caller', unreachable: 'neither',
}

/**
 * Codes by side for a row written before they were kept apart (or merged by an older version,
 * which keeps `codes` only): given only where the row's failures are all of one side, so a code
 * of the caller's is never read as a new fault of Walnut's.
 */
export function backfillSides(a: Agg): void {
  const own = ownFaults(a)
  const caller = callerSide(a)
  if (a.unreachable) return
  if (own > 0 && caller === 0) a.ownCodes = { ...(a.codes ?? {}) }
  else if (caller > 0 && own === 0) a.callerCodes = { ...(a.codes ?? {}) }
}

/** Walnut's own faults among the calls: server errors and timeouts. */
export function ownFaults(a: Pick<Agg, 'errors' | 'timeouts'>): number {
  return (a.errors ?? 0) + (a.timeouts ?? 0)
}

/** The caller's side: bad arguments and designed refusals. Never a failure; reported apart. */
export function callerSide(a: Pick<Agg, 'badArgs' | 'refused'>): number {
  return (a.badArgs ?? 0) + (a.refused ?? 0)
}

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
  /** The codes of Walnut's own faults (error, timeout) alone, for the new-code check. Older rows have none. */
  ownCodes: Record<string, number>
  /** The codes of the caller's side (bad_args, refused) alone. Older rows have none. */
  callerCodes: Record<string, number>
  /** Requests: server errors (5xx). */
  serverErrors: number
}

export const BIG_CHARS = 10_000
const RATIO = Math.log(1.25)

export function emptyAgg(): Agg {
  return { calls: 0, fails: 0, refused: 0, badArgs: 0, errors: 0, timeouts: 0, unreachable: 0, over10k: 0, overLimit: 0, cut: 0, spilled: 0, charsSum: 0, charsMax: 0, msSum: 0, msMax: 0, slow: 0, hist: {}, msHist: {}, codes: {}, ownCodes: {}, callerCodes: {}, serverErrors: 0 }
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
  for (const m of ['codes', 'ownCodes', 'callerCodes'] as const) {
    for (const [k, v] of [...Object.entries(a[m] ?? {}), ...Object.entries(b[m] ?? {})]) out[m][k] = (out[m][k] ?? 0) + v
  }
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

/**
 * A call's outcome into an hour: one call, its class, size and time. No `chars`: the answer was
 * not an agent's read (a program took it, or the caller asked for it whole), so it is in no size number.
 */
export function addCall(agg: Agg, c: { cls: OutcomeClass; code?: string; chars?: number; ms: number }): void {
  agg.calls++
  if (c.cls !== 'ok') {
    agg.fails++
    if (c.cls === 'refused') agg.refused++
    else if (c.cls === 'bad_args') agg.badArgs++
    else if (c.cls === 'error') agg.errors++
    else if (c.cls === 'timeout') agg.timeouts++
    else agg.unreachable++
  }
  if (c.code) {
    agg.codes[c.code] = (agg.codes[c.code] ?? 0) + 1
    const side = c.cls === 'ok' ? null : OUTCOME_SIDE[c.cls] === 'own' ? 'ownCodes' : OUTCOME_SIDE[c.cls] === 'caller' ? 'callerCodes' : null
    if (side) { agg[side] ??= {}; agg[side][c.code] = (agg[side][c.code] ?? 0) + 1 }
  }
  if (c.chars !== undefined) {
    if (c.chars > BIG_CHARS) agg.over10k++
    agg.charsSum += c.chars
    if (c.chars > agg.charsMax) agg.charsMax = c.chars
    const b = String(bucketOf(c.chars))
    agg.hist[b] = (agg.hist[b] ?? 0) + 1
  }
  agg.msSum += c.ms
  if (c.ms > agg.msMax) agg.msMax = c.ms
  const m = String(bucketOf(c.ms))
  agg.msHist[m] = (agg.msHist[m] ?? 0) + 1
}
