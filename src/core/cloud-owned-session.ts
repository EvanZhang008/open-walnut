/**
 * "Does THIS cloud box own this session?" — the one question every cloud v1
 * session endpoint has to answer once the companion can execute.
 *
 * ## Why a separate lookup exists at all
 *
 * On a relay-only companion the answer was always "no", so every endpoint
 * resolved a session's host from the Mac-authored projection (plus the TTL'd
 * launch seed) and sent everything over the `/bridge`. A session the companion
 * SPAWNED ITSELF will never appear in that projection — the exporter is behind
 * `if (!CLOUD_MODE)`, `sessions.sqlite` is gitignored, and
 * `sessions/projection.json` must keep exactly one writer (it has no
 * `lastUpdated` content clock, so two writers would hand git-sync's LWW a
 * commit-time coin flip over a whole 500-row list — the 2026-08-23 shape).
 *
 * So ownership is answered from the companion's OWN registry, which is the same
 * `session-tracker` every box uses. That makes the check durable (survives
 * restarts, unlike the 10-minute launch seed) and keeps the two data planes
 * strictly disjoint: the Mac's rows arrive read-only via the projection, ours
 * live only here, and they meet only at read time on this box.
 *
 * ## The ordering rule
 *
 * Own-registry lookup runs BEFORE the projection lookup. Both directions of
 * getting this wrong are real bugs:
 *
 *  - Projection first → an own session that the Mac coincidentally also knows
 *    about (e.g. a stale row from before ownership changed) would be relayed to
 *    the Mac, which has no such CLI process. Sends would land nowhere.
 *  - No own lookup at all → own sessions 404 the moment the launch seed expires.
 *
 * There is no id ambiguity to worry about: ids are UUIDs.
 */

import { CLOUD_MODE } from '../constants.js';
import { readCloudExecConfig, CLOUD_HOST_ALIAS } from './cloud-exec.js';
import { log } from '../logging/index.js';

export interface CloudOwnedSession {
  sessionId: string;
  cwd?: string;
  model?: string;
  processStatus: string;
}

/**
 * Cheap gate so a relay-only companion (the default) pays nothing: no config
 * read, no DB hit, no import of the tracker. Cached because it is consulted on
 * every session request and `cloud.exec.enabled` is not a hot-reload knob (the
 * daemon only starts at boot anyway).
 */
let execEnabled: boolean | null = null;

export async function cloudExecActive(): Promise<boolean> {
  if (!CLOUD_MODE) return false;
  if (execEnabled !== null) return execEnabled;
  try {
    const { getConfig } = await import('./config-manager.js');
    execEnabled = readCloudExecConfig(await getConfig(), true).enabled;
  } catch {
    // Unreadable config → behave as relay-only. Failing open into "this box
    // owns sessions" would make it answer for sessions living on the Mac.
    execEnabled = false;
  }
  return execEnabled;
}

/** Test hook — config is read once per process otherwise. */
export function resetCloudExecCache(): void {
  execEnabled = null;
}

/**
 * The session record if this box owns it, else null. Never throws: a lookup
 * failure must degrade to "not ours" (the relay path), not to a 500.
 */
export async function cloudOwnedSession(sessionId: string): Promise<CloudOwnedSession | null> {
  if (!await cloudExecActive()) return null;
  try {
    const { getSessionByClaudeId } = await import('./session-tracker.js');
    const record = await getSessionByClaudeId(sessionId);
    if (!record) return null;
    // A record with a `host` set was created FOR a remote host — on the cloud
    // box that only happens if config.hosts is populated there, and such a
    // session's CLI is not local. Only host-less records are ours to serve.
    if (record.host) return null;
    return {
      sessionId: record.claudeSessionId,
      ...(record.cwd ? { cwd: record.cwd } : {}),
      ...(record.model ? { model: record.model } : {}),
      processStatus: record.process_status ?? '',
    };
  } catch (err) {
    log.session.warn('cloud-owned session lookup failed — treating as relayed', {
      sessionId, error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}

/**
 * Host alias to report for a cloud-owned session.
 *
 * A locally-created record stores `host: ''`, which in the projection vocabulary
 * means "the primary box". Shipping that verbatim would tell the phone a cloud
 * session lives on the Mac, and its next send would be relayed to a machine
 * with no such process — so own rows are always re-tagged.
 */
export const cloudOwnedHostAlias = CLOUD_HOST_ALIAS;
