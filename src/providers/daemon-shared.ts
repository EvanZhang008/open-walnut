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
import crypto from 'node:crypto'
import { ADVERTISED_DAEMON_CAPABILITIES } from './daemon-capabilities.js'

/** Another Walnut seen this recently still uses the daemon. */
export const SHARED_WINDOW_MS = 3 * 24 * 3600_000
export const SERVES_FILE = 'daemon.serves.json'

/**
 * Capabilities a daemon says or not by its host, never by its build: the service ones, the
 * ACP host engines, and reading the process on its gateway socket (caller-proof-v1, only
 * where bun's FFI loads libc). They are no reason to keep or to replace it. Every one a twin
 * adds in its hello beyond ADVERTISED_DAEMON_CAPABILITIES belongs here
 * (tests/providers/daemon-shared-host-dependent.test.ts): 2026-11-12, caller-proof-v1 was
 * missing, so a dev host's daemon read as having something every newer build "lacks" and was
 * kept for good, and none of the day's daemon fixes reached it.
 */
export const HOST_DEPENDENT_CAPABILITIES: ReadonlySet<string> = new Set(['service-handover-v1', 'cron-supervision-v1', 'service-update-v1', 'service-update-force-v1', 'acp-host-v1', 'caller-proof-v1'])
const HOST_DEPENDENT = HOST_DEPENDENT_CAPABILITIES

export type DaemonTwin = 'binary' | 'source'

/** What a running daemon says it serves (its serves file, or `served` in its hello). */
export interface DaemonServes {
  version: string
  twin: DaemonTwin | null
  capabilities: string[]
  /** Walnut key ('-' = a server that names no home) → last seen, ms. */
  walnuts: Record<string, number>
}

/**
 * The key a daemon files a Walnut under (served-walnuts-core.ts does the same): the same
 * data dir written with a trailing or doubled slash is one Walnut.
 */
export function walnutKeyOf(home: string): string {
  const dir = home.replace(/\/+/g, '/').replace(/(.)\/$/, '$1')
  return crypto.createHash('sha1').update(dir).digest('hex').slice(0, 16)
}

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

/** Reads a serves file's text (or a hello's `served`); null when it is none. */
export function parseServes(input: unknown): DaemonServes | null {
  let v: unknown = input
  if (typeof input === 'string') {
    if (!input.trim()) return null
    try { v = JSON.parse(input) } catch { return null }
  }
  if (!v || typeof v !== 'object') return null
  const o = v as Record<string, unknown>
  if (!Array.isArray(o.capabilities) || !o.walnuts || typeof o.walnuts !== 'object') return null
  const walnuts: Record<string, number> = {}
  for (const [k, at] of Object.entries(o.walnuts as Record<string, unknown>)) {
    if (typeof at === 'number' && Number.isFinite(at)) walnuts[k] = at
  }
  return {
    version: typeof o.version === 'string' ? o.version : '',
    twin: o.twin === 'binary' || o.twin === 'source' ? o.twin : null,
    capabilities: o.capabilities.filter((c): c is string => typeof c === 'string'),
    walnuts,
  }
}

export type SharedVerdict =
  | { keep: true; others: string[]; why: string }
  /** `shared`: another Walnut uses it, so a replace arms the breaker (replacedRecently). */
  | { keep: false; why: string; missing?: string[]; shared?: boolean }

/** Whether a server keeps another build's daemon running; pure. */
export function sharedDaemonVerdict(args: {
  ourKey: string
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
    .filter(([k, at]) => k !== args.ourKey && args.now - at < window)
    .map(([k]) => k)
  if (!others.length) return { keep: false, why: 'only this Walnut uses it' }
  const has = new Set(running.capabilities)
  const ours = ourDaemonCapabilities(running.twin)
  const missing = ours.filter((c) => !has.has(c))
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

/** How long a replace of a shared daemon holds off replacing it again (sharedDaemonVerdict). */
export const REPLACE_BREAKER_MS = 24 * 3600_000
