/**
 * How an overdue daemon update (daemon-update-behind.ts) gets past a busy daemon, in a bounded
 * time: the server passes OVER_BUSY_FLAG to `walnut daemon update` (the new build's CLI), which
 *  1. asks plainly for OVER_BUSY_PLAIN_MS (a run about to end, a relay of a second, ends on its own);
 *  2. then sends `force` with service.update until OVER_BUSY_WAIT_MS: a daemon with
 *     service-update-force-v1 goes over its requests, relays, ACP workers and host_exec runs;
 *  3. if it still refuses (an older daemon that ignores `force`, or a session command or file
 *     write that keeps its drain past 15 s), the service is restarted without the daemon's
 *     preparation: its own shutdown (SIGTERM) closes its intake, finishes the session commands
 *     and writes in flight, answers the relays and saves its sessions, and the CLI sessions keep
 *     running for the next daemon to adopt, as `walnut daemon restart` does.
 * No imports: the service CLI loads it.
 */
export const OVER_BUSY_FLAG = '--over-busy'
export const OVER_BUSY_WAIT_MS = 60_000
export const OVER_BUSY_PLAIN_MS = 30_000
