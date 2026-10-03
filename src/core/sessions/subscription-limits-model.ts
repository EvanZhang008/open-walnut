/**
 * The pure half of the subscription limit readout: one Claude Code
 * `rate_limit_event` line read defensively, and folded into what a host's
 * account has shown so far. No IO, no clock (the caller passes `seenAt`).
 *
 * What the CLI sends (fork src/services/claudeAiLimits.ts + cli/print.ts, and
 * the 2.1.284 bundle): `{type:'rate_limit_event', rate_limit_info, uuid,
 * session_id}`, only for a claude.ai sign-in (API key, Bedrock and Vertex
 * sessions never carry the headers it is read from). `rate_limit_info` is a FULL
 * snapshot of the CLI's current limits, not a delta:
 *   - status / rateLimitType / resetsAt / utilization describe the window that
 *     limits right now (the "representative claim"). utilization is a 0-1
 *     fraction and, on older CLIs, present only once a warning threshold fired;
 *     resetsAt is unix epoch SECONDS.
 *   - overage* / isUsingOverage describe extra usage.
 *   - unifiedWindows (newer CLIs) carries five_hour, seven_day and
 *     seven_day_overage_included, each {utilization, resetsAt}, on every
 *     observation.
 * Older CLIs emit only when the snapshot changes (lodash isEqual), newer ones
 * also when a window's rounded percentage moves (throttled to 30s). So a host
 * keeps the newest reading per window and the UI shows its age.
 */

export type LimitStatus = 'allowed' | 'allowed_warning' | 'rejected'

const STATUSES: readonly LimitStatus[] = ['allowed', 'allowed_warning', 'rejected']
/** A window name is a short snake_case word ("five_hour", "seven_day_opus", a future one). */
const WINDOW_NAME = /^[a-z][a-z0-9_]{0,39}$/
/** Utilization runs past 1 when usage legitimately overshoots a cap; beyond this it is junk. */
const MAX_UTILIZATION = 100

export interface ParsedRateLimitInfo {
  status: LimitStatus
  /** The limiting window ("five_hour", "seven_day", ...). */
  rateLimitType?: string
  /** Epoch MS. */
  resetsAt?: number
  /** 0-1 fraction of the limiting window. */
  utilization?: number
  surpassedThreshold?: number
  overageStatus?: LimitStatus
  /** Epoch MS. */
  overageResetsAt?: number
  overageDisabledReason?: string
  isUsingOverage?: boolean
  /** Per-window usage, newer CLIs only (resetsAt in epoch MS). */
  windows: Array<{ type: string; utilization: number; resetsAt: number }>
}

export interface LimitWindow {
  type: string
  /** 0-1 fraction used; absent when the CLI did not say. */
  utilization?: number
  /** Epoch ms the window resets. */
  resetsAt?: number
  /** Server time this window was last reported. */
  seenAt: number
  /** The session whose stream reported it. */
  sessionId?: string
}

/** The newest snapshot's headline: the status of the window that limits right now. */
export interface LimitCurrent {
  status: LimitStatus
  type?: string
  resetsAt?: number
  utilization?: number
  surpassedThreshold?: number
  seenAt: number
  sessionId?: string
}

export interface LimitOverage {
  status?: LimitStatus
  resetsAt?: number
  disabledReason?: string
  isUsingOverage?: boolean
  seenAt: number
}

export interface HostLimitState {
  /** '__local__' or the host alias. */
  host: string
  /** Newest reading per window type. */
  windows: Record<string, LimitWindow>
  current?: LimitCurrent
  overage?: LimitOverage
  /** Server time of the newest event. */
  updatedAt: number
}

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)
const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v)
const oneStatus = (v: unknown): LimitStatus | undefined => STATUSES.includes(v as LimitStatus) ? v as LimitStatus : undefined
const windowName = (v: unknown): string | undefined => typeof v === 'string' && WINDOW_NAME.test(v) ? v : undefined

/** The CLI sends epoch seconds; a value already in ms (a future CLI) is kept. */
export function epochMs(v: unknown): number | undefined {
  if (!finite(v) || v <= 0) return undefined
  return v < 1e11 ? Math.round(v * 1000) : Math.round(v)
}

function fraction(v: unknown): number | undefined {
  return finite(v) && v >= 0 && v <= MAX_UTILIZATION ? v : undefined
}

/** `rate_limit_info` → the fields Walnut reads, or null when it is not one. */
export function parseRateLimitInfo(raw: unknown): ParsedRateLimitInfo | null {
  if (!isObj(raw)) return null
  const status = oneStatus(raw.status)
  if (!status) return null
  const out: ParsedRateLimitInfo = { status, windows: [] }
  const type = windowName(raw.rateLimitType)
  if (type) out.rateLimitType = type
  const resetsAt = epochMs(raw.resetsAt)
  if (resetsAt) out.resetsAt = resetsAt
  const utilization = fraction(raw.utilization)
  if (utilization !== undefined) out.utilization = utilization
  if (finite(raw.surpassedThreshold)) out.surpassedThreshold = raw.surpassedThreshold
  const overageStatus = oneStatus(raw.overageStatus)
  if (overageStatus) out.overageStatus = overageStatus
  const overageResetsAt = epochMs(raw.overageResetsAt)
  if (overageResetsAt) out.overageResetsAt = overageResetsAt
  if (typeof raw.overageDisabledReason === 'string' && raw.overageDisabledReason) {
    out.overageDisabledReason = raw.overageDisabledReason.slice(0, 64)
  }
  if (typeof raw.isUsingOverage === 'boolean') out.isUsingOverage = raw.isUsingOverage
  if (isObj(raw.unifiedWindows)) {
    for (const [key, w] of Object.entries(raw.unifiedWindows)) {
      const name = windowName(key)
      if (!name || !isObj(w)) continue
      const u = fraction(w.utilization)
      const r = epochMs(w.resetsAt)
      if (u === undefined || !r) continue
      out.windows.push({ type: name, utilization: u, resetsAt: r })
    }
  }
  return out
}

/** A whole stream line (already JSON-parsed) → its info, or null. */
export function parseRateLimitEvent(event: unknown): ParsedRateLimitInfo | null {
  if (!isObj(event) || event.type !== 'rate_limit_event') return null
  return parseRateLimitInfo(event.rate_limit_info)
}

/** Does this snapshot say anything about extra usage? */
function hasOverage(info: ParsedRateLimitInfo): boolean {
  return info.overageStatus !== undefined || info.overageResetsAt !== undefined
    || info.overageDisabledReason !== undefined || info.isUsingOverage === true
}

/**
 * Fold one event into a host's state (a new object; `prev` is not touched).
 * The headline and the overage state are replaced wholesale (each event is a
 * full snapshot); windows accumulate, newest per type. A headline that names a
 * window but carries no percentage keeps the percentage an earlier reading of
 * that SAME window (same reset time) carried, with that reading's own time: the
 * best number there is, honestly aged.
 */
export function applyRateLimitInfo(
  prev: HostLimitState | undefined,
  host: string,
  info: ParsedRateLimitInfo,
  seenAt: number,
  sessionId?: string,
): HostLimitState {
  const windows: Record<string, LimitWindow> = { ...(prev?.windows ?? {}) }
  const by = sessionId ? { sessionId } : {}
  if (info.rateLimitType && (info.resetsAt !== undefined || info.utilization !== undefined)) {
    const old = windows[info.rateLimitType]
    const keepOld = info.utilization === undefined && old?.utilization !== undefined
      && old.resetsAt !== undefined && old.resetsAt === info.resetsAt
    if (!keepOld) {
      windows[info.rateLimitType] = {
        type: info.rateLimitType,
        ...(info.utilization !== undefined ? { utilization: info.utilization } : {}),
        ...(info.resetsAt !== undefined ? { resetsAt: info.resetsAt } : {}),
        seenAt, ...by,
      }
    }
  }
  // Per-window usage always carries both numbers: it wins over the headline's.
  for (const w of info.windows) windows[w.type] = { type: w.type, utilization: w.utilization, resetsAt: w.resetsAt, seenAt, ...by }
  const current: LimitCurrent = {
    status: info.status,
    ...(info.rateLimitType ? { type: info.rateLimitType } : {}),
    ...(info.resetsAt !== undefined ? { resetsAt: info.resetsAt } : {}),
    ...(info.utilization !== undefined ? { utilization: info.utilization } : {}),
    ...(info.surpassedThreshold !== undefined ? { surpassedThreshold: info.surpassedThreshold } : {}),
    seenAt, ...by,
  }
  const overage: LimitOverage | undefined = hasOverage(info) ? {
    ...(info.overageStatus ? { status: info.overageStatus } : {}),
    ...(info.overageResetsAt !== undefined ? { resetsAt: info.overageResetsAt } : {}),
    ...(info.overageDisabledReason ? { disabledReason: info.overageDisabledReason } : {}),
    ...(info.isUsingOverage !== undefined ? { isUsingOverage: info.isUsingOverage } : {}),
    seenAt,
  } : undefined
  return { host, windows, current, ...(overage ? { overage } : {}), updatedAt: Math.max(seenAt, prev?.updatedAt ?? 0) }
}

/**
 * How a host's Claude Code is signed in, from the readiness check's
 * `authDetail` (providers/claude-check-core.ts words it): only a Claude
 * account has subscription limits. 'unknown' when the check did not say.
 */
export type SignInKind = 'subscription' | 'other' | 'unknown'

const SUBSCRIPTION_DETAILS = new Set(['a Claude account', 'an OAuth token'])
const OTHER_DETAILS = new Set([
  'Bedrock', 'Vertex AI', 'Microsoft Foundry', 'a third-party provider',
  'an Anthropic API key', 'an auth token', 'an API key helper',
])

export function signInKind(auth: string | undefined, authDetail: string | undefined): SignInKind {
  if (auth !== 'ok' || !authDetail) return 'unknown'
  if (SUBSCRIPTION_DETAILS.has(authDetail)) return 'subscription'
  if (OTHER_DETAILS.has(authDetail)) return 'other'
  return 'unknown'
}

/** Read a persisted state defensively (a cache: junk is dropped, never thrown). */
export function reviveHostLimitState(host: string, raw: unknown): HostLimitState | null {
  if (!isObj(raw) || !isObj(raw.windows)) return null
  const windows: Record<string, LimitWindow> = {}
  for (const [key, w] of Object.entries(raw.windows)) {
    const name = windowName(key)
    if (!name || !isObj(w) || !finite(w.seenAt)) continue
    windows[name] = {
      type: name, seenAt: w.seenAt,
      ...(fraction(w.utilization) !== undefined ? { utilization: w.utilization as number } : {}),
      ...(finite(w.resetsAt) ? { resetsAt: w.resetsAt } : {}),
      ...(typeof w.sessionId === 'string' ? { sessionId: w.sessionId } : {}),
    }
  }
  const out: HostLimitState = { host, windows, updatedAt: finite(raw.updatedAt) ? raw.updatedAt : 0 }
  const c = raw.current
  if (isObj(c) && oneStatus(c.status) && finite(c.seenAt)) {
    out.current = {
      status: oneStatus(c.status)!, seenAt: c.seenAt,
      ...(windowName(c.type) ? { type: c.type as string } : {}),
      ...(finite(c.resetsAt) ? { resetsAt: c.resetsAt } : {}),
      ...(fraction(c.utilization) !== undefined ? { utilization: c.utilization as number } : {}),
      ...(finite(c.surpassedThreshold) ? { surpassedThreshold: c.surpassedThreshold } : {}),
      ...(typeof c.sessionId === 'string' ? { sessionId: c.sessionId } : {}),
    }
  }
  const o = raw.overage
  if (isObj(o) && finite(o.seenAt)) {
    out.overage = {
      seenAt: o.seenAt,
      ...(oneStatus(o.status) ? { status: oneStatus(o.status) } : {}),
      ...(finite(o.resetsAt) ? { resetsAt: o.resetsAt } : {}),
      ...(typeof o.disabledReason === 'string' ? { disabledReason: o.disabledReason } : {}),
      ...(typeof o.isUsingOverage === 'boolean' ? { isUsingOverage: o.isUsingOverage } : {}),
    }
  }
  return out
}
