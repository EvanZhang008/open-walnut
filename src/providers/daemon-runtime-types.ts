import type { FollowerEntry } from './follower-entry-core.js'

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
  /**
   * With listen false: open the door anyway (daemon-door.ts), for every process the server does not
   * call directly (a leader's tunnel, walnut-net, a host's follower server, hub forwards). A program
   * always opens it.
   */
  door?: boolean
  /**
   * With listen false: daemon.pid names this process. Only a host's one service, which a leader
   * finds by its command line; a server on the leader's own machine never writes one.
   */
  pidFile?: boolean
  /**
   * With listen false: what its hello says it is (`serves`). 'walnut-serve' only for a host's one
   * Walnut service (a `walnut serve` process holding the runtime); default 'daemon'. A program is
   * always 'daemon'.
   */
  serves?: 'daemon' | 'walnut-serve'
  /**
   * A host's one Walnut service: the follower home this very process is (src/binary/service-entry.ts).
   * Its host-server supervisor starts no child for that home, and a follower spec the leader changes
   * for it ends the runtime (exit), so the launcher starts the service again on the new spec.
   */
  selfHome?: string
  /**
   * A leading service (src/binary/service-entry.ts runLeaderService): the Walnut this machine leads.
   * Its host-server supervisor never starts or adopts a follower of that Walnut here.
   */
  leadsWalnut?: string
  /** With listen false: the data dir of the server this runtime runs in (its lock banner names it: in-process-daemon.ts AnotherServiceError). */
  serverHome?: string
  /** With listen false: the launcher's facts for hello, from the process that writes its marks (serve-launcher-beat.ts). */
  launcherFacts?: () => unknown
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
  /** The program's exit hook gets the log's synchronous flush (an in-process runtime flushes at its stop). */
  onExitFlush?: (flush: () => void) => void
}

/** A message from the daemon to an in-process client: an answer (`id`, `ok`) or an event (`ev`). */
export type DaemonFrame = Record<string, unknown>

export interface DaemonClient {
  /**
   * A command frame ({ id, cmd, ...params }) handed over as the object it is: its reply comes back
   * through onFrame with the same id (a positive number: the caller's own, as on a socket).
   */
  send(frame: Record<string, unknown>): void
  /**
   * A command frame the runtime answers by function (fs.*, git.*, changes.*, ...), called: its
   * reply frame comes back from the call (null when the client closed first), through the same
   * gates a sent frame passes. null at once for any other command, which goes by send().
   */
  call(frame: Record<string, unknown>): Promise<DaemonFrame | null> | null
  /** One command, answered by its reply frame (`ok`, `error`, ...). */
  request(cmd: string, params?: Record<string, unknown>): Promise<DaemonFrame>
  close(): void
}

/**
 * What the follower server of a host's one Walnut service calls on the runtime in its own process
 * (core/link/follower-link.ts createDirectFollowerLink): the follower entry's functions of
 * `(home, params)`, each already inside the daemon's command lane and drain (what the same
 * `follower.*` command gets on a socket), and `attach`, which seats the server as the follower of
 * `home` with no `follower.hello` and no socket. Only the home the service serves is seated.
 */
export type FollowerSeatCalls = Pick<FollowerEntry,
  'view' | 'sessions' | 'slice' | 'send' | 'permission' | 'peer' | 'op' | 'triggers' | 'triggerTest' | 'pending' | 'start'>
export interface FollowerSeat extends FollowerSeatCalls {
  /**
   * The server follows `home` from now on: the client below is its one in-process link (the same
   * commands and events a follower socket has: streams, `gateway-request`, `trigger-delivery`,
   * `follower.report`, reads scoped to its Walnut). `hello` says what the follower socket's hello
   * says. onClose runs once when the runtime closes the client (stop).
   */
  attach(home: string, hello: FollowerSeatHello, onFrame: (frame: DaemonFrame) => void, onClose?: () => void): DaemonClient
  /**
   * The home the client `attach` returned holds the seat of now: the Walnut's first home here,
   * also after a declared move made the attached home its alias. Null once the seat is not its
   * own any more (another follower took it, or the client closed): the server seats itself again.
   * Every call above resolves its home the same way, as a follower socket's command is.
   */
  seatedAs(client: DaemonClient): string | null
}
/** What `follower.hello` carries besides the Walnut: which of the daemon's events this follower takes. */
export interface FollowerSeatHello {
  answersLocal?: boolean
  deliversTriggers?: boolean
  answersOnline?: boolean
  /** The follower's host-call entry socket (host-call-entry.ts), when it answers local calls. */
  callSocket?: unknown
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
  /** The seat of the follower server that holds this runtime in its own process (a host's one Walnut service). */
  readonly follower: FollowerSeat
  /** A line in the daemon's own log. */
  log(level: 'info' | 'warn' | 'error', msg: string, data?: Record<string, unknown>): void
}
