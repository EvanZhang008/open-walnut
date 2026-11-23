/**
 * A host network machine whose walnut-net is another Walnut's (the experiment host_service_sets;
 * review round 2, drill N2): its daemon is shared with another Walnut, which runs the machine's
 * default service and so its walnut-net. The connect push (net-mac.ts pushToHost, `net.configure`)
 * REPLACES that walnut-net's whole member list, which dropped the other Walnut's members. Its daemon's
 * `net.status` says nothing of the list there, so it cannot be merged: this leader got on it by
 * joining, and pushes nothing there. This Walnut's own set's daemon (the link after a move) runs this
 * Walnut's own walnut-net and still gets its list. Flag off: nothing changes.
 */
import { WALNUT_HOME } from '../../constants.js'

/** What this reads of the link (DaemonConnection). */
export interface SharedHostLink {
  /** The service set the hello names ('' the default's daemon, or an older host). */
  readonly serviceSet?: string
  /** The running daemon's record of the Walnuts it served lately (daemon-shared.ts), or null. */
  readonly daemonServes?: { walnuts: Record<string, number> } | null
}

/** Flag on, and the daemon `conn` reaches on host `name` runs another Walnut's walnut-net. */
export async function walnutNetOfAnother(name: string, conn: SharedHostLink, now = Date.now()): Promise<boolean> {
  const [{ hostServiceSets, hostServiceSetsWanted }, { SHARED_WINDOW_MS, walnutKeyOf }] = await Promise.all([
    import('../../providers/service-set-leader.js'), import('../../providers/daemon-shared.js'),
  ])
  if (!(await hostServiceSetsWanted())) return false
  const record = await hostServiceSets.read(`net:${name}`).catch(() => null)
  const hello = conn.serviceSet ?? ''
  // A set's daemon: this Walnut's own when the record names it, else another Walnut's.
  if (hello) return hello !== record?.set
  // The default's daemon: another Walnut holds it when this Walnut has a set of its own there.
  if (record?.set) return true
  // Or its record of served Walnuts names another lately (the rule daemon-shared.ts keeps a shared daemon by).
  const ours = walnutKeyOf(WALNUT_HOME)
  return Object.entries(conn.daemonServes?.walnuts ?? {}).some(([k, at]) => k !== ours && now - at < SHARED_WINDOW_MS)
}
