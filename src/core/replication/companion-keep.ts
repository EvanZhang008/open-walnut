/**
 * Where the cloud companion's keep choice lives, read the same way by the server and by
 * Settings (one effective value; docs/plan/walnut-companion-unified-replica.md, 4f):
 * `cloud_bridge.keep` (notes, pictures, memory, skills) and `cloud_bridge.copies` (the copy
 * kinds), else where an older build kept them, `hosts.companion.keep` and
 * `hosts.companion.server.copies`. A `hosts.companion` that is a real host (it has a
 * hostname) is that host's, never the companion's, and no new host takes the alias
 * (companionAliasRefusal).
 *
 * Every read of config.yaml moves the older keys into cloud_bridge (config-manager.ts
 * normalizeReadConfig), and every write does the same on disk first, so a choice made there
 * is never turned on again by a save that does not carry it.
 *
 * Pure (no imports but types): the web console loads it too (@open-walnut/companion-keep).
 */

import type { Config } from '../types.js'

type Bridge = NonNullable<Config['cloud_bridge']>
export type CompanionKeep = Bridge['keep']
export type CompanionCopies = Bridge['copies']

/** The alias the older keys lived under, which a real host may not take. */
export const COMPANION_ALIAS = 'companion'

type Obj = Record<string, unknown>
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v)

/** The older entry, when `hosts.companion` holds the companion's keys and is no real host. */
function legacyEntry(hosts: unknown): Obj | undefined {
  if (!isObj(hosts)) return undefined
  const h = hosts[COMPANION_ALIAS]
  return isObj(h) && !h.hostname ? h : undefined
}

/** What the companion keeps (notes, pictures, memory, skills); undefined: everything. */
export function companionKeepOf(config: Partial<Pick<Config, 'cloud_bridge' | 'hosts'>>): CompanionKeep {
  return config.cloud_bridge?.keep ?? (legacyEntry(config.hosts)?.keep as CompanionKeep)
}

/** Which copy kinds this Mac sends the companion; undefined: every one. */
export function companionCopiesOf(config: Partial<Pick<Config, 'cloud_bridge' | 'hosts'>>): CompanionCopies {
  const server = legacyEntry(config.hosts)?.server
  return config.cloud_bridge?.copies ?? ((isObj(server) ? server.copies : undefined) as CompanionCopies)
}

/**
 * Move the older keys into cloud_bridge (where cloud_bridge has none of its own) and drop
 * them; `hosts.companion` goes when nothing else is left in it. In place, on a raw or a
 * read config. Returns whether anything changed.
 */
export function migrateLegacyCompanionKeep(config: Obj): boolean {
  const entry = legacyEntry(config.hosts)
  if (!entry) return false
  const server = isObj(entry.server) ? entry.server : undefined
  const keep = entry.keep
  const copies = server?.copies
  if (keep === undefined && copies === undefined) return false
  const bridge: Obj = isObj(config.cloud_bridge) ? { ...config.cloud_bridge } : {}
  if (keep !== undefined && bridge.keep === undefined) bridge.keep = keep
  if (copies !== undefined && bridge.copies === undefined) bridge.copies = copies
  config.cloud_bridge = bridge
  const rest: Obj = { ...entry }
  delete rest.keep
  if (server) {
    const { copies: _moved, ...serverRest } = server
    if (Object.keys(serverRest).length > 0) rest.server = serverRest
    else delete rest.server
  }
  const hosts: Obj = { ...(config.hosts as Obj) }
  if (Object.keys(rest).length > 0) hosts[COMPANION_ALIAS] = rest
  else delete hosts[COMPANION_ALIAS]
  config.hosts = hosts
  return true
}

/**
 * Why a host may not be saved under `alias`, or null: `companion` names the cloud companion
 * (its keep, its copy rounds, its journal handover), so a host there would take the
 * companion's choice and share its rounds. `saved`: a host an older build saved there, which
 * keeps saving but is asked to move.
 */
export function companionAliasRefusal(alias: string, opts: { saved?: boolean } = {}): string | null {
  if (alias.trim() !== COMPANION_ALIAS) return null
  return opts.saved
    ? 'The name "companion" is also the cloud companion\'s, so the two share their copy rounds. Give this host another alias.'
    : 'The name "companion" is taken by the cloud companion. Give this host another alias.'
}
