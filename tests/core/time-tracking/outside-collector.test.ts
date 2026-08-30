/**
 * Outside-activity collector — the PURE parts: what a helper line is, what one
 * sample is worth, and what it becomes in the store. No child process is spawned
 * here (the helper needs macOS + a swiftc compile); the acceptance rule is
 * factored out precisely so it can be tested without one.
 */

import { describe, it, expect, vi } from 'vitest';
import { createMockConstants } from '../../helpers/mock-constants.js';

vi.mock('../../../src/constants.js', () => createMockConstants('walnut-outside-collector'));

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  AWAY_BUNDLE_IDS, HELPER_VERSION, MAX_BANK_MS, MAX_IDLE_SECS, TICK_MS, decideSample,
  isOutsideCollectorRunning, parseSampleLine, sampleToRecord, stopOutsideCollector,
  type ActivitySample,
} from '../../../src/core/time-tracking/outside-collector.js';
import { localDateKey } from '../../../src/core/time-tracking/rollup.js';

function sample(over: Partial<ActivitySample> = {}): ActivitySample {
  return { ts: '2026-08-29T14:11:21', app: 'Slack', bundleId: 'com.tinyspeck.slackmacgap', idleSecs: 3.2, locked: false, ...over };
}

describe('parseSampleLine', () => {
  it('accepts the helper line shape', () => {
    const line = '{"app":"Google Chrome","bundleId":"com.google.Chrome","host":"GitHub.com","idleSecs":3.2,"locked":false,"ts":"2026-08-29T14:11:21"}';
    expect(parseSampleLine(line)).toEqual({
      ts: '2026-08-29T14:11:21',
      app: 'Google Chrome',
      bundleId: 'com.google.Chrome',
      idleSecs: 3.2,
      locked: false,
      host: 'github.com', // hosts are compared, so they are normalized at the door
    });
  });

  it('carries the browser permission marker instead of a host', () => {
    const parsed = parseSampleLine('{"app":"Safari","bundleId":"com.apple.Safari","browserErr":"permission","idleSecs":1,"locked":false,"ts":"2026-08-29T14:11:21"}');
    expect(parsed).toMatchObject({ browserErr: 'permission' });
    expect(parsed?.host).toBeUndefined();
  });

  it('rejects anything that is not a sample', () => {
    expect(parseSampleLine('')).toBeNull();
    expect(parseSampleLine('   ')).toBeNull();
    expect(parseSampleLine('not json')).toBeNull();
    expect(parseSampleLine('{"ts":"2026-08-29T14:11:21"}')).toBeNull(); // no app
    expect(parseSampleLine('{"app":"   ","ts":"x"}')).toBeNull();
    expect(parseSampleLine('{"error":"usage","code":"usage"}')).toBeNull();
    expect(parseSampleLine('{"app":"Slack","idleSecs":"lots"}')?.idleSecs).toBeUndefined();
  });
});

describe('decideSample', () => {
  const NOW = 1_800_000_000_000;

  it('banks one nominal tick for the first sample', () => {
    expect(decideSample(sample(), null, NOW)).toEqual({ durationMs: TICK_MS, nextPrev: NOW });
  });

  it('banks the real elapsed time inside a continuous run', () => {
    expect(decideSample(sample(), NOW - 5000, NOW)).toEqual({ durationMs: 5000, nextPrev: NOW });
  });

  it('clamps a late sample instead of counting the whole gap', () => {
    expect(decideSample(sample(), NOW - 40 * 60_000, NOW)).toEqual({ durationMs: MAX_BANK_MS, nextPrev: NOW });
  });

  it('discards a locked screen and drops the anchor', () => {
    expect(decideSample(sample({ locked: true }), NOW - 5000, NOW)).toEqual({ durationMs: 0, nextPrev: null });
  });

  it('discards an idle sample and drops the anchor', () => {
    expect(decideSample(sample({ idleSecs: MAX_IDLE_SECS + 0.1 }), NOW - 5000, NOW))
      .toEqual({ durationMs: 0, nextPrev: null });
    // Exactly at the threshold is still attention.
    expect(decideSample(sample({ idleSecs: MAX_IDLE_SECS }), NOW - 5000, NOW).durationMs).toBe(5000);
  });

  it('banks one tick (not the away period) on the first sample after an away stretch', () => {
    let prev: number | null = NOW - 5000;
    const away = decideSample(sample({ locked: true }), prev, NOW);
    prev = away.nextPrev;
    const back = decideSample(sample(), prev, NOW + 30 * 60_000);
    expect(back).toEqual({ durationMs: TICK_MS, nextPrev: NOW + 30 * 60_000 });
  });

  it('banks nothing for a non-advancing clock but keeps the anchor', () => {
    expect(decideSample(sample(), NOW, NOW)).toEqual({ durationMs: 0, nextPrev: NOW });
    expect(decideSample(sample(), NOW + 10, NOW)).toEqual({ durationMs: 0, nextPrev: NOW + 10 });
  });

  it('accepts a sample with no idle field at all (an older helper)', () => {
    const bare: ActivitySample = { ts: '2026-08-29T14:11:21', app: 'Slack' };
    expect(decideSample(bare, null, NOW).durationMs).toBe(TICK_MS);
  });

  it('discards the lock screen and the screen saver even when locked says false', () => {
    // The field bug: a stale frontmost read banked 20 minutes of `loginwindow` as
    // work, with locked:false alongside it (the lock flag was live and the screen
    // really was unlocked — the APP name was the frozen value).
    for (const bundleId of AWAY_BUNDLE_IDS) {
      expect(decideSample(sample({ app: 'loginwindow', bundleId, locked: false }), NOW - 5000, NOW))
        .toEqual({ durationMs: 0, nextPrev: null });
    }
    expect(AWAY_BUNDLE_IDS).toContain('com.apple.loginwindow');
  });

  it('still counts an app whose name merely resembles one of those', () => {
    expect(decideSample(sample({ app: 'Login Items', bundleId: 'com.example.loginwindow-tool' }), NOW - 5000, NOW).durationMs)
      .toBe(5000);
  });
});

describe('helper version (ratchet)', () => {
  it('matches the version baked into the swift source', async () => {
    // The collector names the compiled binary after this version and reuses any
    // file already at that path, so a swift change without a bump would keep
    // running the OLD binary forever — which is exactly how a fixed staleness bug
    // would appear unfixed on an upgraded machine.
    const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
    const source = await fs.readFile(path.join(repoRoot, 'src/data/walnut-activity.swift'), 'utf-8');
    expect(source).toContain(`let HELPER_VERSION = "${HELPER_VERSION}"`);
    // And the tick wait must keep servicing the run loop: a plain sleep is what
    // froze the frontmost app for the life of the process.
    expect(source).toContain('waitServicingRunLoop(until: next)');
  });
});

describe('sampleToRecord', () => {
  it('stamps the START of the counted window and files it under that local day', () => {
    const at = new Date(2026, 7, 29, 14, 11, 21); // local, as the helper reports
    const rec = sampleToRecord(
      sample({ ts: '2026-08-29T14:11:21', app: 'Google Chrome', bundleId: 'com.google.Chrome', host: 'github.com' }),
      5000,
      new Date(),
    );
    expect(rec).toEqual({
      date: localDateKey(new Date(at.getTime() - 5000)),
      ts: new Date(at.getTime() - 5000).toISOString(),
      durationMs: 5000,
      app: 'Google Chrome',
      bundleId: 'com.google.Chrome',
      host: 'github.com',
    });
  });

  it('falls back to the receive time when the helper stamp is unusable', () => {
    const receivedAt = new Date(2026, 7, 29, 9, 0, 0);
    const rec = sampleToRecord({ ts: 'not-a-date', app: 'Slack' }, 5000, receivedAt);
    expect(rec.date).toBe(localDateKey(new Date(receivedAt.getTime() - 5000)));
    expect(rec.bundleId).toBeUndefined();
    expect(rec.host).toBeUndefined();
  });

  it('files a window that straddled midnight under the day it began', () => {
    const justAfterMidnight = new Date(2026, 7, 29, 0, 0, 2);
    const rec = sampleToRecord({ ts: '2026-08-29T00:00:02', app: 'Slack' }, 5000, justAfterMidnight);
    expect(rec.date).toBe('2026-08-28');
  });
});

describe('lifecycle', () => {
  it('reports not-running before anything starts, and stop() is idempotent', () => {
    expect(isOutsideCollectorRunning()).toBe(false);
    stopOutsideCollector();
    stopOutsideCollector();
    expect(isOutsideCollectorRunning()).toBe(false);
  });
});
