/**
 * Presence and the sitting streak. PURE: every function takes `now` and returns a new state.
 *
 * Two signals say "the person is at the keyboard right now":
 *   - `time:banked`: the console's own attention records (the browser posts a batch
 *     about once a minute). Phone records and agent time are NOT keyboard time and
 *     are dropped here.
 *   - `time:outside`: the Mac-wide frontmost-app stream, when Time's app sampling is
 *     on. It already excludes a locked screen and idle stretches over two minutes.
 *
 * The fold borrows the idea behind Time's chapters (walnut-time/src/web/time-chapters.ts):
 * the natural boundary between two stretches of work is that you WEREN'T at the
 * computer for a while. A gap of `awayMs` or more since the last attention ends the
 * streak, because the person was away and so already moved, and the next attention
 * starts a new one. Two rules carried over from that fold:
 *   1. The cursor never moves backwards. A late or overlapping record can extend the
 *      streak's end but can never reopen a gap that already ended a streak.
 *   2. Attention is what advances the streak. A silent hour is not sitting: the streak
 *      is `lastActiveAt - streakStartedAt`, never `now - streakStartedAt`.
 */

export interface PresenceState {
  /** End of the latest attention seen, epoch ms. 0 = never. */
  lastActiveAt: number
  /** Start of the current sitting streak, epoch ms. 0 = no streak (away, or never seen). */
  streakStartedAt: number
}

export interface AttentionSpan {
  start: number
  end: number
}

export interface StreakEnded {
  startedAt: number
  endedAt: number
  streakMs: number
  /** How long the person was away when this was decided. */
  awayMs: number
}

export interface FoldResult {
  state: PresenceState
  ended: StreakEnded[]
}

export const EMPTY_PRESENCE: PresenceState = { lastActiveAt: 0, streakStartedAt: 0 }

/** One record can never claim more than this: a stalled client must not bill an hour. */
export const MAX_SPAN_MS = 30 * 60_000
/** Records from further back than this are history, not presence. */
export const MAX_SPAN_AGE_MS = 24 * 60 * 60_000
/** A client clock a little ahead of ours is tolerated; the span is clamped to `now`. */
const FUTURE_SLACK_MS = 2 * 60_000
/** The Mac helper's own ceiling: idle past this is away, whatever the event says. */
export const MAX_IDLE_SECS = 120
/** Frontmost apps that are the ABSENCE of the person (lock screen, screen saver). */
const AWAY_BUNDLE_IDS = new Set(['com.apple.loginwindow', 'com.apple.ScreenSaver.Engine', 'com.apple.ScreenSaverEngine'])

function span(tsValue: unknown, durationValue: unknown, now: number): AttentionSpan | null {
  const start = typeof tsValue === 'string' ? Date.parse(tsValue) : typeof tsValue === 'number' ? tsValue : NaN
  const duration = typeof durationValue === 'number' ? durationValue : NaN
  if (!Number.isFinite(start) || !Number.isFinite(duration) || duration <= 0) return null
  if (start > now + FUTURE_SLACK_MS || now - start > MAX_SPAN_AGE_MS) return null
  let from = start
  let end = start + Math.min(duration, MAX_SPAN_MS)
  if (end > now) {
    // A client clock slightly ahead of ours: shift the window back rather than drop it.
    const skew = Math.min(end - now, FUTURE_SLACK_MS)
    from -= skew
    end -= skew
  }
  end = Math.min(end, now)
  return end > from ? { start: from, end } : null
}

/** `time:banked` payload into keyboard spans. Unknown shapes yield nothing. */
export function spansFromBanked(data: unknown, now: number): AttentionSpan[] {
  const records = data && typeof data === 'object' ? (data as { records?: unknown }).records : undefined
  if (!Array.isArray(records)) return []
  const out: AttentionSpan[] = []
  for (const record of records) {
    if (!record || typeof record !== 'object') continue
    const value = record as Record<string, unknown>
    if (value.kind === 'agent') continue
    // Absent source means the console browser; 'ios' is the phone, which is not the keyboard.
    if (value.source !== undefined && value.source !== 'web') continue
    const one = span(value.ts, value.durationMs, now)
    if (one) out.push(one)
  }
  return out
}

/** `time:outside` payload into one keyboard span, or null. */
export function spanFromOutside(data: unknown, now: number): AttentionSpan | null {
  if (!data || typeof data !== 'object') return null
  const value = data as Record<string, unknown>
  if (typeof value.bundleId === 'string' && AWAY_BUNDLE_IDS.has(value.bundleId)) return null
  if (typeof value.idleSecs === 'number' && value.idleSecs > MAX_IDLE_SECS) return null
  return span(value.ts, value.durationMs, now)
}

/** Fold attention spans into the streak. Spans may arrive unsorted and overlapping. */
export function foldAttention(state: PresenceState, spans: readonly AttentionSpan[], awayMs: number): FoldResult {
  const ordered = spans.slice().sort((a, b) => a.start - b.start || a.end - b.end)
  let { lastActiveAt, streakStartedAt } = state
  const ended: StreakEnded[] = []
  for (const one of ordered) {
    if (one.end <= one.start) continue
    if (streakStartedAt === 0) {
      // No streak: anything no newer than what we already saw is history.
      if (one.end <= lastActiveAt) continue
      streakStartedAt = Math.max(one.start, lastActiveAt)
      lastActiveAt = one.end
      continue
    }
    if (one.end <= lastActiveAt) continue
    const gap = one.start - lastActiveAt
    if (gap >= awayMs) {
      ended.push({ startedAt: streakStartedAt, endedAt: lastActiveAt, streakMs: Math.max(0, lastActiveAt - streakStartedAt), awayMs: gap })
      streakStartedAt = one.start
    }
    lastActiveAt = one.end
  }
  return { state: { lastActiveAt, streakStartedAt }, ended }
}

/**
 * End the streak once the silence itself is long enough, without waiting for the
 * person to come back. That is what lets a stale reminder be withdrawn while they
 * are still away, and what records the streak's length on the right day.
 */
export function expireIfAway(state: PresenceState, now: number, awayMs: number): FoldResult {
  if (state.streakStartedAt === 0 || now - state.lastActiveAt < awayMs) return { state, ended: [] }
  return {
    state: { lastActiveAt: state.lastActiveAt, streakStartedAt: 0 },
    ended: [{
      startedAt: state.streakStartedAt,
      endedAt: state.lastActiveAt,
      streakMs: Math.max(0, state.lastActiveAt - state.streakStartedAt),
      awayMs: now - state.lastActiveAt,
    }],
  }
}

/**
 * What `state.json` held, made safe to use after a restart. A streak whose last
 * attention is older than the away threshold is over: the server was down, or the
 * person was, and either way nobody sat through it.
 */
export function presenceOnBoot(raw: unknown, now: number, awayMs: number): PresenceState {
  const value = raw && typeof raw === 'object' ? raw as Partial<PresenceState> : {}
  const valid = (n: unknown): number => (typeof n === 'number' && Number.isFinite(n) && n > 0 && n <= now + FUTURE_SLACK_MS ? n : 0)
  const lastActiveAt = valid(value.lastActiveAt)
  let streakStartedAt = valid(value.streakStartedAt)
  if (lastActiveAt === 0 || streakStartedAt > lastActiveAt + FUTURE_SLACK_MS) streakStartedAt = 0
  const state = { lastActiveAt, streakStartedAt }
  return expireIfAway(state, now, awayMs).state
}

export function isPresent(state: PresenceState, now: number, awayMs: number): boolean {
  return state.streakStartedAt > 0 && now - state.lastActiveAt < awayMs
}

/** The current sitting streak, or 0 when the person is away. */
export function sittingMs(state: PresenceState, now: number, awayMs: number): number {
  if (!isPresent(state, now, awayMs)) return 0
  return Math.max(0, state.lastActiveAt - state.streakStartedAt)
}

/** "I took a break": the streak starts over from now, whatever the signals say. */
export function restartStreak(state: PresenceState, now: number): PresenceState {
  return { lastActiveAt: state.lastActiveAt, streakStartedAt: now }
}
