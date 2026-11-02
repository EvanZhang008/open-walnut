/**
 * The host network's relay choice (docs/reference/host-network.md, "Choosing the relay"):
 * `own` (the relay on the user's companion), `public` (iroh's public relays, run by n0),
 * `none` (direct only), and the checks that keep a change from cutting a machine off.
 */
import { socketAddr } from '../../providers/net-config-core.js'

export type RelayChoice = 'own' | 'public' | 'none'

/**
 * The relay in use. A paired companion always means its relay: the machines that join
 * through it come up on it, so another choice would leave each new one unreachable.
 * Without one, the user's pick, else public relays (a machine behind a home router
 * still connects).
 */
export function relayChoice(pick: unknown, companion: boolean): RelayChoice {
  if (companion) return 'own'
  return pick === 'none' ? 'none' : 'public'
}

/** The choice a running walnut-net is on, from its status (`relayMode`). */
export function choiceOfMode(mode: unknown): RelayChoice | null {
  if (mode === 'custom') return 'own'
  return mode === 'public' || mode === 'none' ? mode : null
}

/** The direct address this Mac reaches a machine at, from its walnut-net's link (`Ip(1.2.3.4:5)`). */
export function directAddr(link: unknown): string | null {
  const paths = (link as { paths?: Array<{ kind?: string; addr?: string; selected?: boolean }> } | null | undefined)?.paths ?? []
  const p = paths.find((x) => x.selected && x.kind === 'direct') ?? paths.find((x) => x.kind === 'direct')
  const m = /^Ip\((.+)\)$/.exec(p?.addr ?? '')
  return m && socketAddr(m[1]) ? m[1] : null
}

export interface MachineLink {
  name: string
  /** Reached now, and how. */
  connected: boolean
  path?: string
  /** The address this Mac reaches it at (directAddr). */
  at?: string | null
  /** The addresses it listens on, as it says. */
  own: string[]
}

/**
 * The machines No relay would cut off: each one this Mac reaches now through a relay,
 * or directly but at an address the machine does not have (a router in between, which
 * the relay helped it through). Told to drop its relay, such a machine could never be
 * reached again to be told otherwise. One that is away is not told, so it is safe.
 */
export function cutOffByNoRelay(machines: MachineLink[]): string[] {
  return machines.filter((m) => m.connected && !(m.path === 'direct' && m.at && m.own.includes(m.at))).map((m) => m.name)
}
