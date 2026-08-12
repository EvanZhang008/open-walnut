/**
 * Disk watermark monitor — the guard the 2026-08-12 ENOSPC outage was missing.
 *
 * The cloud companion's root filesystem filled to 100% (un-gc'd git repos +
 * push-quarantine debris) and the first symptom anyone saw was a task write
 * dying mid-lock with ENOSPC. Nothing warned earlier, and nothing stopped
 * git-sync from appending pack files to a nearly-full disk.
 *
 * This module watches the data-dir filesystem with a cheap statfs (a syscall —
 * never a child process, so it can run forever on the event loop):
 *
 *   - WARN:     loud feed notification ("disk filling up") — same surface as
 *     git-sync's "Data Sync Paused" notification.
 *   - CRITICAL: git-sync flips to pull-only mode (no commits, no pushes — a
 *     push packs objects locally too) and mutating API routes answer
 *     507 Insufficient Storage instead of crashing with ENOSPC
 *     (see src/web/middleware/disk-guard.ts).
 *
 * Each level requires BOTH a high used-percent AND a low absolute free-byte
 * count. Percent alone is a trap: macOS APFS keeps purgeable snapshots, so a
 * healthy Mac reports 90%+ "used" while tens of GB are reclaimable — a
 * percent-only trigger would have put the primary box into write-block on the
 * day this shipped. Absolute-free alone is the opposite trap (a tiny dedicated
 * volume would trip while mostly empty). Requiring both matches the incident
 * (100% used, 0 bytes free) and nothing else.
 *
 * Thresholds carry hysteresis so a filesystem hovering at a boundary doesn't
 * flap notifications and safe mode on every poll.
 *
 * Fail-open by design: if statfs itself errors, the previous state is kept and
 * writes are never blocked because of a monitoring failure.
 */

import fsp from 'node:fs/promises';
import { WALNUT_HOME } from '../constants.js';
import { setDiskPullOnly } from '../integrations/git-sync.js';
import { log } from '../logging/index.js';

export type WatermarkLevel = 'ok' | 'warn' | 'critical';

const GiB = 1024 * 1024 * 1024;

/** WARN when used% ≥ this AND free ≤ WARN_MIN_AVAIL_BYTES. */
export const WARN_PCT = 80;
export const WARN_MIN_AVAIL_BYTES = 10 * GiB;
/** CRITICAL (block writes, git pull-only) when used% ≥ this AND free ≤ CRITICAL_MIN_AVAIL_BYTES. */
export const CRITICAL_PCT = 90;
export const CRITICAL_MIN_AVAIL_BYTES = 5 * GiB;
/** Hysteresis: leave a level only once used% drops this many points below entry. */
export const HYSTERESIS_PCT = 2;
/** Hysteresis on the absolute-free condition (bytes must recover past this margin). */
export const HYSTERESIS_AVAIL_BYTES = 512 * 1024 * 1024;

const DEFAULT_POLL_INTERVAL_MS = 60_000;

export interface DiskWatermarkState {
  level: WatermarkLevel;
  /** df-style used percent of the data-dir filesystem (0–100, rounded). */
  usedPct: number;
  /** Bytes available to an unprivileged writer (statfs bavail × bsize). */
  availBytes: number;
  /** Path whose filesystem is being watched. */
  path: string;
  /** ISO timestamp of the last successful statfs. */
  checkedAt: string | null;
}

let state: DiskWatermarkState = {
  level: 'ok',
  usedPct: 0,
  availBytes: Number.MAX_SAFE_INTEGER,
  path: WALNUT_HOME,
  checkedAt: null,
};

/** One warn per outage for statfs failures — a broken statfs must not spam. */
let statfsFailureLogged = false;

interface StatfsLike {
  bsize: number | bigint;
  blocks: number | bigint;
  bfree: number | bigint;
  bavail: number | bigint;
}

// Injectable for tests/E2E: swap the statfs syscall for a fake that reports a
// chosen fill level. Production never touches this.
type StatfsFn = (dir: string) => Promise<StatfsLike>;
let statfsImpl: StatfsFn = (dir) => fsp.statfs(dir);

export function _setStatfsForTest(fn: StatfsFn | null): void {
  statfsImpl = fn ?? ((dir) => fsp.statfs(dir));
}

/** Test hook: reset to a clean 'ok' state (and release any pull-only latch). */
export function resetDiskWatermarkForTest(): void {
  state = { level: 'ok', usedPct: 0, availBytes: Number.MAX_SAFE_INTEGER, path: WALNUT_HOME, checkedAt: null };
  statfsFailureLogged = false;
  setDiskPullOnly(false, { reason: 'test-reset' });
}

/**
 * df-compatible used percent: used / (used + available-to-unprivileged).
 * Uses bavail (not bfree) so root-reserved blocks count as used — matching
 * what `df` prints and what a non-root process can actually allocate.
 */
export function usedPercent(f: StatfsLike): number {
  const blocks = Number(f.blocks);
  const bfree = Number(f.bfree);
  const bavail = Number(f.bavail);
  const used = blocks - bfree;
  const denom = used + bavail;
  if (!Number.isFinite(denom) || denom <= 0) return 0;
  return Math.round((used / denom) * 100);
}

/**
 * Pure threshold logic with hysteresis — exported for direct unit testing.
 * A level is ENTERED when both its percent and absolute-free conditions hold;
 * it is LEFT only once either condition recovers past the hysteresis margin.
 */
export function nextLevel(usedPct: number, availBytes: number, prev: WatermarkLevel): WatermarkLevel {
  const critEnter = usedPct >= CRITICAL_PCT && availBytes <= CRITICAL_MIN_AVAIL_BYTES;
  const critHold = usedPct >= CRITICAL_PCT - HYSTERESIS_PCT
    && availBytes <= CRITICAL_MIN_AVAIL_BYTES + HYSTERESIS_AVAIL_BYTES;
  if (critEnter || (prev === 'critical' && critHold)) return 'critical';

  const warnEnter = usedPct >= WARN_PCT && availBytes <= WARN_MIN_AVAIL_BYTES;
  const warnHold = usedPct >= WARN_PCT - HYSTERESIS_PCT
    && availBytes <= WARN_MIN_AVAIL_BYTES + HYSTERESIS_AVAIL_BYTES;
  if (warnEnter || (prev !== 'ok' && warnHold)) return 'warn';

  return 'ok';
}

export function getDiskWatermarkState(): Readonly<DiskWatermarkState> {
  return { ...state };
}

/** True while mutating routes must answer 507 (see disk-guard middleware). */
export function isDiskWriteBlocked(): boolean {
  return state.level === 'critical';
}

export type WatermarkNotify = (title: string, body: string, dedupScope: string) => void;

function fmtGiB(bytes: number): string {
  return `${(bytes / GiB).toFixed(1)}GB`;
}

/**
 * One poll: statfs → level transition → side effects (notify + git pull-only).
 * Exported so tests/E2E can force an immediate evaluation instead of waiting
 * out the interval.
 */
export async function pollDiskWatermarkOnce(notify?: WatermarkNotify, dir = WALNUT_HOME): Promise<DiskWatermarkState> {
  let usedPct: number;
  let availBytes: number;
  try {
    const f = await statfsImpl(dir);
    usedPct = usedPercent(f);
    availBytes = Number(f.bavail) * Number(f.bsize);
  } catch (err) {
    // Fail open: keep the previous state, never block writes on monitor failure.
    if (!statfsFailureLogged) {
      statfsFailureLogged = true;
      log.web.warn('disk-watermark statfs failed — monitor is blind (fail-open, writes stay allowed)', {
        dir,
        error: err instanceof Error ? err.message : String(err),
      });
    }
    return { ...state };
  }
  statfsFailureLogged = false;

  const prev = state.level;
  const level = nextLevel(usedPct, availBytes, prev);
  state = { level, usedPct, availBytes, path: dir, checkedAt: new Date().toISOString() };

  if (level !== prev) {
    if (level === 'critical') {
      log.web.error('disk-watermark CRITICAL — data disk nearly full; write routes answer 507, git-sync pull-only', {
        usedPct, availBytes, dir,
      });
      notify?.(
        'Data Disk Critically Full',
        `The data disk is ${usedPct}% full (${fmtGiB(availBytes)} free). Writes are paused (507) and data sync `
        + 'is pull-only until space is freed. Free disk space (old logs, git gc) to resume.',
        'disk:critical',
      );
    } else if (level === 'warn') {
      // Covers both ok→warn (getting worse) and critical→warn (recovering).
      if (prev === 'ok') {
        log.web.warn('disk-watermark WARN — data disk filling up', { usedPct, availBytes, dir });
        notify?.(
          'Data Disk Filling Up',
          `The data disk is ${usedPct}% full with only ${fmtGiB(availBytes)} free. `
          + `Below ${fmtGiB(CRITICAL_MIN_AVAIL_BYTES)} free, writes will pause to protect data integrity. `
          + 'Free disk space soon.',
          'disk:warn',
        );
      } else {
        log.web.warn('disk-watermark recovered from critical — writes resume', { usedPct, availBytes, dir });
      }
    } else {
      log.web.info('disk-watermark back to ok', { usedPct, availBytes, dir });
    }
  }

  // Idempotent (setDiskPullOnly no-ops on same value) — asserting it every poll
  // keeps git-sync honest even if some other code path cleared the flag.
  setDiskPullOnly(level === 'critical', { usedPct, availBytes, dir });

  return { ...state };
}

export interface DiskWatermarkHandle {
  stop: () => void;
  /** Force an immediate poll (used by tests and manual diagnostics). */
  poll: () => Promise<DiskWatermarkState>;
}

/**
 * Start the periodic monitor. Cheap enough to run on every box (one statfs
 * per minute); the caller supplies the notification sink so this module never
 * imports the web layer.
 */
export function startDiskWatermarkMonitor(opts: {
  notify?: WatermarkNotify;
  intervalMs?: number;
  dir?: string;
} = {}): DiskWatermarkHandle {
  const intervalMs = opts.intervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  const dir = opts.dir ?? WALNUT_HOME;

  // First check shortly after boot (not instantly — let startup I/O settle).
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  const tick = async (): Promise<void> => {
    try {
      await pollDiskWatermarkOnce(opts.notify, dir);
    } finally {
      if (!stopped) {
        timer = setTimeout(() => { void tick(); }, intervalMs);
        timer.unref?.();
      }
    }
  };
  timer = setTimeout(() => { void tick(); }, Math.min(5_000, intervalMs));
  timer.unref?.();

  log.web.info('disk-watermark monitor started', {
    dir,
    intervalMs,
    warnPct: WARN_PCT,
    criticalPct: CRITICAL_PCT,
    warnMinAvailBytes: WARN_MIN_AVAIL_BYTES,
    criticalMinAvailBytes: CRITICAL_MIN_AVAIL_BYTES,
  });

  return {
    stop() {
      stopped = true;
      if (timer) clearTimeout(timer);
    },
    poll: () => pollDiskWatermarkOnce(opts.notify, dir),
  };
}
