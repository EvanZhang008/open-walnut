/**
 * A host that leaves this leader for good (Settings > Remove of an SSH host or of a host network
 * machine) takes this Walnut's own service set there with it (providers/service-set-provision.ts
 * leaveServiceSet; the experiment host_service_sets): while the link still reaches the host, the set
 * is removed there, bounded so a Remove never waits long; then, whatever the host answered, the set's
 * walnut-net endpoint leaves the cloud companion's member list (and so its relay) and the host's set
 * record goes here, so this leader's walnut-net stops dialling it. A companion that keeps the
 * endpoint keeps the record too, and the next host network sync finishes it (core/net/net-service-sets.ts).
 *
 * A Turn off is no leave: the host comes back with its set as it was.
 */
import { log } from '../../logging/index.js'

export interface HostSetLeave {
  /** The host had a set of this Walnut's own (then its default service, and walnut-net, are another Walnut's). */
  own: boolean
  ok: boolean
  why: string
}

const PLACES = ['net', 'ssh'] as const

/** One leave per host at a time: Remove and the config change it causes both ask for it. */
const leaving = new Map<string, Promise<HostSetLeave>>()

export function leaveHostServiceSet(host: string, boundMs: number): Promise<HostSetLeave> {
  let run = leaving.get(host)
  if (!run) {
    run = leaveOnce(host, boundMs).finally(() => leaving.delete(host))
    leaving.set(host, run)
  }
  return run
}

async function leaveOnce(host: string, boundMs: number): Promise<HostSetLeave> {
  try {
    const [{ hostServiceSets }, { isServiceSetId }, { forgetSetNet }, { peekDaemonConnection }, net] = await Promise.all([
      import('../../providers/service-set-leader.js'), import('../../providers/service-set.js'),
      import('../../providers/service-set-net-pair.js'), import('../../providers/daemon-connection.js'), import('../net/net-service-sets.js'),
    ])
    const records = await Promise.all(PLACES.map((k) => hostServiceSets.read(`${k}:${host}`).catch(() => null)))
    if (!records.some(Boolean)) return { own: false, ok: true, why: 'no service set kept for this host' }
    const own = records.some((r) => !!r && isServiceSetId(r.set))
    // The link's own place: its set removed there, then forgotten (service-set-move-link.ts leave).
    const left = await peekDaemonConnection(host)?.leaveServiceSet?.(boundMs) ?? null
    // Every place's record, the link's own included when the link could not (none, or another kind now).
    for (const k of PLACES) {
      await forgetSetNet({ place: `${k}:${host}`, unregister: net.unregisterSetEndpoint, apply: net.applyServiceSetMembers }).catch((err: unknown) => {
        log.session.warn('host left Settings: the cloud companion still lists its service set endpoint; the next sync tries again', { host, error: err instanceof Error ? err.message : String(err) })
      })
    }
    return { own, ok: left?.ok ?? false, why: left?.why ?? 'the host is not reached now: this Walnut\'s own service stays there' }
  } catch (err) {
    log.session.warn('host left Settings: its service set could not be left', { host, error: err instanceof Error ? err.message : String(err) })
    return { own: false, ok: false, why: err instanceof Error ? err.message : String(err) }
  }
}
