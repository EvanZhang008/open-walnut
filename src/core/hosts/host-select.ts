/**
 * `@tag` host selectors: a start may ask for what a host has instead of naming
 * one (`host: "@ios"`, `"@browser"`, `"@mcp:docs-mcp"`, `"@ios+always-on"`
 * for both). The server picks a connected host whose capabilities carry every
 * tag (capabilities.ts, on each fleet card), or refuses with a sentence that
 * says which hosts have it and why none can take it now, so a task never starts
 * a session that cannot do the work.
 *
 * Order among the hosts that qualify: the host the task's conversation runs on,
 * then the caller's own host (no move needed), then the ones placement does not call busy, then the most room, then the Mac.
 * A host placement may never pick (weight 0) still serves a selector: the user
 * keeping it out of automatic placement is not the user keeping it from work
 * that needs it, and naming a host by its capability is naming it.
 */
import { normalizeTag } from './capabilities.js'
import type { FleetHost } from './fleet-model.js'

export const SELECTOR_PREFIX = '@'

export class HostSelectorError extends Error {
  constructor(message: string, public code: 'bad_selector' | 'no_capable_host') {
    super(message)
    this.name = 'HostSelectorError'
  }
}

/** The tags a selector asks for; null when `host` is a plain host name. Throws on a malformed one. */
export function parseHostSelector(host: unknown): string[] | null {
  if (typeof host !== 'string' || !host.trim().startsWith(SELECTOR_PREFIX)) return null
  // `+` joins tags; a query string decodes a literal + to a space, so both split.
  const parts = host.trim().slice(1).split(/[+\s]+/).filter(Boolean)
  const tags = parts.map(normalizeTag)
  if (!parts.length || tags.some((t) => !t)) {
    throw new HostSelectorError(`"${host}" is not a host selector: write @ and a capability tag, e.g. "@ios", "@browser", "@mcp:<server>", or "@ios+always-on" for both`, 'bad_selector')
  }
  return [...new Set(tags as string[])]
}

/** Which `unknown` entry (capabilities.ts) would hide a tag: the system for the OS and place tags. */
function unknownKey(tag: string): string {
  if (tag === 'ios' || tag === 'browser' || tag === 'always-on') return tag
  if (tag.startsWith('mcp:')) return 'mcp'
  return 'system'
}

/** A host to take first when it qualifies, with the words that say why. */
export interface Preference { host: string; why: string }

export interface HostPick { host: string; label: string; tags: string[]; reason: string }

/**
 * Pure: choose among the fleet's cards. `prefer` names hosts to take first when they
 * qualify, in order: the host the task's conversation already runs on (a start
 * elsewhere would be refused as a move), then the caller's own host.
 */
export function pickFromFleet(cards: FleetHost[], tags: string[], opts: { prefer?: Preference[] } = {}): HostPick {
  const prefer = (opts.prefer ?? []).filter((p) => !!p.host).map((p) => p.host)
  const want = tags.join(', ')
  const having = cards.filter((c) => tags.every((t) => c.capabilities?.tags.includes(t)))
  const ready = having.filter((c) => c.connection.connected)
  if (!ready.length) {
    const offline = having.map((c) => `${c.label} (${c.host}): ${c.connection.phaseLabel}`)
    // Only hosts that could not report one of THESE tags: an unknown always-on is no excuse for a missing iOS.
    const unknown = cards.filter((c) => !having.includes(c) && tags.some((t) => !c.capabilities?.tags.includes(t)
      && c.capabilities?.unknown.includes(unknownKey(t))))
      .map((c) => `${c.label} (${c.host})`)
    const why = offline.length
      ? `Every host with ${want} is out of reach now: ${offline.join('; ')}.`
      : `No host Walnut knows has ${want}.${unknown.length ? ` Not known yet for ${unknown.join(', ')} (its daemon has not reported it).` : ''}`
    throw new HostSelectorError(`${why} host_list shows each host's capabilities.tags.`, 'no_capable_host')
  }
  const rank = (c: FleetHost): number[] => [
    prefer.includes(c.host) ? prefer.indexOf(c.host) : prefer.length,
    c.placement.busy ? 1 : 0,
    -(c.placement.score ?? -1),
    c.local ? 0 : 1,
  ]
  const sorted = [...ready].sort((a, b) => {
    const ra = rank(a), rb = rank(b)
    for (let i = 0; i < ra.length; i++) if (ra[i] !== rb[i]) return ra[i] - rb[i]
    return a.host.localeCompare(b.host)
  })
  const pick = sorted[0]
  const others = ready.length - 1
  const reason = `${pick.label} (${pick.host}) has ${want}`
    + (prefer.includes(pick.host) ? ` and ${opts.prefer!.find((p) => p.host === pick.host)!.why}` : pick.placement.busy ? ', though placement calls it busy' : '')
    + (others ? `; ${others} other connected host${others === 1 ? '' : 's'} also qualif${others === 1 ? 'ies' : 'y'}` : '')
  return { host: pick.host, label: pick.label, tags, reason }
}

/** Resolve a selector against the live fleet. */
export async function pickHost(tags: string[], opts: { prefer?: Preference[] } = {}): Promise<HostPick> {
  const { listFleet } = await import('./fleet.js')
  return pickFromFleet(await listFleet({ days: 7 }), tags, opts)
}

/**
 * `host` as a start should use it: a plain name unchanged, a selector resolved.
 * `prefer`: hosts to take first when they qualify (pickFromFleet).
 */
export async function resolveHostParam(host: string | undefined, opts: { prefer?: Preference[] } = {}): Promise<{ host: string | undefined; pick?: HostPick }> {
  const tags = parseHostSelector(host)
  if (!tags) return { host }
  const pick = await pickHost(tags, opts)
  return { host: pick.host, pick }
}
