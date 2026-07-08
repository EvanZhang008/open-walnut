/**
 * Forensic Observability — process resource health (file descriptors, memory).
 *
 * Why this exists: prod once accumulated ~16k open fds; every subsequent
 * `spawn('ssh', …)` failed with EBADF, so daemon reconnects could never
 * succeed, remote history reads timed out (30s), and the UI degraded to
 * stale streaming blocks with a fake Streaming badge (inc-1783406628291).
 * The leak itself was invisible until the process died — by then the fd
 * table (the evidence of WHAT leaked) was gone with it.
 *
 * This module makes the leak visible while it is happening:
 *  - getFdCount(): cheap O(1)-ish readdir of the process fd table.
 *  - checkProcessFdHealth(): called from the 30s health-monitor tick; logs a
 *    warn/error when the count crosses bands, throttled so a sustained leak
 *    re-reports every REPORT_EVERY_MS instead of spamming each tick.
 *  - processHealthSnapshot(): one-line summary for evidence bundles.
 */

import fs from 'node:fs';
import { log } from '../../logging/index.js';

/** Above this, something is probably leaking — investigate. */
const FD_WARN_THRESHOLD = 1_000;
/** Above this, spawn/connect failures (EMFILE/EBADF) are imminent or already happening. */
const FD_ERROR_THRESHOLD = 4_000;
/** While inside a band, re-log at most this often. */
const REPORT_EVERY_MS = 10 * 60_000;

let lastBand = 0;
let lastReportAt = 0;

/** Open fd count for this process, or null when the fd table isn't readable. */
export function getFdCount(): number | null {
  const dir = process.platform === 'linux' ? '/proc/self/fd' : '/dev/fd';
  try {
    return fs.readdirSync(dir).length;
  } catch {
    return null;
  }
}

/**
 * Band for a given count: 0 healthy, 1 warn, 2 error. Exported for tests.
 */
export function fdBand(count: number): 0 | 1 | 2 {
  if (count >= FD_ERROR_THRESHOLD) return 2;
  if (count >= FD_WARN_THRESHOLD) return 1;
  return 0;
}

/**
 * Health-monitor tick hook. Logs on band ENTRY immediately, then re-logs every
 * REPORT_EVERY_MS while the band persists (a leak that sits at 5k fds for an
 * hour must not be a single line 55 minutes up-scroll). Recovery back to
 * healthy is logged once so the timeline has a closing bracket.
 */
export function checkProcessFdHealth(now = Date.now()): void {
  const count = getFdCount();
  if (count === null) return;
  const band = fdBand(count);

  if (band === 0) {
    if (lastBand > 0) {
      log.obs.info('process fd count recovered', { fdCount: count });
      lastBand = 0;
    }
    return;
  }

  const bandChanged = band !== lastBand;
  const due = now - lastReportAt >= REPORT_EVERY_MS;
  if (!bandChanged && !due) return;

  lastBand = band;
  lastReportAt = now;
  const fields = {
    fdCount: count,
    warnThreshold: FD_WARN_THRESHOLD,
    errorThreshold: FD_ERROR_THRESHOLD,
    rssMb: Math.round(process.memoryUsage.rss() / 1024 / 1024),
    uptimeSec: Math.round(process.uptime()),
  };
  if (band === 2) {
    log.obs.error('process fd count CRITICAL — spawn EBADF/EMFILE imminent (ssh reconnects will fail)', fields);
  } else {
    log.obs.warn('process fd count elevated — possible leak', fields);
  }
}

/** Reset internal throttle state (tests only). */
export function _resetFdHealthState(): void {
  lastBand = 0;
  lastReportAt = 0;
}

/** One-line process summary for evidence bundles. */
export function processHealthSnapshot(): string {
  const mem = process.memoryUsage();
  return JSON.stringify({
    pid: process.pid,
    fdCount: getFdCount(),
    rssMb: Math.round(mem.rss / 1024 / 1024),
    heapUsedMb: Math.round(mem.heapUsed / 1024 / 1024),
    uptimeSec: Math.round(process.uptime()),
    platform: process.platform,
  }, null, 2);
}
