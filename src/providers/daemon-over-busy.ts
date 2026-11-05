/**
 * The way an overdue daemon update (daemon-update-behind.ts) asks the running daemon to go over
 * its own work: the server passes OVER_BUSY_FLAG to `walnut daemon update`, which then sends
 * `force` with service.update once a plain ask was refused for OVER_BUSY_PLAIN_MS, and asks for
 * OVER_BUSY_WAIT_MS in all instead of 30 s. The server passes it only to a daemon that advertises
 * service-update-force-v1. No imports: the service CLI loads it.
 */
export const OVER_BUSY_FLAG = '--over-busy'
export const OVER_BUSY_WAIT_MS = 90_000
/** How long the CLI asks without `force` first: a run about to end, a relay of a second, ends on its own. */
export const OVER_BUSY_PLAIN_MS = 60_000
