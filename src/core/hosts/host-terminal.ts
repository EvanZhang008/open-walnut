/**
 * A terminal stream on another host Walnut knows, through its daemon link ('pty-stream-v1',
 * providers/pty-stream-core.ts): the remote side of the in-app terminal on a host with no SSH
 * route (src/web/terminal/link-pty.ts).
 *
 * Dialled as host_exec dials (its capability check, and a quiet link asked first), so a terminal
 * never opens on a link that died out of sight. It is a person's terminal socket, never a task's
 * op: no caller, no grant, so nothing here reads callerOf (core/hosts/trigger-caller.ts).
 */
import type { PtyOpenOptions, PtyStream } from '../../lib/link-stream.js'
import { PTY_STREAM_CAPABILITY, ptyStreamMissingSentence } from './terminal-link.js'

/**
 * The link to `host`, as host_exec dials it, then a terminal running `command` there. A daemon
 * without terminal streams is refused in the words every surface says (ptyStreamMissingSentence).
 */
export async function openTerminalStream(host: string, command: string, opts: PtyOpenOptions): Promise<PtyStream> {
  const { dial, hostName, HostExecError } = await import('./host-exec.js')
  let conn: Awaited<ReturnType<typeof dial>>
  try {
    conn = await dial(host, undefined, PTY_STREAM_CAPABILITY, 'open a terminal')
  } catch (err) {
    if (err instanceof HostExecError && err.code === 'daemon_upgrade') throw new HostExecError(`${ptyStreamMissingSentence(await hostName(host))}.`, err.status, err.code)
    throw err
  }
  return conn.openPtyStream(command, opts)
}
