/**
 * The cloud companion as the backup leader of a Walnut
 * (docs/plan/walnut-control-plane.md). Cloud box only.
 *
 * It listens to the primary's heartbeat (a `leader-heartbeat` frame the
 * primary sends every 15s down its own bridge), and every tick it decides with
 * takeover.ts whether to take the lead of the hosts it reaches, keep it, or let
 * it go. The hosts hold the truth: each daemon grants a claim only when the
 * user allowed it and the daemon itself has not heard the primary, and refuses
 * anything from an old epoch. This module only asks.
 *
 * While it leads a host, that host's daemon hands it the gateway calls it
 * cannot answer itself (backup-gateway.ts), and the companion routes messages
 * between hosts with `leader.deliver`.
 */

import fsp from 'node:fs/promises'
import path from 'node:path'
import { log } from '../../logging/index.js'
import { decideTakeover, type WitnessEntry, type WitnessReport } from './takeover.js'

/** The primary's own alias on the bridge registry: its daemon, never a host this leads. */
const PRIMARY_ALIAS = '__local__'

export interface LeaderHeartbeat {
  walnutId?: unknown
  /** The user lets the companion lead while the primary is away. */
  backup?: unknown
  /** The primary is going down for a restart and expects to be back within this. */
  restartingMs?: unknown
}

export interface BackupLeaderDeps {
  now: () => number
  takeoverMs: number
  /** Hosts with a live bridge right now. */
  hosts: () => string[]
  request: (host: string, cmd: string, params: Record<string, unknown>, timeoutMs: number) => Promise<Record<string, unknown>>
  /** Where the Walnut id survives a restart (null: keep it in memory only). */
  stateFile: string | null
}

export interface BackupLeaderStatus {
  walnutId: string | null
  leading: Array<{ host: string; epoch: number; since: number }>
  primaryLastSeenAt: number
  primaryHeard: boolean
  /** What the primary's last heartbeat said of `cloud_bridge.backup_leader`; null before one. */
  backupAllowed: boolean | null
  restartingUntil: number | null
  lastDecision: string | null
  takeoverMs: number
}

const WITNESS_TIMEOUT_MS = 5_000
const CLAIM_TIMEOUT_MS = 5_000
/** A restart notice never holds the takeover off longer than this. */
const MAX_RESTART_MS = 10 * 60_000

export function createBackupLeader(deps: BackupLeaderDeps) {
  const bootAt = deps.now()
  let walnutId: string | undefined
  let lastHeartbeatAt: number | null = null
  let backupAllowed: boolean | null = null
  let restartingUntil: number | null = null
  let lastDecision: string | null = null
  const leading = new Map<string, { epoch: number; since: number }>()
  let ticking: Promise<void> | null = null
  let loaded = false

  async function load(): Promise<void> {
    if (loaded || !deps.stateFile) { loaded = true; return }
    loaded = true
    try {
      const raw = JSON.parse(await fsp.readFile(deps.stateFile, 'utf8')) as { walnutId?: unknown }
      if (typeof raw.walnutId === 'string' && !walnutId) walnutId = raw.walnutId
    } catch { /* first start */ }
  }

  async function persistWalnut(id: string): Promise<void> {
    if (!deps.stateFile) return
    try {
      await fsp.mkdir(path.dirname(deps.stateFile), { recursive: true })
      await fsp.writeFile(deps.stateFile, JSON.stringify({ walnutId: id }), { mode: 0o600 })
    } catch (err) {
      log.leader.warn('backup leader: could not save the Walnut id', { error: err instanceof Error ? err.message : String(err) })
    }
  }

  /** A heartbeat from the primary's own bridge (events-v1 trusts only that one). */
  function noteHeartbeat(hb: LeaderHeartbeat): void {
    lastHeartbeatAt = deps.now()
    backupAllowed = hb.backup === true
    const ms = typeof hb.restartingMs === 'number' && hb.restartingMs > 0 ? Math.min(hb.restartingMs, MAX_RESTART_MS) : 0
    restartingUntil = ms > 0 ? lastHeartbeatAt + ms : null
    if (typeof hb.walnutId === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(hb.walnutId) && hb.walnutId !== walnutId) {
      walnutId = hb.walnutId
      void persistWalnut(hb.walnutId)
    }
  }

  async function witnesses(hosts: string[]): Promise<WitnessReport[]> {
    return Promise.all(hosts.map(async (host): Promise<WitnessReport> => {
      try {
        const r = await deps.request(host, 'leader.witness', {}, WITNESS_TIMEOUT_MS)
        if (r.ok !== true) return { host, error: String(r.error ?? 'refused') }
        return { host, walnuts: Array.isArray(r.walnuts) ? r.walnuts as WitnessEntry[] : [] }
      } catch (err) {
        return { host, error: err instanceof Error ? err.message : String(err) }
      }
    }))
  }

  async function tickOnce(): Promise<void> {
    await load()
    const now = deps.now()
    const primaryLastSeenAt = lastHeartbeatAt ?? bootAt
    const quiet = now - primaryLastSeenAt
    const windowMs = Math.max(deps.takeoverMs, restartingUntil && restartingUntil > now ? restartingUntil - primaryLastSeenAt : 0)
    // Nothing to ask while the primary is heard and nothing is led.
    if (leading.size === 0 && quiet < windowMs) return
    const hosts = deps.hosts().filter((h) => h !== PRIMARY_ALIAS)
    if (hosts.length === 0 && leading.size === 0) return
    const reports = await witnesses(hosts)
    const decision = decideTakeover({
      now, takeoverMs: deps.takeoverMs, primaryLastSeenAt,
      ...(restartingUntil ? { restartingUntil } : {}),
      ...(walnutId ? { walnutId } : {}),
      leading: new Map([...leading].map(([h, l]) => [h, l.epoch])),
      reports,
    })
    if (decision.reason !== lastDecision) {
      log.leader.info('backup leader: decision', { action: decision.action, reason: decision.reason, walnutId: decision.walnutId ?? walnutId ?? null, leading: [...leading.keys()] })
    }
    lastDecision = decision.reason
    if (decision.action === 'demote') {
      for (const host of decision.hosts) {
        const had = leading.get(host)
        leading.delete(host)
        if (had) log.leader.info('backup leader: gave the lead back', { host, epoch: had.epoch, ledMs: now - had.since, reason: decision.reason })
      }
      return
    }
    if (decision.action !== 'claim') return
    if (!walnutId) { walnutId = decision.walnutId; void persistWalnut(decision.walnutId) }
    for (const { host, epoch } of decision.claims) {
      try {
        const r = await deps.request(host, 'leader.claim', { walnutId: decision.walnutId, epoch }, CLAIM_TIMEOUT_MS)
        if (r.ok === true && typeof r.epoch === 'number') {
          leading.set(host, { epoch: r.epoch, since: deps.now() })
          log.leader.info('backup leader: leads host', { host, epoch: r.epoch, walnutId: decision.walnutId, primarySilentMs: quiet })
        } else {
          log.leader.info('backup leader: claim refused', { host, epoch, code: r.errorKind ?? null, error: r.error ?? null })
        }
      } catch (err) {
        log.leader.warn('backup leader: claim failed', { host, error: err instanceof Error ? err.message : String(err) })
      }
    }
  }

  /** One decision round; overlapping calls join the running one. */
  function tick(): Promise<void> {
    if (!ticking) ticking = tickOnce().finally(() => { ticking = null })
    return ticking
  }

  /** The lead this companion holds on `host`, if any. */
  function leadFor(host: string): { walnutId: string; epoch: number } | null {
    const l = leading.get(host)
    return l && walnutId ? { walnutId, epoch: l.epoch } : null
  }

  /** A host refused a command as stale: it is not ours any more. */
  function lostHost(host: string, reason: string): void {
    const had = leading.get(host)
    if (!had) return
    leading.delete(host)
    log.leader.info('backup leader: lost the lead of a host', { host, epoch: had.epoch, reason })
  }

  function status(): BackupLeaderStatus {
    return {
      walnutId: walnutId ?? null,
      leading: [...leading].map(([host, l]) => ({ host, epoch: l.epoch, since: l.since })),
      primaryLastSeenAt: lastHeartbeatAt ?? bootAt,
      primaryHeard: lastHeartbeatAt !== null,
      backupAllowed,
      restartingUntil,
      lastDecision,
      takeoverMs: deps.takeoverMs,
    }
  }

  return { noteHeartbeat, tick, leadFor, lostHost, status, isLeading: () => leading.size > 0 }
}

export type BackupLeader = ReturnType<typeof createBackupLeader>

// ── The cloud box's one instance ──

let instance: BackupLeader | null = null
let timer: ReturnType<typeof setInterval> | null = null

export function takeoverMsFromEnv(): number {
  const n = Number(process.env.WALNUT_LEADER_TAKEOVER_MS)
  return Number.isFinite(n) && n >= 500 ? Math.floor(n) : 60_000
}

/** The instance, created on first use (cloud box only; null elsewhere). */
export async function getBackupLeader(): Promise<BackupLeader | null> {
  const { CLOUD_MODE, LEADER_STATE_DIR } = await import('../../constants.js')
  if (!CLOUD_MODE) return null
  if (!instance) {
    const registry = await import('../../web/ws/bridge-registry.js')
    instance = createBackupLeader({
      now: () => Date.now(),
      takeoverMs: takeoverMsFromEnv(),
      hosts: () => registry.bridgeHosts().map((h) => h.hostAlias),
      request: (host, cmd, params, timeoutMs) => registry.bridgeRequest(host, cmd, params, timeoutMs),
      stateFile: path.join(LEADER_STATE_DIR, 'companion.json'),
    })
  }
  return instance
}

/** Start the decision loop (server.ts, cloud box only). */
export async function startBackupLeader(): Promise<{ stop: () => void } | null> {
  const leader = await getBackupLeader()
  if (!leader) return null
  const n = Number(process.env.WALNUT_LEADER_TICK_MS)
  const every = Number.isFinite(n) && n >= 100 ? Math.floor(n) : 5_000
  if (timer) clearInterval(timer)
  timer = setInterval(() => { void leader.tick().catch((err) => log.leader.warn('backup leader: tick failed', { error: err instanceof Error ? err.message : String(err) })) }, every)
  timer.unref?.()
  log.leader.info('backup leader: watching the primary', { takeoverMs: takeoverMsFromEnv(), tickMs: every })
  return { stop: () => { if (timer) clearInterval(timer); timer = null } }
}

/** Tests only. */
export function _resetBackupLeaderForTesting(): void {
  if (timer) clearInterval(timer)
  timer = null
  instance = null
}
