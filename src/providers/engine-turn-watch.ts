/**
 * The bound on a turn an engine keeps open without getting anywhere, for every engine Walnut runs.
 *
 * An engine may retry its model request by itself with no upper limit (2026-11-24: Codex sent
 * "Reconnecting... waiting for network" every minute for 7 hours to a proxy that was not listening,
 * and the session read Running all that time). Each retry notice proves the engine is alive, so a
 * watchdog that counts every event as progress never fires. This module is the one policy:
 *
 *   progress      any event of the turn that is not a retry notice: the clocks start again
 *   retry notice  the engine says it will try again: a streak starts (if none runs); the idle
 *                 clock holds, the streak's own clock does not
 *   verdict       a streak older than the retry limit is `retry_exhausted`; no event at all for
 *                 the idle limit (the item limit while a command or tool runs) is `turn_stalled`;
 *                 nothing while the turn waits on a person
 *
 * Its feeders, one per way a turn's events reach Walnut (ENGINE_RETRY_BOUNDS below; the guard test
 * tests/providers/engine-retry-bound.test.ts fails when an engine or a retry signal has none):
 * the direct Codex client (codex-app-server/connection.ts) and the ACP worker for every adapter
 * (acp-worker/worker.ts). Both run on the host that runs the session, so the bound holds with the
 * leader away. Claude Code bounds its own retries once Walnut gives it the same limit
 * (claudeRetryEnv, in the daemon's spawn env). It imports only errors.ts, which imports nothing (the daemon bundles it).
 */
import { classifyCodexFailure } from './codex-app-server/errors.js'

/** How long an engine may keep retrying with nothing else from the turn: the same ~30 minutes Claude Code's retry budget covers (the daemon's CLAUDE_CODE_MAX_RETRIES 60). */
export const ENGINE_RETRY_LIMIT_DEFAULT_MS = 30 * 60_000

function positive(raw: string | undefined, def: number): number {
  const n = Number(raw)
  return Number.isFinite(n) && n > 0 ? n : def
}

/** How long a retry streak may run before the turn is stopped (`WALNUT_ENGINE_RETRY_LIMIT_MS`). */
export function retryLimitMs(env: NodeJS.ProcessEnv): number {
  return positive(env.WALNUT_ENGINE_RETRY_LIMIT_MS, ENGINE_RETRY_LIMIT_DEFAULT_MS)
}

/** No event at all for this long while a turn runs and nothing is in progress: the turn is stuck. */
export function stallIdleMs(env: NodeJS.ProcessEnv): number {
  return positive(env.WALNUT_TURN_STALL_MS ?? env.WALNUT_CODEX_STALL_MS, 15 * 60_000)
}

/** The same while a command or tool call runs (a quiet build or test run is no stall). */
export function stallItemMs(env: NodeJS.ProcessEnv): number {
  return positive(env.WALNUT_TURN_STALL_ITEM_MS ?? env.WALNUT_CODEX_STALL_ITEM_MS, 90 * 60_000)
}

/** How often a watchdog looks: a short limit (tests) is checked as often as it needs. */
export function watchTickMs(env: NodeJS.ProcessEnv): number {
  return Math.max(50, Math.min(15_000, Math.floor(Math.min(stallIdleMs(env), retryLimitMs(env)) / 4)))
}

/** What kind of failure the engine kept retrying, read from its notice (Codex's error code first). */
export type RetryKind = 'connection' | 'rate_limited' | 'overloaded' | 'server_error'

export interface TurnVerdict {
  kind: 'turn_stalled' | RetryKind
  /** Walnut's own words (no provider text, no secret): what happened, for how long, and that the turn was stopped. */
  words: string
}

export interface WatchFacts {
  now: number
  /** A command or tool call of the turn runs. */
  itemRunning: boolean
  /** The turn waits on a person (a permission, a plan question). */
  holding: boolean
  env: NodeJS.ProcessEnv
  /** The engine's name as the user reads it ("Codex", "Gemini"). */
  engine: string
  /** Where the engine sends its model requests, when Walnut knows it. */
  endpoint?: string
}

export class TurnWatch {
  private lastEventAt: number
  private streak: { since: number; count: number; kind: RetryKind } | null = null

  constructor(now = Date.now()) { this.lastEventAt = now }

  /** Anything of the turn that is not a retry notice. */
  progress(now = Date.now()): void {
    this.lastEventAt = now
    this.streak = null
  }

  /** The engine said it will try again. */
  retried(kind: RetryKind, now = Date.now()): void {
    this.lastEventAt = now
    if (this.streak) { this.streak.count++; this.streak.kind = kind } else this.streak = { since: now, count: 1, kind }
  }

  get retrying(): boolean { return this.streak !== null }

  verdict(f: WatchFacts): TurnVerdict | null {
    if (f.holding) return null
    const s = this.streak
    if (s && f.now - s.since >= retryLimitMs(f.env)) {
      return { kind: s.kind, words: retryWords(f.engine, s.kind, s.count, f.now - s.since, f.endpoint) }
    }
    const quiet = f.now - this.lastEventAt
    if (quiet < (f.itemRunning ? stallItemMs(f.env) : stallIdleMs(f.env))) return null
    return { kind: 'turn_stalled', words: `${f.engine} sent nothing for ${duration(quiet)}, so Walnut stopped the turn (operation timed out).` }
  }
}

/** "12 minutes", "40 seconds". */
export function duration(ms: number): string {
  if (ms < 60_000) { const s = Math.max(1, Math.round(ms / 1000)); return `${s} second${s === 1 ? '' : 's'}` }
  const m = Math.round(ms / 60_000)
  return `${m} minute${m === 1 ? '' : 's'}`
}

// Each kind's tail is the signature Walnut's turn-retry reads as transient (daemon-core.ts classifyTurnError).
// Not "connection error": that is the endpoint wait's (endpoint-unreachable.ts), which resumes only
// Claude Code turns, so an ACP session would read Waiting with nothing behind it.
const RETRY_PHRASES: Record<RetryKind, { what: (at: string) => string; tail: string }> = {
  connection: { what: (at) => `could not reach its model${at}`, tail: 'network error' },
  rate_limited: { what: (at) => `was rate limited by its model${at}`, tail: 'HTTP 429' },
  overloaded: { what: (at) => `found its model${at} overloaded`, tail: 'HTTP 503' },
  server_error: { what: (at) => `got server errors from its model${at}`, tail: 'internal server error' },
}

function retryWords(engine: string, kind: RetryKind, count: number, ms: number, endpoint?: string): string {
  const p = RETRY_PHRASES[kind]
  const at = endpoint ? ` at ${endpoint}` : ''
  const tries = count === 1 ? 'once' : `${count} times`
  return `${engine} ${p.what(at)} for ${duration(ms)} (it retried ${tries} by itself), so Walnut stopped the turn (${p.tail}).`
}

/**
 * The URL a model endpoint is named by in words: scheme, host, port and path; never a user, a
 * password, a query or a fragment (a key can ride any of them).
 */
export function endpointWords(url: unknown): string | undefined {
  if (typeof url !== 'string' || !url) return undefined
  try {
    const u = new URL(url)
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return undefined
    return `${u.protocol}//${u.host}${u.pathname.replace(/\/+$/, '')}`
  } catch { return undefined }
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value)

/** The kind of failure a retry notice's error names (Codex's own error code, errors.ts); a connection failure when it names none. */
export function retryKindOf(error: unknown): RetryKind {
  const kind = classifyCodexFailure(error)
  return kind === 'rate_limited' || kind === 'overloaded' || kind === 'server_error' ? kind : 'connection'
}

/**
 * An ACP `session_info_update` that says the engine retries by itself: the shape the direct Codex
 * client and codex-acp send (`_meta.codex.error.willRetry`), read under any engine's key so an
 * adapter that reports retries the same way is bounded too. Returns the notice's error, or null.
 */
export function acpRetryNotice(update: unknown): Record<string, unknown> | null {
  if (!isRecord(update) || update.sessionUpdate !== 'session_info_update' || !isRecord(update._meta)) return null
  for (const ns of Object.values(update._meta)) {
    if (isRecord(ns) && isRecord(ns.error) && ns.error.willRetry === true) return ns.error
  }
  return null
}

/**
 * How each way a turn's events reach Walnut bounds an engine that retries by itself or goes quiet.
 * The guard test enumerates every engine of the registry and every reader of a retry signal under
 * src/providers, and fails when one of them has no row here.
 */
export const ENGINE_RETRY_BOUNDS = {
  'claude-cli': {
    signals: ["stream-json system line subtype 'api_retry'"],
    bound: 'Claude Code ends the turn itself: CLAUDE_CODE_MAX_RETRIES (60, about 30 minutes) and, in its unattended retry mode, CLAUDE_CODE_RETRY_WATCHDOG_MAX_WAIT_MS, which the daemon sets to retryLimitMs (claudeRetryEnv); its stream idle watchdog ends a silent request. The failed turn is an error result with its words.',
  },
  'codex-app-server': {
    signals: ["app-server notification 'error' with willRetry: true", 'no notification while a turn is open'],
    bound: 'codex-app-server/connection.ts checkStall: a TurnWatch per turn; the turn fails with Walnut words, and Codex is interrupted (its process ended when it does not stop).',
  },
  'acp-adapter': {
    signals: ['session_info_update with _meta.<engine>.error.willRetry: true', 'no session/update while a prompt is open'],
    bound: 'acp-worker/worker.ts watchAdapterTurn: a TurnWatch per turn; the turn fails with Walnut words, the adapter is cancelled (and ended when it does not stop).',
  },
} as const

export type TurnTransport = keyof typeof ENGINE_RETRY_BOUNDS

/**
 * The ways a turn of an engine (its id and its registry `runtimeKind`) may run; none for a kind
 * this table does not know, which the guard test refuses. Codex runs direct or through its ACP
 * adapter (codex-app-server/transport.ts CODEX_TRANSPORT_ENV).
 */
export function transportsOf(engine: string, runtimeKind: string): TurnTransport[] {
  if (runtimeKind === 'native') return engine === 'claude' ? ['claude-cli'] : []
  if (runtimeKind === 'acp') return engine === 'codex' ? ['codex-app-server', 'acp-adapter'] : ['acp-adapter']
  return []
}

/**
 * The spawn env that bounds Claude Code's unattended retry mode (CLAUDE_CODE_RETRY_WATCHDOG, which
 * otherwise waits with no limit) at the same limit as every other engine. A value the host already
 * has wins.
 */
export function claudeRetryEnv(env: NodeJS.ProcessEnv): Record<string, string> {
  if (env.CLAUDE_CODE_RETRY_WATCHDOG_MAX_WAIT_MS) return {}
  return { CLAUDE_CODE_RETRY_WATCHDOG_MAX_WAIT_MS: String(retryLimitMs(env)) }
}
