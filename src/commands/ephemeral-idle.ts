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
