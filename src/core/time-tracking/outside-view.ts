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
import type { OutsideRow } from './outside-store.js';

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
