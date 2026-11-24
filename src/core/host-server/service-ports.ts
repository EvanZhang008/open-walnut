/**
 * The loopback range a Walnut host service listens in on a host (41000 to 49999): clear of a server's
 * and a daemon's own ports. The host-server manager picks its services' ports here (manager.ts portsFor),
 * and so does a leader switch for the old leader's host service on its own machine (host-follow-steps.ts).
 */
export const HOST_SERVICE_PORT_BASE = 41_000
export const HOST_SERVICE_PORT_SPAN = 9_000
