/**
 * A host's daemon update that waits, on either update path: the host network's
 * (NetDaemonUpdater, daemon-net-update.ts: its 'postponed', 'skipped' and 'held' phases) and SSH's
 * (DaemonConnection's postponeUpgrade and keepSharedDaemon). Before this, a host whose update
 * waited for hours ("waiting: service.handover: active ACP workers or relay requests must finish
 * first", or kept as shared because another Walnut uses it) said so only in the log.
 *
 * Now each wait is one record (kind, what it waits for, since when, for which build), worded by ONE
 * sentence builder: the host's status shows it as a plain note (host-status.ts foldDaemonUpdate,
 * Settings' grey info lines), and a wait that is long reaches Walnut Health once
 * (core/hosts/daemon-update-wait-health.ts): a postponed update still waiting past the overdue
 * bound (daemon-update-behind.ts), or a skip that means something went wrong (WAIT_HEALTH) for more
 * than an hour. Never a skip the person chose (a host's setting, the switch that turns these updates
 * off), and never a steady fact of the host (a shared daemon that lacks nothing, a daemon Walnut
 * cannot update, no build for its system): those stay a grey line, an alarm would never clear.
 *
 * Since when: one clock per host, build and kind of wait (WAIT_CLOCKS), kept on disk with the other
 * update hold clocks (acp-upgrade-hold.ts), because every deploy restarts the leader. Within a kind
 * the reason may change (a busy host, then a cooldown) while the build still waits; a move into or
 * out of a skip the person chose, or a shared daemon kept, starts the clock again (a 3-day hold then
 * a short postpone is not a 3-day postpone). The update landing drops it.
 */
import type { NetUpdatePhase, NetUpdateSkip } from './daemon-net-update.js'
import { dropHoldClocks, upgradeHoldClock } from './acp-upgrade-hold.js'
import { DAEMON_UPDATE_BEHIND_MAX_MS } from './daemon-update-behind.js'
import { clockTime as clockWords, pointInTime } from '../core/time-words.js'

/** Why an update waits: 'postponed' (work there, another name of the daemon updating it, a link cut), or why it is skipped for now. */
export type DaemonUpdateWaitKind = 'postponed' | NetUpdateSkip

export interface DaemonUpdateWait {
  kind: DaemonUpdateWaitKind
  /** What it waits for, in the update path's own words. */
  why: string
  /** When this build's update began to wait (ms epoch, wall clock). */
  since: number
  /** The build it waits to put there: a host that runs it has no wait. */
  expected: string
  /** When the wait ends by itself, when that is known (the update gap: daemon-update-gap.ts). */
  until?: number
}

/** What a skip says on the host's status; null: no wait to show (nothing to update, or not this path's host). */
export const SKIP_WAIT_LEADS: Record<NetUpdateSkip, ((label: string) => string) | null> = {
  'not-net': null,
  local: null,
  'test-server': null,
  follower: null,
  'no-build-version': null,
  current: null,
  unmanaged: (l) => `The daemon on ${l} is not one Walnut can update over the link`,
  'old-daemon': (l) => `The daemon on ${l} is too old to be updated over the link`,
  'turned-off': () => 'Daemon updates over the host network are turned off on this Walnut',
  held: (l) => `Daemon updates on ${l} are held by its setting`,
  contested: (l) => `Another build keeps coming back on ${l}, so Walnut does not update its daemon again for now`,
  shared: (l) => `${l} keeps the daemon another Walnut uses there, so this Walnut does not update it`,
  'gave-up': (l) => `The daemon update on ${l} failed too many times, so Walnut stopped trying by itself`,
  cooldown: (l) => `The daemon update on ${l} waits for its cooldown`,
  recent: (l) => `The daemon on ${l} started a short while ago, so its update waits`,
  'platform-unknown': (l) => `Walnut cannot tell which system ${l} runs, so its daemon is not updated`,
  'no-binary': (l) => `There is no daemon of this build for the system ${l} runs`,
  'service-set': (l) => `The daemon update on ${l} waits for this Walnut's own service there`,
  refused: (l) => `The daemon update asked for ${l} was refused`,
}

/** What each phase of the host network's updater is for the wait: one ('wait', or 'skip' by its reason), none, or 'keep' (a check under way leaves it as it is). */
export const PHASE_WAITS: Record<NetUpdatePhase, 'wait' | 'skip' | 'keep' | null> = {
  idle: null, checking: 'keep', running: null, updated: null, failed: null, skipped: 'skip', held: 'skip', postponed: 'wait',
}

/** The wait a phase (and its skip reason) is, null for none, 'keep' to leave it as it is. */
export function waitKindOf(phase: NetUpdatePhase, skip?: NetUpdateSkip): DaemonUpdateWaitKind | 'keep' | null {
  const p = PHASE_WAITS[phase]
  if (p === 'keep' || p === 'wait') return p === 'wait' ? 'postponed' : 'keep'
  if (p === 'skip' && skip && SKIP_WAIT_LEADS[skip]) return skip
  return null
}


/** "4:07 AM", in this server's own time zone (the status's reader is its user). */
export function clockTime(at: number): string {
  return clockWords(at)
}

/** "4:07 AM" today, "Nov 22, 4:07 AM" on another day (a wait over a day must not read as one of a few hours). */
export function sinceTime(at: number, now: number = Date.now()): string {
  const today = new Date(at).toDateString() === new Date(now).toDateString()
  return today ? clockWords(at) : pointInTime(at, { now, dated: true })
}

/** The one sentence a waiting update says, on the host's status and in Walnut Health. */
export function daemonUpdateWaitSentence(label: string, w: Pick<DaemonUpdateWait, 'kind' | 'why' | 'since' | 'until'>, now: number = Date.now()): string {
  const why = w.why.replace(/^waiting:\s*/, '').trim()
  const lead = w.kind === 'postponed' ? `The daemon update on ${label} waits` : SKIP_WAIT_LEADS[w.kind]?.(label) ?? `The daemon update on ${label} waits`
  const span = w.until && w.until > now ? `since ${sinceTime(w.since, now)}, until ${sinceTime(w.until, now)}` : `since ${sinceTime(w.since, now)}`
  return `${lead} (${span})${why ? `: ${why}` : ''}`
}

/** A postponed update this long is past the bound every hold gives way at, and still waits. */
export const LONG_POSTPONE_MS = DAEMON_UPDATE_BEHIND_MAX_MS
export const LONG_SKIP_MS = 60 * 60_000

/**
 * Which waits reach Walnut Health, and after how long; null: never (a grey line only). Never: a skip
 * the person chose (held, turned-off), and a steady fact of the host (a shared daemon that lacks
 * nothing, one Walnut cannot update, no build for its system, a move to the own service, which has its
 * own notice). The skips with no wait (SKIP_WAIT_LEADS null) are never one either.
 */
export const WAIT_HEALTH: Record<DaemonUpdateWaitKind, number | null> = {
  postponed: LONG_POSTPONE_MS,
  'gave-up': LONG_SKIP_MS, contested: LONG_SKIP_MS, refused: LONG_SKIP_MS, cooldown: LONG_SKIP_MS,
  // The update gap holds one build 2 h at most in all (daemon-update-gap.ts): past the 3 h bound it is no gap.
  recent: LONG_POSTPONE_MS,
  held: null, 'turned-off': null,
  shared: null, unmanaged: null, 'old-daemon': null, 'platform-unknown': null, 'no-binary': null, 'service-set': null,
  'not-net': null, local: null, 'test-server': null, follower: null, 'no-build-version': null, current: null,
}

/** Long enough for Walnut Health. */
export function updateWaitIsLong(w: Pick<DaemonUpdateWait, 'kind' | 'since'>, now: number): boolean {
  const after = WAIT_HEALTH[w.kind]
  return after !== null && now - w.since >= after
}

/** Which clock a wait counts on: a move between these starts it again (the person's choice, a shared daemon kept, everything else). */
export const WAIT_CLOCKS: Record<DaemonUpdateWaitKind, 'own-choice' | 'shared' | 'waits'> = {
  held: 'own-choice', 'turned-off': 'own-choice', shared: 'shared',
  postponed: 'waits', 'gave-up': 'waits', contested: 'waits', refused: 'waits', cooldown: 'waits', recent: 'waits',
  unmanaged: 'waits', 'old-daemon': 'waits', 'platform-unknown': 'waits', 'no-binary': 'waits', 'service-set': 'waits',
  'not-net': 'waits', local: 'waits', 'test-server': 'waits', follower: 'waits', 'no-build-version': 'waits', current: 'waits',
}

/** A wait not seen again for this long (a host away a day) starts over. */
const WAIT_STALE_MS = 24 * 3600_000
const prefix = (host: string) => `update-wait:${host}:`
/** Hosts whose wait ended (the update landed, or there was none to make) since their last wait. */
const ended = new Set<string>()

/** The update of `expected` on `host` waits now: since when it has waited (kept across leader restarts). */
export function noteUpdateWait(host: string, kind: DaemonUpdateWaitKind, why: string, expected: string, now: number = Date.now(), until?: number): DaemonUpdateWait {
  const key = `${prefix(host)}${WAIT_CLOCKS[kind]}:${expected}`
  dropHoldClocks(prefix(host), key)
  ended.delete(host)
  const { heldMs } = upgradeHoldClock(key, true, Number.POSITIVE_INFINITY, now, WAIT_STALE_MS)
  return { kind, why, since: now - heldMs, expected, ...(until ? { until } : {}) }
}

/** The host runs the build (its update landed, or there was none to make): no wait is left. */
export function endUpdateWait(host: string): void {
  dropHoldClocks(prefix(host), '')
  ended.add(host)
}

/** The host's wait ended since it last waited (endUpdateWait): its Health item recovers at once. */
export function updateWaitEnded(host: string): boolean {
  return ended.has(host)
}

/** A host no longer listed (removed, turned off): its clocks go. */
export function forgetUpdateWait(host: string): void {
  dropHoldClocks(prefix(host), '')
  ended.delete(host)
}
