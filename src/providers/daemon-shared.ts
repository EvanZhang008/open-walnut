/**
 * A daemon two Walnuts share is not replaced by a build that brings nothing it lacks
 * (2026-11-03: a host shared by two people's Walnuts of different builds; each server
 * replaced the daemon with its own build whenever it connected, because a daemon's
 * version is a content hash with no order, so every reconnect of either side restarted
 * the daemon and cut the other's link).
 *
 * The running daemon keeps `daemon.serves.json` beside daemon.version
 * (served-walnuts-core.ts): its capabilities and which Walnuts it served lately, by key.
 * A server that finds another build running keeps it when both hold:
 *   - its capabilities cover everything this server's build of the daemon advertises
 *     (for the same twin: the source twin adds some only when its sidecar loads), and
 *   - another Walnut than this one used it within SHARED_WINDOW_MS.
 * Otherwise it replaces it as before: a daemon that lacks a capability is still
 * upgraded (a new feature would not work), and a host only this Walnut uses still gets
 * exactly this build. Replacing never ends a session: the new daemon adopts every
 * running CLI, and the ACP, host_exec and hold guards still apply first.
 *
 * Kept daemons converge on the newest: the build that adds a capability replaces the
 * older one once, and the older server then finds a daemon that covers it and keeps
 * it. A server older than this rule (no daemon-shared check) still replaces the daemon
 * whenever it would have before; only its upgrade makes it stop.
 */
import { ADVERTISED_DAEMON_CAPABILITIES } from './daemon-capabilities.js'
import { WALNUT_HOME } from '../constants.js'
import { ownFollowerDirs } from '../core/host-server/own-follower-dirs.js'
import { SHARED_WINDOW_MS, walnutKeyOf, type DaemonServes, type DaemonTwin } from './daemon-serves.js'

// The serves record itself (daemon-serves.ts), for the callers that read it with the rule.
export { parseServes, SERVES_FILE, SHARED_WINDOW_MS, walnutKeyOf, type DaemonServes, type DaemonTwin } from './daemon-serves.js'

/**
 * Capabilities a daemon says or not by its host, never by its build: the service ones, the
 * ACP host engines, and reading the process on its gateway socket (caller-proof-v1, only
 * where bun's FFI loads libc). They are no reason to keep or to replace it. Every one a twin
 * adds in its hello beyond ADVERTISED_DAEMON_CAPABILITIES belongs here
 * (tests/providers/daemon-shared-host-dependent.test.ts): 2026-11-12, caller-proof-v1 was
 * missing, so a dev host's daemon read as having something every newer build "lacks" and was
 * kept for good, and none of the day's daemon fixes reached it. pty-stream-v1 is not one: it
 * is advertised, and a daemon lacking it counts as missing it (sharedDaemonVerdict) unless it
 * says its runtime has no pty (`pty: false`, a source twin on Node).
 */
export const HOST_DEPENDENT_CAPABILITIES: ReadonlySet<string> = new Set(['service-handover-v1', 'cron-supervision-v1', 'service-update-v1', 'service-update-force-v1', 'acp-host-v1', 'caller-proof-v1'])
const HOST_DEPENDENT = HOST_DEPENDENT_CAPABILITIES

/**
 * Capabilities this server's build of `twin` says with everything it ships loaded. The
 * source twin has no `walnut-mcp-v1` (binary only); a source daemon whose sidecar did not
 * load lacks more, is replaced once, and the replace breaker (`replacedRecently`) keeps
 * that from repeating when the new one lacks the same.
 */
export function ourDaemonCapabilities(twin: DaemonTwin | null): string[] {
  if (twin === 'binary') return [...ADVERTISED_DAEMON_CAPABILITIES]
  return [...ADVERTISED_DAEMON_CAPABILITIES].filter((c) => c !== 'walnut-mcp-v1')
}

export type SharedVerdict =
  | { keep: true; others: string[]; why: string }
  /** `shared`: another Walnut uses it, so a replace arms the breaker (replacedRecently). */
  | { keep: false; why: string; missing?: string[]; shared?: boolean }

/** Whether a server keeps another build's daemon running; pure. */
export function sharedDaemonVerdict(args: {
  ourKey: string
  /**
   * The keys of this Walnut's own servers' data dirs on that host (thisWalnutSharedVerdict): a
   * daemon before 2026-11-23 filed a host replica's own data dir as a second Walnut.
   */
  ownFollowerKeys?: readonly string[]
  /** The daemon's version as this server read it (daemon.version or hello). */
  runningVersion: string
  running: DaemonServes | null
  now: number
  windowMs?: number
  /**
   * This server put its build on this host in the last REPLACE_BREAKER_MS and another
   * build is back: someone else puts theirs back, so replacing again would swap forever.
   */
  replacedRecently?: boolean
  env?: NodeJS.ProcessEnv
}): SharedVerdict {
  const { running } = args
  // WALNUT_DAEMON_KEEP_SHARED=0: this server replaces another build's daemon as before.
  if (['0', 'false', 'off', 'no'].includes(((args.env ?? process.env).WALNUT_DAEMON_KEEP_SHARED ?? '').trim().toLowerCase())) {
    return { keep: false, why: 'WALNUT_DAEMON_KEEP_SHARED=0' }
  }
  if (!running) return { keep: false, why: 'the running daemon keeps no record of the Walnuts it serves (an older build)' }
  // A record of another daemon (a stale file a stopped build left) proves nothing about this one.
  if (running.version !== args.runningVersion) return { keep: false, why: `its record is of another build (${running.version || 'none'})` }
  const window = args.windowMs ?? SHARED_WINDOW_MS
  const others = Object.entries(running.walnuts)
    .filter(([k, at]) => k !== args.ourKey && !args.ownFollowerKeys?.includes(k) && args.now - at < window)
    .map(([k]) => k)
  if (!others.length) return { keep: false, why: 'only this Walnut uses it' }
  const has = new Set(running.capabilities)
  const ours = ourDaemonCapabilities(running.twin)
  // A twin that says its runtime has no pty (a source twin on Node) lacks pty-stream-v1 in every
  // build, so that one is not missing; a daemon that says nothing (an older build) still is.
  const noPty = (c: string) => c === 'pty-stream-v1' && running.pty === false
  const missing = ours.filter((c) => !has.has(c) && !noPty(c))
  const kept = (why: string): SharedVerdict => ({ keep: true, others, why: `another Walnut uses it (${others.length}) and ${why}` })
  if (!missing.length) return kept('it has every capability this build\'s daemon has')
  // It has something this build would take away: neither build covers the other, and
  // each replacing the other's would swap it on every connect.
  const known = new Set(ours)
  const extra = running.capabilities.filter((c) => !known.has(c) && !HOST_DEPENDENT.has(c))
  if (extra.length) return kept(`it has ${extra.join(', ')}, which this build's daemon lacks`)
  if (args.replacedRecently) return kept('this server replaced it lately and another build came back')
  return { keep: false, why: `it lacks ${missing.join(', ')}`, missing, shared: true }
}

/**
 * The verdict for this Walnut on one host, the one way its servers ask it (daemon-connection.ts,
 * daemon-net-update.ts, local-daemon.ts; tests/providers/daemon-shared-own-follower.test.ts):
 * this Walnut is its data dir's key (`ourKey`, the caller's own when it keeps one) and the keys of
 * its own servers' data dirs on that host
 * (own-follower-dirs.ts; `hostKey` null for this computer's own daemon). The state file is read
 * only when another key is in the record at all.
 */
export async function thisWalnutSharedVerdict(
  hostKey: string | null,
  args: Omit<Parameters<typeof sharedDaemonVerdict>[0], 'ourKey' | 'ownFollowerKeys'> & { ourKey?: string },
): Promise<SharedVerdict> {
  const ourKey = args.ourKey ?? walnutKeyOf(WALNUT_HOME)
  const first = sharedDaemonVerdict({ ...args, ourKey })
  if (!first.keep && !first.shared) return first
  const dirs = await ownFollowerDirs(hostKey).catch(() => [] as string[])
  return dirs.length ? sharedDaemonVerdict({ ...args, ourKey, ownFollowerKeys: dirs.map(walnutKeyOf) }) : first
}

/** How long a replace of a shared daemon holds off replacing it again (sharedDaemonVerdict). */
export const REPLACE_BREAKER_MS = 24 * 3600_000
