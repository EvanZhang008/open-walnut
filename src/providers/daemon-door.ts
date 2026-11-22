/**
 * The daemon's door: the loopback WebSocket listener other processes reach the runtime through
 * (a leader over its ssh tunnel, walnut-net, a host's follower server, a hub forward), and the
 * files that tell them where it is (daemon.port, and daemon.pid for a process a leader may look
 * for by its command line).
 *
 * A daemon program always opens it. A runtime inside a Walnut server's process opens it too when
 * asked (DaemonRuntimeOptions.door): the server calls the runtime directly, and the door serves
 * everyone else with the same handlers, so the legacy protocol and its commands stay one code path.
 */
/** What the door hands each socket event to: the runtime's own handlers. `W` is the runtime's socket type. */
export interface DoorHandlers<W> {
  open(ws: W): void
  message(ws: W, text: string): void
  /** Any frame back (ping, pong) is proof of life. */
  heard(ws: W): void
  /** The socket's buffer drained: send what waited. */
  drain(ws: W): void
  close(ws: W): void
}

/** The open door: its port, and stop (true also closes the sockets on it). */
export interface DaemonDoor {
  readonly port: number
  stop(closeActive?: boolean): void
}

/**
 * Bun's server, typed here by what the door uses: this module is also type-checked by the
 * main build (Node's types), where the `bun` type package does not exist.
 */
interface BunServeOptions<W> {
  port: number
  hostname: string
  fetch(req: Request, server: { upgrade(req: Request, init: { data: unknown }): boolean }): Response | undefined
  websocket: {
    open(ws: W): void
    message(ws: W, msg: string | Uint8Array): void
    ping(ws: W): void
    pong(ws: W): void
    drain(ws: W): void
    close(ws: W): void
  }
}
type BunServe = <W>(options: BunServeOptions<W>) => DaemonDoor

/** Opens the door on 127.0.0.1, a port the OS picks. Throws when Bun cannot listen (or this is no Bun). */
export function openDaemonDoor<W>(handlers: DoorHandlers<W>, data: () => unknown): DaemonDoor {
  const serve = (globalThis as { Bun?: { serve: BunServe } }).Bun?.serve
  if (!serve) throw new Error('the daemon door needs Bun')
  return serve<W>({
    port: 0,
    hostname: '127.0.0.1',
    fetch(req, server) {
      if (server.upgrade(req, { data: data() })) return undefined
      return new Response('walnut-daemon ok')
    },
    websocket: {
      open: (ws) => handlers.open(ws),
      message: (ws, msg) => handlers.message(ws, typeof msg === 'string' ? msg : Buffer.from(msg).toString()),
      ping: (ws) => handlers.heard(ws),
      pong: (ws) => handlers.heard(ws),
      drain: (ws) => handlers.drain(ws),
      close: (ws) => handlers.close(ws),
    },
  })
}

interface DoorFs {
  writeFileSync(file: string, text: string): void
  renameSync(from: string, to: string): void
  unlinkSync(file: string): void
}

export interface DoorFiles {
  pidFile: string
  portFile: string
}

/**
 * Says where the door is. daemon.pid before daemon.port: a starter that sees the port file reads
 * the pid next (2026-11-04: a test read daemon.pid in that gap, ENOENT;
 * tests/providers/daemon-pid-before-port.test.ts). daemon.port by rename, so a reader that sees
 * the file reads the whole port, never the empty file between its creation and its write (CI
 * 43535674084: ws://127.0.0.1:NaN).
 *
 * `pid` null: no daemon.pid (a runtime inside a server on the leader's own machine: its pid is
 * that server's, never a daemon's to signal), and one left by a daemon program this dir had
 * before goes. `port` null: no door, and a port file left from before goes too.
 */
export function publishDoorFiles(fs: DoorFs, files: DoorFiles, at: { pid: number | null; port: number | null }): void {
  if (at.pid !== null) fs.writeFileSync(files.pidFile, String(at.pid))
  else { try { fs.unlinkSync(files.pidFile) } catch { /* none */ } }
  if (at.port !== null) {
    const tmp = `${files.portFile}.${process.pid}.tmp`
    fs.writeFileSync(tmp, String(at.port))
    fs.renameSync(tmp, files.portFile)
  } else { try { fs.unlinkSync(files.portFile) } catch { /* none */ } }
}
