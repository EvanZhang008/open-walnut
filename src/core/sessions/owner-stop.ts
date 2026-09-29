/**
 * owner-stop: the only way the server ends a CLI process is to ask the daemon
 * that owns it.
 *
 * THE RULE: the server never signals a CLI pid. A CLI process belongs to the
 * daemon that spawned it: that daemon holds its FIFO, the .pgid file it wrote at
 * spawn, its registry entry and its start-time identity, and every death is
 * meant to funnel into the daemon's reapSession(). A pid in a server database row
 * proves nothing about which daemon spawned the process, or whether the pid still
 * names that process at all.
 *
 * WHY (2026-09-26 23:38Z and 2026-09-27 20:50Z): a test run started an ephemeral
 * server over a hand-made copy of the production sessions.sqlite. On its first
 * session start the orphan sweep found rows marked 'stopped' whose pids were
 * alive and looked like claude, and SIGTERM'd them: 11, then 9, of the user's
 * live sessions, all owned by the production daemon. Its only veto was "the JSONL
 * was written in the last 2 minutes", which also fails for any live CLI idling
 * between turns, so the same sweep could end a healthy production session too.
 *
 * Three entry points:
 *   stopThroughOwner          : a stop the server has DECIDED on (idle timeout,
 *                               capacity eviction, task completion). Uses the
 *                               daemon's `stop` RPC, which only ever signals a
 *                               process in its own registry after checking its
 *                               start time, and names this Walnut
 *                               (owner-home-v1, stop-provenance.ts) so a shared
 *                               daemon refuses to stop another Walnut's session.
 *   sweepOrphansThroughOwner  : records that say "deliberately ended" while a pid
 *                               is still set. Asks with `stop` reason 'orphan'
 *                               (capability orphan-stop-v1); the daemon ends the
 *                               process only after proving it spawned it for
 *                               THIS Walnut and that nothing keeps it alive. A
 *                               daemon without the capability is not asked, so
 *                               nothing is ended.
 *   stopAcpThroughOwner       : a detached ACP session's worker, via `acpStop`
 *                               on the daemon that hosts it (never from a test
 *                               server to a shared host).
 *
 * None of them ever calls process.kill. All are no-ops when the owning host's
 * daemon is not connected: its own idle reaper bounds the leak.
 */

import { IS_EPHEMERAL, WALNUT_HOME } from '../../constants.js'
import { log } from '../../logging/index.js'
import type { SessionRecord } from '../types.js'
import { engineCaps } from '../agents/engine-registry.js'
import { stopProvenance, type StopInitiator } from './stop-provenance.js'

/** Daemon capability that answers orphan stops with an ownership proof. */
export const ORPHAN_STOP_CAPABILITY = 'orphan-stop-v1'

/** A record whose status changed this recently may be mid-transition: not an orphan yet. */
export const ORPHAN_GRACE_MS = 2 * 60 * 1000

/**
 * status_reason values that record a DECISION that the process should end, as
 * opposed to an observation that it did. Only these make a record an orphan
 * candidate ("terminal" for the sweep). An observation ('normal_completion',
 * 'liveness_check_failed', 'process_exited_no_result', none at all) is a claim a
 * live process refutes: the recovery loop relabels such rows, and the owner's
 * idle reaper ends a CLI that really is idle.
 */
export const END_DECIDED_REASONS: ReadonlySet<string> = new Set([
  'user_stopped',
  'user_terminated',
  'expected_teardown',
  'idle_timeout',
  'idle_eviction',
])

/** `stop` waits for the process group to exit: SIGINT, 5s, SIGTERM, 2s more. */
const OWNER_STOP_TIMEOUT_MS = 15_000

export type OwnerStopReason = 'user' | 'maintenance' | 'idle'

/** The slice of DaemonConnection this module uses. */
export interface OwnerConnection {
  readonly connected: boolean
  hasCapability(cap: string): boolean
  send(command: string, args: Record<string, unknown>, timeoutMs?: number): Promise<Record<string, unknown>>
}

export interface OwnerStopDeps {
  /** The POOLED, connected daemon connection for a host key. Never dials. */
  connection(hostKey: string): Promise<OwnerConnection | null>
}

type OwnedRow = Pick<SessionRecord, 'claudeSessionId' | 'host'>

/** Session records store the local host as null/undefined; the daemon pool calls it '__local__'. */
export function ownerHostKey(row: Pick<SessionRecord, 'host'>): string {
  return row.host || '__local__'
}

// ONE shared import for every caller. Stops run concurrently (idle reaps, four
// at a time), and under vitest concurrent dynamic imports of one mocked module
// from the same importer are unsafe: the mocker tracks the pending import on a
// callstack that module's imports share, so the second caller gets the REAL
// module. A test's fake daemon then saw only some of the stops.
let daemonConnectionModule: Promise<typeof import('../../providers/daemon-connection.js')> | null = null

async function pooledConnection(hostKey: string): Promise<OwnerConnection | null> {
  try {
    daemonConnectionModule ??= import('../../providers/daemon-connection.js')
    const { getConnectedDaemonConnection } = await daemonConnectionModule
    return getConnectedDaemonConnection(hostKey)
  } catch {
    daemonConnectionModule = null
    return null
  }
}

/**
 * What became of a stop sent to the owner:
 *  - 'stopped'     the daemon confirmed (the process exited, or it holds none);
 *  - 'refused'     the daemon answered no (another Walnut's session, supervised
 *                  by cron, identity unknown), or this server may not send the
 *                  stop at all (an ephemeral server and a daemon that cannot
 *                  check ownership). The process is where it was;
 *  - 'unreachable' the host's daemon is not connected: nothing was sent;
 *  - 'unknown'     the request failed in flight (timeout, closed socket).
 */
export type OwnerStopOutcome = 'stopped' | 'refused' | 'unreachable' | 'unknown'

/**
 * Ask the daemon that owns `row`'s CLI to stop it. Never signals anything
 * locally; a disconnected host means nothing happens. The request names this
 * Walnut (owner-home-v1), so a shared daemon refuses to stop a session another
 * Walnut started. `initiator` is 'automatic' unless a person asked for it.
 */
export async function stopThroughOwner(
  row: OwnedRow,
  reason: OwnerStopReason,
  why: string,
  deps: Partial<OwnerStopDeps> = {},
  initiator: StopInitiator = 'automatic',
): Promise<OwnerStopOutcome> {
  const sessionId = row.claudeSessionId
  const host = ownerHostKey(row)
  let conn: OwnerConnection | null = null
  try { conn = await (deps.connection ?? pooledConnection)(host) } catch { conn = null }
  if (!conn?.connected) {
    log.session.info('owner stop: host daemon not connected, nothing signalled', { sessionId, host, why })
    return 'unreachable'
  }
  const provenance = stopProvenance(conn, initiator)
  if (!provenance) {
    log.session.info('owner stop: not sent, the daemon cannot check ownership', { sessionId, host, why })
    return 'refused'
  }
  try {
    const reply = await conn.send('stop', { sid: sessionId, reason, ...provenance }, OWNER_STOP_TIMEOUT_MS)
    const stopped = reply.ok === true && reply.stopped === true
    log.session.info('owner stop: daemon answered', {
      sessionId, host, why, reason, stopped,
      ...(reply.noop ? { noop: true } : {}),
      ...(typeof reply.reason === 'string' ? { daemonReason: reply.reason } : {}),
      ...(typeof reply.detail === 'string' ? { detail: reply.detail } : {}),
      ...(typeof reply.error === 'string' ? { error: reply.error } : {}),
    })
    return stopped ? 'stopped' : 'refused'
  } catch (err) {
    log.session.warn('owner stop: request failed, nothing signalled', {
      sessionId, host, why, error: err instanceof Error ? err.message : String(err),
    })
    return 'unknown'
  }
}

/**
 * End a detached ACP session's worker through the daemon that hosts it (the
 * ACP worker is a daemon child keyed by its runtime id; the server never holds
 * its pid). No ACP command can check ownership yet, so an ephemeral server only
 * ever asks its OWN local daemon (an isolated one): a remote host's daemon is
 * shared with production, and a copied record carries production's runtime id.
 */
export async function stopAcpThroughOwner(
  row: Pick<SessionRecord, 'claudeSessionId' | 'host' | 'acpRuntimeId'>,
  why: string,
  deps: Partial<OwnerStopDeps> = {},
  opts: { ephemeral?: boolean } = {},
): Promise<OwnerStopOutcome> {
  const sessionId = row.claudeSessionId
  const host = ownerHostKey(row)
  const runtimeId = row.acpRuntimeId
  if (typeof runtimeId !== 'string' || !runtimeId) {
    log.session.info('owner acp stop: record names no ACP runtime, nothing to stop', { sessionId, host, why })
    return 'refused'
  }
  if ((opts.ephemeral ?? IS_EPHEMERAL) && host !== '__local__') {
    log.session.info('owner acp stop: not sent, a test server never stops ACP work on a shared host', { sessionId, host, why })
    return 'refused'
  }
  let conn: OwnerConnection | null = null
  try { conn = await (deps.connection ?? pooledConnection)(host) } catch { conn = null }
  if (!conn?.connected) {
    log.session.info('owner acp stop: host daemon not connected, nothing stopped', { sessionId, host, why })
    return 'unreachable'
  }
  try {
    const reply = await conn.send('acpStop', { sid: runtimeId }, OWNER_STOP_TIMEOUT_MS)
    const stopped = reply.ok === true && reply.stopped === true
    log.session.info('owner acp stop: daemon answered', {
      sessionId, host, why, runtimeId, stopped,
      ...(typeof reply.error === 'string' ? { error: reply.error } : {}),
    })
    return stopped ? 'stopped' : 'refused'
  } catch (err) {
    log.session.warn('owner acp stop: request failed', {
      sessionId, host, why, runtimeId, error: err instanceof Error ? err.message : String(err),
    })
    return 'unknown'
  }
}

// ── Orphan sweep ──────────────────────────────────────────────────────────

export interface OrphanSweepDeps extends OwnerStopDeps {
  /** The record as stored right now (the sweep's input may be seconds old). */
  reread(sid: string): Promise<SessionRecord | null>
  /** Tell the in-memory session its coming death is expected; returns the undo. */
  markExpectedTeardown(sid: string, reason: string): Promise<(() => void) | undefined>
  now(): number
}

export type OrphanOutcome =
  | { sessionId: string; host: string; pid: number; result: 'ended' }
  | { sessionId: string; host: string; pid: number; result: 'left'; reason: string; detail?: string }

/**
 * Why a record is NOT an orphan candidate, or null when it is one. Pure field
 * reads: no syscall, no RPC. A candidate is a CLI record that says it was
 * deliberately ended (END_DECIDED_REASONS), still carries a usable pid, has no
 * user stop still being delivered, and has been in that state past the grace.
 */
export function orphanCandidateSkip(s: SessionRecord, nowMs: number): string | null {
  if (typeof s.pid !== 'number' || !Number.isSafeInteger(s.pid) || s.pid <= 1) return 'no_pid'
  if (s.provider === 'embedded' || s.provider === 'sdk') return 'not_cli'
  if (!engineCaps(s.engine).sidLivenessProbe) return 'not_cli'
  if (s.process_status !== 'stopped' && s.process_status !== 'error') return 'not_terminal'
  if (typeof s.status_reason !== 'string' || !END_DECIDED_REASONS.has(s.status_reason)) return 'not_terminal'
  // A pending user stop is the stop coordinator's to deliver (session-stop.ts).
  if (s.stopRequest?.state === 'pending') return 'stop_pending'
  const changedAt = Date.parse(s.last_status_change ?? s.lastActiveAt ?? '')
  if (!Number.isFinite(changedAt) || nowMs - changedAt < ORPHAN_GRACE_MS) return 'grace'
  return null
}

async function defaultReread(sid: string): Promise<SessionRecord | null> {
  const { getSessionByClaudeId } = await import('../session-tracker.js')
  return getSessionByClaudeId(sid)
}

async function defaultMarkExpectedTeardown(sid: string, reason: string): Promise<(() => void) | undefined> {
  // Dynamic: the runner imports this module, so a static import back is a cycle.
  try {
    const { sessionRunner } = await import('../../providers/claude-code-session.js')
    return sessionRunner.markExpectedTeardown(sid, reason)
  } catch {
    return undefined // runner unavailable: no in-memory session to mark
  }
}

const defaultOrphanDeps: OrphanSweepDeps = {
  connection: pooledConnection,
  reread: defaultReread,
  markExpectedTeardown: defaultMarkExpectedTeardown,
  now: () => Date.now(),
}

let sweepInFlight: Promise<OrphanOutcome[]> | null = null

/**
 * End orphaned CLI processes through the daemons that own them. Single-flight
 * across every caller: the runner fires this on each session start and the
 * health monitor on its slow cadence, and one sweep at a time is plenty.
 * `deps` overrides the defaults piecemeal (tests stub all of them).
 */
export function sweepOrphansThroughOwner(
  rows: readonly SessionRecord[],
  source: string,
  deps: Partial<OrphanSweepDeps> = {},
): Promise<OrphanOutcome[]> {
  if (sweepInFlight) return sweepInFlight
  const run = runSweep(rows, source, { ...defaultOrphanDeps, ...deps }).finally(() => { sweepInFlight = null })
  sweepInFlight = run
  return run
}

async function runSweep(rows: readonly SessionRecord[], source: string, deps: OrphanSweepDeps): Promise<OrphanOutcome[]> {
  const nowMs = deps.now()
  const seen = new Set<string>()
  const candidates: SessionRecord[] = []
  for (const s of rows) {
    if (seen.has(s.claudeSessionId)) continue
    seen.add(s.claudeSessionId)
    if (orphanCandidateSkip(s, nowMs) === null) candidates.push(s)
  }
  if (candidates.length === 0) return []

  // One request per sid, concurrently: each waits under the daemon's own per-sid
  // gate, and the slowest (a process that needs SIGTERM) takes about 7s.
  const outcomes = await Promise.all(candidates.map((s) => askOwner(s, source, deps)))
  const ended = outcomes.filter((o) => o.result === 'ended').length
  if (ended > 0) log.session.info('orphan sweep: owning daemons ended orphaned sessions', { source, count: ended })
  return outcomes
}

async function askOwner(s: SessionRecord, source: string, deps: OrphanSweepDeps): Promise<OrphanOutcome> {
  const sessionId = s.claudeSessionId
  const host = ownerHostKey(s)
  const pid = s.pid as number
  const left = (reason: string, detail?: string): OrphanOutcome => {
    log.session.info('orphan sweep: left alone', { source, sessionId, host, pid, reason, ...(detail ? { detail } : {}) })
    return { sessionId, host, pid, result: 'left', reason, ...(detail ? { detail } : {}) }
  }
  try {
    const conn = await deps.connection(host)
    if (!conn?.connected) return left('owner_unreachable')
    // Old daemon, or hello not answered yet: no ownership answer, so no request.
    if (!conn.hasCapability(ORPHAN_STOP_CAPABILITY)) return left('no_ownership_capability')

    const current = await deps.reread(sessionId)
    if (!current || current.pid !== pid || ownerHostKey(current) !== host
        || orphanCandidateSkip(current, deps.now()) !== null) {
      return left('record_changed')
    }

    const undo = await deps.markExpectedTeardown(sessionId, 'orphan_cleanup')
    let reply: Record<string, unknown>
    try {
      // `home` names this Walnut: a remote daemon is shared by every Walnut that
      // reaches it, and ends only what its spawn journal records as started for us.
      reply = await conn.send('stop', { sid: sessionId, reason: 'orphan', expectPid: pid, home: WALNUT_HOME }, OWNER_STOP_TIMEOUT_MS)
    } catch (err) {
      undo?.()
      return left('request_failed', err instanceof Error ? err.message : String(err))
    }
    if (reply.ok === true && reply.stopped === true) {
      log.session.warn('orphan sweep: owning daemon ended an orphaned session', {
        source, sessionId, taskId: s.taskId, host, pid, status_reason: s.status_reason,
      })
      return { sessionId, host, pid, result: 'ended' }
    }
    undo?.()
    if (reply.ok !== true) return left('daemon_error', typeof reply.error === 'string' ? reply.error : undefined)
    return left(
      typeof reply.reason === 'string' ? reply.reason : 'refused',
      typeof reply.detail === 'string' ? reply.detail : undefined,
    )
  } catch (err) {
    return left('sweep_error', err instanceof Error ? err.message : String(err))
  }
}
