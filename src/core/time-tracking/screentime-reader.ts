/**
 * Apple Screen Time reader: the iPhone's (and any other synced device's) usage,
 * as macOS itself already holds it.
 *
 * ── Where the data is, and how that was established ──
 *
 * With Screen Time's "Share Across Devices" on, macOS System Settings shows the
 * iPhone's App & Website Activity. That answer comes out of a Core Data store
 * belonging to the ScreenTimeAgent daemon:
 *
 *   $(getconf DARWIN_USER_DIR)com.apple.ScreenTimeAgent/Store/RMAdminStore-Cloud.sqlite
 *
 * Found by `lsof` on the running ScreenTimeAgent rather than by guessing: the
 * paths that documentation and forensics write-ups point at are wrong or
 * incomplete here. `~/Library/Application Support/Knowledge/knowledgeC.db` holds
 * only THIS Mac's own app usage. `~/Library/Application Support/com.apple.
 * remotemanagementd/` (the iOS location) does not exist on macOS. `-Local` is
 * this device, `-Cloud` is the synced set, which is the one with the phone in it.
 *
 * Two traps when re-verifying that with lsof. Its default output TRUNCATES the path
 * to the terminal width, which turns the real answer into a plausible-looking
 * relative fragment: use `-Fn`. And on a machine with an iOS simulator booted there
 * are SEVERAL ScreenTimeAgent processes, one per simulated device, each holding a
 * store of the same name inside its own container. `pgrep` returns the simulator's
 * first, so the process to look at is the one whose executable is under
 * /System/Library/PrivateFrameworks/ScreenTimeCore.framework.
 *
 * The schema was read off a byte-identical, unprotected copy inside an iOS
 * simulator container, so the join could be written and validated without ever
 * touching the real file:
 *
 *   ZCOREDEVICE      one row per device: ZNAME ("iPhone"), ZPLATFORM, ZIDENTIFIER
 *     ← ZUSAGE.ZDEVICE
 *         ← ZUSAGEBLOCK.ZUSAGE        a time block: ZSTARTDATE, ZSCREENTIMEINSECONDS
 *             ← ZUSAGECATEGORY.ZBLOCK category totals ("Entertainment", "Social")
 *                 ← ZUSAGETIMEDITEM.ZCATEGORY   per app (ZBUNDLEIDENTIFIER) and
 *                                               per website (ZDOMAIN), seconds
 *             ← ZUSAGECOUNTEDITEM.ZBLOCK        pickups + notifications per app
 *
 * Timestamps are Core Data TIMESTAMPs: seconds since the Apple epoch
 * (2001-01-01), so +978307200 converts to Unix.
 *
 * ── Two hard constraints this file exists to satisfy ──
 *
 * 1. NEVER WRITE, and not by being careful: sqlite never sees the real path. The
 *    protected files are copied out byte-for-byte through walnut-reader (which
 *    can only write to stdout; src/core/protected-reader.ts runs it inside
 *    Walnut.app when it can) and every query runs against that private copy.
 *    The copy must include `-wal` and `-shm`: this database is in WAL mode with a
 *    multi-megabyte write-ahead log, so the main file alone is hours stale.
 *    Reading the original with `immutable=1` would be the other way to guarantee
 *    no writes, but immutable mode ignores the WAL, which is the same staleness.
 *
 * 2. NEVER BLOCK THE EVENT LOOP: the query runs in `/usr/bin/sqlite3` (a child
 *    process, macOS ships 3.43+, `-json` gives parseable output), not in an
 *    in-process synchronous SQLite binding. One sync multi-megabyte parse on the
 *    server's single event loop freezes every route in the app. The queries
 *    aggregate before returning, so what crosses back is a few hundred rows.
 *
 * ── Full Disk Access, and the failure mode that needs its own message ──
 *
 * The store is TCC-protected (its file mode is world-readable; the wall is
 * entirely TCC), so the reader needs Full Disk Access: Walnut itself when
 * Walnut.app knows `--reader-bridge`, else the walnut-reader helper. FDA cannot
 * be requested programmatically and never prompts, so a missing grant looks
 * exactly like nothing happening.
 *
 * Observed 2026-10-02 on macOS 26: the store's directory refuses even a process
 * that HOLDS Full Disk Access (tccd answered "allowed" for Walnut, and an MDM
 * security agent with the grant logged a sandbox deny on the same directory). So a
 * denial here is not proof of a missing grant; the Permission Doctor judges the
 * grant by every protected file in use (src/core/permissions/darwin-fda.ts).
 *
 * Worse, there are TWO distinct denied states with DIFFERENT fixes, and System
 * Settings makes them look identical:
 *
 *   never granted   the reader is not in the Full Disk Access list. Fix: press
 *                   PLUS and add it.
 *   grant is stale  the reader IS in the list and its toggle still shows ON, but
 *                   the row describes an older build. An ad-hoc signed binary's
 *                   TCC identity includes its content hash, so rebuilding it
 *                   creates a program macOS has never seen. Fix: select the row,
 *                   press MINUS, then press PLUS and add the SAME path back.
 *                   Toggling it off and on does NOT work, and nobody guesses
 *                   this, so the UI has to say it.
 *
 * The TCC database cannot be read to tell these apart, so protected-reader.ts
 * records a marker the first time a read succeeds through a route. Ever-succeeded
 * plus denied-now means stale; never-succeeded means never granted. (A
 * certificate-signed program never reaches the stale state at all, because its
 * identity carries no hash — see src/core/helper-build.ts.)
 */

import { spawn } from 'node:child_process';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { HelperUnavailable } from '../helper-build.js';
import {
  EXIT_NO_PERMISSION,
  readerRoute,
  readerStandIn,
  readerUnavailable,
  routeEverSucceeded,
  runProtectedReader,
  type ReaderRoute,
} from '../protected-reader.js';
import { log } from '../../logging/index.js';

/** The three files a WAL-mode SQLite database needs to be read consistently. */
const DB_SUFFIXES = ['', '-wal', '-shm'] as const;

/** Budget for one query against the private copy. */
const SNAPSHOT_TIMEOUT_MS = 60_000;

export type ScreenTimeDenied =
  /** The reader is not in the Full Disk Access list yet. */
  | 'needs_grant'
  /** The reader is in the list but the entry describes an older build (remove + re-add). */
  | 'stale_grant';

/**
 * `helperPath` is what the user adds in System Settings → Full Disk Access: the
 * Walnut.app bundle when Walnut reads, else the helper binary. `grantTo` says which,
 * so the guidance can name it.
 */
export type ScreenTimeFailure =
  | { kind: 'unavailable'; reason: HelperUnavailable }
  | { kind: 'denied'; denied: ScreenTimeDenied; helperPath: string; grantTo: ReaderRoute['kind'] }
  | { kind: 'no_store'; helperPath: string; grantTo: ReaderRoute['kind'] }
  | { kind: 'error'; message: string };

export interface ScreenTimeAccessOk {
  ok: true;
  helperPath: string;
  grantTo: ReaderRoute['kind'];
  /** Set while Walnut is refused and an older walnut-reader grant is answering. */
  standIn?: string;
}

/** One device's one day, exactly as Apple counted it. */
export interface ScreenTimeDay {
  /** Local calendar day (YYYY-MM-DD) the blocks fall in. */
  date: string;
  /** Stable per-device id from ZCOREDEVICE.ZIDENTIFIER. */
  deviceId: string;
  /** Display name ("iPhone"). Can change; the id is the identity. */
  deviceName: string;
  /** ZCOREDEVICE.ZPLATFORM. Used only to tell this Mac from a phone. */
  platform: number;
  totalMs: number;
  pickups: number;
  notifications: number;
  apps: ScreenTimeApp[];
  /** Hour-resolution blocks, for the timeline. */
  blocks: ScreenTimeBlock[];
}

export interface ScreenTimeApp {
  bundleId: string;
  /** ZUSAGETIMEDITEM.ZDOMAIN when the row is a website rather than an app. */
  domain?: string;
  category?: string;
  ms: number;
  pickups?: number;
  notifications?: number;
}

export interface ScreenTimeBlock {
  startTs: string;
  ms: number;
}

export interface ScreenTimeSnapshot {
  days: ScreenTimeDay[];
  /** Every device seen in the store, whether or not it had usage in range. */
  devices: Array<{ deviceId: string; deviceName: string; platform: number }>;
  /**
   * Which of those ids is THIS Mac. Walnut samples this Mac itself every five
   * seconds, so Apple's hour-resolution row for the same machine is a second,
   * coarser answer for time Walnut already measured: showing both side by side
   * leaves the user with two different numbers and no way to tell which to
   * believe. The UI hides these by default (config `include_this_mac`), and the
   * data is still stored either way. See localDeviceIds() for how it is decided.
   */
  localDeviceIds: string[];
}

/**
 * The Screen Time store, inside the ScreenTimeAgent daemon's own container.
 *
 * The container lives under DARWIN_USER_DIR, which is per-user and per-boot-volume,
 * so the path can never be hardcoded. It is asked of the system rather than derived
 * from `os.tmpdir()`: tmpdir is the SIBLING `/T` directory and would give the right
 * answer, but only until something sets TMPDIR, which Walnut's own deploy and sandbox
 * scripts do. That substitution would not fail loudly, it would report "Screen Time
 * has never been used on this Mac" and send the user looking for a setting that is
 * already on.
 *
 * Verified against the live daemon: `lsof` on the ScreenTimeAgent process shows
 * exactly `<DARWIN_USER_DIR>/com.apple.ScreenTimeAgent/Store/RMAdminStore-{Cloud,
 * Local}.sqlite` plus their -wal and -shm files.
 */
let storeDirPromise: Promise<string> | null = null;

export function screenTimeStoreDir(): Promise<string> {
  if (storeDirPromise) return storeDirPromise;
  storeDirPromise = (async () => {
    const userDir = await darwinUserDir();
    return path.join(userDir, 'com.apple.ScreenTimeAgent', 'Store');
  })();
  return storeDirPromise;
}

async function darwinUserDir(): Promise<string> {
  const asked = await new Promise<string>((resolve) => {
    const child = spawn('/usr/bin/getconf', ['DARWIN_USER_DIR'], { stdio: ['ignore', 'pipe', 'ignore'] });
    let out = '';
    const timer = setTimeout(() => { child.kill('SIGKILL'); resolve(''); }, 5_000);
    child.stdout.on('data', (d) => { out += String(d); });
    child.on('error', () => { clearTimeout(timer); resolve(''); });
    child.on('close', () => { clearTimeout(timer); resolve(out.trim()); });
  });
  if (asked.startsWith('/')) return asked;
  // Last resort. Wrong under an overridden TMPDIR, which is exactly why it is the
  // fallback and not the answer, but better than giving up on the feature.
  return path.dirname(os.tmpdir()) + '/0';
}

export async function screenTimeStorePath(): Promise<string> {
  return path.join(await screenTimeStoreDir(), 'RMAdminStore-Cloud.sqlite');
}

/**
 * The sibling store that holds ONLY this device. Same directory, same schema.
 * Its ZCOREDEVICE rows are the answer to "which of the synced devices is me",
 * which is otherwise a guess: ZPLATFORM is an undocumented integer, and matching
 * on a display name breaks the moment someone owns two Macs with the same name.
 */
async function screenTimeLocalStorePath(): Promise<string> {
  return path.join(await screenTimeStoreDir(), 'RMAdminStore-Local.sqlite');
}

/** Test hook: forget the resolved container directory. */
export function resetScreenTimeStoreDir(): void {
  storeDirPromise = null;
}

/** What to add in System Settings for Screen Time (resolving the route may
 *  compile the helper once). Null when this host cannot read it at all. */
export async function screenTimeHelperPath(): Promise<string | null> {
  return (await readerRoute())?.grantTarget ?? null;
}

/**
 * Can we read the store right now? Cheap: opens and closes, moves no bytes.
 * This is what the settings UI calls to decide which guidance to show.
 *
 * `preferCurrent` asks the current route even while a stand-in answers (the
 * Permission Doctor, which must see a fresh grant on its next poll).
 */
export async function probeScreenTimeAccess(
  opts: { preferCurrent?: boolean } = {},
): Promise<ScreenTimeAccessOk | ScreenTimeFailure> {
  const store = await screenTimeStorePath();
  const probe = await runProtectedReader('probe', store, opts);
  const route = probe.route;
  if (!route) return { kind: 'unavailable', reason: readerUnavailable() };
  const target = { helperPath: route.grantTarget, grantTo: route.kind };
  if (probe.code === 0) {
    const standIn = probe.viaStandIn ? readerStandIn() : null;
    return { ok: true, ...target, ...(standIn ? { standIn } : {}) };
  }
  if (probe.code === EXIT_NO_PERMISSION) {
    return {
      kind: 'denied',
      denied: (await routeEverSucceeded(route.kind)) ? 'stale_grant' : 'needs_grant',
      ...target,
    };
  }
  // Anything else on a path we did not choose ourselves means the store is not
  // there: Screen Time was never enabled, or this macOS keeps it elsewhere.
  return { kind: 'no_store', ...target };
}
/**
 * Read the store and return the aggregated per-device days it holds.
 *
 * `sinceDate` bounds the query so a first run does not fold years of history in
 * one go; Apple only keeps a few weeks anyway.
 */
export async function readScreenTime(sinceDate: string): Promise<ScreenTimeSnapshot | ScreenTimeFailure> {
  const access = await probeScreenTimeAccess();
  if (!('ok' in access)) return access;

  const work = await fsp.mkdtemp(path.join(os.tmpdir(), 'walnut-st-'));
  try {
    const store = await screenTimeStorePath();
    const copy = path.join(work, 'store.sqlite');
    for (const suffix of DB_SUFFIXES) {
      const copied = await copyProtected(`${store}${suffix}`, `${copy}${suffix}`);
      // Only the main database is required. A checkpointed store legitimately has
      // no -wal/-shm, and treating that as failure would break the common case.
      if (!copied && suffix === '') {
        return { kind: 'error', message: 'could not copy the Screen Time database' };
      }
    }
    const rows = await queryCopy(copy, sinceDate);
    if ('kind' in rows) return rows;
    rows.localDeviceIds = await localDeviceIds(work);
    return rows;
  } catch (err) {
    return { kind: 'error', message: err instanceof Error ? err.message : String(err) };
  } finally {
    // The copy holds another app's data; it must not outlive the read.
    await fsp.rm(work, { recursive: true, force: true }).catch(() => {});
  }
}

/**
 * Which device ids are THIS Mac, read out of the -Local store.
 *
 * Returns an empty list when the local store cannot be read, and that is a
 * deliberate choice about which way to be wrong: an empty list means nothing gets
 * hidden, so the user sees a Mac row they may not want. The alternative, guessing
 * from ZPLATFORM, risks hiding the IPHONE, which is the whole feature. Showing
 * one row too many is recoverable by looking at it; silently dropping the data the
 * user turned this on for is not.
 */
async function localDeviceIds(work: string): Promise<string[]> {
  const src = await screenTimeLocalStorePath();
  const copy = path.join(work, 'local.sqlite');
  for (const suffix of DB_SUFFIXES) {
    const copied = await copyProtected(`${src}${suffix}`, `${copy}${suffix}`);
    if (!copied && suffix === '') return [];
  }
  const rows = await sqlJson(copy, 'SELECT ZIDENTIFIER AS deviceId FROM ZCOREDEVICE;');
  if ('kind' in rows) return [];
  return rows.map((r) => str(r.deviceId)).filter(Boolean);
}

/** Stream one protected file to a private path (removed on failure). Returns
 *  false when absent or unreadable. */
async function copyProtected(src: string, dst: string): Promise<boolean> {
  const result = await runProtectedReader('read', src, { dst });
  return result.code === 0;
}

/**
 * One SQL round trip per shape we need, against the private copy.
 *
 * `ZUSAGE.ZDEVICE IS NULL` rows are Apple's own all-devices rollup and MUST be
 * excluded: counting them alongside the per-device rows doubles every total.
 */
async function queryCopy(copy: string, sinceDate: string): Promise<ScreenTimeSnapshot | ScreenTimeFailure> {
  const APPLE_EPOCH = 978307200;
  const day = (col: string) => `date(${col} + ${APPLE_EPOCH}, 'unixepoch', 'localtime')`;

  const devicesSql = `
    SELECT ZIDENTIFIER AS deviceId, ZNAME AS deviceName, ZPLATFORM AS platform
    FROM ZCOREDEVICE WHERE ZIDENTIFIER IS NOT NULL;`;

  const daysSql = `
    SELECT ${day('b.ZSTARTDATE')} AS date, d.ZIDENTIFIER AS deviceId,
           d.ZNAME AS deviceName, d.ZPLATFORM AS platform,
           SUM(b.ZSCREENTIMEINSECONDS) AS secs,
           SUM(COALESCE(b.ZNUMBEROFPICKUPSWITHOUTAPPLICATIONUSAGE, 0)) AS bare_pickups
    FROM ZUSAGEBLOCK b
    JOIN ZUSAGE u ON b.ZUSAGE = u.Z_PK
    JOIN ZCOREDEVICE d ON u.ZDEVICE = d.Z_PK
    WHERE u.ZDEVICE IS NOT NULL AND ${day('b.ZSTARTDATE')} >= '${sinceDate}'
    GROUP BY date, deviceId;`;

  const blocksSql = `
    SELECT ${day('b.ZSTARTDATE')} AS date, d.ZIDENTIFIER AS deviceId,
           datetime(b.ZSTARTDATE + ${APPLE_EPOCH}, 'unixepoch') AS startTs,
           SUM(b.ZSCREENTIMEINSECONDS) AS secs
    FROM ZUSAGEBLOCK b
    JOIN ZUSAGE u ON b.ZUSAGE = u.Z_PK
    JOIN ZCOREDEVICE d ON u.ZDEVICE = d.Z_PK
    WHERE u.ZDEVICE IS NOT NULL AND ${day('b.ZSTARTDATE')} >= '${sinceDate}'
      AND b.ZSCREENTIMEINSECONDS > 0
    GROUP BY date, deviceId, startTs ORDER BY startTs;`;

  const appsSql = `
    SELECT ${day('b.ZSTARTDATE')} AS date, d.ZIDENTIFIER AS deviceId,
           i.ZBUNDLEIDENTIFIER AS bundleId, i.ZDOMAIN AS domain,
           c.ZIDENTIFIER AS category, SUM(i.ZTOTALTIMEINSECONDS) AS secs
    FROM ZUSAGETIMEDITEM i
    JOIN ZUSAGECATEGORY c ON i.ZCATEGORY = c.Z_PK
    JOIN ZUSAGEBLOCK b ON c.ZBLOCK = b.Z_PK
    JOIN ZUSAGE u ON b.ZUSAGE = u.Z_PK
    JOIN ZCOREDEVICE d ON u.ZDEVICE = d.Z_PK
    WHERE u.ZDEVICE IS NOT NULL AND ${day('b.ZSTARTDATE')} >= '${sinceDate}'
      AND i.ZTOTALTIMEINSECONDS > 0
    GROUP BY date, deviceId, bundleId, domain;`;

  const countsSql = `
    SELECT ${day('b.ZSTARTDATE')} AS date, d.ZIDENTIFIER AS deviceId,
           k.ZBUNDLEIDENTIFIER AS bundleId,
           SUM(COALESCE(k.ZNUMBEROFPICKUPS, 0)) AS pickups,
           SUM(COALESCE(k.ZNUMBEROFNOTIFICATIONS, 0)) AS notifications
    FROM ZUSAGECOUNTEDITEM k
    JOIN ZUSAGEBLOCK b ON k.ZBLOCK = b.Z_PK
    JOIN ZUSAGE u ON b.ZUSAGE = u.Z_PK
    JOIN ZCOREDEVICE d ON u.ZDEVICE = d.Z_PK
    WHERE u.ZDEVICE IS NOT NULL AND ${day('b.ZSTARTDATE')} >= '${sinceDate}'
    GROUP BY date, deviceId, bundleId;`;

  const [devices, days, blocks, apps, counts] = await Promise.all([
    sqlJson(copy, devicesSql), sqlJson(copy, daysSql), sqlJson(copy, blocksSql),
    sqlJson(copy, appsSql), sqlJson(copy, countsSql),
  ]);
  for (const r of [devices, days, blocks, apps, counts]) {
    if ('kind' in r) return r;
  }

  return assemble(
    devices as Row[], days as Row[], blocks as Row[], apps as Row[], counts as Row[],
  );
}

type Row = Record<string, string | number | null>;

const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
const str = (v: unknown): string => (typeof v === 'string' ? v : '');

/** Stitch the five result sets into one day-per-device shape. */
function assemble(
  devices: Row[], days: Row[], blocks: Row[], apps: Row[], counts: Row[],
): ScreenTimeSnapshot {
  const key = (date: string, deviceId: string): string => `${date}\u0000${deviceId}`;
  const out = new Map<string, ScreenTimeDay>();
  for (const r of days) {
    const date = str(r.date);
    const deviceId = str(r.deviceId);
    if (!date || !deviceId) continue;
    out.set(key(date, deviceId), {
      date,
      deviceId,
      deviceName: str(r.deviceName) || deviceId,
      platform: num(r.platform),
      totalMs: num(r.secs) * 1000,
      pickups: num(r.bare_pickups),
      notifications: 0,
      apps: [],
      blocks: [],
    });
  }
  for (const r of blocks) {
    const d = out.get(key(str(r.date), str(r.deviceId)));
    if (!d) continue;
    // sqlite's datetime() renders "YYYY-MM-DD HH:MM:SS" in UTC; make it explicit
    // so the client parses an instant rather than a floating local time.
    d.blocks.push({ startTs: `${str(r.startTs).replace(' ', 'T')}Z`, ms: num(r.secs) * 1000 });
  }
  const perApp = new Map<string, ScreenTimeApp>();
  for (const r of apps) {
    const d = out.get(key(str(r.date), str(r.deviceId)));
    if (!d) continue;
    const bundleId = str(r.bundleId);
    const domain = str(r.domain);
    if (!bundleId && !domain) continue;
    const app: ScreenTimeApp = {
      bundleId,
      ...(domain ? { domain } : {}),
      ...(str(r.category) ? { category: str(r.category) } : {}),
      ms: num(r.secs) * 1000,
    };
    d.apps.push(app);
    if (bundleId && !domain) perApp.set(`${str(r.date)}\u0000${str(r.deviceId)}\u0000${bundleId}`, app);
  }
  for (const r of counts) {
    const d = out.get(key(str(r.date), str(r.deviceId)));
    if (!d) continue;
    const pickups = num(r.pickups);
    const notifications = num(r.notifications);
    d.pickups += pickups;
    d.notifications += notifications;
    const app = perApp.get(`${str(r.date)}\u0000${str(r.deviceId)}\u0000${str(r.bundleId)}`);
    if (app) {
      if (pickups) app.pickups = pickups;
      if (notifications) app.notifications = notifications;
    }
  }
  for (const d of out.values()) {
    d.apps.sort((a, b) => b.ms - a.ms || a.bundleId.localeCompare(b.bundleId));
  }
  return {
    days: [...out.values()].sort((a, b) => a.date.localeCompare(b.date) || a.deviceId.localeCompare(b.deviceId)),
    devices: devices
      .map((r) => ({ deviceId: str(r.deviceId), deviceName: str(r.deviceName) || str(r.deviceId), platform: num(r.platform) }))
      .filter((d) => d.deviceId),
    // Filled in by the caller from the -Local store; the cloud store cannot tell
    // which of its devices is the one running this code.
    localDeviceIds: [],
  };
}

/**
 * Run one query with the system sqlite3 CLI and parse its JSON.
 *
 * A CHILD PROCESS on purpose: an in-process synchronous SQLite binding would run
 * a multi-megabyte parse on the one event loop every HTTP route shares.
 */
function sqlJson(dbPath: string, sql: string): Promise<Row[] | ScreenTimeFailure> {
  return new Promise((resolve) => {
    // `file:...?mode=ro` so even the private copy is opened read-only: the only
    // thing that should ever change this file is us deleting it.
    const uri = `file:${dbPath}?mode=ro`;
    const child = spawn('/usr/bin/sqlite3', ['-json', '-readonly', uri, sql], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => child.kill('SIGKILL'), SNAPSHOT_TIMEOUT_MS);
    child.stdout.on('data', (d) => { stdout += String(d); });
    child.stderr.on('data', (d) => { stderr += String(d).slice(0, 500); });
    child.on('error', (err) => {
      clearTimeout(timer);
      resolve({ kind: 'error', message: `sqlite3 unavailable: ${err.message}` });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code !== 0) {
        resolve({ kind: 'error', message: `sqlite3 exited ${code}: ${stderr.trim()}` });
        return;
      }
      const text = stdout.trim();
      if (!text) { resolve([]); return; } // an empty result set prints nothing
      try {
        const parsed = JSON.parse(text) as unknown;
        resolve(Array.isArray(parsed) ? (parsed as Row[]) : []);
      } catch (err) {
        log.web.warn('screen time query returned unparseable JSON', {
          error: err instanceof Error ? err.message : String(err),
        });
        resolve({ kind: 'error', message: 'could not parse the Screen Time query result' });
      }
    });
  });
}
