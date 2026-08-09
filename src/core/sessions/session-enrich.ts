/**
 * Session record enrichment — live-status correction + hostname resolution.
 * Extracted from src/web/routes/sessions.ts so the /api/v1 mobile routes and
 * the daemon control relay can reuse the exact same logic (one definition of
 * "is this session really alive?").
 */

import { log } from '../../logging/index.js';
import {
  emitSessionStatusChanged,
  toSessionStatusSnapshot,
  updateSessionRecordConditionally,
} from '../session-tracker.js';
import { getConfig } from '../config-manager.js';
import { isSessionProcessAlive } from '../../utils/session-liveness.js';
import type { SessionRecord } from '../types.js';

/** Route-level ceiling on one liveness probe. A remote probe rides
 *  conn.send('status') whose own timeout is 30s — a wedged daemon would hold
 *  the sessions-list response (and one of the browser's 6 connections) that
 *  whole time, on one of the hottest endpoints in the app. Local PID checks
 *  are a sync syscall and never hit this. Timing out resolves `true`
 *  ("assume alive"): remote corrections are skipped anyway (transport
 *  uncertainty ≠ death), and the health monitor owns authoritative
 *  reconciliation on its own 30s cycle. */
const LIVENESS_PROBE_TIMEOUT_MS = 2_500;

function probeWithDeadline(p: Promise<boolean>): Promise<boolean> {
  return Promise.race([
    p,
    new Promise<boolean>((resolve) => {
      const t = setTimeout(() => resolve(true), LIVENESS_PROBE_TIMEOUT_MS);
      t.unref?.();
    }),
  ]);
}

/** Recompute process_status live via PID check (for GET responses).
 *  Runs all PID checks in parallel to avoid blocking the event loop. */
export async function enrichWithLiveStatus(sessions: SessionRecord[]): Promise<SessionRecord[]> {
  // Parallel liveness checks via unified session liveness utility.
  // Routes to local PID check for local sessions, daemon connection check for remote.
  const needsCheck: number[] = [];
  for (let i = 0; i < sessions.length; i++) {
    const s = sessions[i];
    if (s.process_status === 'running' || s.process_status === 'idle') {
      needsCheck.push(i);
    }
  }

  if (needsCheck.length > 0) {
    const results = await Promise.allSettled(
      needsCheck.map((i) => probeWithDeadline(isSessionProcessAlive(sessions[i]))),
    );
    const corrections: Promise<void>[] = [];
    for (let j = 0; j < needsCheck.length; j++) {
      const r = results[j];
      const alive = r.status === 'fulfilled' && r.value === true;
      if (!alive) {
        const index = needsCheck[j];
        const checked = sessions[index];
        // A failed remote liveness check can mean only that the daemon/tunnel
        // is unreachable. GET must not turn transport uncertainty into durable
        // process death; the health monitor owns remote reconciliation.
        if (checked.host) continue;
        // Not-yet-spawned session: the start routes seed the record BEFORE the CLI
        // exists, so for a moment there is legitimately no pid to probe. For those
        // rows "no pid" is absence of evidence, not evidence of death. Keyed off
        // the explicit `status_reason` the seed writes; the window mirrors the
        // health monitor's ORPHAN_GRACE_MS.
        const SPAWN_GRACE_MS = 2 * 60 * 1000;
        if (checked.pid == null && checked.status_reason === 'awaiting_spawn') {
          const since = new Date(checked.last_status_change ?? checked.startedAt ?? 0).getTime();
          if (Date.now() - since < SPAWN_GRACE_MS) continue;
        }
        const checkedStatus = toSessionStatusSnapshot(checked);
        corrections.push((async () => {
          const updated = await updateSessionRecordConditionally(
            checked.claudeSessionId,
            {
              process_status: 'stopped',
              activity: undefined,
              last_status_change: new Date().toISOString(),
              status_reason: 'liveness_check_failed',
              status_changed_by: 'system',
            },
            (current) => {
              const status = toSessionStatusSnapshot(current);
              return status.statusRevision === checkedStatus.statusRevision
                && status.process_status === checkedStatus.process_status
                && (status.process_status === 'running' || status.process_status === 'idle');
            },
          );
          if (!updated) return;
          sessions[index] = updated;
          emitSessionStatusChanged(updated, {}, ['*'], {
            source: 'sessions-route:liveness',
            urgency: 'urgent',
          });
        })());
      }
    }
    await Promise.all(corrections);
  }

  return sessions;
}

/** Resolve host aliases to full hostnames from config (for tooltip display). */
export async function enrichWithHostnames(sessions: SessionRecord[]): Promise<SessionRecord[]> {
  const hostsNeeded = sessions.some((s) => s.host && !s.hostname);
  if (!hostsNeeded) return sessions;
  try {
    const config = await getConfig();
    const hosts = config.hosts;
    if (!hosts) return sessions;
    for (const s of sessions) {
      if (s.host && !s.hostname) {
        const def = hosts[s.host];
        if (def) {
          s.hostname = def.hostname;
        }
      }
    }
  } catch {
    log.session.debug('enrichWithHostnames: config read failed — serving aliases only');
  }
  return sessions;
}
