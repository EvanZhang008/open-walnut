/**
 * The few things every area module of the session daemon's runtime takes from it
 * (createDaemonRuntime in daemon-standalone.ts): how it answers a command and how it logs.
 *
 * An area module (daemon-git.ts, daemon-skills.ts, ...) is `create<Area>(deps)`: code moved
 * out of the runtime's body as it was. Its deps name only what the area uses, each under the
 * runtime's own name (`HOME_DIR`, `daemonEnv`, `logMsg`, `sendOk`), so the moved code reads the
 * same and the runtime passes them by name; these types keep the common part one shape. `W` is the
 * runtime's socket type (a Bun ServerWebSocket with the runtime's own data); a module never
 * looks inside it, it only hands it back to these functions.
 */

/** The runtime's answer to one command: `sendOk` / `sendError` (daemon-standalone.ts, "Protocol helpers"). */
export interface DaemonReplies<W> {
  sendOk: (ws: W, id: number | null, data: Record<string, unknown>) => void
  /** `level`: an expected refusal is logged below error. */
  sendError: (ws: W, id: number | null, error: string, data?: Record<string, unknown>, level?: 'error' | 'warn' | 'info') => void
}

/** The runtime's push of one event to one socket (sendEvent, "Protocol helpers"). */
export type DaemonSendEvent<W> = (ws: W, ev: string, data: Record<string, unknown>) => void

/** The runtime's log (logMsg): one JSON line in the daemon's log; debug lines only on opt-in. */
export type DaemonLog = (level: string, msg: string, data?: Record<string, unknown>) => void

/** The runtime's env (`options.env`): what its modules read where a program would read process.env. */
export type DaemonEnv = Record<string, string | undefined>

/** One command handler as the dispatcher calls it. */
export type DaemonCommand<W> = (ws: W, id: number, cmd: Record<string, unknown>) => unknown

/** Expand a leading `~` against the host's HOME, as every path-taking command does. */
export function expandHome(p: string, homeDir: string): string {
  return (p === '~' || p.startsWith('~/')) ? homeDir + p.slice(1) : p
}
