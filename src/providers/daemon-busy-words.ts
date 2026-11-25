import { OVER_BUSY_GOES_OVER } from './daemon-over-busy.js'

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

/**
 * What a busy refusal names as open, as the daemon counted it when it refused: ` (open: 2 ACP
 * workers, 14 relay requests)` after the busy words (empty when it counted nothing). Each name is
 * a regular noun, said in the plural past one. A daemon before this says the busy words alone;
 * every reader treats the two the same.
 */
export function busyOpenWords(counts: ReadonlyArray<readonly [number, string]>): string {
  const open = counts.filter(([n]) => n > 0).map(([n, what]) => `${n} ${what}${n === 1 ? '' : 's'}`)
  return open.length ? ` (open: ${open.join(', ')})` : ''
}

const OPEN_WORDS = /\(open: ([^()]+)\)/g

/**
 * The words for an update the host's daemon refused as busy, the same on both paths that replace a
 * remote daemon (an SSH host, a host network machine): what holds it, as the daemon counted it (a
 * daemon before busyOpenWords: its refusal as it said it), and, unless this try already went over
 * that work, how the asker goes over it now and what that ends (daemon-over-busy.ts).
 */
export function daemonBusyWhy(error: unknown, o: { host: string; forced: boolean }): string {
  const text = error instanceof Error ? error.message : String(error)
  const open = [...new Set([...text.matchAll(OPEN_WORDS)].map((m) => m[1].trim()))]
  const held = open.length ? `open there: ${open.join('; ')}` : text.split('\n')[0].slice(0, 200)
  return `the host's daemon is busy (${held})` + (o.forced ? '' : `; host_daemon_update ${o.host} with over_busy goes ahead now: ${OVER_BUSY_GOES_OVER}`)
}
