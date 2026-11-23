/**
 * The words a daemon refuses an update or a handover with while its own work runs (an ACP worker
 * on pipes, a relay, a host_exec run, an accepted command): it changed nothing, so every reader
 * asks again later instead of counting a failure. One pattern for every reader: the CLI's
 * handover wait (daemon-service-cli.ts), the server's answer in time (exec-runs-hold.ts) and a
 * record read back after the server's wait ended (daemon-update-readback.ts). The detached
 * runner's shell retry (daemon-net-update-io.ts) greps the same words.
 * Ratchet: tests/providers/daemon-busy-refusal-readback.test.ts.
 */
export const DAEMON_BUSY_WORDS = /must finish first|has active operations; retry after they finish/
