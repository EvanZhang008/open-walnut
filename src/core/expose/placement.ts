/**
 * Where this Walnut's tunnel runs (docs/plan/walnut-servers-everywhere.md,
 * "Where the tunnel runs"): on this computer, or on the server this computer
 * keeps on one of its hosts, so the address answers while this computer sleeps.
 *
 * One tunnel, one name, one machine at a time. A tunnel service that gives a
 * name to whoever connected last (the second machine takes the address, and the
 * first one gets it back the moment it reconnects) must never see two machines
 * holding the same name, so the place is one answer, read by both sides: the
 * runtime here stops its own tunnel while a host carries it, and the host
 * server's settings carry it (core/host-server/index.ts).
 *
 * `expose.run_on` in config.yaml: `here`, a host key, or unset. Unset follows the
 * provider: the first host (by key) whose hostname matches the provider's
 * `alwaysOnHostPattern`, unless its server was turned off by hand; else here.
 * The host that carries it runs a Walnut server (installed there if it was not),
 * and this computer keeps its own tunnel until that host's is up (the handover,
 * hostHolds below and web/expose-runtime.ts): the address never goes dark while a
 * server installs. The built-in `command` provider stays here: its command is
 * written for this computer.
 */

import crypto from 'node:crypto'
import { COMMAND_PROVIDER_ID, type ExposeProviderDefinition, type ExposeRunsOn, type ExposeStatus } from './types.js'

export const RUN_ON_HERE = 'here'

/** The fields of a config.yaml host this reads. */
export interface PlacementHost {
  label?: string
  hostname?: string
  /** `false`: the person hid the host; nothing runs there. */
  enabled?: unknown
  cloud_box?: unknown
  server?: { enabled?: unknown } | null
}

export type ExposePlacement =
  | { where: 'here'; auto: boolean }
  | { where: 'host'; hostKey: string; label: string; auto: boolean }

/** One choice the person has for where it runs (Settings, Open from a browser). */
export interface ExposePlace {
  /** `here`, or a host key. */
  id: string
  label: string
  /** A host the provider names as always on. */
  alwaysOn: boolean
}

type Hosts = Record<string, PlacementHost | null | undefined> | undefined

function hostLabel(hostKey: string, host: PlacementHost): string {
  return host.label?.trim() || hostKey
}

function usable(host: PlacementHost | null | undefined): host is PlacementHost {
  return !!host && typeof host === 'object' && !host.cloud_box && host.enabled !== false
}

/** A host config.yaml names (never one inherited from Object.prototype, `__proto__` say). */
function hostAt(hosts: Hosts, key: string): PlacementHost | null {
  return hosts && Object.hasOwn(hosts, key) ? hosts[key] ?? null : null
}

function alwaysOnPattern(def: ExposeProviderDefinition | null): RegExp | null {
  if (!def?.alwaysOnHostPattern) return null
  try { return new RegExp(def.alwaysOnHostPattern, 'i') } catch { return null }
}

/** The hosts the provider names as always on, by key. */
export function alwaysOnHosts(def: ExposeProviderDefinition | null, hosts: Hosts): string[] {
  const pattern = alwaysOnPattern(def)
  if (!pattern || def?.id === COMMAND_PROVIDER_ID) return []
  return Object.keys(hosts ?? {}).sort().filter((key) => {
    const host = hostAt(hosts, key)
    return usable(host) && typeof host.hostname === 'string' && pattern.test(host.hostname.trim())
  })
}

export function exposePlacement(runOn: unknown, def: ExposeProviderDefinition | null, hosts: Hosts): ExposePlacement {
  if (def?.id === COMMAND_PROVIDER_ID) return { where: 'here', auto: false }
  const chosen = typeof runOn === 'string' ? runOn.trim() : ''
  if (chosen === RUN_ON_HERE) return { where: 'here', auto: false }
  if (chosen) {
    const host = hostAt(hosts, chosen)
    // A host removed since it was picked: back here, where the person can see it.
    if (usable(host)) return { where: 'host', hostKey: chosen, label: hostLabel(chosen, host), auto: false }
    return { where: 'here', auto: false }
  }
  for (const key of alwaysOnHosts(def, hosts)) {
    const host = hostAt(hosts, key)!
    // Turned off by hand: the person said no server there.
    if (host.server?.enabled === false) continue
    return { where: 'host', hostKey: key, label: hostLabel(key, host), auto: true }
  }
  return { where: 'here', auto: true }
}

/** The places Settings offers: the always-on hosts, the one picked (if another), and here. */
export function exposePlaces(runOn: unknown, def: ExposeProviderDefinition | null, hosts: Hosts): ExposePlace[] {
  if (def?.id === COMMAND_PROVIDER_ID) return []
  const keys = alwaysOnHosts(def, hosts)
  const placed = exposePlacement(runOn, def, hosts)
  if (placed.where === 'host' && !keys.includes(placed.hostKey)) keys.push(placed.hostKey)
  if (keys.length === 0) return []
  return [
    ...keys.map((key) => ({ id: key, label: hostLabel(key, hostAt(hosts, key)!), alwaysOn: alwaysOnHosts(def, hosts).includes(key) })),
    { id: RUN_ON_HERE, label: 'This computer', alwaysOn: false },
  ]
}

/** A run_on value PUT /api/expose takes: `here`, a host key config.yaml names, or null (follow the provider). */
export function validRunOn(value: unknown, hosts: Hosts): boolean {
  if (value === null) return true
  if (typeof value !== 'string') return false
  if (value === RUN_ON_HERE) return true
  return usable(hostAt(hosts, value))
}

/**
 * What one tunnel is, for a handover: its provider and the option values a run fills in
 * (defaults included). Hashed: an option may be a secret, and the key travels in a host's report.
 */
export function tunnelKey(def: Pick<ExposeProviderDefinition, 'id' | 'options'>, values: Record<string, string> = {}): string {
  const filled = (def.options ?? []).map((o) => (values[o.key] ?? o.default ?? '').trim())
  return `${def.id}:${crypto.createHash('sha256').update(JSON.stringify(filled)).digest('hex').slice(0, 16)}`
}

/** The fields of a host server's view (core/host-server/manager.ts) the status reads. */
export interface PlacementHostView {
  phase: string
  message?: string
  since: number
  server?: { expose?: ExposeStatus } | null
  /** The reported tunnel's `since`, on this computer's clock (the host's may differ). */
  exposeSince?: number
}

/** A host's tunnel that has been up this long at another address than this computer's holds it. */
export const HOLD_GRACE_MS = 2 * 60_000

/** This computer's own tunnel, as a handover reads it (supervisor.ts `hold()`). */
export interface LocalHold { url?: string }

export type HandoverStep =
  | { held: true }
  | { held: false; recheckInMs?: number }

/** The host server's report of this Walnut's tunnel (provider and options, `key`), connected with an address; else null. */
export function reportedTunnel(view: PlacementHostView | null, def: Pick<ExposeProviderDefinition, 'id'>, key: string): (ExposeStatus & { url: string }) | null {
  const r = view?.phase === 'running' ? view.server?.expose : undefined
  if (!r || !r.enabled || r.provider !== def.id || r.tunnelKey !== key || r.state !== 'connected' || !r.url) return null
  return r as ExposeStatus & { url: string }
}

/**
 * Whether the host is ready to hold this Walnut's tunnel, so the one here may stop. Its
 * server must report this same tunnel (`key`) connected, and then:
 *
 * - at the address this computer's own had (the same name gives the same address), or
 *   with none here: it is ready. Which connection is newer does not matter: the runtime
 *   stops the one here first and then asks the host to connect again
 *   (web/expose-runtime.ts), so the host's is the newest, and the service routes to it;
 * - at another address (a region that differs, say): once it has been up HOLD_GRACE_MS.
 *
 * `firstSeenAt`: when this computer first saw that connection, for a view without the
 * host's clock readings (`exposeSince`).
 */
export function hostHolds(
  view: PlacementHostView | null,
  def: Pick<ExposeProviderDefinition, 'id'>,
  key: string,
  local: LocalHold,
  at: { now: number; firstSeenAt?: number },
): HandoverStep {
  const r = reportedTunnel(view, def, key)
  if (!r) return { held: false }
  if (!local.url || r.url === local.url) return { held: true }
  const since = view!.exposeSince ?? at.firstSeenAt ?? at.now
  const left = since + HOLD_GRACE_MS - at.now
  return left <= 0 ? { held: true } : { held: false, recheckInMs: left }
}

/**
 * This Walnut's tunnel status while a host carries it: the host server's own
 * report while it runs (its port is the host's, so it is left out), else a
 * sentence about the server it waits for.
 */
export function statusOnHost(
  placement: { hostKey: string; label: string; auto: boolean },
  def: Pick<ExposeProviderDefinition, 'id' | 'title'>,
  view: PlacementHostView | null,
  /** This computer's tunnelKey: a report of another tunnel of the provider (other options) is not this one. */
  key?: string,
): ExposeStatus {
  const runsOn: ExposeRunsOn = { hostKey: placement.hostKey, label: placement.label, auto: placement.auto }
  const base = { enabled: true, provider: def.id, providerTitle: def.title, runsOn }
  const reported = view?.phase === 'running' ? view.server?.expose : undefined
  // Another provider's report (or another tunnel of it) is the host's own tunnel from before, not this one.
  // A report without a key comes from an older build there: it can only be this one.
  const same = !key || reported?.tunnelKey === undefined || reported.tunnelKey === key
  if (reported && reported.enabled && reported.state !== 'off' && reported.provider === def.id && same) {
    const {
      port: _hostPort, runsOn: _ignored, enabled: _enabled, provider: _provider, providerTitle: _title,
      tunnelKey: _key, movingTo: _moving, ...rest
    } = reported
    return { ...base, ...rest }
  }
  if (view?.phase === 'error' || view?.phase === 'unsupported') {
    return { ...base, state: 'retrying', since: view.since, lastError: view.message ?? `Walnut on ${placement.label} stopped.` }
  }
  return {
    ...base,
    state: 'starting',
    since: view?.since ?? 0,
    lastError: view?.phase === 'waiting-for-host'
      ? `Waiting to connect to ${placement.label}.`
      : view?.message ?? (view?.phase === 'running' ? `Starting ${def.title} on ${placement.label}.` : `Starting Walnut on ${placement.label}.`),
  }
}
