/**
 * Every way DaemonConnection reaches a host's daemon, and how that daemon gets
 * this server's build after a deploy. A kind with no update path silently keeps an
 * old daemon forever: 2026-11-03, a Mac that joined over the host network kept a
 * daemon 8 hours older than the server, because every update path ran over SSH and
 * that kind has none, while a comment said it "updates itself" (nothing did).
 *
 * DaemonConnection decides its transport only through `daemonLinkKind`, and each
 * kind here names its update path (the file and the symbol that do it) or an
 * exemption with its reason. tests/providers/daemon-update-paths-ratchet.test.ts
 * fails when a kind (or a new `SshTarget.via`) has neither.
 */
import type { SshTarget } from './session-io.js'

export const DAEMON_LINK_KINDS = ['local', 'ssh', 'net', 'cloud-tunnel', 'direct-url'] as const
export type DaemonLinkKind = typeof DAEMON_LINK_KINDS[number]

export interface DaemonLinkFacts {
  hostKey: string
  via?: SshTarget['via']
  /** The connection was dialled straight to a daemon URL (connectDirect). */
  dialledDirect: boolean
}

/** The one classifier: which kind of link this is. */
export function daemonLinkKind(c: DaemonLinkFacts, cloudBoxAlias: string): DaemonLinkKind {
  if (c.hostKey === '__local__') return 'local'
  if (c.hostKey === cloudBoxAlias) return 'cloud-tunnel'
  switch (c.via) {
    case undefined: break
    case 'net': return 'net'
    default: {
      // A new `via` fails to compile here until it is named (and so given a row below).
      // At run time an unknown value keeps the old reading (ssh), as before this table.
      const unknown: never = c.via
      void unknown
    }
  }
  return c.dialledDirect ? 'direct-url' : 'ssh'
}

export type DaemonUpdatePath =
  | { path: string; code: Array<{ file: string; symbol: string }> }
  | { exempt: string; code?: Array<{ file: string; symbol: string }> }

export const DAEMON_UPDATE_PATHS: Record<DaemonLinkKind, DaemonUpdatePath> = {
  local: {
    path: 'LocalDaemon.ensureRunning compares the running daemon with this build and replaces it: a managed one through walnut daemon update, '
      + 'run detached with the tail after it; an unmanaged one only after the new build served in a trial run, the old one kept to go back to',
    code: [
      { file: 'src/providers/local-daemon.ts', symbol: 'updateManagedDaemon' },
      { file: 'src/providers/local-daemon-service.ts', symbol: 'updateLocalService' },
      { file: 'src/providers/local-daemon.ts', symbol: 'refuseReplacement' },
    ],
  },
  ssh: {
    path: 'every connect reads daemon.version over SSH and service-updates a daemon of another build (detached on the host), '
      + 'or stages the new build, tries it in a throwaway dir, and only then stops the old one, whose files are kept to go back to (rechecked while postponed)',
    code: [
      { file: 'src/providers/daemon-connection.ts', symbol: 'shouldUpgradeDaemon' },
      { file: 'src/providers/daemon-connection.ts', symbol: 'updateManagedDaemon' },
      { file: 'src/providers/daemon-connection.ts', symbol: 'trialStaged' },
    ],
  },
  net: {
    path: 'a connect to a daemon of another build uploads this build over the daemon link itself (fs.writePart, exec.run) and runs walnut daemon update there, detached; '
      + 'on a Mac whose launchd starts no jobs now (a dark wake) the update is deferred before anything stops, and asked again after the cooldown',
    code: [
      { file: 'src/providers/daemon-service-launchd.ts', symbol: 'launchdSpawnsJobs' },
      { file: 'src/providers/daemon-net-update.ts', symbol: 'NetDaemonUpdater' },
      { file: 'src/providers/daemon-net-update-io.ts', symbol: 'createNetUpdateIo' },
      { file: 'src/providers/daemon-connection.ts', symbol: 'NetDaemonUpdater' },
    ],
  },
  'cloud-tunnel': {
    exempt: 'the cloud companion starts this daemon from its own build and replaces it on every new companion build '
      + '(LocalDaemon version check in cloud-tunnel-daemon.ts); this Mac runs a different build, and replacing it from here would fight the companion',
    code: [{ file: 'src/providers/cloud-tunnel-daemon.ts', symbol: 'LocalDaemon' }],
  },
  'direct-url': {
    exempt: 'only tests dial a remote daemon straight by its URL (a MockDaemon or a twin they started); nothing deploys it, and the test owns its build',
  },
}

/** WALNUT_NET_DAEMON_UPDATE=0 (or false/off/no): the automatic update of host network daemons is off. */
export function netDaemonUpdateTurnedOff(env: Record<string, string | undefined> = process.env): boolean {
  return ['0', 'false', 'off', 'no'].includes((env.WALNUT_NET_DAEMON_UPDATE ?? '').trim().toLowerCase())
}

/**
 * How the daemon on `name` (reached as `kind`) gets a newer build, in one sentence the user
 * can act on (no final period). The ONE wording every surface says after "needs an update":
 * DaemonConnection's refusals, the host status frame (`daemonUpdateHow`, shown by the web
 * console's fix line) and host_daemon_update's answer. A host network machine whose config
 * says `autofix: false` is updated only on request (daemon-net-update.ts), hence "unless".
 */
export function daemonUpdateHowSentence(
  kind: DaemonLinkKind, name: string,
  opts: { env?: Record<string, string | undefined> } = {},
): string {
  switch (kind) {
    case 'local': return 'Walnut updates this machine\'s daemon itself when it starts: restart Walnut to update it'
    case 'cloud-tunnel': return 'Deploying the cloud companion updates the daemon there (it starts that daemon from its own build)'
    case 'net': {
      const ask = `use "Update the daemon" in Settings › Hosts`
      if (netDaemonUpdateTurnedOff(opts.env)) return `The automatic daemon update for host network machines is turned off on this Mac (WALNUT_NET_DAEMON_UPDATE=0): ${ask}`
      return `Walnut updates the daemon on ${name} by itself after a deploy (unless its automatic fixes are off), or ${ask} to do it now`
    }
    case 'direct-url': return 'This is a test daemon reached by its URL: the test that started it owns its build'
    case 'ssh': return `Walnut updates the daemon on ${name} by itself the next time it connects there over SSH`
  }
}
