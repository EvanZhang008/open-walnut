/**
 * The host rows of GET /api/replicas/status (docs/plan/walnut-replica-servers-impl.md
 * section 13, WP14): for each host that runs a server, the program that runs and any
 * fallback (the daemon's supervision, `server.status`), and the host's journal as the
 * replica last reported it (its daemon's `follower.status` journal line): its size,
 * the drainable and parked counts and the oldest record. The copy ages are per kind
 * (replica-status.ts kindStatusOf `ageMs`).
 *
 * Pure: the manager's views in, rows out. A report older than the manager's stale
 * mark is not shown as the host's journal (`journal: null`, `reportAgeMs` says why).
 */
import type { HostServerView } from '../host-server/manager.js'

export interface HostJournalStatus {
  records: number
  drainable: number
  /** Records the Mac cannot drain yet (a kind a newer Mac drains). */
  parked: number
  bytes: number
  blobBytes: number
  oldestAt: number | null
  oldestAgeMs: number | null
  lastDrainAt: number | null
}

export interface HostReplicaStatus {
  hostKey: string
  phase: string
  program: 'replica' | 'host-server' | 'fallback' | null
  /** The server runs and reports (phase running). */
  running: boolean
  daemonState: string | null
  restarts: number
  fallback: { since: number; until: number; lastError?: string } | null
  reportAgeMs: number | null
  journal: HostJournalStatus | null
}

const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null)

export function hostJournalOf(raw: unknown, now: number): HostJournalStatus | null {
  if (!raw || typeof raw !== 'object') return null
  const j = raw as Record<string, unknown>
  const records = num(j.records)
  const drainable = num(j.drainable)
  if (records === null || drainable === null) return null
  const oldestAt = num(j.oldestAt)
  return {
    records, drainable, parked: Math.max(0, records - drainable),
    bytes: num(j.bytes) ?? 0, blobBytes: num(j.blobBytes) ?? 0,
    oldestAt, oldestAgeMs: oldestAt === null ? null : Math.max(0, now - oldestAt),
    lastDrainAt: num(j.lastDrainAt),
  }
}

export function hostReplicaStatusOf(view: HostServerView, now = Date.now()): HostReplicaStatus {
  const d = view.daemon
  const server = view.server as (HostServerView['server'] & { journal?: unknown; at?: unknown }) | null | undefined
  return {
    hostKey: view.hostKey,
    phase: view.phase,
    program: view.program ?? null,
    running: view.phase === 'running',
    daemonState: d?.state ?? null,
    restarts: d?.restarts ?? 0,
    fallback: d?.fallback ?? null,
    reportAgeMs: typeof d?.reportAgeMs === 'number' ? d.reportAgeMs : null,
    // The host's clock stamps oldestAt; the copy age is read on the Mac's (a small skew).
    journal: server ? hostJournalOf(server.journal, now) : null,
  }
}

export function hostReplicaStatuses(views: readonly HostServerView[], now = Date.now()): HostReplicaStatus[] {
  return views.filter((v) => v.enabled).map((v) => hostReplicaStatusOf(v, now))
}
