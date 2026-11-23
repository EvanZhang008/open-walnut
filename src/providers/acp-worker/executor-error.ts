/**
 * A turn that failed while its prompt answered `end_turn`: some adapters (the Gemini
 * family's agent CLIs) report a model API failure as the turn's last chat text,
 *
 *   "\n<U+26A0> agent executor error: generating and executing: Error 400, Message: API key not
 *    valid. Please pass a valid API key., Status: INVALID_ARGUMENT, Details: [map[...
 *    reason:API_KEY_INVALID ...]]\n"
 *
 * and then end the turn as if it ran. Read here (the worker keeps the live turn's text
 * tail), the turn is journaled with an `error` meta of Walnut's own kind ahead of its
 * `turn-ended`, so it reads as failed, a missing key as a sign-in problem, and a quota as
 * the usage limit Walnut waits out (core/sessions/usage-limit-wait.ts).
 *
 * Kept apart from usage-limit-text.ts on purpose: the daemon twins copy that module's
 * pattern list, and these shapes are only ever read in the worker.
 *
 * Pure: no IO, the clock is an argument.
 */

export type TurnFailureKind = 'usage_limit' | 'auth_required' | 'protocol'

export interface TurnTextFailure {
  kind: TurnFailureKind
  /** The quota's reset (epoch ms), when the provider named one. */
  resetsAt?: number
  /** The provider's error line, for the daemon's log only (redacted there); never journaled. */
  words: string
}

/** The adapter's error line: at a line start, the warning sign, then the mark. */
const EXECUTOR_ERROR_LINE = /(?:^|\n)[ \t]*\u26a0\ufe0f?[ \t]*agent executor error:/g
/** How much of a turn's text the worker keeps: the error line is the turn's last words. */
export const TURN_TAIL_CHARS = 4096
/** The most an error line runs past its mark (its Details list included). */
const ERROR_LINE_MAX = 3000
const WORDS_MAX = 400

/** The last `max` characters of a turn's agent text. */
export class TurnTextTail {
  private text = ''
  constructor(private readonly max = TURN_TAIL_CHARS) {}
  push(chunk: string): void {
    this.text = (this.text + chunk).slice(-this.max)
  }
  read(): string { return this.text }
  reset(): void { this.text = '' }
}

/**
 * The failure an executor-error line in `text` names, or undefined when the text holds
 * none. The line must start a line with the warning sign and be the text's end (at most
 * ERROR_LINE_MAX characters follow the mark): a model that merely quotes such a line in
 * its answer, with more answer after it, ends no turn as failed. Only the LAST one counts.
 */
export function readExecutorError(text: string, nowMs: number): TurnTextFailure | undefined {
  let at = -1
  for (const m of text.matchAll(EXECUTOR_ERROR_LINE)) at = m.index + m[0].length
  if (at < 0) return undefined
  const line = text.slice(at)
  if (line.trim().length > ERROR_LINE_MAX) return undefined
  const words = line.trim().replace(/\s+/g, ' ').slice(0, WORDS_MAX)

  // "Error 400, Message: ..., Status: INVALID_ARGUMENT" and "RESOURCE_EXHAUSTED (code 429): ...".
  const shaped = /\bError (\d{3}), Message: (.+?), Status: ([A-Z_]+)/.exec(line)
  const named = shaped ? null : /\b([A-Z][A-Z_]{2,}) \(code (\d{3})\): /.exec(line)
  const code = Number(shaped?.[1] ?? named?.[2] ?? NaN)
  const status = shaped?.[3] ?? named?.[1]
  const reason = /\breason:\s*"?([A-Z][A-Z_]+)/.exec(line)?.[1]

  const kind = classify(code, status, reason)
  if (kind !== 'usage_limit') return { kind, words }
  const resetsAt = quotaReset(line, nowMs)
  return { kind, words, ...(resetsAt !== undefined ? { resetsAt } : {}) }
}

const AUTH_STATUSES = new Set(['UNAUTHENTICATED', 'PERMISSION_DENIED'])
const AUTH_REASON = /^(?:API_KEY_[A-Z_]+|ACCESS_TOKEN_[A-Z_]+|CREDENTIALS_MISSING)$/
const QUOTA_REASON = /^(?:QUOTA_EXHAUSTED|RATE_LIMIT_EXCEEDED|RESOURCE_EXHAUSTED)$/

function classify(code: number, status: string | undefined, reason: string | undefined): TurnFailureKind {
  if (code === 401 || code === 403 || (status && AUTH_STATUSES.has(status)) || (reason && AUTH_REASON.test(reason))) return 'auth_required'
  if (code === 429 || status === 'RESOURCE_EXHAUSTED' || (reason && QUOTA_REASON.test(reason))) return 'usage_limit'
  return 'protocol'
}

/** The quota's reset: its timestamp first, then its reset delay, then the retry delay. */
function quotaReset(line: string, nowMs: number): number | undefined {
  const stamp = /\bquotaResetTimeStamp:\s*"?(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2}))/.exec(line)?.[1]
  if (stamp) {
    const at = Date.parse(stamp)
    if (Number.isFinite(at)) return at
  }
  for (const key of ['quotaResetDelay', 'retryDelay']) {
    const raw = new RegExp(`\\b${key}:\\s*"?([0-9.][0-9.a-z\\u00b5\\u03bc]*)`).exec(line)?.[1]
    const ms = raw ? parseGoDuration(raw) : undefined
    if (ms !== undefined) return nowMs + ms
  }
  return undefined
}

const GO_UNIT_MS: Record<string, number> = {
  ns: 1e-6, us: 1e-3, '\u00b5s': 1e-3, '\u03bcs': 1e-3, ms: 1, s: 1000, m: 60_000, h: 3_600_000,
}

/**
 * A Go `time.Duration` string ("1h2m3.5s", "34.07s", "500ms", "0") as milliseconds, or
 * undefined when it is not one. Signs are refused: a delay is never negative.
 */
export function parseGoDuration(text: string): number | undefined {
  const s = text.trim()
  if (s === '0') return 0
  if (!s) return undefined
  const part = /(\d+(?:\.\d*)?|\.\d+)(ns|us|\u00b5s|\u03bcs|ms|s|m|h)/y
  let pos = 0
  let total = 0
  while (pos < s.length) {
    part.lastIndex = pos
    const m = part.exec(s)
    if (!m) return undefined
    total += Number(m[1]) * GO_UNIT_MS[m[2]]
    pos = part.lastIndex
  }
  return Number.isFinite(total) ? Math.round(total) : undefined
}

/**
 * True when the adapter ends a quota-exhausted turn with `stopReason: "refusal"`, so a
 * refusal there is the usage limit, not the model's safeguards. Keyed on the adapter's
 * own identity (initialize's agentInfo.name), never on a Walnut engine id.
 */
export function refusalMeansUsageLimit(initializeResponse: unknown): boolean {
  const info = initializeResponse && typeof initializeResponse === 'object'
    ? (initializeResponse as { agentInfo?: { name?: unknown } }).agentInfo
    : undefined
  return typeof info?.name === 'string' && info.name.startsWith('Antigravity')
}

/**
 * How a turn that the provider answered (not rejected) failed, or undefined when it ran:
 * an executor-error line at its end, else a refusal from an adapter whose refusal is its
 * quota.
 */
export function turnEndFailure(o: {
  tail: string
  stopReason: unknown
  initializeResponse: unknown
  nowMs: number
}): TurnTextFailure | undefined {
  const fromText = readExecutorError(o.tail, o.nowMs)
  if (o.stopReason === 'refusal' && refusalMeansUsageLimit(o.initializeResponse)) {
    return fromText?.kind === 'usage_limit' ? fromText : { kind: 'usage_limit', words: 'refusal stop (quota)' }
  }
  return fromText
}
