/**
 * What this box offers beyond the replica core
 * (docs/plan/walnut-companion-unified-replica.md, stage 5). A replica is one
 * program; what differs between replicas is configuration, and these four
 * capabilities are the part of it that turns jobs and doors on:
 *
 *   public-door    phones pair and claim here, push, voice, the revoke queue,
 *                  the tunnel in front of the box (expose)
 *   bridge-door    daemons dial in on /bridge, the Mac drives its own daemon on
 *                  /daemon-tunnel, the Mac's /bridge/* HTTPS routes and /git/data
 *   cloud-exec     the box's own session daemons (they still start only with
 *                  cloud.exec.enabled), stream file cleanup, the send path canary
 *   backup-leader  takeover, and while it leads: cron, routines, overview,
 *                  project summary
 *
 * The box sets them for itself in WALNUT_CAPABILITIES (names separated by commas
 * or spaces, `none` for no capability), in its own unit as root sets
 * WALNUT_COMPANION_MAC_BUILDS. Unset or blank, the companion has all four, which
 * is exactly what it ran before capabilities existed; the Mac and a host replica
 * have none. Only the companion reads the variable for now: the Mac runs every
 * job by its own column, and a host replica keeps its plan's OFF list, so on
 * both a value is ignored and the boot policy line says so. On the companion a
 * name that is not a capability stops the boot: a typo must not read as a door
 * left shut.
 *
 * The defaults read `CLOUD_MODE` here on purpose (with the env parse in
 * constants.ts, the reads the boot policy ratchet keeps), and live: tests flip
 * the constant between cases, so nothing is cached past a change of either input.
 */

import { CLOUD_MODE } from '../constants.js'
import type { Placement } from './server-role.js'

export const CAPABILITIES = ['public-door', 'bridge-door', 'cloud-exec', 'backup-leader'] as const
export type Capability = (typeof CAPABILITIES)[number]

export const CAPABILITIES_ENV = 'WALNUT_CAPABILITIES'

export interface CapabilityFacts {
  capabilities: ReadonlySet<Capability>
  /** A value this server did not apply (set on the Mac or a host replica), else null. */
  ignored: string | null
}

const ALL: ReadonlySet<Capability> = new Set(CAPABILITIES)
const NONE: ReadonlySet<Capability> = new Set()

export function isCapability(name: string): name is Capability {
  return (CAPABILITIES as readonly string[]).includes(name)
}

/** What a server at `where` has when it sets nothing: the companion all four, the rest none. */
export function defaultCapabilities(where: Placement): ReadonlySet<Capability> {
  return where === 'cloud' ? ALL : NONE
}

/** The capabilities `raw` (WALNUT_CAPABILITIES) gives a server; `companion` is whether it is the companion. */
export function resolveCapabilities(raw: string | undefined, companion: boolean): CapabilityFacts {
  const text = (raw ?? '').trim()
  if (!companion) return { capabilities: NONE, ignored: text || null }
  if (!text) return { capabilities: ALL, ignored: null }
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
