/**
 * Outside-activity — PURE read-time fold. No fs, no clock, no config I/O.
 *
 * Turns one day's stored buckets into the per-app / per-site answer the time
 * panel renders, and decides which of that time was spent INSIDE Walnut.
 *
 * "Inside Walnut" is computed here, at read time, never stamped into the stored
 * record: the desktop bundle id can change and the cloud companion's hostname is
 * a config value the user can edit, so a day recorded last month must be able to
 * answer today's question.
 */

import type { Config } from '../types.js';
import type { OutsideRecord, OutsideRow } from './outside-store.js';

/** The Walnut desktop shell (a WKWebView around the local server). */
export const WALNUT_DESKTOP_BUNDLE_ID = 'com.local.walnut-desktop';

/**
 * Browsers the helper can ask for the active tab's host. Kept in sync with
 * BROWSER_SCRIPTS in src/data/walnut-activity.swift — the read side needs it to
 * tell "no browser was used today" apart from "a browser was used but no host
 * came back", which is the Automation-permission hint.
 */
export const BROWSER_BUNDLE_IDS: readonly string[] = [
  'com.apple.Safari',
  'com.google.Chrome',
  'com.microsoft.edgemac',
  'com.brave.Browser',
  'company.thebrowser.Browser',
  'com.vivaldi.Vivaldi',
  'com.operasoftware.Opera',
];

/** Hosts that mean "this is Walnut" no matter what config says. */
const LOCAL_HOSTS: readonly string[] = ['localhost', '127.0.0.1', '[::1]', '::1'];

export interface OutsideSite {
  host: string;
  ms: number;
}

export interface OutsideApp {
  app: string;
  bundleId?: string;
  ms: number;
  /** Present only when the WHOLE row is Walnut time (never a partial flag). */
  walnut?: true;
  /** Browser rows only, and only for samples that carried a host. */
  sites?: OutsideSite[];
}

export interface OutsideDayFold {
  totalMs: number;
  walnutMs: number;
  /** False only when a browser WAS used and not one sample carried a host. */
  browserHostsSeen: boolean;
  apps: OutsideApp[];
}

/**
 * Hostnames that count as Walnut's own web surface. localhost/127.0.0.1 always;
 * the companion hostname comes from the configured bridge URL, so no deployment
 * domain is ever hardcoded in the source.
 */
export function walnutHostsFromConfig(config: Pick<Config, 'cloud_bridge'> | undefined): string[] {
  const out = new Set<string>(LOCAL_HOSTS);
  const url = config?.cloud_bridge?.url;
  if (typeof url === 'string' && url.trim()) {
    try {
      const host = new URL(url.trim()).hostname.toLowerCase();
      if (host) out.add(host.startsWith('www.') ? host.slice(4) : host);
    } catch {
      // A malformed bridge URL is a config problem, not a reason to fail a read.
    }
  }
  return [...out];
}

/** Group key: the bundle id is the identity; a helper that reported no bundle
 *  id (rare) falls back to its display name so two such apps stay separate. */
function groupKey(row: OutsideRow): string {
  return row.bundleId ? `b:${row.bundleId}` : `n:${row.app}`;
}

interface Group {
  app: string;
  /** ms of the largest bucket that supplied `app` — keeps the label stable. */
  labelMs: number;
  bundleId: string;
  ms: number;
  walnutMs: number;
  sites: Map<string, number>;
}

export function foldOutsideApps(
  rows: readonly OutsideRow[],
  opts: { walnutHosts: Iterable<string> },
): OutsideDayFold {
  const walnutHosts = new Set([...opts.walnutHosts].map((h) => h.toLowerCase()));
  const browsers = new Set(BROWSER_BUNDLE_IDS);
  const groups = new Map<string, Group>();
  let totalMs = 0;
  let walnutMs = 0;
  let browserMs = 0;
  let browserHostMs = 0;

  for (const row of rows) {
    if (row.ms <= 0) continue;
    const key = groupKey(row);
    let g = groups.get(key);
    if (!g) {
      g = { app: row.app, labelMs: 0, bundleId: row.bundleId, ms: 0, walnutMs: 0, sites: new Map() };
      groups.set(key, g);
    }
    if (row.app && row.ms > g.labelMs) {
      g.app = row.app;
      g.labelMs = row.ms;
    }
    g.ms += row.ms;
    totalMs += row.ms;
    const isWalnut = row.bundleId === WALNUT_DESKTOP_BUNDLE_ID
      || (row.host !== '' && walnutHosts.has(row.host));
    if (isWalnut) {
      g.walnutMs += row.ms;
      walnutMs += row.ms;
    }
    if (row.host) g.sites.set(row.host, (g.sites.get(row.host) ?? 0) + row.ms);
    if (browsers.has(row.bundleId)) {
      browserMs += row.ms;
      if (row.host) browserHostMs += row.ms;
    }
  }

  const apps: OutsideApp[] = [...groups.values()]
    .map((g) => {
      const sites: OutsideSite[] = [...g.sites.entries()]
        .map(([host, ms]) => ({ host, ms }))
        .sort((a, b) => b.ms - a.ms || a.host.localeCompare(b.host));
      return {
        app: g.app,
        ...(g.bundleId ? { bundleId: g.bundleId } : {}),
        ms: g.ms,
        // Only a row that is ENTIRELY Walnut time gets the flag — a browser that
        // spent half its day on other sites is not a Walnut row, and its Walnut
        // share is already in walnutMs.
        ...(g.ms > 0 && g.walnutMs === g.ms ? { walnut: true as const } : {}),
        ...(sites.length > 0 ? { sites } : {}),
      };
    })
    .sort((a, b) => b.ms - a.ms || a.app.localeCompare(b.app));

  return {
    totalMs,
    walnutMs,
    // No browser at all means there is nothing to hint about, so the answer is
    // "nothing missing" rather than "hosts are broken".
    browserHostsSeen: browserMs === 0 || browserHostMs > 0,
    apps,
  };
}

// ── Timeline fold: WHEN each outside app was in front ────────────────────────

/**
 * Two records of the same app this close together read as one stretch of use.
 * Wider than the compaction gap on purpose: compaction preserves the data at
 * sample fidelity, this is the SEMANTIC "still in that app" question.
 */
export const OUTSIDE_TIMELINE_GAP_MS = 60_000;
/** Row cap: a day rarely has more than a dozen real apps; the tail is noise. */
export const OUTSIDE_TIMELINE_MAX_APPS = 30;
/** Interval cap per app — beyond this the fidelity adds nothing but payload. */
export const OUTSIDE_TIMELINE_MAX_BLOCKS = 500;

export interface OutsideBlock {
  startTs: string;
  endTs: string;
  /** Tracked ms inside the interval (≤ the wall span when gaps were merged). */
  ms: number;
}

export interface OutsideAppTimeline {
  app: string;
  bundleId?: string;
  /** ALL of this app's NON-Walnut time that day, placeable or not. For a browser
   *  that also visited Walnut pages, this is smaller than the Apps tab's row. */
  ms: number;
  blocks: OutsideBlock[];
  truncated?: true;
}

export interface OutsideTimelineFold {
  totalMs: number;
  /** Time that counts but cannot be drawn: a ts-less record, or one whose ts
   *  falls outside the day's local bounds (old midnight-UTC folds, clock jumps). */
  unplacedMs: number;
  apps: OutsideAppTimeline[];
  /** Apps beyond the row cap: their time is IN totalMs but has no row. */
  droppedApps: number;
  droppedMs: number;
}

/**
 * Per-app intervals for the timeline, from one day's raw records.
 *
 * Walnut's own time (the desktop shell, any Walnut-hosted page) is EXCLUDED:
 * on the timeline it would duplicate the attention lanes that already show it.
 * Grouping is per APP (bundle id), not per site — a browser is one row, its
 * sites stay the Apps tab's detail.
 */
export function foldOutsideTimeline(
  records: readonly OutsideRecord[],
  opts: {
    walnutHosts: Iterable<string>;
    /** The day's LOCAL bounds. A record whose ts falls outside them still counts
     *  toward totals but is never drawn — an old midnight-UTC fold placed at
     *  00:00Z would otherwise paint an hours-long bar at the wrong local hour. */
    bounds?: { startMs: number; endMs: number } | null;
  },
): OutsideTimelineFold {
  const walnutHosts = new Set([...opts.walnutHosts].map((h) => h.toLowerCase()));
  const bounds = opts.bounds ?? null;
  interface AppGroup {
    app: string;
    labelMs: number;
    bundleId: string;
    ms: number;
    unplacedMs: number;
    spans: Array<{ startMs: number; endMs: number; ms: number }>;
  }
  const groups = new Map<string, AppGroup>();
  const keyed: Array<{ rec: OutsideRecord; startMs: number; g: AppGroup }> = [];
  let totalMs = 0;
  let unplacedMs = 0;

  for (const rec of records) {
    if (rec.durationMs <= 0) continue;
    const isWalnut = rec.bundleId === WALNUT_DESKTOP_BUNDLE_ID
      || (typeof rec.host === 'string' && rec.host !== '' && walnutHosts.has(rec.host));
    if (isWalnut) continue;
    const key = rec.bundleId ? `b:${rec.bundleId}` : `n:${rec.app}`;
    let g = groups.get(key);
    if (!g) {
      g = { app: rec.app, labelMs: 0, bundleId: rec.bundleId ?? '', ms: 0, unplacedMs: 0, spans: [] };
      groups.set(key, g);
    }
    if (rec.app && rec.durationMs > g.labelMs) { g.app = rec.app; g.labelMs = rec.durationMs; }
    g.ms += rec.durationMs;
    totalMs += rec.durationMs;
    const startMs = Date.parse(rec.ts);
    const placeable = Number.isFinite(startMs)
      && (!bounds || (startMs >= bounds.startMs && startMs < bounds.endMs));
    if (placeable) keyed.push({ rec, startMs, g });
    else { g.unplacedMs += rec.durationMs; unplacedMs += rec.durationMs; }
  }

  keyed.sort((a, b) => a.startMs - b.startMs);
  for (const { rec, startMs, g } of keyed) {
    const last = g.spans[g.spans.length - 1];
    if (last && startMs <= last.endMs + OUTSIDE_TIMELINE_GAP_MS) {
      last.endMs = Math.max(last.endMs, startMs + rec.durationMs);
      last.ms += rec.durationMs;
    } else {
      g.spans.push({ startMs, endMs: startMs + rec.durationMs, ms: rec.durationMs });
    }
  }

  const ranked = [...groups.values()]
    .sort((a, b) => b.ms - a.ms || a.app.localeCompare(b.app));
  const dropped = ranked.slice(OUTSIDE_TIMELINE_MAX_APPS);
  const apps: OutsideAppTimeline[] = ranked
    .slice(0, OUTSIDE_TIMELINE_MAX_APPS)
    .map((g) => {
      const over = g.spans.length > OUTSIDE_TIMELINE_MAX_BLOCKS;
      // Keep the LONGEST intervals when over the cap: the ones a chart can show.
      const spans = over
        ? [...g.spans].sort((a, b) => b.ms - a.ms).slice(0, OUTSIDE_TIMELINE_MAX_BLOCKS)
          .sort((a, b) => a.startMs - b.startMs)
        : g.spans;
      return {
        app: g.app,
        ...(g.bundleId ? { bundleId: g.bundleId } : {}),
        ms: g.ms,
        blocks: spans.map((s) => ({
          startTs: new Date(s.startMs).toISOString(),
          endTs: new Date(s.endMs).toISOString(),
          // Overlapping stored records can sum past the wall span; a tooltip
          // must never claim more time inside an interval than the interval is.
          ms: Math.min(s.ms, s.endMs - s.startMs),
        })),
        ...(over ? { truncated: true as const } : {}),
      };
    });

  return {
    totalMs,
    unplacedMs,
    apps,
    droppedApps: dropped.length,
    droppedMs: dropped.reduce((sum, g) => sum + g.ms, 0),
  };
}
