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
  // WALNUT_ROLE is trimmed as resolveServerRole() trims it, so both answers agree.
  if (process.env.WALNUT_HOST_SERVER === '1' || (process.env.WALNUT_ROLE ?? '').trim() === 'replica') return 'host'
  return null
}

/**
 * The role and placement of this server (docs/plan/walnut-replica-servers-impl.md,
 * section 2), read once from env and kept:
 *
 *   role       leader | replica     WALNUT_ROLE, else replica on the companion or a host server
 *   placement  mac | host | cloud   WALNUT_PLACEMENT, else cloud on the companion, host on a host server
 *
 * A contradiction (a leader that says it runs in the cloud, a replica on the
 * Mac, a cloud placement without WALNUT_CLOUD_MODE) throws: a server that
 * cannot tell what it is must not boot as the leader by default.
 */
export type ServerRole = 'leader' | 'replica'
export type Placement = 'mac' | 'host' | 'cloud'

export interface RoleFacts { role: ServerRole; placement: Placement }

export function resolveServerRole(env: NodeJS.ProcessEnv, cloudMode: boolean): RoleFacts {
  const rawRole = (env.WALNUT_ROLE ?? '').trim()
  const rawPlacement = (env.WALNUT_PLACEMENT ?? '').trim()
  const hostServer = env.WALNUT_HOST_SERVER === '1'
  if (rawRole && rawRole !== 'leader' && rawRole !== 'replica') throw new Error(`WALNUT_ROLE must be leader or replica, not "${rawRole}"`)
  if (rawPlacement && rawPlacement !== 'mac' && rawPlacement !== 'host' && rawPlacement !== 'cloud') {
    throw new Error(`WALNUT_PLACEMENT must be mac, host or cloud, not "${rawPlacement}"`)
  }
  const role: ServerRole = (rawRole as ServerRole) || (cloudMode || hostServer ? 'replica' : 'leader')
  const placement: Placement = (rawPlacement as Placement) || (cloudMode ? 'cloud' : role === 'replica' ? 'host' : 'mac')
  if (role === 'leader' && (cloudMode || hostServer)) throw new Error('WALNUT_ROLE=leader contradicts WALNUT_CLOUD_MODE=1 or WALNUT_HOST_SERVER=1: the leader is the Mac')
  if (role === 'leader' && placement !== 'mac') throw new Error(`a leader runs on the Mac, not placement ${placement}`)
  if (role === 'replica' && placement === 'mac') throw new Error('a replica never runs with placement mac')
  if (placement === 'cloud' && !cloudMode) throw new Error('placement cloud is the companion: it needs WALNUT_CLOUD_MODE=1')
  if (placement !== 'cloud' && cloudMode) throw new Error(`WALNUT_CLOUD_MODE=1 is placement cloud, not ${placement}`)
  return { role, placement }
}

let facts: RoleFacts | null = null

function current(): RoleFacts {
  facts ??= resolveServerRole(process.env, CLOUD_MODE)
  return facts
}

export function role(): ServerRole { return current().role }
export function placement(): Placement { return current().placement }
/** A server on a host the user picked, running the full program (`walnut web --replica`). */
export function isHostReplica(): boolean { return current().placement === 'host' }
/** This server may run a local session daemon: the Mac, or the companion with cloud.exec on (checked by its caller). */
export function hasLocalDaemon(): boolean { return current().placement !== 'host' }
/** Sessions run where this server is: the Mac, or (WP12) the host. */
export function runsSessions(): boolean { return current().placement !== 'cloud' }
/** The companion may stand in for the Mac when the user allowed it (backupAllowed). */
export function canStandIn(allowed: boolean): boolean { return current().placement === 'cloud' && allowed }

export function _resetServerRoleForTesting(): void {
  facts = null
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
