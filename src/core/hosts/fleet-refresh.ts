/**
 * The Overview's two halves (2026-11-03, the user, on Settings › Remote Hosts ›
 * Overview sitting on "Reading each host..." for half a minute: "just show cache
 * and fetch when user click"):
 *
 *   cachedFleet()        every card at once: what this server holds itself (the
 *                        link, the profile, the host's Walnut server, all live) plus
 *                        what each host answered at its last read (fleet-cache.ts).
 *                        It never asks a host, so a host that is slow or away costs
 *                        the page nothing.
 *   startFleetRefresh()  reads the named hosts again (every host by default) and
 *                        returns at once. Each host is read on its own, in parallel,
 *                        held to `hostMs`, and its entry in the cache changes when ITS
 *                        read ends, so one slow host never holds up the others. A host
 *                        already being read is not read twice.
 *
 * The page polls cachedFleet while it says `refreshing`. Each card adds `readAt`
 * (when its readings were read; null before the first read), `refreshing` (its read
 * runs now), and `readError` / `readFailedAt` (why its last read failed: the readings
 * shown are the older ones then, with `now.stale`).
 */
import { getConfig } from '../config-manager.js'
import { isCompanion } from '../server-role.js'
import { log } from '../../logging/index.js'
import { readHostProfile } from './host-profile.js'
import { fleetCacheEntry, loadFleetCache, pruneFleetCache, recordFleetFailure, recordFleetNoVitals } from './fleet-cache.js'
import {
  askVitals, assembleCard, cloudFleet, DEFAULT_DAYS, fleetConnections, fleetEntries, localParts, placementViews,
  probeInBackground, refreshSpendIfOld, spendSnapshot, VITALS_CAPABILITY, type HostEntry, type VitalsConn,
} from './fleet.js'
import type { FleetHost } from './fleet-model.js'

/** A card as the Overview reads it: a FleetHost plus how old it is (additive). */
export type CachedFleetHost = FleetHost & {
  readAt: number | null
  refreshing: boolean
  readError: string | null
  readFailedAt: number | null
}

/**
 * A cached reading older than this is served as stale (`now.stale`, "last reading"): it is
 * not how the host is doing now, and its session count is not counted as open now.
 */
export const READING_FRESH_MS = 5 * 60_000
/** A host.vitals asked by a refresh may take this long (a host behind a relay is slow). */
let sendMs = 20_000
/** And the whole read of one host, past which it counts as failed. */
let hostMs = 25_000
const running = new Map<string, Promise<void>>()

/** Every host the fleet lists, from what was read last; never asks a host. */
export async function cachedFleet(): Promise<{ hosts: CachedFleetHost[]; refreshing: boolean }> {
  const config = await getConfig()
  const now = Date.now()
  if (isCompanion()) {
    // The companion knows each host's bridge only, and that it knows live.
    const cards = await cloudFleet(config, now)
    return { hosts: cards.map((h) => ({ ...h, readAt: now, refreshing: false, readError: null, readFailedAt: null })), refreshing: false }
  }
  await loadFleetCache()
  const conns = await fleetConnections()
  const spend = spendSnapshot()
  const hosts = await Promise.all(fleetEntries(config).map(async (e): Promise<CachedFleetHost> => {
    const conn = conns.get(e.host)?.[0]
    const kept = fleetCacheEntry(e.host)
    const answering = !!conn?.connected && conn.hasCapability(VITALS_CAPABILITY)
    const card = assembleCard(e, conn, await localParts(e, conn), {
      vitals: kept?.vitals ? { ...kept.vitals, stale: kept.stale || !answering || now - kept.vitals.at > READING_FRESH_MS } : null,
      // Its room only while it is connected: a load read before it dropped is not its room now.
      load: conn?.connected ? (kept?.load ?? null) : null,
      spend,
      now,
    })
    return { ...card, readAt: kept?.readAt ?? null, refreshing: running.has(e.host), readError: kept?.error ?? null, readFailedAt: kept?.errorAt ?? null }
  }))
  return { hosts, refreshing: running.size > 0 }
}

/** Read these hosts again (every host when none is named); answers at once with what runs. */
export async function startFleetRefresh(only?: readonly string[]): Promise<{ started: string[]; refreshing: string[] }> {
  if (isCompanion()) return { started: [], refreshing: [] }
  const config = await getConfig()
  await loadFleetCache()
  const conns = await fleetConnections()
  refreshSpendIfOld()
  const listed = fleetEntries(config)
  if (!only) pruneFleetCache(listed.map((e) => e.host))
  const started: string[] = []
  for (const e of listed) {
    if ((only && !only.includes(e.host)) || running.has(e.host)) continue
    started.push(e.host)
    const at = Date.now()
    const run = readHost(e, conns.get(e.host)?.[0])
      .then((outcome) => {
        const ms = Date.now() - at
        if (outcome === 'failed' || outcome === 'late' || ms > 5_000) log.web.info('fleet: host read', { host: e.host, outcome, ms })
      })
      .catch((err) => { log.web.warn('fleet: host read threw', { host: e.host, error: err instanceof Error ? err.message : String(err) }) })
      .finally(() => { running.delete(e.host) })
    running.set(e.host, run)
  }
  if (started.length) log.web.debug('fleet: refresh started', { hosts: started })
  return { started, refreshing: [...running.keys()] }
}

function within<T>(p: Promise<T>, ms: number, fallback: T): Promise<T> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(fallback), ms)
    timer.unref?.()
    p.then((v) => { clearTimeout(timer); resolve(v) }, () => { clearTimeout(timer); resolve(fallback) })
  })
}

type ReadOutcome = 'ok' | 'failed' | 'late' | 'no-vitals' | 'away'

/** One host's read: its vitals and its load side by side, each held to its own deadline. */
async function readHost(e: HostEntry, conn: VitalsConn | undefined): Promise<ReadOutcome> {
  const answering = !!conn?.connected && conn.hasCapability(VITALS_CAPABILITY)
  const vitals: Promise<ReadOutcome> = answering
    ? within(askVitals(e.host, conn!, DEFAULT_DAYS, undefined, sendMs).then((v): ReadOutcome => (v ? 'ok' : 'failed')), hostMs, 'late')
    : Promise.resolve(conn?.connected ? 'no-vitals' : 'away')
  // placementViews keeps every load it read in the cache itself; the cloud box is never placed.
  const load = e.kind === 'bridge' ? Promise.resolve(null) : placementViews([e.host])
  const [outcome] = await Promise.all([vitals, load])
  // askVitals keeps an answer and a failure itself; only these two are said here.
  if (outcome === 'away' || outcome === 'no-vitals') recordFleetNoVitals(e.host, Date.now(), { away: outcome === 'away' })
  else if (outcome === 'late') recordFleetFailure(e.host, `it did not answer in ${Math.round(hostMs / 1000)} s`, Date.now())
  probeInBackground(e.host, conn, await readHostProfile(e.host).catch(() => null))
  return outcome
}

/** Test seams: shorter deadlines, and a wait for every read in flight. */
export function __setFleetRefreshDeadlinesForTesting(next: { sendMs?: number; hostMs?: number } | null): void {
  sendMs = next?.sendMs ?? 20_000
  hostMs = next?.hostMs ?? 25_000
}
export async function fleetRefreshIdle(): Promise<void> {
  while (running.size) await Promise.all([...running.values()])
}
