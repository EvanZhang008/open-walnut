/**
 * Outside-activity read-time fold: per-app grouping, per-site breakdown, and the
 * inside-Walnut rule (which is computed here, never stored). Pure — no fs.
 */

import { describe, it, expect } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  BROWSER_BUNDLE_IDS, WALNUT_DESKTOP_BUNDLE_ID, foldOutsideApps, walnutHostsFromConfig,
} from '../../../src/core/time-tracking/outside-view.js';
import type { OutsideRow } from '../../../src/core/time-tracking/outside-store.js';

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
