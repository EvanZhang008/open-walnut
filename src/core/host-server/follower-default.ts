/**
 * With the experiment `follower_on_every_host` on (src/core/experimental.ts), every host Walnut
 * manages runs a follower Walnut server, unless the person turned it off for that host
 * (docs/plan/one-service-every-host.md, "Phase 1 as built"). The experiment is on by default; with it
 * turned off (a stored false), the switch is opt-in, as it always was.
 *
 * The switch is `hosts.<key>.server.enabled`. Walnut writes it only when the person flips it
 * (PUT /api/host-servers/:hostKey; the config write keeps it as it is), so a stored value is the
 * person's choice and an absent one was never chosen: a stored `false` stays off across
 * upgrades, a stored `true` stays on, and only a host with no stored choice follows the default.
 * Nothing new is written, so an older release reads the same file as before (it reads an absent
 * switch as off, and stops the follower it did not ask for).
 *
 * The default is on, with the experiment, for a host that is one Walnut manages: in config.yaml,
 * not turned off as a host, not the paired cloud box (a Walnut server itself), and not a found host
 * still waiting for the person's yes. The experiment is the one global switch.
 */

import type { Config } from '../types.js'
import { experimentalEnabled } from '../experimental.js'
import { foundHostUnadopted } from '../hosts/found-hosts.js'

type HostRow = NonNullable<Config['hosts']>[string]

/** Whether the experiment is on: a host with no stored choice of its own runs a follower. */
export function followerOnEveryHost(config: Pick<Config, 'experimental'>): boolean {
  return experimentalEnabled(config.experimental, 'follower_on_every_host')
}

/** Whether a host with no stored choice of its own runs a follower. */
export function followerOnByDefault(host: HostRow | null | undefined, config: Pick<Config, 'experimental'>): boolean {
  if (!host || host.cloud_box || host.enabled === false) return false
  if (!followerOnEveryHost(config)) return false
  return !foundHostUnadopted(host)
}

/** Who decided the host's switch: the person (a stored value), or the default (none stored). */
export function followerChosenBy(server: unknown): 'user' | 'default' {
  const enabled = server && typeof server === 'object' ? (server as { enabled?: unknown }).enabled : undefined
  return typeof enabled === 'boolean' ? 'user' : 'default'
}
