/**
 * "Which daemon runs this trigger, and can it?" — the ONE answer, shared by
 * save-time validation, the `check-test` route and "Run now".
 *
 * A check is host work (docs/plan/walnut-trigger.md): the script reads that
 * host's files and runs that host's tools, and the daemon there owns the clock,
 * the dedup state and the fire queue. So every trigger path starts by resolving
 * a CONNECTED daemon that advertises `triggers-v1`, and the two failure modes
 * are deliberately different answers:
 *
 *   - connected but old  → 400: the user's input is fine, the host needs a
 *                          newer daemon (auto-deploys on the next send).
 *   - not connected      → 503: nothing is wrong with the request; come back.
 *
 * The lookup is a settable seam because a real `triggers-v1` daemon needs a
 * deployed binary, which no test server has. Production never touches it.
 */

import { SessionControlError } from '../sessions/session-controls.js';

export const TRIGGERS_CAPABILITY = 'triggers-v1';

/** The slice of DaemonConnection every trigger path needs. */
export interface TriggerDaemon {
  host: string;
  hasCapability(cap: string): boolean;
  send(cmd: string, params?: Record<string, unknown>, timeoutMs?: number): Promise<{ ok: boolean; error?: string;[key: string]: unknown }>;
  /**
   * True once this server's `triggers.configure` was accepted on the live
   * connection, i.e. the daemon's armed set is ours. Absent/false means a fire
   * for an unknown id may be another server's and must not be acked.
   */
  readonly triggersPushed?: boolean;
}

export type TriggerDaemonLookup = (host: string) => TriggerDaemon | null;

let lookupOverride: TriggerDaemonLookup | null = null;

/**
 * Test seam (@internal): stand in for the daemon pool. Pass null to restore the
 * real lookup — always do that in afterEach, or the next file inherits a fake.
 */
export function setTriggerDaemonLookupForTest(fn: TriggerDaemonLookup | null): void {
  lookupOverride = fn;
}

/** A cold local daemon is spawned and dialed on demand; this bounds that wait. */
const LOCAL_WARM_TIMEOUT_MS = 20_000;

/**
 * The connected daemon for a host, or null. A REMOTE host is never dialed here (a
 * route must not pay for SSH; the host warmup and the sessions keep those pools
 * warm). The LOCAL daemon is different: on a fresh install nothing has connected
 * it yet when the first `/walnut-trigger` arrives, and answering "not connected"
 * about the user's own machine would be wrong, so it is warmed on demand.
 */
export async function findTriggerDaemon(host: string): Promise<TriggerDaemon | null> {
  if (lookupOverride) return lookupOverride(host);
  // Lazy: daemon-connection pulls in the whole session stack, and cron/routines
  // are imported from it in the other direction.
  const dc = await import('../../providers/daemon-connection.js');
  const pooled = dc.getConnectedDaemonConnection(host);
  if (pooled || host !== '__local__') return pooled;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      dc.getDaemonConnection('__local__', { hostname: '__local__' }),
      new Promise<null>((resolve) => { timer = setTimeout(() => resolve(null), LOCAL_WARM_TIMEOUT_MS); }),
    ]);
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/** Normalize a host value from user/agent input. */
export function triggerHost(raw: unknown): string {
  return typeof raw === 'string' && raw.trim() ? raw.trim() : '__local__';
}

/**
 * The daemon that will run this check, or a SessionControlError naming which of
 * the two problems it is.
 */
export async function requireTriggerDaemon(host: string): Promise<TriggerDaemon> {
  const conn = await findTriggerDaemon(host);
  if (!conn) {
    throw new SessionControlError(`daemon on ${host} is not connected — a trigger runs on its host, so it cannot be saved while that host is unreachable`, 503);
  }
  if (!conn.hasCapability(TRIGGERS_CAPABILITY)) {
    throw new SessionControlError(`upgrade the daemon on ${host} (it auto-deploys on the next send)`, 400);
  }
  return conn;
}

/** Same resolution, as a reason string instead of a throw (for "Run now"). */
export async function triggerDaemonOrReason(host: string): Promise<{ conn: TriggerDaemon } | { reason: string }> {
  try {
    return { conn: await requireTriggerDaemon(host) };
  } catch (err) {
    return { reason: err instanceof Error ? err.message : String(err) };
  }
}
