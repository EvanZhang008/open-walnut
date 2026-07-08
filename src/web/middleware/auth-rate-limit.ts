/**
 * Minimal in-memory rate limiter for authentication failures.
 *
 * Sliding 60s window, max 10 failures per IP. Applied to the setup/claim
 * endpoint and every 401/403 auth path (HTTP + WS upgrade) in cloud mode.
 * In-app on purpose: the reverse proxy (Caddy) also rate-limits, but we don't
 * rely on it. No deps, bounded memory (entries pruned on touch).
 */

const WINDOW_MS = 60_000
const MAX_FAILURES = 10

// ip → timestamps of recent failures (pruned lazily)
const failures = new Map<string, number[]>()

/** Record one auth failure for this IP. */
export function recordAuthFailure(ip: string): void {
  const now = Date.now()
  const list = (failures.get(ip) ?? []).filter((t) => now - t < WINDOW_MS)
  list.push(now)
  failures.set(ip, list)
  // Bound total tracked IPs — drop the oldest map entry beyond a sane cap.
  if (failures.size > 10_000) {
    const first = failures.keys().next().value
    if (first !== undefined) failures.delete(first)
  }
}

/** True when this IP has exceeded the failure budget (should get 429). */
export function isAuthRateLimited(ip: string): boolean {
  const now = Date.now()
  const list = (failures.get(ip) ?? []).filter((t) => now - t < WINDOW_MS)
  if (list.length === 0) failures.delete(ip)
  else failures.set(ip, list)
  return list.length >= MAX_FAILURES
}

/** Test-only: clear limiter state. */
export function _resetAuthRateLimitForTesting(): void {
  failures.clear()
}
