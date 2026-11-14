/**
 * The capability registry: what a replica may offer beyond the replica core
 * (docs/reference/session-daemon.md, "The cloud companion is a replica with
 * capabilities"). Each capability is one manifest in src/core/capabilities/,
 * which names everything it does: the boot jobs it turns on, the socket doors it
 * opens and who may open them, and every file that asks for it. Adding one is a
 * new manifest file and its line in MANIFESTS below; the tests in
 * tests/core/capability-manifests.test.ts then hold it exact.
 *
 * The box sets them for itself in WALNUT_CAPABILITIES (names separated by commas
 * or spaces, `none` for no capability), in its own unit as root sets
 * WALNUT_COMPANION_MAC_BUILDS. Unset or blank, the companion has the four marked
 * companionDefault, exactly what it ran before capabilities existed; one added later
 * is off until the box names it. The Mac and a host replica have none. Only the companion reads the variable for now: the Mac runs every
 * job by its own column, and a host replica keeps its plan's OFF list, so on
 * both a value is ignored and the boot policy line says so. On the companion a
 * name that is not a capability stops the boot: a typo must not read as a door
 * left shut, and nothing outside this list can be switched on.
 *
 * The defaults read `CLOUD_MODE` here on purpose (with the env parse in
 * constants.ts, the reads the boot policy ratchet keeps), and live: tests flip
 * the constant between cases, so nothing is cached past a change of either input.
 */

import { CLOUD_MODE } from '../constants.js'
import type { Placement } from './server-role.js'
import type { Entrance } from './capabilities/manifest.js'
import { publicDoor } from './capabilities/public-door.js'
import { bridgeDoor } from './capabilities/bridge-door.js'
import { cloudExec } from './capabilities/cloud-exec.js'
import { backupLeader } from './capabilities/backup-leader.js'

/** Every capability, in the order the boot policy line and serverCapabilities list them. */
export const MANIFESTS = [publicDoor, bridgeDoor, cloudExec, backupLeader] as const
export type Capability = (typeof MANIFESTS)[number]['name']
export const CAPABILITIES: readonly Capability[] = MANIFESTS.map((m) => m.name)

/** The capability that turns `job` on for a replica, if one does. */
export function capabilityOfJob(job: string): Capability | undefined {
  return MANIFESTS.find((m) => (m.jobs as readonly string[]).includes(job))?.name
}

/**
 * The socket door at `path` this server has open, or null. A path no manifest
 * declares is null on every server: the upgrade handler refuses it. `caps`
 * defaults to this server's own (a test reads another set).
 */
export function openSocketDoor(path: string, caps: ReadonlySet<Capability> = capabilityFacts().capabilities): Entrance | null {
  for (const m of MANIFESTS) {
    const door = m.doors.find((d) => d.path === path)
    if (door) return caps.has(m.name) ? door : null
  }
  return null
}

export const CAPABILITIES_ENV = 'WALNUT_CAPABILITIES'

export interface CapabilityFacts {
  capabilities: ReadonlySet<Capability>
  /** A value this server did not apply (set on the Mac or a host replica), else null. */
  ignored: string | null
}

/** What a companion that sets nothing has: the manifests marked companionDefault (the four it always ran). */
const COMPANION_DEFAULT: ReadonlySet<Capability> = new Set(MANIFESTS.filter((m) => m.companionDefault).map((m) => m.name))
const NONE: ReadonlySet<Capability> = new Set()

export function isCapability(name: string): name is Capability {
  return (CAPABILITIES as readonly string[]).includes(name)
}

/** What a server at `where` has when it sets nothing: the companion its default set, the rest none. */
export function defaultCapabilities(where: Placement): ReadonlySet<Capability> {
  return where === 'cloud' ? COMPANION_DEFAULT : NONE
}

/** The capabilities `raw` (WALNUT_CAPABILITIES) gives a server; `companion` is whether it is the companion. */
export function resolveCapabilities(raw: string | undefined, companion: boolean): CapabilityFacts {
  const text = (raw ?? '').trim()
  if (!companion) return { capabilities: NONE, ignored: text || null }
  if (!text) return { capabilities: COMPANION_DEFAULT, ignored: null }
  const names = text.split(/[\s,]+/).filter(Boolean)
  if (names.length === 1 && names[0] === 'none') return { capabilities: NONE, ignored: null }
  const out = new Set<Capability>()
  for (const name of names) {
    if (!isCapability(name)) {
      throw new Error(`${CAPABILITIES_ENV}: "${name}" is not a capability (${CAPABILITIES.join(', ')}, or none alone)`)
    }
    out.add(name)
  }
  return { capabilities: out, ignored: null }
}

let memo: { raw: string | undefined; companion: boolean; facts: CapabilityFacts } | null = null

/** This server's capabilities, from its env and whether it is the companion. */
export function capabilityFacts(): CapabilityFacts {
  const raw = process.env[CAPABILITIES_ENV]
  const companion = CLOUD_MODE
  if (!memo || memo.raw !== raw || memo.companion !== companion) {
    memo = { raw, companion, facts: resolveCapabilities(raw, companion) }
  }
  return memo.facts
}

export function hasCapability(cap: Capability): boolean {
  return capabilityFacts().capabilities.has(cap)
}

/** This server's capabilities in table order, for the boot policy line. */
export function capabilityList(): Capability[] {
  const own = capabilityFacts().capabilities
  return CAPABILITIES.filter((c) => own.has(c))
}

/**
 * The capabilities a server at `where` boots with: this server's own when it
 * runs there, that placement's defaults otherwise (a table read for another
 * placement, as the boot policy tests do).
 */
export function capabilitiesAt(where: Placement): ReadonlySet<Capability> {
  return (where === 'cloud') === CLOUD_MODE ? capabilityFacts().capabilities : defaultCapabilities(where)
}
