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
  /**
   * When this Walnut's sessions moved off another Walnut's shared daemon into this set. From then on
   * the host is this set's for this Walnut, whatever the experiment says now (review round 1, B7):
   * every line names the Walnut, SSH dials the set's runtime dir, and the record never expires (B7, should-fix 8).
   */
  movedAt?: number
  /**
   * Host network: the set's own walnut-net endpoint (its key inside the set), paired over the link to
   * the shared daemon (service-set-net-pair.ts), and where this leader's walnut-net finds it.
   */
  netEndpoint?: string
  netAddrs?: string[]
  /** The endpoint the link dialled before the move (the shared daemon's walnut-net): no member of this leader's once moved. */
  netShared?: string
  /** When this leader took itself off the shared walnut-net's member list (after the move). */
  netSharedLeftAt?: number
}

const NET_ID = /^[0-9a-f]{64}$/

const validHostSet = (e: unknown): e is HostSetRecord => {
  const r = e as HostSetRecord
  return !!r && typeof r === 'object' && Number.isFinite(r.at) && (r.set === '' || isServiceSetId(r.set))
    && (r.runtimeDir === undefined || (typeof r.runtimeDir === 'string' && r.runtimeDir.startsWith('/')))
    && (r.movedAt === undefined || Number.isFinite(r.movedAt))
    && (r.netEndpoint === undefined || NET_ID.test(r.netEndpoint)) && (r.netShared === undefined || NET_ID.test(r.netShared))
    && (r.netAddrs === undefined || (Array.isArray(r.netAddrs) && r.netAddrs.every((a) => typeof a === 'string')))
    && (r.netSharedLeftAt === undefined || Number.isFinite(r.netSharedLeftAt))
}

/** The pairing facts of a record (kept across every rewrite of the same set's record). */
function netFacts(r: HostSetRecord | null | undefined): Partial<HostSetRecord> {
  if (!r?.netEndpoint) return {}
  return {
    netEndpoint: r.netEndpoint, ...(r.netAddrs ? { netAddrs: r.netAddrs } : {}),
    ...(r.netShared ? { netShared: r.netShared } : {}), ...(r.netSharedLeftAt !== undefined ? { netSharedLeftAt: r.netSharedLeftAt } : {}),
  }
}

/** This Walnut's sessions moved into its own set there (the record's movedAt). */
export function movedToSet(r: HostSetRecord | null | undefined): r is HostSetRecord & { movedAt: number } {
  return !!r?.set && typeof r.movedAt === 'number'
}

/** A set is the host's until the host says otherwise: a year, renewed at every line that names it; a moved one for good. */
export const hostServiceSets = new KeyedUpdateStore<HostSetRecord>('daemon-service-set.json', 'WALNUT_SERVICE_SET_FILE', 365 * 24 * 3600_000, validHostSet, movedToSet)

/** The move into `set` on `place` is done: kept on the host's record for good. */
export async function markServiceSetMoved(place: string, set: string, now = Date.now()): Promise<void> {
  const before = await hostServiceSets.read(place).catch(() => null)
  if (before?.set !== set) return
  if (movedToSet(before) && now - before.at < 24 * 3600_000) return
  await hostServiceSets.write(place, { ...before, at: now, movedAt: before.movedAt ?? now })
}

/**
 * The host's set is not what answers there any more (review round 2, M6: the set was uninstalled by
 * hand or the box rebuilt, and a daemon naming no set answers at the set's dir): the move is undone
 * on this leader, so the link takes today's dir choice again and a later look installs and moves anew.
 */
export async function clearServiceSetMoved(place: string): Promise<void> {
  const before = await hostServiceSets.read(place).catch(() => null)
  if (!movedToSet(before)) return
  const { movedAt: _m, ...rest } = before
  await hostServiceSets.write(place, { ...rest, at: Date.now() })
}

/**
 * Keep the set a `walnut daemon` output names for `place`; null when it names none (an older host:
 * nothing is kept and nothing changes). A runtime dir already known for the same set is kept.
 */
export async function recordServiceSetFrom(place: string, output: string, runtimeDir?: string): Promise<string | null> {
  const set = parseServiceSetLine(output)
  if (set === null) return null
  const before = await hostServiceSets.read(place).catch(() => null)
  const dir = set ? runtimeDir ?? (before?.set === set ? before.runtimeDir : undefined) : undefined
  const movedAt = set && before?.set === set ? before.movedAt : undefined
  await hostServiceSets.write(place, {
    at: Date.now(), set, ...(dir ? { runtimeDir: dir } : {}), ...(movedAt !== undefined ? { movedAt } : {}),
    ...(set && before?.set === set ? netFacts(before) : {}),
  })
  return set
}

/** The set's walnut-net is paired: its endpoint (and addresses) kept on the host's record, beside the one dialled so far. */
export async function markServiceSetNetPaired(place: string, set: string, p: { endpoint: string; addrs: string[]; shared: string | null }, now = Date.now()): Promise<boolean> {
  const before = await hostServiceSets.read(place).catch(() => null)
  if (before?.set !== set || !NET_ID.test(p.endpoint)) return false
  // A record that moved already keeps the endpoint it dialled before (the shared one is never the set's own).
  const shared = before.netShared ?? (p.shared && p.shared !== p.endpoint ? p.shared : undefined)
  await hostServiceSets.write(place, {
    ...before, at: now, netEndpoint: p.endpoint, netAddrs: p.addrs.slice(0, 16),
    ...(shared ? { netShared: shared } : {}), ...(before.netEndpoint === p.endpoint ? {} : { netSharedLeftAt: undefined }),
  })
  return true
}

/** This leader is off the shared walnut-net's member list (after the move). */
export async function markServiceSetNetLeft(place: string, set: string, now = Date.now()): Promise<void> {
  const before = await hostServiceSets.read(place).catch(() => null)
  if (before?.set !== set) return
  await hostServiceSets.write(place, { ...before, at: now, netSharedLeftAt: now })
}

/**
 * Pairing did not go through after its record was written (the companion refused the endpoint): the
 * record gets back the pairing facts it had before, if it still names `endpoint` (nothing wrote since).
 */
export async function unmarkServiceSetNetPaired(place: string, endpoint: string, before: HostSetRecord | null): Promise<void> {
  const now = await hostServiceSets.read(place).catch(() => null)
  if (!now || now.netEndpoint !== endpoint) return
  const { netEndpoint: _e, netAddrs: _a, netShared: _s, netSharedLeftAt: _l, ...rest } = now
  await hostServiceSets.write(place, { ...rest, ...(before?.set === now.set ? netFacts(before) : {}) })
}

/** The member name of a host's set endpoint (a companion takes a plain alias only: net-store.ts NAME_RE). */
export function setNetMemberName(place: string): string {
  const host = place.replace(/^[a-z]+:/, '').replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^[^A-Za-z0-9]+/, '').slice(0, 58)
  return `${host || 'host'}-set`
}

export interface SetNetMembers {
  /** Each paired set's endpoint, dialled (never let in), with the addresses its pairing answered (and, in a sync, where it was last seen). */
  add: Array<{ id: string; name: string; accept: false; addrs?: string[]; relays?: string[] }>
  /** Once a host moved, the shared endpoint this leader no longer dials. */
  drop: Set<string>
  /** Paired sets of hosts this leader no longer has (a Remove whose companion DELETE did not go through): to forget. */
  gone: Array<{ place: string; id: string }>
}

/**
 * What this leader's own walnut-net lists for the service sets it paired with (core/net/net-mac.ts).
 * `present` says which hosts this leader still has (all, when not given). Throws when the records
 * cannot be read: an empty answer would let a sync take each set endpoint for a machine.
 */
export async function serviceSetNetMembers(present: (host: string) => boolean = () => true): Promise<SetNetMembers> {
  const out: SetNetMembers = { add: [], drop: new Set<string>(), gone: [] }
  for (const [place, r] of await hostServiceSets.list({ strict: true })) {
    if (!place.startsWith('net:') || !r.set || !r.netEndpoint) continue
    if (!present(place.slice('net:'.length))) { out.gone.push({ place, id: r.netEndpoint }); continue }
    out.add.push({ id: r.netEndpoint, name: setNetMemberName(place), accept: false, ...(r.netAddrs?.length ? { addrs: r.netAddrs } : {}) })
    if (movedToSet(r) && r.netShared) out.drop.add(r.netShared)
  }
  // A set endpoint of one host is never dropped as another's shared one.
  for (const a of out.add) out.drop.delete(a.id)
  return out
}

/** The set a hello names: its `serviceSet` (a set's service), else '' (the default set, or an older host). */
export function helloServiceSet(hello: object): string {
  const v = (hello as { serviceSet?: unknown }).serviceSet
  return isServiceSetId(v) ? v : ''
}

export type LinkStanding = 'unknown' | 'default' | 'own' | 'shared'

/**
 * Does a daemon update's line name the Walnut (`--walnut …`, the host's CLI picks the set)? Its tail,
 * snapshot, probation and marker watch `set`, the set the link reaches ('' the default). With the set
 * still unknown after the first look (an older host, or a look that failed) on the default's daemon,
 * the words could make the CLI update this Walnut's own set while all of those watch the default
 * (review round 2, H2): the line is today's then, so the line and its watchers name the same set.
 * The next look finds the set, and the update after it names the Walnut. Both paths use it (SSH:
 * daemon-connection.ts updateManagedDaemon, through ServiceSetLink.wordsDue).
 */
export function setWordsDue(ask: SetAsk | null | undefined, standing: LinkStanding, set: string): boolean {
  return !!ask && !(standing === 'unknown' && !set)
}

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
