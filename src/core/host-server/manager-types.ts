/**
 * The shapes of the host-server manager (manager.ts): what it needs of a host and of this
 * server, the settings it reads, the view it keeps per host, and what it keeps on disk.
 */

import type { Duplex } from 'node:stream'
import type { HostServerStatus } from '../../providers/host-server-core.js'
import type { ExposeStatus } from '../expose/types.js'
import type { HostFileSource } from './host-file.js'
import type { InstallState } from './install.js'
import type { FollowerFloors, FollowerGateReason } from './eligibility.js'
import type { TryLaterKind } from './try-later.js'

/** What the manager needs of a host's daemon connection (DaemonConnection has it). */
export interface HostServerHost {
  hostKey: string
  connected: boolean
  hasCapability(cap: string): boolean
  send(cmd: string, params?: Record<string, unknown>, timeoutMs?: number): Promise<Record<string, unknown>>
  runRemoteScript(script: string, timeoutMs?: number): Promise<string>
  /**
   * `sha256` of `data`: a file already there with it is not sent again (DaemonConnection.uploadFile).
   * `onProgress`: the bytes the host holds so far, as the upload goes.
   */
  uploadFile(remotePath: string, data: Buffer, opts?: { sha256?: string; onProgress?: (sent: number, total: number) => void }): Promise<unknown>
  /**
   * Put the walnut file with `sha256` at `gz` from the host's daemon slot, when a
   * compiled Mac made the same file the host's daemon (DaemonConnection
   * seedHostFileFromDaemon): one upload serves both. False: send it.
   */
  seedFromDaemon?(sha256: string, gz: string): Promise<boolean>
  /** A byte stream to the server on that host that follows this Walnut, through its daemon. */
  openStream(to: 'follower', purpose?: string): Promise<Duplex>
  /** Carry those streams on a link of their own while the server runs (providers/stream-lane.ts). */
  keepStreamLane?(on: boolean): void
  /**
   * This link reaches the same daemon process as this server's own daemon (the hello's instance id,
   * daemon-connection.ts sameDaemonHosts): the host row is this computer. null: not known yet (this
   * computer's own daemon is not linked).
   */
  reachesThisComputer?(): Promise<boolean | null>
  /**
   * The name this link's daemon goes by when several aliases reach it (daemon-connection.ts
   * daemonNames): the daemon runs ONE host server per Walnut, so only that name manages it.
   */
  daemonKeeper?(): Promise<string>
  /** The daemon process this link reached (its hello instanceId): what it was sent before, it still holds. */
  readonly daemonInstanceId?: string | null
}

export interface HostServerSettings {
  enabled: boolean
  /** On because of the default (follower-default.ts): the person never set the switch. Such a host is gated (eligibility.ts). */
  byDefault?: boolean
  expose: {
    enabled: boolean; provider: string | null; options: Record<string, string>
    /** Why the host's own tunnel does not run although it is on (it would take this computer's address). */
    blocked?: string
  }
  /** This Walnut's tunnel (Open from a browser) runs here, instead of on this computer (expose/placement.ts). */
  carriesTunnel?: boolean
  /**
   * Whether this host carries this Walnut's tunnel is not known now (its provider is not
   * registered: a plugin still loading, or one that failed): the host is left as it was
   * last configured, so the tunnel it may carry keeps running.
   */
  keepAsConfigured?: string
  /** The host's choice (`hosts.<key>.server_program`): 'host-server' keeps the plain host server; else `web --replica` where the daemon can (D13). */
  program?: 'replica' | 'host-server'
  /**
   * Which kinds the Mac copies to this host's replica (`hosts.<key>.server.copies`,
   * the host's Settings row): sessions, requests, boards, inbox, inbox bodies.
   * Unset: replication/kinds/copy-kind.ts DEFAULT_COPY_CHOICE (every kind on).
   */
  copies?: Record<string, boolean>
  /** `hosts.<key>.server.ask_bypass`: a new ask on the host while the Mac is away may start in bypass (WP12). */
  askBypass?: boolean
}

export type HostServerPhase =
  | 'off' | 'waiting-for-host' | 'unsupported' | 'checking' | 'installing' | 'starting' | 'running' | 'error'
  /** On by default, but the host cannot run a follower well now: `gate` says why, `message` in words. */
  | 'not-eligible'

export interface HostServerView {
  hostKey: string
  enabled: boolean
  phase: HostServerPhase
  /** One sentence for the person: what is happening, or what went wrong. */
  message?: string
  since: number
  build?: string
  install?: InstallState
  /** The daemon's supervision of it. */
  daemon?: HostServerStatus
  /** What the server last reported through its daemon (its route, its daemon link, its tunnel). */
  server?: {
    route?: { kind: string; why?: string }
    expose?: ExposeStatus
    version?: string
    commit?: string | null
    daemon?: { state?: string; lastError?: string | null }
    /** The host's journal (its daemon's follower.status line), a replica's report only (WP14). */
    journal?: Record<string, unknown> | null
  } | null
  /**
   * The reported tunnel's `since` on this computer's clock (the host's clock may differ): its
   * age by the host's clock, counted back from before this computer asked, so never later than
   * it was. A tunnel handover reads it (expose/placement.ts hostHolds).
   */
  exposeSince?: number
  /**
   * The server's last report that came in, kept while it does not answer now (`server` is
   * null then): its version, commit and tunnel stay readable, with `lastReportAt` (this
   * computer's clock) saying how old they are. Nothing decides from it: `server` alone says it runs.
   */
  lastReport?: NonNullable<HostServerView['server']>
  lastReportAt?: number
  port?: number
  /**
   * Which program runs: what the daemon was told (the replica only where the host
   * opted in and its daemon can), or 'fallback' while the daemon runs the plain
   * host server after the replica crash-looped (`daemon.fallback` says since, until, why).
   */
  program?: 'replica' | 'host-server' | 'fallback'
  /** While it runs: why it runs an older build than this Mac's (that one did not answer; Retry tries it again). */
  notice?: string
  /** The host runs one only because of the default (the experiment), not by its person's switch or the tunnel. */
  byDefault?: true
  /** Phase `not-eligible`: the condition the host did not meet, when it was looked at, and when it is looked at again (none: at its next connect or Retry). */
  gate?: { reason: FollowerGateReason; checkedAt: number; recheckAt?: number }
  /** Phase `error`: when Walnut tries again by itself (none: it waits for Retry or the next connect). */
  retryAt?: number
  /** Phase `installing`, while the program goes up to the host: the bytes it holds so far. */
  upload?: { sent: number; total: number }
}

/** A program the host ran that reported, as configured (the settings are always the current ones). */
export interface WorkingProgram {
  id: string
  command: string
  args: string[]
  env: Record<string, string>
  fallback?: { args: string[]; env: Record<string, string> }
  cwd: string
  log: string
}

/** Per host, in the state file: its port, the program that last worked, a build that did not. */
export interface HostRecord {
  publicPort: number
  working?: WorkingProgram
  refused?: { id: string; message: string }
  /** When a newer build of this Mac was first held back from this host (update-hold.ts); gone once one goes out. */
  behindSince?: number
}

/** A host's copy target: `ready` when its server answers, `restarted` when another process answers than last time. */
export interface HostCopyTarget { unregister(): void; ready(restarted: boolean): void }

export interface ManagerDeps {
  settingsOf(hostKey: string): Promise<HostServerSettings | null>
  label(hostKey: string): Promise<string>
  walnutId(): Promise<string>
  home: string
  /** This Mac's tunnel port, held open: host servers' streams come in by it. */
  holdTunnelPort(holder: string): Promise<number>
  releaseTunnelPort(holder: string): Promise<void>
  /** This Mac's build as the walnut file for a host's target (host-file.ts). */
  hostFile: HostFileSource
  stateFile: string
  /**
   * Machine-local (never synced): the tunnel retry count each host was last given. The server
   * there restarts its tunnel when the count changes, so a count that started over at 0 after
   * a restart here would restart it. Unset: kept in memory only.
   */
  retryFile?: string
  now(): number
  /** Copies for the follower (core/replication/replica-targets.ts); `ready` once its server answers. */
  registerTarget?(
    hostKey: string,
    post: (body: Record<string, unknown>, opts?: { timeoutMs?: number }) => Promise<Response>,
    /** The host's choice of copied kinds, read at each round (its Settings row). */
    copies?: () => Promise<Record<string, boolean> | undefined>,
  ): HostCopyTarget
  /** A view changed (the settings page listens). */
  changed?(view: HostServerView): void
  /**
   * True while this server is stopping: a reconcile then changes nothing on a host. Its plugins
   * go first, and a tunnel provider gone with them must not take the tunnel off the host that
   * carries it; the host's daemon keeps that server running, and the next server sets it again.
   */
  frozen?(): boolean | Promise<boolean>
  pollMs?: number
  installPollMs?: number
  /** Waits before a setup runs again by itself, per kind (try-later.ts; tests shorten them). */
  tryLaterMs?: Partial<Record<TryLaterKind, readonly number[]>>
  /** The floors a host on by default must meet (eligibility.ts FOLLOWER_FLOORS). */
  floors?: FollowerFloors
  /**
   * The experiment `follower_on_every_host` (follower-default.ts): a failed start then tries again
   * by itself and Walnut Health hears of it. Off (or unset): a failed start waits for Retry, as before.
   */
  everyHost?(): boolean | Promise<boolean>
  /**
   * Walnut Health (health-item.ts), with the experiment on: a start that failed, and one that
   * settled (it runs, or none is meant to run). Never awaited.
   */
  health?: { failed(hostKey: string, message: string, retries: boolean): void; settled(hostKey: string): void }
  /** How long a started server has to send its first report. */
  firstReportMs?: number
  /** When this server began serving its build (default: when the manager was made). */
  servingSince?: number
  /** How long this build serves with no newer deploy before it goes to a host that works (WALNUT_HOST_SERVER_UPDATE_QUIET_MIN; 0: at once). */
  updateQuietMs?: number
  /** The longest a host that works runs an older build than this Mac's (WALNUT_HOST_SERVER_UPDATE_MAX_BEHIND_MIN). */
  updateMaxBehindMs?: number
  /** Why the host's program cannot take this Mac's copies (a kind rested as newer than it knows), or null. */
  copiesNeedNewer?(hostKey: string): Promise<string | null>
  /** The root on the host (WALNUT_HOST_SERVER_ROOT; default HOST_ROOT). */
  hostRoot?: string
  /**
   * Tests only (WALNUT_HOST_SERVER_APP_DIR): run `<appCommand> <appDir>/dist/cli.js`
   * on the host instead of installing the file. Meant for a "host" that is this
   * machine, so appCommand defaults to this process's own bun. A walnut file is
   * no default: it would run the dist build only told to be bun (BUN_BE_BUN=1),
   * which every child of that server (its daemon, each `claude`) would inherit.
   */
  appDir?: string
  appCommand?: string
}

/** How the host runs Walnut: `<command> ...prefix <subcommand>`; `asBun` when the command is the walnut file. */
export interface HostProgram { command: string; prefix: string[]; asBun: boolean }
