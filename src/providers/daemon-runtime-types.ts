/**
 * The session daemon as a runtime a process creates (createDaemonRuntime in daemon-standalone.ts):
 * its options and its surface. Kept apart from that file so a server that creates one in its own
 * process (in-process-daemon.ts) reads them without taking the daemon's whole body into its build.
 */

/**
 * What creates a daemon runtime. The runtime never touches what belongs to the
 * whole process (cwd, umask, env, argv, signal and crash handlers, exit): the
 * caller hands it what it needs here and does those itself. The process entry
 * (runDaemonProcess, at the end of daemon-standalone.ts) is the caller when the
 * daemon runs as a program of its own, as it always has.
 */
export interface DaemonRuntimeOptions {
  /**
   * The daemon's configuration (WALNUT_DAEMON_DIR, HOME, ...) and the env its children get. The
   * runtime edits it as the daemon always edited its own env (the PATH it computes, no
   * WALNUT_SESSION_ID): a caller that is not a daemon process passes a copy.
   */
  env: NodeJS.ProcessEnv
  /** 'service': run as this user's login service (`--service`); 'start': every other start. */
  mode: 'start' | 'service'
  /**
   * Open the WebSocket door other processes reach it through (its port, daemon.port). Default
   * true. A server running it in its own process (in-process-daemon.ts) passes false: it calls
   * the runtime directly (connect()), and the agent-gateway unix socket stays open either way.
   */
  listen?: boolean
  /** The program that runs this daemon (the `walnut` shim re-runs it): its executable and script (argv[1], '' for none). */
  program?: { script: string }
  /** The umask every child is forked with (077 as the daemon always gave them); null leaves the process's own. */
  childUmask?: number | null
  /** Called once start() made the daemon dir: the process entry moves its cwd there. */
  chdir?: (dir: string) => void
  /** The runtime ended itself (another daemon took its dir, its parent is gone, a stop it was asked for finished): the code a process would exit with. */
  exit: (code: number) => void
  /** End at once, no cleanup (a drain that never finished; test hooks): the process entry SIGKILLs itself. Absent: exit(1). */
  hardExit?: () => void
  /** The port it listens on, as soon as it listens (the process entry prints it for its parent). */
  onListening?: (port: number) => void
  /** Receives the crash reporter (log + exit breadcrumb) as early as it exists. */
  onCrashReporter?: (report: (kind: 'uncaughtException' | 'unhandledRejection', err: unknown) => void) => void
}

/** A message from the daemon to an in-process client: an answer (`id`, `ok`) or an event (`ev`). */
export type DaemonFrame = Record<string, unknown>

export interface DaemonClient {
  /**
   * A command frame ({ id, cmd, ...params }) handed over as the object it is: its reply comes back
   * through onFrame with the same id (a positive number: the caller's own, as on a socket).
   */
  send(frame: Record<string, unknown>): void
  /** One command, answered by its reply frame (`ok`, `error`, ...). */
  request(cmd: string, params?: Record<string, unknown>): Promise<DaemonFrame>
  close(): void
}

export interface DaemonRuntime {
  readonly dir: string
  readonly version: string
  /** This runtime's instance id, as its `hello` answers it. */
  readonly instanceId: string
  /** Starts the daemon: lock, adopt sessions, listen. `existing`: another daemon already serves this dir. Once per runtime: a second call gets the first one's result. */
  start(): Promise<{ kind: 'started'; port: number } | { kind: 'existing'; port: string }>
  /** Stops it the way a SIGTERM always did (drain, save, release the lock) and ends its timers; the exit code a process would use. */
  stop(): Promise<number>
  /**
   * Saves now, synchronously, what a stop saves last (the registry, each session's fold checkpoint):
   * for a host process that must exit before stop() finished (its shutdown bail).
   */
  saveNow(): void
  /** The stop a signal asks for: stop, then options.exit. False when start() is not far enough to stop yet. */
  requestStop(): boolean
  /**
   * A client inside this process: the same commands and events as a socket client, no socket and
   * no JSON: frames are objects both ways, shared, never mutated by either side. onClose runs
   * once when the daemon closes it (another client took its place, stop()), never for its own close().
   */
  connect(onFrame: (frame: DaemonFrame) => void, onClose?: () => void): DaemonClient
  /** `--stop`, `--status`, `--prewarm-folds`: what the program prints, and its exit code. */
  cli: { stop(): Promise<number>; status(): Promise<number>; prewarmFolds(): number }
  /** A line in the daemon's own log. */
  log(level: 'info' | 'warn' | 'error', msg: string, data?: Record<string, unknown>): void
}
