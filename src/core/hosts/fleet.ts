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
 *
 * Every answer a host gives for the default window is also kept in the fleet cache
 * (fleet-cache.ts), which the Overview opens on (fleet-refresh.ts). A row found in
 * ~/.ssh/config for a machine that has joined the host network (joined-twins.ts) is
 * the same machine as the joined row: every list (this one, the Overview, the prompt's
 * host line, a refresh) names and reads it once, as joined. Asked for by its own alias
 * (`host_get` from a session still on it, Set up), it is still found.
 */
import { isCompanion } from '../server-role.js'
import { IS_EPHEMERAL } from '../../constants.js'
import { getConfig } from '../config-manager.js'
import { log } from '../../logging/index.js'
import type { Config } from '../types.js'
import type { HostVitals } from '../../providers/host-vitals-core.js'
import { hostStatusFrame } from './host-connect-action.js'
import { listStatusHosts, type HostDef } from './host-status.js'
import { probeIsStale, readHostProfile, recordProbedFacts, type HostProfile } from './host-profile.js'
import { buildFleetHost, withPlacement, type FleetBootStart, type FleetConnectionKind, type FleetHost, type FleetInputs } from './fleet-model.js'
import { joinedTwins } from './joined-twins.js'
import {
  __resetFleetCacheForTesting, cachedSpend, recordFleetFailure, recordFleetLoad, recordFleetSpend, recordFleetVitals,
} from './fleet-cache.js'
import type { BootStartView } from '../../providers/remote-boot-start-keeper.js'
import type { HostLoadView } from './placement.js'

export type { FleetHost } from './fleet-model.js'

export const LOCAL_HOST = '__local__'
export const VITALS_CAPABILITY = 'host-vitals-v1'
export const CAPS_CAPABILITY = 'host-caps-v1'
const VITALS_DEADLINE_MS = 3_000
const VITALS_TTL_MS = 15_000
const VITALS_CACHE_MAX = 32
const SPEND_TTL_MS = 5 * 60_000
const SPEND_FIRST_WAIT_MS = 1_500
const SPEND_DAYS = 30
/** The window the Overview shows and the fleet cache keeps. */
export const DEFAULT_DAYS = 30
/** placement.ts asks each host for 4 s; a little more covers its session count. */
const PLACEMENT_DEADLINE_MS = 4_500

type LoadsFn = (hosts: string[]) => Promise<HostLoadView[]>
let loadsOverride: LoadsFn | null = null
/** Test seam: placement's view of each host. */
export function __setFleetLoadsForTesting(fn: LoadsFn | null): void { loadsOverride = fn }

/** Placement's view of these hosts by name; an empty map when it does not answer in time. */
export async function placementViews(hosts: string[]): Promise<Map<string, NonNullable<FleetInputs['load']>>> {
  const out = new Map<string, NonNullable<FleetInputs['load']>>()
  if (!hosts.length) return out
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    const ask = loadsOverride ?? (async (h: string[]) => (await import('./placement.js')).hostLoads({ hosts: h }))
    const views = await Promise.race([
      ask(hosts),
      new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('placement did not answer in time')), PLACEMENT_DEADLINE_MS); timer.unref?.() }),
    ])
    for (const v of views) {
      const view = { known: v.known, score: v.score, busy: v.busy, reasons: v.reasons, weight: v.weight }
      out.set(v.host, view)
      // Only a load it read: one it could not read keeps the last one it did.
      if (v.known) recordFleetLoad(v.host, view)
    }
  } catch (err) {
    log.web.debug('fleet: placement view unavailable', { error: err instanceof Error ? err.message : String(err) })
  } finally {
    if (timer) clearTimeout(timer)
  }
  return out
}

export interface VitalsConn {
  connected: boolean
  hasCapability(cap: string): boolean
  send(cmd: string, params: Record<string, unknown>, timeoutMs?: number): Promise<Record<string, unknown>>
  readonly roundTripMs: number
  readonly daemonVersion: string | null
  readonly daemonStartedAt: number | null
  readonly daemonStartup: string
  readonly daemonInstanceId: string | null
  readonly remoteRuntime?: string | null
  readonly bootStart?: BootStartView | null
}

function fleetBootStart(b: BootStartView | null): FleetBootStart | null {
  if (!b) return null
  return {
    mode: b.mode, backend: b.backend, reason: b.reason, checkedAt: b.checkedAt,
    setupRunning: b.setup?.running === true, setupError: b.setup?.running ? null : (b.setup?.error ?? null),
    next: b.setup?.running || b.mode === 'boot' ? null : (b.next ?? null),
  }
}

async function defaultConnections(): Promise<Map<string, VitalsConn[]>> {
  const dc = await import('../../providers/daemon-connection.js')
  return dc.listConnectedDaemonsByHost() as unknown as Map<string, VitalsConn[]>
}

/** Each host's daemon connections (a test's fakes when set). */
export async function fleetConnections(): Promise<Map<string, VitalsConn[]>> {
  return connectionsOverride ? connectionsOverride() : defaultConnections()
}

let spendCache: { at: number; byHost: Map<string, number> | null; from: string } | null = null
let spendRun: Promise<void> | null = null

let connectionsOverride: (() => Map<string, VitalsConn[]>) | null = null
/** Test-only: swap how hosts become daemon connections (and start every cache empty). */
export function __setFleetConnectionsForTesting(next: (() => Map<string, VitalsConn[]>) | null): void {
  connectionsOverride = next
  spendCache = null
  lastFleet = null
  vitalsCache.clear()
  inflight.clear()
  probedInstances.clear()
  recordCounts = null
  __resetFleetCacheForTesting()
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

/**
 * One host.vitals, at most one in flight per host and window. An answer (or why there
 * was none) for the default window is kept in the fleet cache, whoever asked.
 */
export function askVitals(host: string, conn: VitalsConn, days: number, bucketMinutes?: number, sendTimeoutMs = 10_000): Promise<HostVitals | null> {
  const key = vitalsKey(host, days, bucketMinutes)
  const running = inflight.get(key)
  if (running) return running.p
  const kept = days === DEFAULT_DAYS && !bucketMinutes
  const p = conn.send('host.vitals', { days, ...(bucketMinutes ? { bucketMinutes } : {}) }, sendTimeoutMs)
    .then((res) => {
      if (res.ok === false || !res.stats || !res.history) {
        if (kept) recordFleetFailure(host, typeof res.error === 'string' && res.error ? res.error : 'its daemon sent no reading', Date.now())
        return null
      }
      const value = res as unknown as HostVitals
      const at = Date.now()
      vitalsCache.delete(key)
      vitalsCache.set(key, { value, at })
      // Bounded: an agent walking windows and bucket sizes, or hosts since removed, evict the oldest.
      while (vitalsCache.size > VITALS_CACHE_MAX) vitalsCache.delete(vitalsCache.keys().next().value as string)
      if (kept) recordFleetVitals(host, value, at)
      return value
    })
    .catch((err) => {
      log.web.debug('fleet: host.vitals failed', { host, error: String(err) })
      if (kept) recordFleetFailure(host, err instanceof Error ? err.message : String(err), Date.now())
      return null
    })
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
export function probeInBackground(host: string, conn: VitalsConn | undefined, profile: HostProfile | null): void {
  if (!conn?.connected || !conn.hasCapability('host-facts-v1')) return
  // A profile probed before the daemon learned host-caps-v1 lacks the capabilities: probe it again.
  const capsMissing = !!profile?.probed && !('mcp' in profile.probed) && conn.hasCapability(CAPS_CAPABILITY)
  if (profile && !probeIsStale(profile) && !capsMissing) return
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
    recordFleetSpend({ at: spendCache.at, from, byHost: Object.fromEntries(byHost) })
  })().catch((err) => {
    // Tried again only after the TTL, so a failing report never costs every read its wait; the
    // last spend it read stays shown until a report succeeds (2026-11-04: "cache ... until the real data come").
    spendCache = { at: Date.now(), byHost: spendCache?.byHost ?? null, from: spendCache?.from ?? '' }
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
  return spendSnapshot()
}

export type FleetSpendNow = { byHost: Map<string, number>; from: string } | null

/** The spend known now, never waiting: this process's last report, else the cached one. */
export function spendSnapshot(): FleetSpendNow {
  if (spendCache?.byHost) return { byHost: spendCache.byHost, from: spendCache.from }
  const kept = cachedSpend()
  return kept ? { byHost: new Map(Object.entries(kept.byHost)), from: kept.from } : null
}

/** Read the spend again in the background when it is older than its TTL (a person asked). */
export function refreshSpendIfOld(now = Date.now()): void {
  if (!spendCache || now - spendCache.at > SPEND_TTL_MS) void refreshSpend()
}

export interface HostEntry { host: string; def: HostDef | null; label: string; local: boolean; kind: FleetConnectionKind; declared?: unknown }

/**
 * Every host the fleet lists, this Mac first; a found row for a joined machine is left out
 * unless `withTwins` (a lookup by alias, never a list).
 */
export function fleetEntries(config: Config, opts: { withTwins?: boolean } = {}): HostEntry[] {
  // This machine has no hosts entry: its own tags are `local_capabilities`.
  const out: HostEntry[] = [{ host: LOCAL_HOST, def: null, label: 'This computer', local: true, kind: 'local', declared: config.local_capabilities }]
  const twins = new Set(opts.withTwins ? [] : joinedTwins(config.hosts ?? {}, config.net).map((t) => t.alias))
  for (const { key, def } of listStatusHosts(config)) {
    if (twins.has(key)) continue
    out.push({ host: key, def, label: def.label?.trim() || key, local: false, kind: def.cloud_box ? 'bridge' : def.transport === 'net' ? 'host-network' : 'ssh-tunnel', declared: def.capabilities })
  }
  return out
}

async function serverOf(host: string, def: HostDef | null): Promise<FleetInputs['server']> {
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

/** What a card says that this server holds itself: the link, the profile, the host's Walnut server. No host is asked. */
export interface LocalParts {
  status: FleetInputs['status']
  profile: HostProfile | null
  server: FleetInputs['server']
  /** Sessions open there by Walnut's own records; null when they cannot be read. */
  recordedSessions: number | null
}

let recordCounts: { at: number; p: Promise<Record<string, number> | null> } | null = null
/** Walnut's own count of open sessions per host, read at most every 5 s for a whole page of cards. */
function openSessionCounts(): Promise<Record<string, number> | null> {
  const now = Date.now()
  if (recordCounts && now - recordCounts.at < 5_000) return recordCounts.p
  const p = import('../session-tracker.js')
    .then((m) => m.countOpenSessionsByHost())
    .catch((err) => { log.web.debug('fleet: session count failed', { error: err instanceof Error ? err.message : String(err) }); return null })
  recordCounts = { at: now, p }
  return p
}

function recordedFor(host: string, local: boolean, counts: Record<string, number> | null): number | null {
  if (!counts) return null
  return local ? (counts.local ?? 0) + (counts[LOCAL_HOST] ?? 0) : (counts[host] ?? 0)
}

export async function localParts(e: HostEntry, conn: VitalsConn | undefined): Promise<LocalParts> {
  let status: LocalParts['status']
  if (e.local) {
    status = conn?.connected
      ? { connected: true, phase: 'connected', phaseLabel: 'Running on this Mac' }
      : { connected: false, phase: 'idle', phaseLabel: 'The local daemon is not connected' }
  } else {
    const f = hostStatusFrame(e.host, e.def!)
    status = { connected: f.connected, phase: f.phase, phaseLabel: f.phaseLabel, connectedAt: f.connectedAt, error: f.error ?? f.lastError ?? null, ...(f.drops?.length ? { drops: f.drops } : {}) }
  }
  const [profile, server, counts] = await Promise.all([
    readHostProfile(e.host).catch(() => null),
    serverOf(e.host, e.def).catch(() => null),
    // The cloud box runs no Walnut sessions of its own.
    e.kind === 'bridge' ? Promise.resolve(null) : openSessionCounts(),
  ])
  return { status, profile, server, recordedSessions: recordedFor(e.host, e.local, counts) }
}

/** The card from the local parts and the readings (live or cached). */
export function assembleCard(e: HostEntry, conn: VitalsConn | undefined, parts: LocalParts, got: {
  vitals: FleetInputs['vitals']; load: FleetInputs['load']; spend: FleetSpendNow; now: number
}): FleetHost {
  const { status, profile, server, recordedSessions } = parts
  const spendNow = got.spend
  return withPlacement(buildFleetHost({
    host: e.host, label: e.label, local: e.local, kind: e.kind, status,
    rttMs: conn?.roundTripMs ?? null,
    profile, vitals: got.vitals, load: got.load ?? null,
    spendUsd: spendNow ? (spendNow.byHost.get(e.host) ?? 0) : null,
    spendFrom: spendNow?.from ?? null,
    server,
    daemon: conn ? {
      version: conn.daemonVersion, startedAt: conn.daemonStartedAt, startup: conn.daemonStartup,
      runtime: conn.remoteRuntime ?? null, vitals: conn.hasCapability(VITALS_CAPABILITY),
      bootStart: fleetBootStart(conn.bootStart ?? null),
      ...(IS_EPHEMERAL && !e.local ? { throwaway: true } : {}),
    } : null,
    declaredCapabilities: e.declared,
    recordedSessions,
    now: got.now,
  }))
}

async function card(e: HostEntry, conns: Map<string, VitalsConn[]>, days: number, now: number, spendNow: FleetSpendNow, loads: Map<string, NonNullable<FleetInputs['load']>>, bucketMinutes?: number): Promise<FleetHost> {
  const conn = (conns.get(e.host) ?? [])[0]
  const [parts, vitals] = await Promise.all([localParts(e, conn), vitalsFor(e.host, conn, days, now, bucketMinutes)])
  probeInBackground(e.host, conn, parts.profile)
  return assembleCard(e, conn, parts, { vitals, load: loads.get(e.host) ?? null, spend: spendNow, now })
}

/** Every host, the Mac first. `days` is the history window (1 to 31; default 30, day buckets). */
export async function listFleet(opts: { days?: number } = {}): Promise<FleetHost[]> {
  const days = clampDays(opts.days)
  const config = await getConfig()
  const now = Date.now()
  // The companion holds no daemon link: its cards come from the bridges. A host replica never
  // runs this route (the route table forwards it to the Mac, or answers needs-leader).
  if (isCompanion()) return cloudFleet(config, now)
  const conns = await fleetConnections()
  const all = fleetEntries(config)
  const [spendNow, loads] = await Promise.all([spend(now), placementViews(placeable(all))])
  const cards = await Promise.all(all.map((e) => card(e, conns, days, now, spendNow, loads)))
  lastFleet = { at: now, cards }
  return cards
}

let lastFleet: { at: number; cards: FleetHost[] } | null = null
/** The cards of the last full read, for the session prompt's host line (fleet-prompt.ts); null before one. */
export function lastFleetRead(): { at: number; cards: FleetHost[] } | null { return lastFleet }

/** One host with its history at the asked resolution; null for a host Walnut does not know. */
export async function getFleetHost(host: string, opts: { days?: number; bucketMinutes?: number } = {}): Promise<FleetHost | null> {
  const config = await getConfig()
  const e = fleetEntries(config, { withTwins: true }).find((x) => x.host === host)
  if (!e) return null
  const now = Date.now()
  if (isCompanion()) return (await cloudFleet(config, now)).find((h) => h.host === host) ?? null
  const conns = await fleetConnections()
  const bucket = Number.isFinite(opts.bucketMinutes) && (opts.bucketMinutes as number) >= 5 ? Math.round(opts.bucketMinutes as number) : undefined
  const [spendNow, loads] = await Promise.all([spend(now), placementViews(placeable([e]))])
  return card(e, conns, clampDays(opts.days), now, spendNow, loads, bucket)
}

/** The hosts session placement may pick: this Mac and SSH hosts, never the cloud box. */
function placeable(list: HostEntry[]): string[] {
  return list.filter((e) => e.kind !== 'bridge').map((e) => e.host)
}

export class BootStartCheckError extends Error {
  constructor(message: string, readonly code: 'unknown_host' | 'not_connected' | 'not_remote' | 'companion' | 'check_failed') { super(message) }
}

/**
 * The Overview's "Set up" / "Check again": the host's boot start keeper probes
 * now and sets the daemon up to start after a reboot when that is due
 * (remote-boot-start-keeper.ts decides; this only asks it to look now). Answers
 * the card as it reads after the check, held to BOOT_CHECK_DEADLINE_MS: a setup
 * still running then reads setupRunning, and finishes on its own. A probe that
 * failed is an error, never a quiet unchanged card.
 */
const BOOT_CHECK_DEADLINE_MS = 10_000
export async function checkHostBootStart(host: string): Promise<FleetHost> {
  if (isCompanion()) throw new BootStartCheckError('Ask your Mac: the companion holds no host link', 'companion')
  const config = await getConfig()
  const e = fleetEntries(config, { withTwins: true }).find((x) => x.host === host)
  if (!e) throw new BootStartCheckError('Walnut has no such host', 'unknown_host')
  if (e.local || e.kind === 'bridge') throw new BootStartCheckError('Only a host Walnut reaches over SSH or the host network has a boot start Walnut sets up', 'not_remote')
  const { getConnectedDaemonConnection } = await import('../../providers/daemon-connection.js')
  const conn = getConnectedDaemonConnection(host)
  if (!conn) throw new BootStartCheckError(`Walnut is not connected to ${e.label} now`, 'not_connected')
  let timer: ReturnType<typeof setTimeout> | undefined
  const failed = await Promise.race([
    conn.checkBootStart().then(() => null, (err: unknown) => (err instanceof Error ? err.message : String(err))),
    new Promise<null>((resolve) => { timer = setTimeout(() => resolve(null), BOOT_CHECK_DEADLINE_MS); timer.unref?.() }),
  ])
  if (timer) clearTimeout(timer)
  if (failed) {
    log.web.warn('fleet: boot start check failed', { host, error: failed })
    throw new BootStartCheckError(`Walnut could not check ${e.label}: ${failed.split('\n')[0].slice(0, 300)}`, 'check_failed')
  }
  const card = await getFleetHost(host)
  if (!card) throw new BootStartCheckError('Walnut has no such host', 'unknown_host')
  return card
}

function clampDays(days: number | undefined): number {
  const d = Math.round(Number(days))
  return d >= 1 && d <= 31 ? d : 30
}

/** The companion holds no daemon link of its own: each host's bridge says whether it is there. */
export async function cloudFleet(config: Config, now: number): Promise<FleetHost[]> {
  const { bridgeForHost } = await import('../../web/ws/bridge-registry.js')
  return fleetEntries(config).filter((e) => !e.local).map((e) => {
    const connected = bridgeForHost(e.host).connected
    return withPlacement(buildFleetHost({
      host: e.host, label: e.label, local: false, kind: 'bridge',
      status: { connected, phase: connected ? 'connected' : 'idle', phaseLabel: connected ? 'Its bridge is connected' : 'Its bridge is not connected' },
      rttMs: null, profile: null, vitals: null, spendUsd: null, spendFrom: null, server: null, daemon: null, now,
    }))
  })
}
