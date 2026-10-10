/**
 * Which role this Walnut server plays (docs/plan/walnut-servers-everywhere.md):
 * the leader (the primary, the Mac) or a follower of it. Two kinds of follower:
 *
 *   companion  the cloud companion (WALNUT_CLOUD_MODE=1): reaches the leader over
 *              the bridge, its daemons dial in to it.
 *   host       a server on a host the user picked (WALNUT_HOST_SERVER=1): linked
 *              to that host's daemon only, and reaches the leader through it.
 *
 * `leaderAnswers()` is the one answer to "is the leader there right now" for every
 * route on a follower. The follower's presence source (the companion's forward,
 * the host server's daemon link) sets it; nothing else keeps its own view. On the
 * leader it is always true.
 */

import { CLOUD_MODE } from '../constants.js'

export type FollowerKind = 'companion' | 'host'

export function followerKind(): FollowerKind | null {
  if (CLOUD_MODE) return 'companion'
  if (process.env.WALNUT_HOST_SERVER === '1') return 'host'
  return null
}

export function isFollower(): boolean {
  return followerKind() !== null
}

let answers = false
let why = 'not-heard'
let since = 0
const listeners = new Set<(answers: boolean) => void>()

/** The leader answers right now. Always true on the leader itself. */
export function leaderAnswers(): boolean {
  return isFollower() ? answers : true
}

/** Why the leader does not answer (or 'answers'), and since when (ms epoch). */
export function leaderPresence(): { answers: boolean; why: string; since: number } {
  return isFollower() ? { answers, why: answers ? 'answers' : why, since } : { answers: true, why: 'leader', since: 0 }
}

/** The follower's presence source reports a change. */
export function setLeaderPresence(next: boolean, reason: string, now = Date.now()): void {
  why = reason
  if (next === answers) return
  answers = next
  since = now
  for (const cb of listeners) {
    try { cb(next) } catch { /* one listener never stops the others */ }
  }
}

export function onLeaderPresence(cb: (answers: boolean) => void): () => void {
  listeners.add(cb)
  return () => { listeners.delete(cb) }
}

export function _resetLeaderPresenceForTesting(): void {
  answers = false
  why = 'not-heard'
  since = 0
  listeners.clear()
}
