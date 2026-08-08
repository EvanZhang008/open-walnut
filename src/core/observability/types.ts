/**
 * Forensic Observability — shared types (the contract every module depends on).
 *
 * Background: Ops issues (delivery stalls, slowness anywhere in
 * browser→server→daemon→CLI→Bedrock, UI flashing) don't reproduce and the user
 * can only hand over a sessionId. The worst class is "silent success" — the CLI
 * reports result/success but the turn was truncated (stop_reason=null), so no
 * error fires. This module makes the system record a fat record per turn and
 * assert what a *healthy* turn looks like, so those bugs get caught the moment
 * they happen instead of hours of cross-layer grep later.
 */

/**
 * One fat record per completed turn — the single source that feeds metrics,
 * the invariant engine, and (later) OTel export. Carries text (log), numbers
 * (metric), and correlation keys (trace) all in one row, so any later question
 * is a single query (e.g. "WHERE stopReason IS NULL" → every truncation).
 */
export interface TurnEvent {
  /** Claude session id — the universal join key across every layer. */
  sessionId: string;
  taskId?: string;
  /** Host alias (e.g. 'clouddev') or null/undefined for local. */
  host?: string | null;
  /** Reported model id from the CLI init/result events. */
  model?: string;
  /** Transport liveness flag at result time (FIFO open?). */
  hasPipe?: boolean;
  /** Process pid if known. */
  pid?: number | null;

  // ── turn outcome (from the CLI's JSONL `result` + last assistant message) ──
  /** CLI's result.is_error. */
  isError?: boolean;
  /** result.subtype, e.g. 'success' | 'error_max_turns'. */
  subtype?: string;
  /** result.num_turns. */
  numTurns?: number;
  /**
   * stop_reason of the LAST assistant message in the turn. The truncation bug
   * fingerprint is `subtype=success` (or isError=false) with stopReason=null —
   * the stream cut off mid-message but the CLI still reported success.
   */
  stopReason?: string | null;
  /** result.duration_ms — wall time of the turn per the CLI. */
  durationMs?: number;
  /** Length of the result text (chars) — a near-zero success is suspicious. */
  resultLen?: number;

  // ── delivery (from logDeliveryLatency) ──
  /** enqueue→delivered latency of the message(s) that triggered this turn. */
  deliveryMs?: number;
  /** Which delivery path: 'stdin' | 'mid-turn' | 'resume'. */
  deliveryPath?: string;

  /** Count of API 4xx/5xx retries observed during the turn (if tracked). */
  apiRetries?: number;
  /** Whether a Claude Code Team was active (suppresses some invariants). */
  teamActive?: boolean;
  /** Whether a dynamic-workflow / background subagent set was still in flight
   *  (suppresses the same intermediate-result invariants as teamActive). */
  backgroundActive?: boolean;

  /** Epoch ms when this turn event was stamped. */
  ts: number;
}

/** Severity of an invariant violation. */
export type InvariantSeverity = 'warn' | 'error';

/** A single invariant rule: given a TurnEvent, is this turn unhealthy? */
export interface InvariantRule {
  /** Stable id, e.g. 'truncated-success'. */
  id: string;
  /** One-line human description of what healthy looks like. */
  description: string;
  severity: InvariantSeverity;
  /**
   * Return a non-empty reason string when the rule is VIOLATED (unhealthy),
   * or null/undefined when the turn looks healthy for this rule. Pure + sync —
   * runs on the hot path at turn completion.
   */
  check: (turn: TurnEvent) => string | null | undefined;
}

/** Result of evaluating all invariants against a turn. */
export interface InvariantViolation {
  ruleId: string;
  severity: InvariantSeverity;
  reason: string;
}

/** How an incident came to exist. */
export type IncidentTrigger = 'invariant' | 'manual' | 'canary' | 'client';

/** Lifecycle status of an incident. */
export type IncidentStatus = 'open' | 'investigating' | 'resolved' | 'dismissed';

/**
 * A first-class "problem case file": id + the sid it concerns + an evidence
 * bundle path + auto label + status. Persisted so incidents accumulate into a
 * corpus we can later mine for triggers ("7/8 truncations = opus-4-8 + remote").
 */
export interface Incident {
  id: string;
  sessionId: string;
  taskId?: string;
  trigger: IncidentTrigger;
  /** Short auto-label, e.g. 'truncated-success' or a diagnose() cause. */
  label: string;
  /** Human-readable one-liner shown in lists / notifications. */
  summary: string;
  severity: InvariantSeverity;
  status: IncidentStatus;
  /** Absolute path to the captured evidence bundle directory (if captured). */
  bundlePath?: string;
  /** The violations that opened it (for invariant-triggered incidents). */
  violations?: InvariantViolation[];
  /** Snapshot of the turn event that opened it (if any). */
  turn?: TurnEvent;
  createdAt: number;
  updatedAt: number;
}
