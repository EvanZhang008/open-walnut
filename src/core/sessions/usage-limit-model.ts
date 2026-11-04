/**
 * The pure half of the usage-limit wait (sessions/usage-limit-wait.ts): which turn ends it takes,
 * when it continues, and its words. No IO; the clock is an argument.
 */
import type { SessionUsageLimit } from '../types.js'

export type { SessionUsageLimit }

/** What an engine stamps on the turn end the usage limit stopped (session:result / session:error). */
export interface UsageLimitFacts {
  engine: string
  window?: string
  /** Epoch ms. */
  resetsAt?: number
  resetsFrom?: 'event' | 'text' | 'host'
  text?: string
}

/** On unless WALNUT_USAGE_LIMIT_RESUME=0. */
export function usageLimitWaitEnabled(): boolean {
  return process.env.WALNUT_USAGE_LIMIT_RESUME !== '0'
}

/** A turn end the wait takes over: it carries the engine's usage-limit facts. */
export function usageLimitTakes(d: {
  usageLimit?: UsageLimitFacts | null; interrupted?: boolean
  teamActive?: boolean; backgroundActive?: boolean; detachedBgActive?: boolean; wakeupPending?: boolean
} | null | undefined): boolean {
  if (!usageLimitWaitEnabled() || !d?.usageLimit || d.interrupted) return false
  // Its own work still runs (a teammate, a background command, an armed wakeup): that work's end
  // decides the turn, and a continue on top of it would be a second driver.
  return !(d.teamActive || d.backgroundActive || d.detachedBgActive || d.wakeupPending)
}

/** A minute past the reset, so the provider's clock has turned too. */
export const LIMIT_RESET_GRACE_MS = 60_000
/** Sessions of one account stop together and would all continue in one second: spread them. */
export const LIMIT_JITTER_MAX_MS = 45_000
/** No reset time, or a continue that hit the limit again: look again after these (the last repeats). */
export const LIMIT_RETRY_BACKOFF_MS: readonly number[] = [30, 60, 120, 240].map((m) => m * 60_000)
/** Continues with no later reset to wait for, before the user is asked. */
export const LIMIT_MAX_TRIES = 6
/** A weekly window resets within 7 days: past this the reset was misread. */
export const LIMIT_MAX_WAIT_MS = 8 * 24 * 60 * 60_000

/** A stable spread per session (0 to LIMIT_JITTER_MAX_MS). */
export function limitJitterMs(sessionId: string): number {
  let h = 0
  for (let i = 0; i < sessionId.length; i++) h = (h * 31 + sessionId.charCodeAt(i)) >>> 0
  return h % (LIMIT_JITTER_MAX_MS + 1)
}

/** The wait's clock (a test shortens it). */
export interface LimitTiming {
  graceMs: number
  jitterMaxMs: number
  backoffMs: readonly number[]
  resumeCheckMs: number
  /** A wait already due when the server starts waits this long (plus the spread) for its host. */
  bootDelayMs: number
}
export const DEFAULT_LIMIT_TIMING: LimitTiming = {
  graceMs: LIMIT_RESET_GRACE_MS, jitterMaxMs: LIMIT_JITTER_MAX_MS, backoffMs: LIMIT_RETRY_BACKOFF_MS, resumeCheckMs: 5 * 60_000,
  bootDelayMs: 60_000,
}

/** The session's spread on this clock (0 when the clock has none). */
export function limitSpreadMs(sessionId: string, t: LimitTiming): number {
  return t.jitterMaxMs > 0 ? limitJitterMs(sessionId) % (t.jitterMaxMs + 1) : 0
}

/** When the wait continues the session: at the reset, else on the backoff from `fromMs`. */
export function limitDueAt(
  w: Pick<SessionUsageLimit, 'resetsAt' | 'tries'>, sessionId: string, nowMs: number, fromMs = nowMs,
  t: LimitTiming = DEFAULT_LIMIT_TIMING,
): number {
  const reset = w.resetsAt ? Date.parse(w.resetsAt) : NaN
  const tries = w.tries ?? 0
  if (Number.isFinite(reset) && reset > nowMs - t.graceMs && tries === 0) {
    return reset + t.graceMs + limitSpreadMs(sessionId, t)
  }
  return fromMs + t.backoffMs[Math.min(Math.max(0, tries - 1), t.backoffMs.length - 1)]
}

const ENGINE_NAMES: Record<string, string> = { claude: 'Claude', codex: 'Codex', opencode: 'OpenCode', goose: 'Goose', gemini: 'Gemini' }

export function limitEngineWords(engine: string | undefined): string {
  if (!engine) return 'The'
  return ENGINE_NAMES[engine] ?? `${engine.charAt(0).toUpperCase()}${engine.slice(1)}`
}

const WINDOW_NAMES: Record<string, string> = {
  five_hour: '5-hour', seven_day: 'weekly', seven_day_opus: 'weekly Opus', seven_day_sonnet: 'weekly Sonnet',
  seven_day_overage_included: 'weekly', overage: 'extra usage',
}

/** "Claude 5-hour limit", "Codex usage limit". */
export function limitName(w: Pick<SessionUsageLimit, 'engine' | 'window'>): string {
  const win = w.window ? WINDOW_NAMES[w.window] ?? w.window.replace(/_/g, ' ') : ''
  if (win === 'extra usage') return `${limitEngineWords(w.engine)} extra usage`
  return `${limitEngineWords(w.engine)} ${win ? `${win} ` : 'usage '}limit`
}

/** "3:00 PM", "Thu 3:00 PM" past today, in this process's zone (the server's, the user's Mac). */
export function limitTimeWords(iso: string | undefined, nowMs: number): string {
  const t = iso ? Date.parse(iso) : NaN
  if (!Number.isFinite(t)) return ''
  const d = new Date(t)
  const sameDay = new Date(nowMs).toDateString() === d.toDateString()
  // No-break spaces: "12:52 PM" and "Thu 12:52 PM" never wrap apart.
  const time = d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' }).replace(/\s/g, '\u00a0')
  return sameDay ? time : `${d.toLocaleDateString('en-US', { weekday: 'short' })}\u00a0${time}`
}

/** The task's wait in words, for every reader that is not the web (agents, the phone, the Brief). */
export function limitWaitingWords(w: Pick<SessionUsageLimit, 'engine' | 'window' | 'resetsAt' | 'dueAt'>, nowMs: number): string {
  const when = limitTimeWords(w.resetsAt, nowMs)
  const name = limitName(w)
  return when
    ? `Limited: the ${name} resets ${when}, and Walnut continues it by itself then`
    : `Limited: the ${name} stopped it, and Walnut tries it again ${limitTimeWords(w.dueAt, nowMs) || 'later'}`
}

/** The user's words once the wait is theirs (turned off, or gave up). */
export function limitAskWords(w: Pick<SessionUsageLimit, 'engine' | 'window' | 'resetsAt' | 'state'>, nowMs: number): string {
  const when = limitTimeWords(w.resetsAt, nowMs)
  const name = limitName(w)
  const future = !!w.resetsAt && Date.parse(w.resetsAt) > nowMs
  const reset = when ? ` · ${future ? 'resets' : 'reset'} ${when}` : ''
  // What it is first, then until when: a row cut to one line still says why it is here.
  return w.state === 'off'
    ? `Auto-continue off${reset}. The ${name} stopped it; continue it from its session when you want.`
    : `Limited, still refusing${reset}. The ${name} refused every continue; continue it from its session once your limit allows.`
}

// ── Claude Code: what a turn saw ──

/** The window a Claude Code limit text names. */
export function claudeWindowFromText(text: string | null | undefined): string | undefined {
  if (!text) return undefined
  if (/out of extra usage/i.test(text)) return 'overage'
  if (/\bsession limit\b/i.test(text)) return 'five_hour'
  if (/\bopus limit\b/i.test(text)) return 'seven_day_opus'
  if (/\bsonnet limit\b/i.test(text)) return 'seven_day_sonnet'
  if (/\bweekly limit\b/i.test(text)) return 'seven_day'
  return undefined
}

/** A `rate_limit_info` that blocks the turn: rejected, with no extra usage to fall back on. */
export function blockedLimitOf(info: {
  status: string; rateLimitType?: string; resetsAt?: number; overageStatus?: string; isUsingOverage?: boolean
} | null | undefined): { resetsAt?: number; window?: string } | 'allowed' | null {
  if (!info) return null
  if (info.status !== 'rejected') return 'allowed'
  if (info.overageStatus === 'allowed' || info.overageStatus === 'allowed_warning' || info.isUsingOverage) return 'allowed'
  return { ...(info.resetsAt ? { resetsAt: info.resetsAt } : {}), ...(info.rateLimitType ? { window: info.rateLimitType } : {}) }
}

/**
 * The usage-limit facts of a Claude Code turn that ended in an error, or undefined when the limit
 * did not stop it: a rejected limit seen in the turn (its own event or the blocked reply), or the
 * CLI's limit words.
 */
export function claudeUsageLimitFacts(
  rejected: { resetsAt?: number; window?: string; blocked?: boolean } | null | undefined,
  text: string | null | undefined,
  nowMs: number,
  match: (t: string | null | undefined) => boolean,
  parseReset: (t: string | null | undefined, now: number) => number | undefined,
): UsageLimitFacts | undefined {
  // A rejected reading alone is no stop: the CLI may switch model and go on, and a turn that then
  // fails for another reason is that reason's. The CLI's blocked reply, or its limit words, are.
  if (!rejected?.blocked && !match(text)) return undefined
  const fromText = parseReset(text, nowMs)
  const resetsAt = rejected?.resetsAt ?? fromText
  return {
    engine: 'claude',
    ...((rejected?.window ?? claudeWindowFromText(text)) ? { window: rejected?.window ?? claudeWindowFromText(text) } : {}),
    ...(resetsAt ? { resetsAt, resetsFrom: rejected?.resetsAt ? 'event' as const : 'text' as const } : {}),
    ...(text ? { text: text.slice(0, 300) } : {}),
  }
}
