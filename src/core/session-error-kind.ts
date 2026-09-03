/**
 * session-error-kind — is a session's 'error' status the substrate's fault or the
 * work's fault?
 *
 * ZERO runtime imports on purpose (type-only imports vanish at compile time):
 * session-tracker consults this synchronously inside its write choke point, and
 * both recovery paths (daemon reconnect + the health monitor's 30s loop) consult
 * it too. A leaf module keeps those three out of an import cycle.
 *
 * WHY THIS FILE EXISTS. Recoverability used to be decided by matching prose:
 *
 *     if (!s.errorMessage?.includes('Connection lost')) continue   // skip forever
 *
 * in BOTH `DaemonConnection.recoverDisconnectedSessions` and
 * `SessionHealthMonitor.recoverInfraFailedSessions` (named recoverConnectionLost-
 * Sessions back when the prose match was the contract). Meanwhile the C2 snapshot
 * projection became the authoritative status writer, and it writes 'error' with
 * NO message (by design — it has no richer text to offer). Every
 * snapshot-projected error therefore failed the prose test and was treated as "a
 * real user-visible error, don't auto-recover".
 *
 * 2026-08-22 (incident inc-1787439819342): a remote dev host took its weekly
 * patch reboot mid-build. Walnut saw it correctly (`remote_unreachable`), but
 * that write was a category-① pair, so the gate dropped it whole; the snapshot
 * then projected a message-less 'error'; both recovery loops skipped the session
 * for the next 3.5 hours even though the daemon had been back for over an hour.
 * 51 sessions were sitting in exactly that state. A classification that lives in
 * a string is not a classification.
 *
 * Two tiers, deliberately different bars:
 *   isRecoverableSessionError  — infra OR unknown. Cheap: re-probe, relabel,
 *                                clear a scary badge. Being wrong costs nothing.
 *   shouldAutoResumeSession    — infra ONLY (see session-auto-recover). Spends
 *                                tokens and runs an agent unattended, so an
 *                                unknown cause must not qualify.
 */

import type { SessionErrorKind, SessionRecord, StatusReason } from './types.js'

/**
 * Reasons that mean "the substrate died under a healthy session". Resuming
 * re-establishes the process and the work continues.
 */
export const INFRA_STATUS_REASONS: ReadonlySet<string> = new Set<StatusReason>([
  // The Mac could not reach the execution host (tunnel down, host rebooting).
  'remote_unreachable',
  // The daemon told us the process is gone, or came back without it.
  'daemon_reported_exit',
  // A liveness probe found no process where the record expected one.
  'liveness_check_failed',
  'process_exited_no_result',
  'orphan_no_pid',
  // The Walnut server itself restarted and the CLI did not survive.
  'server_restart',
  // A reconnect/retry path that was already mid-recovery.
  'retry_reconnect',
  // A spawn's daemon `start` timed out / hit a dead connection: the command may
  // still execute daemon-side after the connection recovers (inc-1787511363340:
  // the "failed" start spawned 15s later and ran for hours behind a terminal
  // record). Unknown outcome is an infra condition — probe, never a verdict.
  'spawn_outcome_unknown',
])

/**
 * Reasons that mean "the work ended the session". Resuming re-asks the same
 * failing question, so these must never auto-resume.
 *
 * `idle_timeout` sits here on purpose: we killed it because nothing was
 * happening, and reviving it would fight our own reaper.
 */
export const TERMINAL_STATUS_REASONS: ReadonlySet<string> = new Set<StatusReason>([
  'user_stopped',
  'user_terminated',
  'expected_teardown',
  'idle_timeout',
  'idle_eviction',
  'normal_completion',
  'turn_completed',
])

/**
 * Infra signatures in free text — the fallback for records written before
 * `errorKind` existed (and for the legacy 'Connection lost' contract the two
 * recovery loops used to key off). Lowercased substring match.
 *
 * Kept SHORT and specific. A generous list here would re-create the original
 * bug in the other direction: auto-resuming a session whose real problem was a
 * refusal or a bad credential, forever.
 */
const INFRA_TEXT_SIGNATURES: readonly string[] = [
  'connection lost',
  'connection closed',
  'connection to ',
  'failed to deploy daemon',
  'failed to start daemon',
  'daemon spawn failed',
  'host unreachable',
  'no route to host',
  'ssh tunnel',
  'broken pipe',
]

/**
 * Reasons whose diagnosis is a claim about the TRANSPORT itself ("we could not
 * reach the host"), as opposed to a claim about the session's own fate.
 *
 * Such a claim has a validity condition the record cannot express: it is only
 * true while the host is out of contact. Any first-hand evidence FROM that host
 * disproves it — you cannot receive a daemon's fold over a connection you do not
 * have. A consumer holding such evidence must therefore drop the diagnosis
 * rather than carry it forward (see the 'error' branch of applySnapshot).
 *
 * Kept to reachability reasons ONLY. `daemon_reported_exit` deliberately stays
 * out: "the daemon says the process is gone" survives a reconnect intact, and
 * discarding it would trade a stale claim for no information at all.
 */
const REACHABILITY_CLAIM_REASONS: ReadonlySet<string> = new Set<StatusReason>([
  'remote_unreachable',
])

/**
 * True when this record's current diagnosis asserts its host is unreachable.
 *
 * Structural on purpose (`status_reason`, never the message text): the whole
 * point of this module is that a classification living in a string is not a
 * classification. The reason is also what pins the claim's lifetime — a
 * projection that overwrites `status_reason` orphans the prose that belonged to
 * it, which is exactly how "Connection lost — unable to reach remote host"
 * outlived its outage by hours on a host that had been answering the whole time.
 */
export function assertsHostUnreachable(record: Pick<SessionRecord,
  'status_reason' | 'errorMessage'>): boolean {
  if (!record.errorMessage) return false
  return typeof record.status_reason === 'string'
    && REACHABILITY_CLAIM_REASONS.has(record.status_reason)
}

/** Map a status_reason to a cause class. Unknown/absent reasons return undefined. */
export function classifyStatusReasonKind(reason: unknown): SessionErrorKind | undefined {
  if (typeof reason !== 'string') return undefined
  if (INFRA_STATUS_REASONS.has(reason)) return 'infra'
  if (TERMINAL_STATUS_REASONS.has(reason)) return 'terminal'
  return undefined
}

/**
 * Classify a session record's error cause.
 *
 * Order matters: the STRUCTURED field wins over the reason, and the reason wins
 * over prose. `api_error` deliberately stays 'unknown' here — transient upstream
 * failures are already owned by the daemon's turn-retry layer and by
 * session-auto-continue, and the terminal half of that bucket (auth, refusal,
 * context overflow) must never be resumed by this path.
 */
export function classifySessionError(record: Pick<SessionRecord,
  'errorKind' | 'status_reason' | 'errorMessage'>): SessionErrorKind | 'unknown' {
  if (record.errorKind === 'infra' || record.errorKind === 'terminal') return record.errorKind

  const byReason = classifyStatusReasonKind(record.status_reason)
  if (byReason) return byReason

  const text = record.errorMessage?.toLowerCase()
  if (text && INFRA_TEXT_SIGNATURES.some((sig) => text.includes(sig))) return 'infra'

  return 'unknown'
}

/**
 * Worth re-probing and relabelling. Includes 'unknown': a message-less error is
 * exactly the shape the incident produced, and refusing to look at it is what
 * stranded 51 sessions. Only a positively TERMINAL cause is left alone.
 */
export function isRecoverableSessionError(record: Pick<SessionRecord,
  'errorKind' | 'status_reason' | 'errorMessage'>): boolean {
  return classifySessionError(record) !== 'terminal'
}

/** True when the cause is positively infrastructure — the bar for spending
 *  tokens on an unattended auto-resume. */
export function isInfraSessionError(record: Pick<SessionRecord,
  'errorKind' | 'status_reason' | 'errorMessage'>): boolean {
  return classifySessionError(record) === 'infra'
}

/**
 * How long a 'stopped' record stays eligible for a liveness re-probe. A live
 * CLI hiding behind a wrongly-terminal record is by definition recent (the
 * daemon's own idle reaper kills a silent CLI at 2h; a turn tops out well
 * under a day), so anything older is settled truth and not worth an RPC.
 */
export const RESCUABLE_STOPPED_WINDOW_MS = 24 * 60 * 60 * 1000

/**
 * A 'stopped' record that is worth re-probing against the daemon registry.
 *
 * 'stopped' used to be an unconditional dead end: every recovery loop skipped
 * it, so a record wedged at 'stopped' while the CLI lived on was invisible
 * forever (inc-1787511363340: a spawn whose daemon `start` timed out was
 * marked 'stopped', the command executed 15s later anyway, and the session ran
 * for 1.6h behind a "Stopped" badge). The skip is only safe when the stop is
 * POSITIVELY intentional — a user action or a terminal-class reason. Anything
 * else (infra reasons, un-stamped writes, unknown causes) is a claim about
 * process death that the daemon can cheaply confirm or refute.
 *
 * Mirrors isRecoverableSessionError's bar ("being wrong costs nothing" — a
 * probe that finds the process dead changes nothing), plus a recency bound so
 * reconnect passes don't re-probe months of history.
 */
export function isRescuableStoppedRecord(record: Pick<SessionRecord,
  'process_status' | 'errorKind' | 'status_reason' | 'errorMessage'
  | 'status_changed_by' | 'last_status_change'>, nowMs: number = Date.now()): boolean {
  if (record.process_status !== 'stopped') return false
  if (record.status_changed_by === 'user') return false
  if (classifySessionError(record) === 'terminal') return false
  const changedAt = record.last_status_change ? Date.parse(record.last_status_change) : NaN
  // No/unparsable timestamp → treat as settled history, not a fresh wedge.
  if (!Number.isFinite(changedAt)) return false
  return nowMs - changedAt <= RESCUABLE_STOPPED_WINDOW_MS
}
