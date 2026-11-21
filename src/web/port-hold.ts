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
  // A port this process let go of a moment ago is retried briefly (listenAfterHold, below).
  await listenAfterHold(() => listenAttempt(holder, port, host), { budgetMs: HOLD_RELISTEN_BUDGET_MS })
  holder.unref()
  let released: Promise<void> | null = null
  return {
    release() {
      released ??= new Promise<void>((resolve) => holder.close(() => resolve()))
      return released
    },
  }
}

/** How long the real listen retries a port this process just released (ms). */
export const RELISTEN_BUDGET_MS = 2_000
const RELISTEN_STEP_MS = 25
/** The hold's own listen: shorter, so a port really taken (Walnut already running) is said soon. */
const HOLD_RELISTEN_BUDGET_MS = 500

/**
 * One listen of `server` on `port` (and `host`) that leaves no listener behind, whichever way it
 * ends: the one it did not need is removed. Each attempt of listenAfterHold is one of these; a
 * listen callback (`listen(port, cb)`) instead stays as a 'listening' listener on every attempt
 * that failed, ~80 of them in a 2 s retry.
 */
export function listenAttempt(server: net.Server, port: number, host?: string): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const onError = (err: Error) => { server.off('listening', onListening); reject(err) }
    const onListening = () => { server.off('error', onError); resolve() }
    server.once('error', onError)
    server.once('listening', onListening)
    if (host) server.listen(port, host)
    else server.listen(port)
  })
}

/**
 * The real listen, right after the hold is released. A port this process held a moment ago can
 * still be taken for a few milliseconds: a child that another thread is starting holds a copy of
 * every descriptor of this process until it has exec'd (Bun closes them in the child one by one,
 * about 30 ms at an open-file limit of 32768), the released hold among them, still listening. The
 * spawn pool starts children on its own thread while this one runs (spawn-pool.ts, experiment
 * in_process_daemon), so a listen at that moment met EADDRINUSE and the server died on its own
 * port (2026-11-21, two of a dozen restarts with a session alive). EADDRINUSE is retried until
 * `budgetMs`; any other error, or a port still taken after it, is the caller's as before.
 * `listen` must be callable again after it rejected (node's and Bun's servers are), and must remove
 * what it added to the server whichever way it ends, or each retry leaves listeners behind:
 * listenAttempt does both.
 */
export async function listenAfterHold(
  listen: () => Promise<void>,
  opts: { budgetMs?: number; stepMs?: number; onRetry?: (attempt: number) => void } = {},
): Promise<void> {
  const deadline = Date.now() + (opts.budgetMs ?? RELISTEN_BUDGET_MS)
  for (let attempt = 1; ; attempt++) {
    try {
      await listen()
      return
    } catch (err) {
      if ((err as NodeJS.ErrnoException)?.code !== 'EADDRINUSE' || Date.now() >= deadline) throw err
      opts.onRetry?.(attempt)
      await new Promise((r) => setTimeout(r, opts.stepMs ?? RELISTEN_STEP_MS))
    }
  }
}
