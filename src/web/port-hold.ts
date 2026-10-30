/**
 * Hold the server's port from early in the boot until the HTTP server listens on it.
 *
 * The boot starts the local session daemon before it listens, and the daemon listens
 * on a port the OS picks. Nothing kept the server's own port taken in between, so on
 * a port in the OS's ephemeral range the daemon could be handed exactly that port and
 * the server then died with EADDRINUSE on its own daemon (2026-10-30, the binary
 * matrix's ubuntu:20.04 arm64 rehearsal: `--port 42495`, daemon on 42495). While a
 * socket holds the port the OS never picks it for another listener.
 */
import net from 'node:net'

export interface PortHold {
  /** Free the port (idempotent); call right before the real listen. */
  release(): Promise<void>
}

/** Listen on `port` (and `host`) with a plain socket. Port 0 needs no hold: null. Rejects as listen does (EADDRINUSE). */
export async function holdPort(port: number, host?: string): Promise<PortHold | null> {
  if (!port) return null
  // A client that connects meanwhile (a browser reconnecting during a restart, a deploy's
  // readiness poll) is cut at once, as a closed port would refuse it, never left hanging.
  const holder = net.createServer({ pauseOnConnect: true }, (socket) => socket.destroy())
  await new Promise<void>((resolve, reject) => {
    holder.once('error', reject)
    if (host) holder.listen(port, host, () => resolve())
    else holder.listen(port, () => resolve())
  })
  holder.unref()
  let released: Promise<void> | null = null
  return {
    release() {
      released ??= new Promise<void>((resolve) => holder.close(() => resolve()))
      return released
    },
  }
}
