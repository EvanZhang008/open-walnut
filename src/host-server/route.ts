/**
 * Where a host server sends a browser's request right now
 * (docs/plan/walnut-servers-everywhere.md, "Routing"):
 *
 *   leader     the Mac leads (the daemon's leader book) and the daemon hears it:
 *              every byte goes to it, on a stream through the daemon.
 *   companion  the Mac does not answer, and the cloud companion is linked to the
 *              daemon (it leads, or answers from its own copy): every byte goes there.
 *   alone      neither: this server says so.
 *
 * All of it is the daemon's view (`follower.status`); there is no probe of our
 * own. A stream that could not be opened marks its target suspect for a few
 * seconds, so the next request goes on to the next one at once.
 */

import type { FollowerView } from './daemon-link.js'

export type Route =
  | { kind: 'leader' }
  | { kind: 'companion'; origin: string }
  | { kind: 'alone'; why: string }

/** A daemon answer this old says nothing (the link is stuck). */
export const VIEW_STALE_MS = 15_000
/** The Mac answers while the daemon heard it within this. */
export const LEADER_QUIET_MS = 30_000
/** A target whose stream failed is skipped this long. */
export const SUSPECT_MS = 5_000

export interface RouteInput {
  view: { view: FollowerView; at: number } | null
  now: number
  /** Until when each target is skipped. */
  suspect: { leader?: number; companion?: number }
}

function freshView(input: RouteInput): FollowerView | null {
  const v = input.view
  return v && input.now - v.at <= VIEW_STALE_MS ? v.view : null
}

/** Whether the leader (the Mac) answers right now, by the daemon's view. */
export function leaderAnswers(input: RouteInput): { answers: boolean; why: string } {
  const v = freshView(input)
  if (!v) return { answers: false, why: 'no-daemon' }
  if (v.holder !== 'primary') return { answers: false, why: 'companion-leads' }
  const quietFor = v.primaryHeardAgoMs + (input.now - input.view!.at)
  if (!v.primaryConnected || quietFor > LEADER_QUIET_MS) return { answers: false, why: 'mac-away' }
  if ((input.suspect.leader ?? 0) > input.now) return { answers: false, why: 'unreachable' }
  return { answers: true, why: 'answers' }
}

export function chooseRoute(input: RouteInput): Route {
  if (leaderAnswers(input).answers) return { kind: 'leader' }
  const v = freshView(input)
  if (!v) return { kind: 'alone', why: 'no-daemon' }
  if (v.bridge.connected && v.bridge.companion && (input.suspect.companion ?? 0) <= input.now) {
    return { kind: 'companion', origin: v.bridge.companion }
  }
  return { kind: 'alone', why: v.bridge.companion ? 'nobody-answers' : 'mac-away' }
}
