/**
 * How long an ephemeral server lives with no HTTP request before it shuts itself down.
 *
 * Ten minutes by default, so a forgotten server on someone's machine goes away on its own.
 * WALNUT_EPHEMERAL_IDLE_MINUTES raises it for a server something else already bounds: a
 * background container with its own time limit holds a demo server that reviewers open only
 * now and then (2026-11-04: four review servers died between two rounds of one review).
 * Capped at a day; anything unreadable keeps the default.
 */
export const DEFAULT_EPHEMERAL_IDLE_MINUTES = 10
const MAX_EPHEMERAL_IDLE_MINUTES = 24 * 60

export function ephemeralIdleTtlMs(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.WALNUT_EPHEMERAL_IDLE_MINUTES?.trim()
  const minutes = raw && /^\d+(\.\d+)?$/.test(raw) ? Number(raw) : NaN
  const chosen = minutes > 0 ? Math.min(minutes, MAX_EPHEMERAL_IDLE_MINUTES) : DEFAULT_EPHEMERAL_IDLE_MINUTES
  return Math.round(chosen * 60_000)
}

/**
 * How long a server may sit idle while another launcher waits for a slot
 * (ephemeral-slots.ts): WALNUT_EPHEMERAL_CONTENDED_IDLE_MINUTES, default 15. A raised idle
 * limit is honoured only while nobody waits. 2026-11-09 on one Mac: 14 of 21 servers had
 * their limit raised to 120 to 480 minutes and most were ended by their owner after 40 to
 * 100 minutes, so a forgotten one held its slot for hours. Fifteen minutes with no request
 * is past a normal pause in a check, and short enough that a waiter gets in well inside its
 * own wait (30 minutes by default).
 */
export const DEFAULT_CONTENDED_IDLE_MINUTES = 15

export function ephemeralContendedIdleTtlMs(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.WALNUT_EPHEMERAL_CONTENDED_IDLE_MINUTES?.trim()
  const minutes = raw && /^\d+(\.\d+)?$/.test(raw) ? Number(raw) : NaN
  const chosen = minutes > 0 ? Math.min(minutes, MAX_EPHEMERAL_IDLE_MINUTES) : DEFAULT_CONTENDED_IDLE_MINUTES
  return Math.round(chosen * 60_000)
}

/**
 * Pure: which idle rule ends a server now, or null. `idle` once it passed its own limit;
 * `idle-contended` once someone waits for a slot and it passed the contended limit, which
 * never lengthens its own (a server on the default 10 minutes ends on `idle` as before).
 */
export function idleExitRule(idleMs: number, limitMs: number, contended: boolean, contendedLimitMs: number): 'idle' | 'idle-contended' | null {
  if (idleMs > limitMs) return 'idle'
  if (contended && contendedLimitMs < limitMs && idleMs > contendedLimitMs) return 'idle-contended'
  return null
}
