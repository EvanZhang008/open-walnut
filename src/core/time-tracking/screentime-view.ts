/**
 * Screen Time: PURE read-time fold. No fs, no clock, no config.
 *
 * Turns one day of stored records (screentime-store.ts) into the per-device shape
 * a UI renders: Apple's own day total, pickups, notifications, ranked apps,
 * ranked website domains, and the day's blocks for a timeline.
 *
 * ── This Mac is excluded by default, and its data is still returned ──
 *
 * Walnut already samples the Mac it runs on, itself, at 5-second resolution
 * (outside-store.ts). Apple's Screen Time row for that same Mac is hour
 * resolution and counted by different rules, so showing the two side by side
 * leaves the user with two numbers for one machine and no way to tell which one
 * to trust. Local Macs come back in `localDevices` instead of `devices`: out of
 * the default view and out of the day totals, but never dropped, so a UI that
 * wants to show Apple's version can.
 *
 * A device counts as local if the STORED row says so (the reader decided that at
 * capture time, from Apple's own -Local store) or if the caller names it in
 * `localDeviceIds`. The union, not either one alone: the stored flag is the only
 * trustworthy answer for a day captured on a machine that has since been
 * replaced, and the caller's list is the only way to classify a day written
 * before the flag existed.
 *
 * ── Apps and websites are two lists, never one ──
 *
 * Apple measures a browser's app time and the domains visited inside it as
 * separate things. Summing them would double-count the browsing, and ranking them
 * together would put a domain and an application in one column as if they were
 * the same kind of row. They stay apart all the way to the UI, and the device's
 * `totalMs` comes from Apple's own header number rather than from adding rows up.
 *
 * Every cap reports what it dropped, as a count AND as ms, because a rank list
 * that silently ends at N tells the user their day was shorter than it was.
 */

import type { ScreenTimeRecord } from './screentime-store.js';

/**
 * Apple's blocks are hour-resolution. This rides on every device fold so a
 * timeline drawn from them cannot be mistaken for the 5-second sampling the Mac's
 * own lane uses; the two are drawn at very different confidence.
 */
export const SCREEN_TIME_BLOCK_GRANULARITY = 'hour';

/** Row caps. A phone's real day is a dozen apps and a handful of sites; the tail
 *  is single-second noise that costs payload and pushes the real rows off screen. */
export const SCREEN_TIME_MAX_APPS = 40;
export const SCREEN_TIME_MAX_SITES = 40;
/** Blocks per device per day. An hour-resolution day cannot honestly exceed 24. */
export const SCREEN_TIME_MAX_BLOCKS = 96;

export interface ScreenTimeAppRow {
  bundleId: string;
  ms: number;
  pickups?: number;
  notifications?: number;
  category?: string;
}

/** A website row. Deliberately a DIFFERENT type from an app row (see the header). */
export interface ScreenTimeSiteRow {
  domain: string;
  ms: number;
  category?: string;
}

export interface ScreenTimeTimelineBlock {
  startTs: string;
  ms: number;
}

/** What each cap left out. Counts and ms, never a silent truncation. */
export interface ScreenTimeDropped {
  apps: number;
  appMs: number;
  sites: number;
  siteMs: number;
  blocks: number;
  blockMs: number;
}

export interface ScreenTimeDeviceFold {
  deviceId: string;
  deviceName: string;
  platform: number;
  /** APPLE's number for the device's day. Never a sum of the rows below. */
  totalMs: number;
  /** Sum of the app rows. A separate field on purpose: it can differ from
   *  totalMs, and a UI that wants to say so needs both numbers. */
  appMs: number;
  /** Sum of the website rows. Overlaps app time inside a browser; never added. */
  siteMs: number;
  pickups: number;
  notifications: number;
  apps: ScreenTimeAppRow[];
  sites: ScreenTimeSiteRow[];
  blocks: ScreenTimeTimelineBlock[];
  /** Always 'hour' (see SCREEN_TIME_BLOCK_GRANULARITY). */
  blockGranularity: typeof SCREEN_TIME_BLOCK_GRANULARITY;
  dropped: ScreenTimeDropped;
  /** The day file had rows for this device but no header record (a torn or
   *  hand-edited file), so totalMs is 0 rather than a number we invented. */
  headerMissing?: true;
  /** A Mac Walnut samples itself; folded, but kept out of `devices`. */
  local?: true;
}

export interface ScreenTimeDayFold {
  date: string;
  /** The default view: every device that is not a local Mac. */
  devices: ScreenTimeDeviceFold[];
  /** Local Macs, folded identically. The UI opts in by rendering this list. */
  localDevices: ScreenTimeDeviceFold[];
  /** Sums over `devices` only, so a local Mac can never inflate the day. */
  totalMs: number;
  pickups: number;
  notifications: number;
  /** Sum over `localDevices`, for a UI that offers a combined number. */
  localTotalMs: number;
}

export interface ScreenTimeFoldOptions {
  /** The day being folded. Passed in rather than read off a clock or a record. */
  date?: string;
  /** Extra deviceIds to treat as Macs this Walnut samples itself. Added to the
   *  stored `local` flags, never used to clear one. */
  localDeviceIds?: Iterable<string>;
  maxApps?: number;
  maxSites?: number;
  maxBlocks?: number;
}

interface DeviceAccumulator {
  deviceId: string;
  header: ScreenTimeRecord | null;
  apps: Map<string, ScreenTimeAppRow>;
  sites: Map<string, ScreenTimeSiteRow>;
}

/**
 * Fold one day's stored records into per-device rows.
 *
 * Ordering is a total order at every level (ms desc, then id asc) so a UI redraw
 * can never reshuffle two rows that happen to tie.
 */
export function foldScreenTimeDay(
  records: readonly ScreenTimeRecord[],
  opts: ScreenTimeFoldOptions = {},
): ScreenTimeDayFold {
  const local = new Set(opts.localDeviceIds ?? []);
  const maxApps = capOf(opts.maxApps, SCREEN_TIME_MAX_APPS);
  const maxSites = capOf(opts.maxSites, SCREEN_TIME_MAX_SITES);
  const maxBlocks = capOf(opts.maxBlocks, SCREEN_TIME_MAX_BLOCKS);

  const byDevice = new Map<string, DeviceAccumulator>();
  const accumulator = (deviceId: string): DeviceAccumulator => {
    let acc = byDevice.get(deviceId);
    if (!acc) {
      acc = { deviceId, header: null, apps: new Map(), sites: new Map() };
      byDevice.set(deviceId, acc);
    }
    return acc;
  };

  for (const rec of records) {
    if (!rec || !rec.deviceId) continue;
    if (rec.kind === 'device') {
      const acc = accumulator(rec.deviceId);
      // FIRST header wins. A second header for one device means a corrupt file,
      // and summing two of them would double the device's whole day.
      if (!acc.header) acc.header = rec;
      continue;
    }
    if (rec.ms <= 0) continue;
    if (rec.kind === 'app') {
      if (!rec.bundleId) continue;
      const acc = accumulator(rec.deviceId);
      const prev = acc.apps.get(rec.bundleId);
      acc.apps.set(rec.bundleId, {
        bundleId: rec.bundleId,
        ms: (prev?.ms ?? 0) + rec.ms,
        pickups: (prev?.pickups ?? 0) + (rec.pickups ?? 0),
        notifications: (prev?.notifications ?? 0) + (rec.notifications ?? 0),
        category: prev?.category ?? rec.category,
      });
      continue;
    }
    if (rec.kind === 'site') {
      if (!rec.domain) continue;
      const acc = accumulator(rec.deviceId);
      const prev = acc.sites.get(rec.domain);
      acc.sites.set(rec.domain, {
        domain: rec.domain,
        ms: (prev?.ms ?? 0) + rec.ms,
        category: prev?.category ?? rec.category,
      });
    }
  }

  const devices: ScreenTimeDeviceFold[] = [];
  const localDevices: ScreenTimeDeviceFold[] = [];
  for (const acc of byDevice.values()) {
    const fold = foldDevice(acc, {
      maxApps,
      maxSites,
      maxBlocks,
      local: local.has(acc.deviceId) || acc.header?.local === true,
    });
    (fold.local ? localDevices : devices).push(fold);
  }
  devices.sort(byTotalThenId);
  localDevices.sort(byTotalThenId);

  let totalMs = 0;
  let pickups = 0;
  let notifications = 0;
  for (const d of devices) {
    totalMs += d.totalMs;
    pickups += d.pickups;
    notifications += d.notifications;
  }

  return {
    date: opts.date ?? records.find((rec) => rec?.date)?.date ?? '',
    devices,
    localDevices,
    totalMs,
    pickups,
    notifications,
    localTotalMs: localDevices.reduce((sum, d) => sum + d.totalMs, 0),
  };
}

function capOf(raw: number | undefined, fallback: number): number {
  return typeof raw === 'number' && Number.isFinite(raw) && raw >= 0 ? Math.floor(raw) : fallback;
}

function byTotalThenId(a: ScreenTimeDeviceFold, b: ScreenTimeDeviceFold): number {
  return b.totalMs - a.totalMs || a.deviceId.localeCompare(b.deviceId);
}

function foldDevice(
  acc: DeviceAccumulator,
  opts: { maxApps: number; maxSites: number; maxBlocks: number; local: boolean },
): ScreenTimeDeviceFold {
  const header = acc.header;
  const rankedApps = [...acc.apps.values()]
    .sort((a, b) => b.ms - a.ms || a.bundleId.localeCompare(b.bundleId));
  const rankedSites = [...acc.sites.values()]
    .sort((a, b) => b.ms - a.ms || a.domain.localeCompare(b.domain));
  const droppedApps = rankedApps.slice(opts.maxApps);
  const droppedSites = rankedSites.slice(opts.maxSites);

  const rawBlocks = header?.blocks ?? [];
  const overBlocks = rawBlocks.length > opts.maxBlocks;
  // Keep the LONGEST blocks when over the cap: they are the ones a chart shows.
  // Dropping the tail of the array instead would cut the end of the day off.
  const keptBlocks = (overBlocks
    ? [...rawBlocks].sort((a, b) => b.ms - a.ms || a.startTs.localeCompare(b.startTs)).slice(0, opts.maxBlocks)
    : [...rawBlocks]
  ).sort((a, b) => a.startTs.localeCompare(b.startTs) || b.ms - a.ms);
  const droppedBlockMs = overBlocks
    ? rawBlocks.reduce((sum, b) => sum + b.ms, 0) - keptBlocks.reduce((sum, b) => sum + b.ms, 0)
    : 0;

  return {
    deviceId: acc.deviceId,
    deviceName: header?.deviceName || acc.deviceId,
    platform: header?.platform ?? 0,
    totalMs: header?.ms ?? 0,
    appMs: rankedApps.reduce((sum, row) => sum + row.ms, 0),
    siteMs: rankedSites.reduce((sum, row) => sum + row.ms, 0),
    pickups: header?.pickups ?? 0,
    notifications: header?.notifications ?? 0,
    apps: rankedApps.slice(0, opts.maxApps).map(trimApp),
    sites: rankedSites.slice(0, opts.maxSites).map(trimSite),
    blocks: keptBlocks.map((b) => ({ startTs: b.startTs, ms: b.ms })),
    blockGranularity: SCREEN_TIME_BLOCK_GRANULARITY,
    dropped: {
      apps: droppedApps.length,
      appMs: droppedApps.reduce((sum, row) => sum + row.ms, 0),
      sites: droppedSites.length,
      siteMs: droppedSites.reduce((sum, row) => sum + row.ms, 0),
      blocks: rawBlocks.length - keptBlocks.length,
      blockMs: droppedBlockMs,
    },
    ...(header ? {} : { headerMissing: true as const }),
    ...(opts.local ? { local: true as const } : {}),
  };
}

/** Zero counts are absent rather than 0, so a row carries only what was measured. */
function trimApp(row: ScreenTimeAppRow): ScreenTimeAppRow {
  return {
    bundleId: row.bundleId,
    ms: row.ms,
    ...(row.pickups ? { pickups: row.pickups } : {}),
    ...(row.notifications ? { notifications: row.notifications } : {}),
    ...(row.category ? { category: row.category } : {}),
  };
}

function trimSite(row: ScreenTimeSiteRow): ScreenTimeSiteRow {
  return {
    domain: row.domain,
    ms: row.ms,
    ...(row.category ? { category: row.category } : {}),
  };
}
