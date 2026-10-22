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
 * `alwaysOnHostPattern` and whose Walnut server is on; else here. Never a host
 * whose server is off: following the provider must not install a server and
 * copy this Walnut's data there unasked, nor leave the address dark while it
 * installs. Picking a host turns its server on. The built-in `command` provider
 * stays here: its command is written for this computer.
 */

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
    if (host.server?.enabled !== true) continue
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

/** The fields of a host server's view (core/host-server/manager.ts) the status reads. */
export interface PlacementHostView {
  phase: string
  message?: string
  since: number
  server?: { expose?: ExposeStatus } | null
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
): ExposeStatus {
  const runsOn: ExposeRunsOn = { hostKey: placement.hostKey, label: placement.label, auto: placement.auto }
  const base = { enabled: true, provider: def.id, providerTitle: def.title, runsOn }
  const reported = view?.phase === 'running' ? view.server?.expose : undefined
  // Another provider's report is the host's own tunnel from before, not this one.
  if (reported && reported.enabled && reported.state !== 'off' && reported.provider === def.id) {
    const { port: _hostPort, runsOn: _ignored, enabled: _enabled, provider: _provider, providerTitle: _title, ...rest } = reported
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
      : view?.message ?? `Starting Walnut on ${placement.label}.`,
  }
}
