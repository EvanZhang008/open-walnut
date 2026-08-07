/**
 * Launch-seed cache (cloud REPLICA only) — bridges the projection gap for
 * sessions the replica itself just launched.
 *
 * Every cloud v1 session endpoint (stream/transcript/messages) resolves a
 * session's host from the git-synced projection.json. That file only updates
 * after the primary's 60s-throttled transcript sweep + a 30s git-sync tick on
 * each side — so for the first 1–3 minutes after a mobile launch the replica
 * serves 404 "Session not found" for a session it JUST created (observed
 * 2026-08-07: 14 consecutive 404s across stream/transcript/messages; the
 * phone showed "Not sent — tap to retry" on every message while the CLI was
 * alive and waiting on the Mac).
 *
 * The replay relay already knows the truth at 201 time: sessionId + target
 * host (+cwd/model hints) came through its own hands. Seed that mapping here;
 * projectedSession() falls back to it ONLY when the projection misses, so the
 * synced file takes over automatically once it lands. Entries expire after a
 * TTL comfortably above the worst-case sync lag; the map is size-capped since
 * entries are only useful for minutes.
 */

export interface LaunchSeed {
  host: string
  cwd?: string
  model?: string
}

const TTL_MS = 10 * 60 * 1000
const MAX_ENTRIES = 100

const seeds = new Map<string, LaunchSeed & { at: number }>()

export function seedLaunchedSession(sessionId: string, seed: LaunchSeed): void {
  // Sweep expired first so the size cap never evicts live seeds for dead ones.
  const now = Date.now()
  for (const [sid, entry] of seeds) {
    if (now - entry.at > TTL_MS) seeds.delete(sid)
  }
  // Map preserves insertion order — dropping the oldest is FIFO enough here.
  while (seeds.size >= MAX_ENTRIES) {
    const oldest = seeds.keys().next().value
    if (oldest === undefined) break
    seeds.delete(oldest)
  }
  seeds.set(sessionId, { ...seed, at: now })
}

export function getLaunchSeed(sessionId: string): LaunchSeed | null {
  const entry = seeds.get(sessionId)
  if (!entry) return null
  if (Date.now() - entry.at > TTL_MS) {
    seeds.delete(sessionId)
    return null
  }
  return { host: entry.host, cwd: entry.cwd, model: entry.model }
}

/** Test hook. */
export function _resetLaunchSeedsForTesting(): void {
  seeds.clear()
}
