/**
 * The daemon's door: the loopback WebSocket listener other processes reach the runtime through
 * (a leader over its ssh tunnel, walnut-net, a host's follower server, a hub forward), and the
 * files that tell them where it is (daemon.port; daemon.pid, and daemon.stamp, the pid's start
 * time, by which a leader knows that pid is still this daemon: daemon-live-sh.ts).
 *
 * A daemon program always opens it. A runtime inside a Walnut server's process opens it too when
 * asked (DaemonRuntimeOptions.door): the server calls the runtime directly, and the door serves
 * everyone else with the same handlers, so the legacy protocol and its commands stay one code path.
 */
/** What the door hands each socket event to: the runtime's own handlers. `W` is the runtime's socket type. */
export interface DoorHandlers<W> {
  open(ws: W): void
  message(ws: W, text: string): void
  /** Any frame back (ping, pong) is proof of life; a pong carries back the payload of the ping it answers. */
  heard(ws: W, pong?: Uint8Array): void
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
    pong(ws: W, data: Uint8Array): void
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
      pong: (ws, data) => handlers.heard(ws, data),
      drain: (ws) => handlers.drain(ws),
      close: (ws) => handlers.close(ws),
    },
  })
}

/** `<pid> <start time>` of the process daemon.pid names, beside it (stampDoor writes it, daemon-live-sh.ts reads it). */
export const DAEMON_STAMP_NAME = 'daemon.stamp'

interface DoorFs {
  readFileSync(file: string, encoding: 'utf8'): string
  writeFileSync(file: string, text: string): void
  renameSync(from: string, to: string): void
  unlinkSync(file: string): void
}

export interface DoorFiles {
  pidFile: string
  portFile: string
  /** daemon.stamp (daemon-live-sh.ts DAEMON_STAMP_NAME). Absent: none written or removed. */
  stampFile?: string
}

/** ps, for the start time where there is no /proc (macOS): node's execFile shape. */
export type DoorExecFile = (
  file: string, args: string[], options: { env?: NodeJS.ProcessEnv; timeout?: number },
  done: (err: unknown, stdout: string | Buffer) => void,
) => unknown

/**
 * How the stamp reads a start time. `procStart`: the Linux reader (daemon-core.ts readProcStartTime;
 * undefined where there is no /proc); `execFile`/`env`: ps, elsewhere.
 */
export interface DoorStartReader {
  procStart(pid: number): string | null | undefined
  execFile?: DoorExecFile
  env?: NodeJS.ProcessEnv
}

/**
 * Writes daemon.stamp, `<pid> <start time>`, in the words daemon-live-sh.ts `w_pstart` reads: Linux
 * field 22 of /proc/<pid>/stat and the boot id, at once (ticks since boot repeat in a later boot);
 * elsewhere ps's lstart under LC_ALL=C TZ=UTC, one space between its words (a login shell and a
 * service read the same words; the registry's own LANG=C reading stays as older daemons recorded
 * it), once ps answers. Called right after daemon.pid is written, and writes only while daemon.pid
 * still names `pid`: a daemon.pid newer than the stamp is an earlier writer's stamp
 * (daemon-live-sh.ts w_stamp). No start time, no stamp: a leader then judges the pid by its
 * command line, as for a daemon from before the stamp. A stamp left by an earlier daemon is removed
 * first, so it never vouches for this pid. Never throws. Self-contained: the source twin carries
 * its text.
 */
export function stampDoor(fs: DoorFs, files: { pidFile: string; stampFile: string }, pid: number, read: DoorStartReader): void {
  const write = (start: string): void => {
    let named = ''
    try { named = fs.readFileSync(files.pidFile, 'utf8').trim() } catch { return }
    if (named !== String(pid)) return
    const tmp = files.stampFile + '.' + pid + '.tmp'
    try { fs.writeFileSync(tmp, pid + ' ' + start); fs.renameSync(tmp, files.stampFile) } catch { try { fs.unlinkSync(tmp) } catch { /* none */ } }
  }
  try { fs.unlinkSync(files.stampFile) } catch { /* none */ }
  let proc: string | null | undefined
  try { proc = read.procStart(pid) } catch { proc = null }
  if (proc !== undefined) {
    if (!proc || !/^[0-9]+$/.test(proc)) return
    let boot = ''
    try { boot = fs.readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim() } catch { /* none: the start alone */ }
    write(/^[0-9a-f-]+$/.test(boot) ? proc + ' ' + boot : proc)
    return
  }
  const execFile = read.execFile
  if (!execFile) return
  try {
    execFile('ps', ['-p', String(pid), '-o', 'lstart='], { env: { ...(read.env ?? process.env), LC_ALL: 'C', TZ: 'UTC' }, timeout: 10000 }, (err, stdout) => {
      const start = String(stdout || '').trim().replace(/\s+/g, ' ')
      if (!err && start) write(start)
    })
  } catch { /* no ps: no stamp */ }
}

/**
 * Says where the door is. daemon.pid, then daemon.stamp, then daemon.port: a starter that sees the
 * port file reads the pid next (2026-11-04: a test read daemon.pid in that gap, ENOENT;
 * tests/providers/daemon-pid-before-port.test.ts), and a leader that reads the pid finds its stamp.
 * The stamp goes after the pid so it is never older than this daemon's pid file (a stamp older
 * than daemon.pid is an earlier daemon's: daemon-live-sh.ts); an earlier stamp goes before the pid.
 * daemon.port by rename, so a reader that sees the file reads the whole port, never the empty file
 * between its creation and its write (CI 43535674084: ws://127.0.0.1:NaN).
 *
 * `pid` null: no daemon.pid (a runtime inside a server on the leader's own machine: its pid is
 * that server's, never a daemon's to signal), and one left by a daemon program this dir had
 * before goes, with its stamp. `port` null: no door, and a port file left from before goes too.
 */
export function publishDoorFiles(fs: DoorFs, files: DoorFiles, at: { pid: number | null; port: number | null }, read?: DoorStartReader): void {
  if (files.stampFile) { try { fs.unlinkSync(files.stampFile) } catch { /* none */ } }
  if (at.pid !== null) fs.writeFileSync(files.pidFile, String(at.pid))
  else { try { fs.unlinkSync(files.pidFile) } catch { /* none */ } }
  if (files.stampFile && at.pid !== null && read) stampDoor(fs, { pidFile: files.pidFile, stampFile: files.stampFile }, at.pid, read)
  if (at.port !== null) {
    const tmp = `${files.portFile}.${process.pid}.tmp`
    fs.writeFileSync(tmp, String(at.port))
    fs.renameSync(tmp, files.portFile)
  } else { try { fs.unlinkSync(files.portFile) } catch { /* none */ } }
}
