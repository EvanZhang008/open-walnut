/**
 * Outside-activity read-time fold: per-app grouping, per-site breakdown, and the
 * inside-Walnut rule (which is computed here, never stored). Pure — no fs.
 */

import { describe, it, expect } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  BROWSER_BUNDLE_IDS, WALNUT_DESKTOP_BUNDLE_ID, foldOutsideApps, foldOutsideTimeline, walnutHostsFromConfig,
} from '../../../src/core/time-tracking/outside-view.js';
import type { OutsideRecord, OutsideRow } from '../../../src/core/time-tracking/outside-store.js';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');

function row(over: Partial<OutsideRow> = {}): OutsideRow {
  return { app: 'Slack', bundleId: 'com.tinyspeck.slackmacgap', host: '', ms: 5000, ...over };
}

const LOCAL_ONLY = { walnutHosts: ['localhost', '127.0.0.1'] };

describe('foldOutsideApps', () => {
  it('groups by bundle id, sorts apps and sites desc, and totals the day', () => {
    const fold = foldOutsideApps([
      row({ ms: 90_000 }),
      row({ app: 'Google Chrome', bundleId: 'com.google.Chrome', host: 'github.com', ms: 300_000 }),
      row({ app: 'Google Chrome', bundleId: 'com.google.Chrome', host: 'news.ycombinator.com', ms: 60_000 }),
      row({ app: 'Google Chrome', bundleId: 'com.google.Chrome', host: '', ms: 30_000 }),
    ], LOCAL_ONLY);

    expect(fold.totalMs).toBe(480_000);
    expect(fold.apps).toEqual([
      {
        app: 'Google Chrome',
        bundleId: 'com.google.Chrome',
        ms: 390_000,
        sites: [
          { host: 'github.com', ms: 300_000 },
          { host: 'news.ycombinator.com', ms: 60_000 },
        ],
      },
      { app: 'Slack', bundleId: 'com.tinyspeck.slackmacgap', ms: 90_000 },
    ]);
    // Host rows never exceed their app's total (untagged browser time is real).
    const chrome = fold.apps[0]!;
    expect(chrome.sites!.reduce((a, s) => a + s.ms, 0)).toBeLessThanOrEqual(chrome.ms);
  });

  it('tags the desktop app as Walnut time', () => {
    const fold = foldOutsideApps([
      row({ app: 'Walnut', bundleId: WALNUT_DESKTOP_BUNDLE_ID, ms: 600_000 }),
      row({ ms: 60_000 }),
    ], LOCAL_ONLY);
    expect(fold.walnutMs).toBe(600_000);
    expect(fold.apps[0]).toMatchObject({ app: 'Walnut', walnut: true });
    expect(fold.apps[1]!.walnut).toBeUndefined();
  });

  it('counts a browser tab on a Walnut host as Walnut time without flagging the whole browser', () => {
    const fold = foldOutsideApps([
      row({ app: 'Google Chrome', bundleId: 'com.google.Chrome', host: 'localhost', ms: 120_000 }),
      row({ app: 'Google Chrome', bundleId: 'com.google.Chrome', host: 'github.com', ms: 300_000 }),
    ], LOCAL_ONLY);
    expect(fold.walnutMs).toBe(120_000);
    expect(fold.apps[0]!.walnut).toBeUndefined(); // partly outside → not a Walnut row
  });

  it('flags a browser that spent its whole day on Walnut', () => {
    const fold = foldOutsideApps([
      row({ app: 'Safari', bundleId: 'com.apple.Safari', host: '127.0.0.1', ms: 60_000 }),
    ], LOCAL_ONLY);
    expect(fold.apps[0]).toMatchObject({ walnut: true });
    expect(fold.walnutMs).toBe(60_000);
  });

  it('treats the configured companion hostname as Walnut too', () => {
    const hosts = walnutHostsFromConfig({ cloud_bridge: { url: 'wss://companion.example.test/bridge' } });
    const fold = foldOutsideApps([
      row({ app: 'Safari', bundleId: 'com.apple.Safari', host: 'companion.example.test', ms: 45_000 }),
    ], { walnutHosts: hosts });
    expect(fold.walnutMs).toBe(45_000);
  });

  it('reports browserHostsSeen false only when a browser was used and no host came back', () => {
    const noHosts = foldOutsideApps([
      row({ app: 'Google Chrome', bundleId: 'com.google.Chrome', ms: 300_000 }),
    ], LOCAL_ONLY);
    expect(noHosts.browserHostsSeen).toBe(false);

    const someHosts = foldOutsideApps([
      row({ app: 'Google Chrome', bundleId: 'com.google.Chrome', ms: 300_000 }),
      row({ app: 'Google Chrome', bundleId: 'com.google.Chrome', host: 'github.com', ms: 5000 }),
    ], LOCAL_ONLY);
    expect(someHosts.browserHostsSeen).toBe(true);

    // No browser at all: nothing to hint about.
    expect(foldOutsideApps([row({ ms: 5000 })], LOCAL_ONLY).browserHostsSeen).toBe(true);
    expect(foldOutsideApps([], LOCAL_ONLY).browserHostsSeen).toBe(true);
  });

  it('labels a group from its largest bucket and keeps a bundle-less app separate', () => {
    const fold = foldOutsideApps([
      row({ app: 'Chrome', bundleId: 'com.google.Chrome', host: 'a.test', ms: 1000 }),
      row({ app: 'Google Chrome', bundleId: 'com.google.Chrome', host: 'b.test', ms: 9000 }),
      row({ app: 'Mystery', bundleId: '', ms: 4000 }),
    ], LOCAL_ONLY);
    expect(fold.apps.map((a) => a.app)).toEqual(['Google Chrome', 'Mystery']);
    expect(fold.apps[1]!.bundleId).toBeUndefined();
  });

  it('drops non-positive buckets', () => {
    const fold = foldOutsideApps([row({ ms: 0 }), row({ ms: -5000 }), row({ ms: 5000 })], LOCAL_ONLY);
    expect(fold.totalMs).toBe(5000);
    expect(fold.apps).toHaveLength(1);
  });
});

describe('BROWSER_BUNDLE_IDS (ratchet)', () => {
  it('matches the browsers the swift helper actually scripts', async () => {
    // browserHostsSeen means "a browser was used but no host came back". If this
    // list and the helper's BROWSER_SCRIPTS drift apart, the read side either
    // hints about a permission the helper never asks for, or stays silent about
    // one it does — so the two lists are pinned to each other here.
    const source = await fs.readFile(path.join(REPO_ROOT, 'src/data/walnut-activity.swift'), 'utf-8');
    for (const bundleId of BROWSER_BUNDLE_IDS) {
      expect(source, `${bundleId} missing from walnut-activity.swift`).toContain(`"${bundleId}"`);
    }
    // And the other direction: every id the helper scripts is known here.
    const scripted = [...source.matchAll(/^\s{4}"([\w.]+)":/gm)].map((m) => m[1]!);
    expect(scripted.length).toBeGreaterThan(0);
    for (const bundleId of scripted) expect(BROWSER_BUNDLE_IDS).toContain(bundleId);
  });
});

describe('walnutHostsFromConfig', () => {
  it('always includes the loopback hosts', () => {
    expect(walnutHostsFromConfig(undefined)).toContain('localhost');
    expect(walnutHostsFromConfig({})).toContain('127.0.0.1');
  });

  it('ignores a malformed bridge URL instead of failing the read', () => {
    expect(walnutHostsFromConfig({ cloud_bridge: { url: 'not a url' } })).toEqual(
      walnutHostsFromConfig({}),
    );
  });

  it('strips a www. prefix from the configured hostname', () => {
    expect(walnutHostsFromConfig({ cloud_bridge: { url: 'https://www.companion.example.test' } }))
      .toContain('companion.example.test');
  });
});

describe('foldOutsideTimeline', () => {
  const D = '2026-08-30';
  const at = (sec: number, over: Partial<OutsideRecord> = {}): OutsideRecord => ({
    date: D,
    ts: `${D}T15:${String(Math.floor(sec / 60)).padStart(2, '0')}:${String(sec % 60).padStart(2, '0')}.000Z`,
    durationMs: 5000,
    app: 'Slack',
    bundleId: 'com.tinyspeck.slackmacgap',
    ...over,
  });

  it('merges one app\'s samples into intervals across a short gap, splits at a long one', () => {
    const fold = foldOutsideTimeline([at(0), at(5), at(30), at(300)], LOCAL_ONLY);
    expect(fold.apps).toHaveLength(1);
    const [slack] = fold.apps;
    expect(slack!.ms).toBe(20_000);
    // 0/5/30s are within OUTSIDE_TIMELINE_GAP_MS of each other; 300s is not.
    expect(slack!.blocks).toHaveLength(2);
    expect(slack!.blocks[0]!.ms).toBe(15_000);
  });

  it('excludes Walnut entirely: the desktop shell and Walnut-hosted pages', () => {
    const fold = foldOutsideTimeline([
      at(0, { app: 'Walnut', bundleId: WALNUT_DESKTOP_BUNDLE_ID }),
      at(5, { app: 'Google Chrome', bundleId: 'com.google.Chrome', host: 'localhost' }),
      at(10, { app: 'Google Chrome', bundleId: 'com.google.Chrome', host: 'github.com' }),
    ], LOCAL_ONLY);
    expect(fold.totalMs).toBe(5000);
    expect(fold.apps.map((a) => a.app)).toEqual(['Google Chrome']);
  });

  it('groups a browser as ONE row across its sites', () => {
    const fold = foldOutsideTimeline([
      at(0, { app: 'Google Chrome', bundleId: 'com.google.Chrome', host: 'github.com' }),
      at(5, { app: 'Google Chrome', bundleId: 'com.google.Chrome', host: 'news.ycombinator.com' }),
    ], LOCAL_ONLY);
    expect(fold.apps).toHaveLength(1);
    expect(fold.apps[0]!.blocks).toHaveLength(1);
    expect(fold.apps[0]!.ms).toBe(10_000);
  });

  it('counts ts-less records into the app total but reports them unplaced', () => {
    const fold = foldOutsideTimeline([at(0), { ...at(0), ts: '' }], LOCAL_ONLY);
    expect(fold.apps[0]!.ms).toBe(10_000);
    expect(fold.apps[0]!.blocks).toHaveLength(1);
    expect(fold.unplacedMs).toBe(5000);
  });

  it('sorts apps by total, biggest first', () => {
    const fold = foldOutsideTimeline([
      at(0),
      at(10, { app: 'Xcode', bundleId: 'com.apple.dt.Xcode', durationMs: 60_000 }),
    ], LOCAL_ONLY);
    expect(fold.apps.map((a) => a.app)).toEqual(['Xcode', 'Slack']);
  });

  it('counts a ts outside the day bounds as unplaced instead of drawing it', () => {
    // Explicit bounds so the test does not depend on the runner's timezone. The
    // real-world case: an old fold stamped midnight UTC, which is hours into the
    // previous local day — drawn, it appeared as a long bar at a fictional hour.
    const startMs = Date.parse(`${D}T07:00:00.000Z`);
    const bounds = { startMs, endMs: startMs + 24 * 3600 * 1000 };
    const fold = foldOutsideTimeline([
      at(0, { ts: `${D}T00:00:00.000Z`, durationMs: 3600_000 }), // before startMs
      at(0), // 15:00Z — inside
    ], { ...LOCAL_ONLY, bounds });
    expect(fold.totalMs).toBe(3_605_000);
    expect(fold.unplacedMs).toBe(3600_000);
    expect(fold.apps[0]!.blocks).toHaveLength(1);
    expect(fold.apps[0]!.blocks[0]!.ms).toBe(5000);
  });

  it('never claims more tracked time inside an interval than the interval spans', () => {
    // Two records at the SAME instant (overlapping sources) merge into one 5s
    // interval; its ms must be capped at the wall span, not summed to 10s.
    const fold = foldOutsideTimeline([at(0), at(0)], LOCAL_ONLY);
    const block = fold.apps[0]!.blocks[0]!;
    const span = Date.parse(block.endTs) - Date.parse(block.startTs);
    expect(block.ms).toBeLessThanOrEqual(span);
    expect(fold.apps[0]!.ms).toBe(10_000); // the TOTAL still counts both
  });

  it('reports apps beyond the row cap as dropped instead of losing them silently', () => {
    const records: OutsideRecord[] = [];
    for (let i = 0; i < 33; i++) {
      records.push(at(i, { app: `App${i}`, bundleId: `com.example.app${i}`, durationMs: 1000 * (33 - i) }));
    }
    const fold = foldOutsideTimeline(records, LOCAL_ONLY);
    expect(fold.apps).toHaveLength(30);
    expect(fold.droppedApps).toBe(3);
    expect(fold.droppedMs).toBe(1000 + 2000 + 3000); // the three smallest
    expect(fold.totalMs).toBe(records.reduce((sum, r) => sum + r.durationMs, 0));
  });
});
