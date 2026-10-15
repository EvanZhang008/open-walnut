/**
 * Minimal in-memory rate limiter for authentication failures.
 *
 * Sliding 60s window, max 10 failures per IP. Applied to the setup/claim
 * endpoint and every 401/403 auth path (HTTP + WS upgrade) in cloud mode.
 * In-app on purpose: the reverse proxy (Caddy) also rate-limits, but we don't
 * rely on it. No deps, bounded memory (entries pruned on touch).
 */

import { createHash } from 'node:crypto'

const WINDOW_MS = 60_000
const MAX_FAILURES = 10

interface Failure { at: number; fp?: string }

// ip → recent failures (pruned lazily)
const failures = new Map<string, Failure[]>()

const fingerprint = (credential: string): string =>
  createHash('sha256').update(credential).digest('base64url').slice(0, 22)

/**
 * Record one auth failure for this IP. Pass the refused `credential` when there
 * is one: the same refused token again inside the window is the same guess, not
 * a new one, so it is not counted twice. A revoked phone reloading the console
 * sends dozens of requests with its one dead token; counted per request they
 * locked the IP for a minute, and behind a tunnel, where every phone shares the
 * tunnel's loopback address, they locked out every signed-in phone with it.
 * Different guesses still count one each, so guessing is limited as before.
 */
export function recordAuthFailure(ip: string, credential?: string): void {
  const now = Date.now()
  const list = (failures.get(ip) ?? []).filter((f) => now - f.at < WINDOW_MS)
  const fp = credential ? fingerprint(credential) : undefined
  if (fp !== undefined && list.some((f) => f.fp === fp)) {
    failures.set(ip, list)
    return
  }
  list.push({ at: now, ...(fp !== undefined ? { fp } : {}) })
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
  const list = (failures.get(ip) ?? []).filter((f) => now - f.at < WINDOW_MS)
  if (list.length === 0) failures.delete(ip)
  else failures.set(ip, list)
  return list.length >= MAX_FAILURES
}

/** Forget this key's failures: a sign-in that just succeeded proved who is there. */
export function clearAuthFailures(ip: string): void {
  failures.delete(ip)
}

/** The body every rate-limited JSON answer carries, so a client can say what happened. */
export const RATE_LIMITED_BODY = { error: 'Too many authentication failures. Try again later.', code: 'rate_limited' } as const
export const RATE_LIMIT_RETRY_AFTER_S = String(WINDOW_MS / 1000)

/** Test-only: clear limiter state. */
export function _resetAuthRateLimitForTesting(): void {
  failures.clear()
}
