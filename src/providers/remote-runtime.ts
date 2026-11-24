/**
 * What runs the session daemon on a remote host.
 *
 * This leader puts one kind of daemon on a host: the compiled one, either a prebuilt
 * `daemon-linux-<arch>` binary or the Walnut file in the binary's slot (daemon-connection.ts
 * deployDaemon). It needs no runtime on the host. A host's daemon that an older leader
 * deployed as a JS source file under bun or node is still met in a live scan and shown
 * as such until the next version change replaces it with the compiled one.
 */

/** What this leader deploys and starts on a host. */
export type RemoteRuntime = 'binary'

/** What a host's running daemon was seen to run on: ours, or the source daemon an older leader left there. */
export type SeenRuntime = RemoteRuntime | 'bun' | 'node'

/**
 * A start failure that says the daemon file cannot RUN on this host (as opposed to a
 * daemon bug or a port clash): exec format error, a CPU without an instruction the build
 * needs, a glibc too old, a signal. `walnut-daemon-exit=N` is what the start command
 * appends when the backgrounded daemon died before writing its pid file
 * (daemon-start-cmd.ts), because a background job killed by SIGILL prints nothing of its own.
 */
export function isRuntimeStartFailure(text: string): boolean {
  if (/exec format error|cannot execute|illegal instruction|illegal hardware instruction|GLIBC_\d|GLIBCXX_\d|version `GLIBC|error while loading shared libraries|symbol lookup error|bad CPU type|Segmentation fault|core dumped|not found \(required by/i.test(text)) return true
  const exit = text.match(/walnut-daemon-exit=(\d+)/)
  if (!exit) return false
  const code = parseInt(exit[1], 10)
  return code === 126 || code === 127 || code > 128
}
