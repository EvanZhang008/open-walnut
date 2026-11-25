/**
 * Whether a host network machine's daemon is updated now, from what is known: the pure rule of
 * NetDaemonUpdater (daemon-net-update.ts), with its facts and answers.
 */
import type { HostFileTarget } from '../core/host-server/host-target.js'
import type { NetUpdateSource } from './daemon-net-update-source.js'
import type { DaemonLinkKind } from './daemon-update-paths.js'
import { daemonUpdateGapHold } from './daemon-update-gap.js'

export type NetUpdateSkip =
  | 'not-net' | 'local' | 'test-server' | 'follower' | 'no-build-version' | 'current' | 'unmanaged'
  | 'old-daemon' | 'turned-off' | 'held' | 'contested' | 'shared' | 'gave-up' | 'cooldown' | 'recent' | 'platform-unknown' | 'no-binary'
  // Service sets: the daemon there is another Walnut's while this one has its own set, or the set is not known yet.
  | 'service-set'
  // The task that asked for it may no longer have it run (its grant was revoked, the host closed).
  | 'refused'

/** Daemon commands the update runs on the host. */
export const NET_UPDATE_CAPABILITIES = ['host-exec-v1', 'fs-write-part-v1', 'service-update-v1'] as const
/** Automatic tries of one build that may fail before only a request tries it again. */
export const MAX_AUTO_FAILURES = 4

export interface NetUpdateFacts {
  kind: DaemonLinkKind
  host: string
  /** An ephemeral server, or one that only reads a host the real Walnut shares. */
  testServer: boolean
  /** A follower (the companion, a host server): it may run another build than the leader. */
  follower: boolean
  expected: string | null
  /** The daemon's own build, from its hello. */
  running: string | null
  /** hello cronSupervision.startup: 'service' for a daemon an OS service runs. */
  startup: string
  serviceExecutable: string | null
  has: (capability: string) => boolean
  /** autofixDisabledReason: 'config' (the host's `autofix: false`), 'env', or null. */
  autofixOff: string | null
  /** WALNUT_NET_DAEMON_UPDATE=0. */
  turnedOff: boolean
  /** Someone asked for it (host_daemon_update): no autofix hold, no cooldown. */
  requested: boolean
  lastAttempt: { expected: string; at: number } | null
  /** This server put `expected` there, and the host came back on another build since. */
  contested?: boolean
  /** Why the running daemon is kept: another Walnut uses it and this build brings nothing it lacks (daemon-shared.ts). */
  shared?: string | null
  /** Automatic tries of `expected` that failed. */
  failedTries?: number
  now: number
  cooldownMs: number
  /** How long the running daemon has run (its hello's startedAt), and the gap between replacements (daemon-update-gap.ts). */
  daemonAgeMs?: number | null
  minGapMs?: number
  /** How long this build's update has been held by the gap already (it waits one gap at most). */
  gapHeldForMs?: number
  /** Past the 3 h bound (daemon-update-behind.ts): the gap gives way, as every hold does. */
  overdue?: boolean
  /** A capability this server asked for that the running daemon lacks (UpdateGapHold.need): the gap gives way. */
  capNeeded?: string | null
  /** A switch of the host's mode alone is due (one-service-mode.ts serviceModeDue): an update on the current build. */
  modeDue?: boolean
  /** Looked up only when everything above allows an update: undefined = not yet. */
  target?: HostFileTarget | null
  source?: NetUpdateSource | { missing: string }
}

export type NetUpdateDecision =
  | { go: true; source: NetUpdateSource; target: HostFileTarget }
  | { go: 'lookup' }
  | { go: false; skip: NetUpdateSkip; why: string; retryInMs?: number; until?: number }

const no = (skip: NetUpdateSkip, why: string, retryInMs?: number): NetUpdateDecision => ({ go: false, skip, why, ...(retryInMs ? { retryInMs } : {}) })

/** Whether this connect updates the host's daemon, from what is known; pure. */
export function decideNetUpdate(f: NetUpdateFacts): NetUpdateDecision {
  if (f.kind === 'local' || f.host === '__local__') return no('local', 'this Mac\'s own daemon is updated by LocalDaemon')
  if (f.kind !== 'net') return no('not-net', `a ${f.kind} host has its own update path (daemon-update-paths.ts)`)
  if (f.testServer) return no('test-server', 'a test server never changes a host\'s daemon')
  if (f.follower) return no('follower', 'only the leader updates a host\'s daemon: two servers of different builds would undo each other')
  if (!f.expected) return no('no-build-version', 'this server runs from source and names no daemon build')
  if (f.running === f.expected && !f.modeDue) return no('current', `its daemon is this build (${f.expected})`)
  if (f.startup !== 'service' || !f.serviceExecutable || !f.has('service-update-v1')) {
    return no('unmanaged', 'its daemon is not a service Walnut can update (no service-update-v1 service)')
  }
  const missing = NET_UPDATE_CAPABILITIES.filter((c) => !f.has(c))
  if (missing.length) return no('old-daemon', `its daemon lacks ${missing.join(', ')}; update Walnut on that machine once`)
  if (!f.requested && f.turnedOff) return no('turned-off', 'WALNUT_NET_DAEMON_UPDATE=0 turns the automatic update off')
  if (!f.requested && f.autofixOff) {
    return no('held', f.autofixOff === 'config'
      ? `the host's setting says autofix: false, so it is updated only on request (host_daemon_update ${f.host})`
      : f.autofixOff === 'config-unreadable'
        ? `the config could not be read, so whether the host allows it is unknown; it is updated only on request (host_daemon_update ${f.host})`
        : `automatic host fixes are off (WALNUT_HOST_AUTOFIX), so it is updated only on request (host_daemon_update ${f.host})`)
  }
  if (!f.requested && f.shared) {
    return no('shared', `${f.shared}, so it keeps running; it is updated on request (host_daemon_update ${f.host})`)
  }
  if (!f.requested && f.contested) {
    return no('contested', `something on that machine (its own Walnut) put another build back after this server updated it to ${f.expected}; `
      + `updating again would swap them back and forth, so it is updated only on request (host_daemon_update ${f.host})`)
  }
  if (!f.requested && (f.failedTries ?? 0) >= MAX_AUTO_FAILURES) {
    return no('gave-up', `${f.failedTries} automatic updates to ${f.expected} failed; it is tried again on request (host_daemon_update ${f.host}) or with the next build`)
  }
  if (!f.requested && f.lastAttempt?.expected === f.expected && f.now - f.lastAttempt.at < f.cooldownMs) {
    return no('cooldown', `an update to ${f.expected} was tried ${Math.round((f.now - f.lastAttempt.at) / 1000)} s ago`,
      f.cooldownMs - (f.now - f.lastAttempt.at))
  }
  // The gap is between builds (as on the SSH path): a switch of the mode alone does not wait for it.
  const gap = f.requested || f.running === f.expected ? null : daemonUpdateGapHold({
    host: f.host, ageMs: f.daemonAgeMs, gapMs: f.minGapMs ?? 0, heldForMs: f.gapHeldForMs ?? 0, overdue: f.overdue, needs: f.capNeeded, now: f.now,
  })
  if (gap) return { go: false, skip: 'recent', why: gap.why, retryInMs: gap.waitMs, until: gap.until }
  if (f.target === undefined || f.source === undefined) return { go: 'lookup' }
  // Both may pass (a probe that timed out, a download that failed): asked again after a cooldown.
  if (!f.target) return no('platform-unknown', 'Walnut does not know which system and processor that machine has', f.cooldownMs)
  if ('missing' in f.source) return no('no-binary', f.source.missing, f.cooldownMs)
  return { go: true, source: f.source, target: f.target }
}

/** The scope `walnut daemon status` names, when Walnut may update it there; pure. */
export function scopeFromStatus(output: string): { scope: 'user' | 'cron' } | { why: string } {
  let s: { installed?: unknown; foreign?: unknown; scope?: unknown }
  try { s = JSON.parse(output.slice(output.indexOf('{'))) } catch { return { why: 'walnut daemon status gave no answer Walnut could read' } }
  if (s.installed !== true) return { why: 'no service of Walnut\'s is installed there' }
  if (s.foreign === true) return { why: 'its service config is not Walnut\'s own' }
  if (s.scope !== 'user' && s.scope !== 'cron') return { why: `its ${String(s.scope)} service needs an administrator` }
  return { scope: s.scope }
}
