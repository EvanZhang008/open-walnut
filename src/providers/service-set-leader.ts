/**
 * The leader's side of service sets (service-set.ts; the experiment host_service_sets): which set
 * this Walnut's service is on each host, as the host's own CLI decided it, and what that means for
 * the link the leader holds there. Pure, plus one small store; daemon-connection.ts, the host
 * network updater and the boot-start keeper call it.
 *
 *   - With the experiment on, every `walnut daemon install|update|status|uninstall` line this leader
 *     runs on a host names its Walnut (`--walnut <walnutId> --walnut-home <data dir>`); the host's
 *     CLI picks the set and prints `service set: default|<id16>` (parseServiceSetLine). Off: no word,
 *     every line byte for byte as before (tests/providers/service-set-leader-lines.test.ts).
 *   - The set the host named is kept per place (`ssh:<host>`, `net:<host>`) on this machine's disk
 *     (hostServiceSets), next to the other per-host daemon facts (daemon-update-store.ts).
 *   - linkStanding: the link reaches this Walnut's own set ('own'), the default set this Walnut holds
 *     ('default'), or another Walnut's shared daemon while this Walnut has a set of its own there
 *     ('shared': the move is due, service-set-move.ts, and the leader never updates or revives it).
 *     'unknown': nothing known, today's behaviour.
 */
import path from 'node:path'
import { experimentalEnabled } from '../core/experimental.js'
import { KeyedUpdateStore } from './daemon-update-store.js'
import { isServiceSetId, parseServiceSetLine, serviceSetNames, SERVICE_SETS_SUBDIR } from './service-set.js'
import { daemonServiceConfigFiles } from './daemon-service-config.js'
// The same quoting as the serve words on that line (daemon-service-update.ts serveWords).
import { shq } from './daemon-net-update-io.js'

/** Does this leader give each host's service its own set where another Walnut holds the default? */
export async function hostServiceSetsWanted(): Promise<boolean> {
  const forced = process.env.WALNUT_HOST_SERVICE_SETS
  if (forced === '1' || forced === '0') return forced === '1'
  try {
    const { getConfig } = await import('../core/config-manager.js')
    return experimentalEnabled((await getConfig()).experimental, 'host_service_sets')
  } catch {
    return false
  }
}

/** Whose service a `walnut daemon` line is for: this Walnut's id and its data dir now (daemon-shared.ts walnutKeyOf). */
export interface SetAsk {
  walnutId: string
  home: string
}

const WALNUT_ID = /^[0-9a-f]{16}[0-9a-f]*$/

/**
 * The words a `walnut daemon` line carries for the set (daemon-service-cli.ts WALNUT_FLAG and
 * WALNUT_HOME_FLAG), with a leading space; '' with no ask (the experiment off). A walnut id that
 * names no set or a home that is not a plain absolute path gives '' too: the host then acts on the
 * default set, as before.
 */
export function serviceSetWords(ask: SetAsk | null | undefined): string {
  if (!ask || !WALNUT_ID.test(ask.walnutId) || ask.walnutId.length > 64) return ''
  if (!ask.home.startsWith('/') || ask.home.length > 1024 || /[\u0000-\u001f]/.test(ask.home)) return ''
  return ` --walnut ${ask.walnutId} --walnut-home ${shq(ask.home)}`
}

/** The ask for this server, or null with the experiment off (no words on any line). */
export async function serviceSetAskNow(walnutId: () => Promise<string>, home: string): Promise<SetAsk | null> {
  if (!(await hostServiceSetsWanted())) return null
  const id = await walnutId().catch(() => '')
  return id && WALNUT_ID.test(id) ? { walnutId: id, home } : null
}

/** What this leader knows of a host's set: the id the host named ('' the default) and, for a set, its runtime dir. */
export interface HostSetRecord {
  at: number
  set: string
  /** The set's runtime dir on the host (service-set.ts serviceSetRuntimeDir), where its daemon.port is. */
  runtimeDir?: string
}

const validHostSet = (e: unknown): e is HostSetRecord => {
  const r = e as HostSetRecord
  return !!r && typeof r === 'object' && Number.isFinite(r.at) && (r.set === '' || isServiceSetId(r.set))
    && (r.runtimeDir === undefined || (typeof r.runtimeDir === 'string' && r.runtimeDir.startsWith('/')))
}

/** A set is the host's until the host says otherwise: a year, renewed at every line that names it. */
export const hostServiceSets = new KeyedUpdateStore<HostSetRecord>('daemon-service-set.json', 'WALNUT_SERVICE_SET_FILE', 365 * 24 * 3600_000, validHostSet)

/**
 * Keep the set a `walnut daemon` output names for `place`; null when it names none (an older host:
 * nothing is kept and nothing changes). A runtime dir already known for the same set is kept.
 */
export async function recordServiceSetFrom(place: string, output: string, runtimeDir?: string): Promise<string | null> {
  const set = parseServiceSetLine(output)
  if (set === null) return null
  const before = await hostServiceSets.read(place).catch(() => null)
  const dir = set ? runtimeDir ?? (before?.set === set ? before.runtimeDir : undefined) : undefined
  await hostServiceSets.write(place, { at: Date.now(), set, ...(dir ? { runtimeDir: dir } : {}) })
  return set
}

/** The set a hello names: its `serviceSet` (a set's service), else '' (the default set, or an older host). */
export function helloServiceSet(hello: object): string {
  const v = (hello as { serviceSet?: unknown }).serviceSet
  return isServiceSetId(v) ? v : ''
}

export type LinkStanding = 'unknown' | 'default' | 'own' | 'shared'

/** Where the link stands for this Walnut's service on the host; 'unknown' with the experiment off or nothing kept. */
export function linkStanding(record: Pick<HostSetRecord, 'set'> | null | undefined, helloSet: string | null, wanted: boolean): LinkStanding {
  if (!wanted || !record) return 'unknown'
  if (record.set === '') return 'default'
  return helloSet === record.set ? 'own' : 'shared'
}

/**
 * The service config files a host's probe looks for, for the set `id` ('' the default), with the
 * home as the probe writes it (a literal '$HOME'): Linux user unit, system unit, cron boot script,
 * then the macOS LaunchAgent. The default's are exactly daemonServiceConfigFiles' (local-daemon.ts).
 */
export function setServiceConfigPaths(id: string, home = '$HOME'): { linux: string[]; darwin: string[] } {
  if (!id) return { linux: daemonServiceConfigFiles('linux', home), darwin: daemonServiceConfigFiles('darwin', home) }
  const names = serviceSetNames(id)
  const set = { ...names, installRoot: path.posix.join(home, SERVICE_SETS_SUBDIR, id, 'daemon') }
  return { linux: daemonServiceConfigFiles('linux', home, set), darwin: daemonServiceConfigFiles('darwin', home, set) }
}
