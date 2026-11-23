/**
 * A host that left Settings (turned off, removed, or a found host put back to waiting for the
 * person's yes) ends Walnut's link to it now (2026-11-10 review: after Turn off or Remove the
 * pooled connection and its SSH master stayed up, so Turn on and Connect came back without a
 * real sign-in while the row said "Walnut does not connect to it").
 *
 * What ends: the pooled daemon connection (its tunnel, its stream lane, and its ControlMaster,
 * which `disconnect()` sends `-O exit`), and the master the host's terminals multiplex through.
 * Both sockets are Walnut's own (their paths are made by Walnut and verified as this user's
 * socket); a master the person's own ~/.ssh/config runs is never touched. The next Connect
 * signs in again.
 *
 * What stays: the session daemon on the host and the sessions it runs. Walnut does not reach
 * into a host it was just told to stop connecting to, and those sessions are the person's work;
 * they end on the host's own idle timer, or keep their history for the next connect. The words
 * on the row say so (RemoteHostSshRow.tsx).
 *
 * A host REMOVED (not turned off) takes this Walnut's own service set there with it first, while the
 * link still reaches it, bounded (host-set-leave.ts): the set's service is removed from the host and
 * its pairing is forgotten here and on the cloud companion. Its other sessions stay as above.
 *
 * The cloud companion's row comes and goes with the pairing and the companion's answer, never
 * with a person's Turn off, so it is not ended here.
 */
import { log } from '../../logging/index.js'
import { CLOUD_BOX_HOST_ALIAS } from './cloud-box-host.js'

export interface HostLinkEndDeps {
  /** Drop the pooled connection (daemon-connection.ts dropDaemonConnection). True when one was pooled. */
  dropConnection: (host: string) => boolean
  /** End the host's terminal master. True when one was running. */
  endTerminalMaster: (host: string) => Promise<boolean>
  /** A removed host's own service set leaves first (host-set-leave.ts). */
  leaveServiceSet: (host: string, boundMs: number) => Promise<unknown>
}

/** How long a removed host's own service set gets to leave before its link ends anyway. */
export const SET_LEAVE_BOUND_MS = 90_000

/** The hosts in `before` that `after` no longer shows (removed or turned off). */
export function hostsThatLeft(before: ReadonlySet<string>, after: ReadonlySet<string>): string[] {
  return [...before].filter((h) => !after.has(h))
}

/**
 * Did `host` leave Settings for good (its row gone from config.yaml itself), not turned off? The merged
 * rows alone cannot say: a host that is also in ~/.ssh/config comes back from the merge as a found host
 * that is off, so a Remove read as a Turn off and its service set never left (drill round 3, R3-4). A
 * config.yaml that cannot be read decides nothing: not removed.
 */
export async function removedFromSettings(
  host: string,
  merged: Readonly<Record<string, unknown>>,
  stored: () => Promise<{ hosts?: Record<string, unknown> } | null> = async () => (await import('../config-manager.js')).readStoredConfig(),
): Promise<boolean> {
  if (!Object.hasOwn(merged, host)) return true
  const doc = await stored().catch(() => null)
  return !!doc && !Object.hasOwn(doc.hosts ?? {}, host)
}

/** Is `host` one whose link a Turn off or Remove ends here? */
export function endsLinkWhenLeft(host: string): boolean {
  return !!host && host !== '__local__' && host !== CLOUD_BOX_HOST_ALIAS && !host.startsWith('direct:')
}

/**
 * End Walnut's own link to a host that left Settings. `removed`: for good, not turned off; or `rows`, the
 * merged host rows after the change, to judge it from (removedFromSettings). Never throws.
 */
export async function endHostLink(host: string, deps?: Partial<HostLinkEndDeps>, o: { removed?: boolean; rows?: Readonly<Record<string, unknown>> } = {}): Promise<{ connection: boolean; terminal: boolean }> {
  if (!endsLinkWhenLeft(host)) return { connection: false, terminal: false }
  const d = { ...(await defaultDeps()), ...deps }
  const removed = o.removed ?? (o.rows ? await removedFromSettings(host, o.rows).catch(() => false) : false)
  if (removed) {
    try { await d.leaveServiceSet(host, SET_LEAVE_BOUND_MS) } catch (err) {
      log.session.warn('host left Settings: its own service set could not be left', { host, error: (err as Error).message })
    }
  }
  let connection = false
  let terminal = false
  try { connection = d.dropConnection(host) } catch (err) {
    log.session.warn('host left Settings: could not drop its connection', { host, error: (err as Error).message })
  }
  try { terminal = await d.endTerminalMaster(host) } catch (err) {
    log.session.warn('host left Settings: could not end its terminal master', { host, error: (err as Error).message })
  }
  log.session.info('host left Settings: Walnut ended its link', { host, connection, terminal })
  return { connection, terminal }
}

async function defaultDeps(): Promise<HostLinkEndDeps> {
  const [{ dropDaemonConnection }, { terminalControlSocket }, { exitOwnedControlMaster }, { leaveHostServiceSet }] = await Promise.all([
    import('../../providers/daemon-connection.js'),
    import('../../web/terminal/spawn.js'),
    import('../../providers/ssh-control-master.js'),
    import('./host-set-leave.js'),
  ])
  return {
    dropConnection: dropDaemonConnection,
    endTerminalMaster: (host) => exitOwnedControlMaster(terminalControlSocket(host), host),
    leaveServiceSet: leaveHostServiceSet,
  }
}
