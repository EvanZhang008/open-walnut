/**
 * A host network machine whose walnut-net is another Walnut's (the experiment host_service_sets;
 * review round 2, drill N2): its daemon is shared with another Walnut, which runs the machine's
 * default service and so its walnut-net. The connect push (net-mac.ts pushToHost, `net.configure`)
 * REPLACES that walnut-net's whole member list, which dropped the other Walnut's members. Its daemon's
 * `net.status` says nothing of the list there, so it cannot be merged: this leader got on it by
 * joining, and pushes nothing there. This Walnut's own set's daemon (the link after a move) runs this
 * Walnut's own walnut-net and still gets its list. Flag off: nothing changes.
 *
 * Review round 3, S4: the host's CLI gave this Walnut the DEFAULT set (record set ''): the default
 * service and its walnut-net are this Walnut's own, whoever else was seen on its daemon. With no record
 * yet, another Walnut seen there within SERVED_LATELY_MS (about a later Walnut's pairing time) counts;
 * a longer window cut a single owner's pushes for days. A relay move always pushes (the caller says so):
 * a machine left on the old relay is cut off.
 */
import { WALNUT_HOME } from '../../constants.js'

/** What this reads of the link (DaemonConnection). */
export interface SharedHostLink {
  /** The service set the hello names ('' the default's daemon, or an older host). */
  readonly serviceSet?: string
  /** The running daemon's record of the Walnuts it served lately (daemon-shared.ts), or null. */
  readonly daemonServes?: { walnuts: Record<string, number> } | null
}

/** Another Walnut seen on the default's daemon this recently, with no set record yet: its walnut-net is that Walnut's. */
export const SERVED_LATELY_MS = 30 * 60_000

/** Flag on, and the daemon `conn` reaches on host `name` runs another Walnut's walnut-net. */
export async function walnutNetOfAnother(name: string, conn: SharedHostLink, opts: { now?: number; relayMoved?: boolean } = {}): Promise<boolean> {
  const now = opts.now ?? Date.now()
  const [{ hostServiceSets, hostServiceSetsWanted }, { walnutKeyOf }] = await Promise.all([
    import('../../providers/service-set-leader.js'), import('../../providers/daemon-shared.js'),
  ])
  if (!(await hostServiceSetsWanted())) return false
  const record = await hostServiceSets.read(`net:${name}`).catch(() => null)
  const hello = conn.serviceSet ?? ''
  // A set's daemon: this Walnut's own when the record names it, else another Walnut's.
  if (hello) return hello !== record?.set
  // The default's daemon: another Walnut holds it when this Walnut has a set of its own there, and
  // this Walnut does when the host gave it the default set.
  if (record) return record.set !== ''
  // No record yet: its record of served Walnuts names another just now, unless the relay moved.
  if (opts.relayMoved) return false
  const ours = walnutKeyOf(WALNUT_HOME)
  return Object.entries(conn.daemonServes?.walnuts ?? {}).some(([k, at]) => k !== ours && now - at < SERVED_LATELY_MS)
}
