/**
 * Cloud REPLICA: WHICH HOST runs a given session, plus the little the send /
 * stream / transcript paths need about it (cwd, model, stop fence).
 *
 * ## Why this file exists
 *
 * The session projection is a bounded LIST projection ("what to show"), and it
 * was being used as an EXISTENCE oracle ("does it exist"); existence is the
 * primary's to answer. buildSessionProjection drops a stopped/error session once
 * its lastActiveAt falls outside STOPPED_RETENTION_DAYS (14 days), so a phone
 * that opened an old coding session — full history rendered from the synced
 * transcript file — got `404 Session not found` on its first send. The 404 was a
 * LOCAL decision on the replica (6ms, no bridge hop) about a session the primary
 * knew perfectly well, and seconds earlier the same replica had relayed `detail`
 * and `model-options` for it successfully.
 *
 * ## Order: cheapest and most authoritative first
 *
 *  1. own registry — a session THIS companion spawned (cloud.exec) never appears
 *     in the Mac-authored projection (core/cloud-owned-session.ts explains why
 *     the order matters in both directions).
 *  2. projection — the synced list. Covers everything the phone normally
 *     touches, at zero network cost.
 *  3. launch seed — a session this replica just launched, before the projection
 *     lands (TTL'd; sessions/launch-seed.ts).
 *  4. the PRIMARY — the same `detail` control relay `GET /sessions/:id` uses
 *     (v1-control-relay.callPrimaryControl over '__local__'). One extra relay
 *     per request, paid ONLY by sessions outside the 14-day list, which is why
 *     there is deliberately no cache here.
 *
 * `null` means the PRIMARY said not_found. A primary that cannot be reached
 * throws PrimaryUnreachableError, and the caller owes the client a retryable
 * 503: a 404 would tell the phone to forget a session that exists.
 */

import type { SessionRecord } from '../types.js';

export interface CloudSessionHost {
  /** Bridge host alias. '__local__' = the primary box's own daemon. */
  host: string;
  cwd?: string;
  model?: string;
  stopRequest?: SessionRecord['stopRequest'];
}

/**
 * The primary could not be asked, so existence is UNKNOWN — never "absent".
 * The message names the PRIMARY, not the session: during the 2026-08-20 DNS
 * incident the user read this family of errors as "my dev box is unreachable"
 * when the missing hop was the Mac.
 */
export class PrimaryUnreachableError extends Error {
  constructor(public readonly reason: string) {
    super('Your primary box (Mac) could not be reached to look up this session — retry when it reconnects');
    this.name = 'PrimaryUnreachableError';
  }
}

/** Projection/record vocabulary: '' (or absent) = the primary box itself. */
const PRIMARY_BRIDGE_ALIAS = '__local__';

function hostAlias(host: unknown): string {
  return typeof host === 'string' && host !== '' ? host : PRIMARY_BRIDGE_ALIAS;
}

/**
 * 10s — the same budget GET /sessions/:id gives its own `detail` relay. The
 * phone abandons a POST at 30s and cloudSend must still answer inside its own
 * 22s deadline, so a stuck primary link has to fail well inside both.
 */
const PRIMARY_DETAIL_TIMEOUT_MS = 10_000;

export async function resolveCloudSessionHost(sessionId: string): Promise<CloudSessionHost | null> {
  // Lazy imports: a relay-only companion must not pull the session registry or
  // the bridge in just to answer from the synced projection.
  const { cloudOwnedSession, cloudOwnedHostAlias } = await import('../cloud-owned-session.js');
  const owned = await cloudOwnedSession(sessionId);
  if (owned) {
    return {
      host: cloudOwnedHostAlias,
      ...(owned.cwd ? { cwd: owned.cwd } : {}),
      ...(owned.model ? { model: owned.model } : {}),
    };
  }

  const { readSessionProjection } = await import('../session-projection.js');
  const row = (await readSessionProjection())?.sessions.find((s) => s.id === sessionId);
  if (row) {
    return { host: hostAlias(row.host), cwd: row.cwd, model: row.model, stopRequest: row.stopRequest };
  }

  const { getLaunchSeed } = await import('./launch-seed.js');
  const seed = getLaunchSeed(sessionId);
  if (seed) return { host: seed.host, cwd: seed.cwd, model: seed.model };

  return askPrimary(sessionId);
}

/**
 * Ask the primary for the record. Reuses the existing `session.control`
 * `detail` relay (never a second bridge protocol) — its reply is
 * getSessionDetail's `{ session, pendingPermissions }`, and the record carries
 * host/cwd/model/stopRequest exactly like a projection row.
 */
async function askPrimary(sessionId: string): Promise<CloudSessionHost | null> {
  const { callPrimaryControl } = await import('../../web/routes/v1-control-relay.js');
  const reply = await callPrimaryControl('detail', sessionId, undefined, PRIMARY_DETAIL_TIMEOUT_MS);
  if (reply.ok) {
    const session = reply.result.session;
    if (!session || typeof session !== 'object') {
      // The primary answered, but not with a record. Unknown, not absent.
      throw new PrimaryUnreachableError('primary detail reply carried no session record');
    }
    const s = session as Record<string, unknown>;
    return {
      host: hostAlias(s.host),
      ...(typeof s.cwd === 'string' && s.cwd ? { cwd: s.cwd } : {}),
      ...(typeof s.model === 'string' && s.model ? { model: s.model } : {}),
      ...(s.stopRequest && typeof s.stopRequest === 'object'
        ? { stopRequest: s.stopRequest as SessionRecord['stopRequest'] }
        : {}),
    };
  }
  // Only the primary can say "no such session". Everything else — no bridge, a
  // relay timeout, a primary that predates the action, an internal failure —
  // leaves existence UNKNOWN, and a guess in either direction is a bug.
  if (reply.failure.kind === 'error' && reply.failure.status === 404) return null;
  throw new PrimaryUnreachableError(
    reply.failure.kind === 'error' ? `${reply.failure.code}: ${reply.failure.message}` : reply.failure.message,
  );
}
