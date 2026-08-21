/**
 * Forensic Observability — turn recorder (the single hot-path entry point).
 *
 * Called once per completed turn from claude-code-session.ts. It:
 *   1. Emits the wide TURN EVENT as a structured log (`obs` subsystem) — this is
 *      the metric source (deliveryMs/durationMs/numTurns…) and the trace anchor.
 *   2. Runs the invariant engine; on violation, opens an Incident (auto-captures
 *      an evidence bundle + notifies) via the registered incident sink.
 *
 * The incident sink is injected (registerIncidentSink) so the heavy modules
 * (bundle capture, persistence, notification) can be built and wired separately
 * without this hot-path module importing them directly. If no sink is
 * registered, violations are still logged — recording never depends on the sink.
 */

import { log } from '../../logging/index.js';
import { evaluateInvariants } from './invariants.js';
import { observe } from './metrics.js';
import type { InvariantViolation, TurnEvent } from './types.js';

/**
 * Sink that turns invariant violations into a durable incident (+ bundle +
 * notification). Implemented by the incident module and registered at startup.
 * Must be fire-and-forget safe; recorder never awaits it on the hot path.
 */
export type IncidentSink = (turn: TurnEvent, violations: InvariantViolation[]) => void;

let incidentSink: IncidentSink | null = null;

/** Register the incident sink (called once at server startup). */
export function registerIncidentSink(sink: IncidentSink): void {
  incidentSink = sink;
}

/**
 * Record one completed turn. Safe to call fire-and-forget — never throws, never
 * blocks delivery. `partial` lets callers omit `ts` (stamped here).
 */
export function recordTurn(partial: Omit<TurnEvent, 'ts'> & { ts?: number }): void {
  try {
    const turn: TurnEvent = { ...partial, ts: partial.ts ?? Date.now() };

    // 1. Wide event — one fat structured record. `obs` subsystem so it's easy to
    // filter (walnut-logs.sh) and later map to an OTel span/metric set.
    log.obs.info('turn', {
      sessionId: turn.sessionId,
      taskId: turn.taskId,
      host: turn.host ?? 'local',
      model: turn.model,
      hasPipe: turn.hasPipe,
      pid: turn.pid ?? null,
      isError: turn.isError,
      subtype: turn.subtype,
      numTurns: turn.numTurns,
      stopReason: turn.stopReason,
      durationMs: turn.durationMs,
      resultLen: turn.resultLen,
      deliveryMs: turn.deliveryMs,
      deliveryPath: turn.deliveryPath,
      firstThinkingMs: turn.firstThinkingMs ?? null,
      firstTextMs: turn.firstTextMs ?? null,
      firstToolMs: turn.firstToolMs ?? null,
      teamActive: turn.teamActive,
      backgroundActive: turn.backgroundActive,
    });

    // 1b. Metrics — the same numbers as histograms, so p50/p90 turn duration and
    // delivery latency are queryable without re-aggregating the wide events.
    if (typeof turn.durationMs === 'number') {
      observe('session.turn.duration', turn.durationMs, { host: turn.host ?? 'local' });
    }
    if (typeof turn.deliveryMs === 'number') {
      observe('session.delivery', turn.deliveryMs, { path: turn.deliveryPath ?? 'unknown' });
    }
    // TTFT histograms — p50/p90 "how long until the user saw anything" per host.
    // A rising session.first_text with flat session.first_thinking = the model
    // is producing text later in the turn (or Bedrock TTFB got worse), NOT a
    // walnut delivery regression.
    const ttftHost = { host: turn.host ?? 'local' };
    if (typeof turn.firstThinkingMs === 'number') observe('session.first_thinking', turn.firstThinkingMs, ttftHost);
    if (typeof turn.firstTextMs === 'number') observe('session.first_text', turn.firstTextMs, ttftHost);
    if (typeof turn.firstToolMs === 'number') observe('session.first_tool', turn.firstToolMs, ttftHost);

    // 2. Invariants — catch "silent success" the moment it happens.
    const violations = evaluateInvariants(turn);
    if (violations.length === 0) return;

    const worst = violations.some(v => v.severity === 'error') ? 'error' : 'warn';
    log.obs[worst === 'error' ? 'error' : 'warn']('invariant violation', {
      sessionId: turn.sessionId,
      taskId: turn.taskId,
      violations: violations.map(v => `${v.ruleId}: ${v.reason}`),
    });

    // 3. Hand off to the incident sink (durable record + bundle + notify).
    // Fire-and-forget: a missing/slow sink must not affect turn completion.
    if (incidentSink) {
      try {
        incidentSink(turn, violations);
      } catch (err) {
        log.obs.warn('incident sink threw', {
          sessionId: turn.sessionId,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
  } catch (err) {
    // Recording must never break a turn.
    log.obs.warn('recordTurn failed', { error: err instanceof Error ? err.message : String(err) });
  }
}
