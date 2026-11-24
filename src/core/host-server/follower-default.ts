/**
 * Every host Walnut manages runs a follower Walnut server, unless the person turned it off for that
 * host (docs/plan/one-service-every-host.md, "Phase 1 as built"). This was the experiment
 * `follower_on_every_host`, on by default from 2026-11-22 until it ended on 2026-11-24; a stored
 * `experimental.follower_on_every_host` stays in the config for older releases and is ignored here.
 *
 * The switch is `hosts.<key>.server.enabled`. Walnut writes it only when the person flips it
 * (PUT /api/host-servers/:hostKey; the config write keeps it as it is), so a stored value is the
 * person's choice and an absent one was never chosen: a stored `false` stays off across
 * upgrades, a stored `true` stays on, and only a host with no stored choice follows the default.
 * Nothing new is written, so an older release reads the same file as before (one from before the
 * experiment reads an absent switch as off, and stops the follower it did not ask for).
 *
 * The default is on for a host that is one Walnut manages: in config.yaml, not turned off as a
 * host, not the paired cloud box (a Walnut server itself), and not a found host still waiting for
 * the person's yes. Whether the host has the room for one is eligibility.ts.
 */

import type { Config } from '../types.js'
import { foundHostUnadopted } from '../hosts/found-hosts.js'

type HostRow = NonNullable<Config['hosts']>[string]

/** Whether a host with no stored choice of its own runs a follower. */
export function followerOnByDefault(host: HostRow | null | undefined): boolean {
  if (!host || host.cloud_box || host.enabled === false) return false
  return !foundHostUnadopted(host)
}

/** Who decided the host's switch: the person (a stored value), or the default (none stored). */
export function followerChosenBy(server: unknown): 'user' | 'default' {
  const enabled = server && typeof server === 'object' ? (server as { enabled?: unknown }).enabled : undefined
  return typeof enabled === 'boolean' ? 'user' : 'default'
}
