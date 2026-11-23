/**
 * A follower that could not start because its port was taken on the host (the follower prints
 * Node's EADDRINUSE, src/web/server.ts). With two Walnuts' followers on one machine (the experiment
 * host_service_sets), the other may have bound the port this leader kept: the leader then forgets
 * it and the next try picks a free one (manager.ts portsFor), bound by the follower before it is
 * reported, so a collision costs one try, never the host.
 */
export function followerPortTaken(message: string): boolean {
  return /\bEADDRINUSE\b|address already in use|Port \d+ is in use/i.test(message)
}
