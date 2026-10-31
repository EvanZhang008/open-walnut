/**
 * The fleet view: every host Walnut runs work on, one card each, for the
 * Settings page and for agents (`host_list`, `host_get`). It gathers what the
 * server already holds (the connection, the host's profile, its Walnut server,
 * the spend by host) and asks each CONNECTED host's daemon one `host.vitals`
 * (host-vitals-core.ts), which reads the host and folds the minute ledger it
 * keeps itself. Nothing here dials a host: a host that is down reads as down.
 *
 * Every daemon call has a deadline (VITALS_DEADLINE_MS); past it the card keeps
 * the last answer marked stale, so one slow host never holds the page. Answers
 * are reused for VITALS_TTL_MS, so a polling page and an agent asking at once
 * cost one call. The spend is read from the per-day usage sums, refreshed in
 * the background every SPEND_TTL_MS. The placement fields are session
 * placement's own view (placement.ts hostLoads, held to PLACEMENT_DEADLINE_MS),
 * so the card shows the room the next start is judged by, never a second score.
 */
import { CLOUD_MODE } from '../../constants.js'
import { getConfig } from '../config-manager.js'
import { log } from '../../logging/index.js'
import type { Config } from '../types.js'
import type { HostVitals } from '../../providers/host-vitals-core.js'
import { hostStatusFrame } from './host-connect-action.js'
import { listStatusHosts, type HostDef } from './host-status.js'
import { probeIsStale, readHostProfile, recordProbedFacts, type HostProfile } from './host-profile.js'
import { buildFleetHost, withPlacement, type FleetConnectionKind, type FleetHost, type FleetInputs } from './fleet-model.js'
import type { HostLoadView } from './placement.js'

export type { FleetHost } from './fleet-model.js'

export const LOCAL_HOST = '__local__'
export const VITALS_CAPABILITY = 'host-vitals-v1'
const VITALS_DEADLINE_MS = 3_000
const VITALS_TTL_MS = 15_000
const VITALS_CACHE_MAX = 32
const SPEND_TTL_MS = 5 * 60_000
const SPEND_FIRST_WAIT_MS = 1_500
const SPEND_DAYS = 30
/** placement.ts asks each host for 4 s; a little more covers its session count. */
const PLACEMENT_DEADLINE_MS = 4_500

type LoadsFn = (hosts: string[]) => Promise<HostLoadView[]>
let loadsOverride: LoadsFn | null = null
/** Test seam: placement's view of each host. */
export function __setFleetLoadsForTesting(fn: LoadsFn | null): void { loadsOverride = fn }

/** Placement's view of these hosts by name; an empty map when it does not answer in time. */
async function placementViews(hosts: string[]): Promise<Map<string, NonNullable<FleetInputs['load']>>> {
  const out = new Map<string, NonNullable<FleetInputs['load']>>()
  if (!hosts.length) return out
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    const ask = loadsOverride ?? (async (h: string[]) => (await import('./placement.js')).hostLoads({ hosts: h }))
    const views = await Promise.race([
      ask(hosts),
      new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('placement did not answer in time')), PLACEMENT_DEADLINE_MS); timer.unref?.() }),
    ])
    for (const v of views) out.set(v.host, { known: v.known, score: v.score, busy: v.busy, reasons: v.reasons, weight: v.weight })
  } catch (err) {
    log.web.debug('fleet: placement view unavailable', { error: err instanceof Error ? err.message : String(err) })
  } finally {
    if (timer) clearTimeout(timer)
  }
  return out
}

interface VitalsConn {
  connected: boolean
  hasCapability(cap: string): boolean
  send(cmd: string, params: Record<string, unknown>, timeoutMs?: number): Promise<Record<string, unknown>>
  readonly roundTripMs: number
  readonly daemonVersion: string | null
  readonly daemonStartedAt: number | null
  readonly daemonStartup: string
  readonly daemonInstanceId: string | null
  readonly remoteRuntime?: string | null
}

async function defaultConnections(): Promise<Map<string, VitalsConn[]>> {
  const dc = await import('../../providers/daemon-connection.js')
  return dc.listConnectedDaemonsByHost() as unknown as Map<string, VitalsConn[]>
}

let spendCache: { at: number; byHost: Map<string, number> | null; from: string } | null = null
let spendRun: Promise<void> | null = null

let connectionsOverride: (() => Map<string, VitalsConn[]>) | null = null
/** Test-only: swap how hosts become daemon connections (and start every cache empty). */
export function __setFleetConnectionsForTesting(next: (() => Map<string, VitalsConn[]>) | null): void {
  connectionsOverride = next
  spendCache = null
  vitalsCache.clear()
  inflight.clear()
  probedInstances.clear()
}

const vitalsCache = new Map<string, { value: HostVitals; at: number }>()
const inflight = new Map<string, { p: Promise<HostVitals | null>; at: number }>()

function vitalsKey(host: string, days: number, bucketMinutes: number | undefined): string {
  return `${host}\u0000${days}\u0000${bucketMinutes ?? ''}`
}

function within<T>(p: Promise<T>, ms: number, fallback: T): Promise<T> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(fallback), ms)
    p.then((v) => { clearTimeout(timer); resolve(v) }, () => { clearTimeout(timer); resolve(fallback) })
  })
}

/** One host.vitals, at most one in flight per host and window. */
function askVitals(host: string, conn: VitalsConn, days: number, bucketMinutes?: number): Promise<HostVitals | null> {
  const key = vitalsKey(host, days, bucketMinutes)
  const running = inflight.get(key)
  if (running) return running.p
  const p = conn.send('host.vitals', { days, ...(bucketMinutes ? { bucketMinutes } : {}) }, 10_000)
    .then((res) => {
      if (res.ok === false || !res.stats || !res.history) return null
      const value = res as unknown as HostVitals
      vitalsCache.delete(key)
      vitalsCache.set(key, { value, at: Date.now() })
      // Bounded: an agent walking windows and bucket sizes, or hosts since removed, evict the oldest.
      while (vitalsCache.size > VITALS_CACHE_MAX) vitalsCache.delete(vitalsCache.keys().next().value as string)
      return value
    })
    .catch((err) => { log.web.debug('fleet: host.vitals failed', { host, error: String(err) }); return null })
    .finally(() => { inflight.delete(key) })
  inflight.set(key, { p, at: Date.now() })
  return p
}

async function vitalsFor(host: string, conn: VitalsConn | undefined, days: number, now: number, bucketMinutes?: number): Promise<{ value: HostVitals; at: number; stale: boolean } | null> {
  const cached = vitalsCache.get(vitalsKey(host, days, bucketMinutes))
  if (!conn?.connected || !conn.hasCapability(VITALS_CAPABILITY)) return cached ? { ...cached, stale: true } : null
  if (cached && now - cached.at < VITALS_TTL_MS) return { ...cached, stale: false }
  // An ask that already outlived its deadline is not waited for again: the page
  // answers at once with what it knew, and the ask may still land for the next read.
  const pending = inflight.get(vitalsKey(host, days, bucketMinutes))
  if (pending && now - pending.at >= VITALS_DEADLINE_MS) return cached ? { ...cached, stale: true } : null
  const fresh = await within(askVitals(host, conn, days, bucketMinutes), VITALS_DEADLINE_MS, null)
  if (fresh) return { value: fresh, at: vitalsCache.get(vitalsKey(host, days, bucketMinutes))?.at ?? now, stale: false }
  return cached ? { ...cached, stale: true } : null
}

// One probe per daemon instance a day when the profile has none or an old one: the
// card then names the system without anyone opening a transfer first, and a probe
// that failed is tried again the next day.
const probedInstances = new Set<string>()
function probeInBackground(host: string, conn: VitalsConn | undefined, profile: HostProfile | null): void {
  if (!conn?.connected || !conn.hasCapability('host-facts-v1')) return
  if (profile && !probeIsStale(profile)) return
  const key = `${host}\u0000${conn.daemonInstanceId ?? ''}\u0000${new Date().toISOString().slice(0, 10)}`
  if (probedInstances.has(key)) return
  probedInstances.add(key)
  void conn.send('host.facts', {}, 20_000)
    .then((res) => {
      if (res.ok === false || !res.os) return
      const { ok: _ok, ...facts } = res
      return recordProbedFacts(host, facts as never)
    })
    .catch((err) => log.web.debug('fleet: host.facts failed', { host, error: String(err) }))
}


function refreshSpend(): Promise<void> {
  if (spendRun) return spendRun
  spendRun = (async () => {
    const [{ buildCostReport }, { responseUsageStore }] = await Promise.all([
      import('../usage/cost-report.js'), import('../usage/collection.js'),
    ])
    const store = responseUsageStore()
    const from = new Date(Date.now() - (SPEND_DAYS - 1) * 86_400_000).toLocaleDateString('en-CA', { timeZone: store.timezone })
    const report = await buildCostReport('agents', { start: from }, {
      rollup: store.rollup, db: store.database, timeZone: store.timezone, overrides: (await getConfig()).usage?.prices,
      // Only the host group is read: no task or session titles are needed.
      tasks: async () => new Map(), sessions: async () => new Map(),
    })
    const byHost = new Map<string, number>()
    for (const line of report.groups?.find((g) => g.id === 'host')?.lines ?? []) byHost.set(line.key, line.costUsd)
    spendCache = { at: Date.now(), byHost, from }
  })().catch((err) => {
    // Remembered as unknown for the TTL, so a failing report never costs every read its wait.
    spendCache = { at: Date.now(), byHost: null, from: '' }
    log.web.warn('fleet: spend by host failed', { error: String(err) })
  })
    .finally(() => { spendRun = null })
  return spendRun
}

async function spend(now: number): Promise<{ byHost: Map<string, number>; from: string } | null> {
  if (!spendCache || now - spendCache.at > SPEND_TTL_MS) {
    const run = refreshSpend()
    if (!spendCache) await within(run, SPEND_FIRST_WAIT_MS, undefined)
  }
  return spendCache?.byHost ? { byHost: spendCache.byHost, from: spendCache.from } : null
}

interface HostEntry { host: string; def: HostDef | null; label: string; local: boolean; kind: FleetConnectionKind }

function entries(config: Config): HostEntry[] {
  const out: HostEntry[] = [{ host: LOCAL_HOST, def: null, label: 'This computer', local: true, kind: 'local' }]
  for (const { key, def } of listStatusHosts(config)) {
    out.push({ host: key, def, label: def.label?.trim() || key, local: false, kind: def.cloud_box ? 'bridge' : 'ssh-tunnel' })
  }
  return out
}

async function serverOf(host: string, def: HostDef | null): Promise<FleetHost['server']> {
  if (!def || def.cloud_box) return null
  const { getHostServerManager } = await import('../host-server/index.js')
  const view = getHostServerManager()?.view(host)
  if (!view) return null
  return {
    enabled: view.enabled,
    program: view.program ?? null,
    phase: view.phase,
    build: view.build ?? null,
    phone: view.server?.expose?.state ?? null,
    message: view.message ?? null,
  }
}

async function card(e: HostEntry, conns: Map<string, VitalsConn[]>, days: number, now: number, spendNow: Awaited<ReturnType<typeof spend>>, loads: Map<string, NonNullable<FleetInputs['load']>>, bucketMinutes?: number): Promise<FleetHost> {
  const conn = (conns.get(e.host) ?? [])[0]
  let status: { connected: boolean; phase: string; phaseLabel: string; connectedAt?: number; error?: string | null }
  if (e.local) {
    status = conn?.connected
      ? { connected: true, phase: 'connected', phaseLabel: 'Running on this Mac' }
      : { connected: false, phase: 'idle', phaseLabel: 'The local daemon is not connected' }
  } else {
    const f = hostStatusFrame(e.host, e.def!)
    status = { connected: f.connected, phase: f.phase, phaseLabel: f.phaseLabel, connectedAt: f.connectedAt, error: f.error ?? f.lastError ?? null }
  }
  const [profile, vitals, server] = await Promise.all([
    readHostProfile(e.host).catch(() => null),
    vitalsFor(e.host, conn, days, now, bucketMinutes),
    serverOf(e.host, e.def).catch(() => null),
  ])
  probeInBackground(e.host, conn, profile)
  return withPlacement(buildFleetHost({
    host: e.host, label: e.label, local: e.local, kind: e.kind, status,
    rttMs: conn?.roundTripMs ?? null,
    profile, vitals, load: loads.get(e.host) ?? null,
    spendUsd: spendNow ? (spendNow.byHost.get(e.host) ?? 0) : null,
    spendFrom: spendNow?.from ?? null,
    server,
    daemon: conn ? {
      version: conn.daemonVersion, startedAt: conn.daemonStartedAt, startup: conn.daemonStartup,
      runtime: conn.remoteRuntime ?? null, vitals: conn.hasCapability(VITALS_CAPABILITY),
    } : null,
    now,
  }))
}

/** Every host, the Mac first. `days` is the history window (1 to 31; default 30, day buckets). */
export async function listFleet(opts: { days?: number } = {}): Promise<FleetHost[]> {
  const days = clampDays(opts.days)
  const config = await getConfig()
  const now = Date.now()
  if (CLOUD_MODE) return cloudFleet(config, now)
  const conns = connectionsOverride ? connectionsOverride() : await defaultConnections()
  const all = entries(config)
  const [spendNow, loads] = await Promise.all([spend(now), placementViews(placeable(all))])
  return Promise.all(all.map((e) => card(e, conns, days, now, spendNow, loads)))
}

/** One host with its history at the asked resolution; null for a host Walnut does not know. */
export async function getFleetHost(host: string, opts: { days?: number; bucketMinutes?: number } = {}): Promise<FleetHost | null> {
  const config = await getConfig()
  const e = entries(config).find((x) => x.host === host)
  if (!e) return null
  const now = Date.now()
  if (CLOUD_MODE) return (await cloudFleet(config, now)).find((h) => h.host === host) ?? null
  const conns = connectionsOverride ? connectionsOverride() : await defaultConnections()
  const bucket = Number.isFinite(opts.bucketMinutes) && (opts.bucketMinutes as number) >= 5 ? Math.round(opts.bucketMinutes as number) : undefined
  const [spendNow, loads] = await Promise.all([spend(now), placementViews(placeable([e]))])
  return card(e, conns, clampDays(opts.days), now, spendNow, loads, bucket)
}

/** The hosts session placement may pick: this Mac and SSH hosts, never the cloud box. */
function placeable(list: HostEntry[]): string[] {
  return list.filter((e) => e.kind !== 'bridge').map((e) => e.host)
}

function clampDays(days: number | undefined): number {
  const d = Math.round(Number(days))
  return d >= 1 && d <= 31 ? d : 30
}

/** The companion holds no daemon link of its own: each host's bridge says whether it is there. */
async function cloudFleet(config: Config, now: number): Promise<FleetHost[]> {
  const { bridgeForHost } = await import('../../web/ws/bridge-registry.js')
  return entries(config).filter((e) => !e.local).map((e) => {
    const connected = bridgeForHost(e.host).connected
    return withPlacement(buildFleetHost({
      host: e.host, label: e.label, local: false, kind: 'bridge',
      status: { connected, phase: connected ? 'connected' : 'idle', phaseLabel: connected ? 'Its bridge is connected' : 'Its bridge is not connected' },
      rttMs: null, profile: null, vitals: null, spendUsd: null, spendFrom: null, server: null, daemon: null, now,
    }))
  })
}
