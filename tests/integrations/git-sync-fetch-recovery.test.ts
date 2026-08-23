/**
 * Regression tests for the 2026-08-23 disk-burial incident.
 *
 * The first fetch after a weekly history compaction must move the ENTIRE
 * rewritten chain (measured 2m33s on the cloud box), but every git-sync fetch
 * ran with the 15s fail-fast NETWORK_TIMEOUT. The 30s tick therefore killed
 * the same fetch forever, and each kill left a partial tmp_pack_* corpse in
 * objects/pack: 92 corpses / 79GB in 73 minutes → disk 100%, ENOSPC, the SSM
 * agent couldn't even fork. Two independent defenses:
 *
 *  1. A fetch-failure STREAK widens the next fetch's timeout
 *     (fetchTimeoutForStreak) so a big-but-legitimate transfer can finish.
 *  2. The fetch-failure path sweeps dead tmp_pack corpses immediately
 *     (sweepDeadFetchPacks), age-gated so live transfers are never touched —
 *     the weekly maintenance sweep's 24h grace is a full disk at one corpse
 *     per tick.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fsp from 'node:fs/promises';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { vi } from 'vitest';
import { createMockConstants } from '../helpers/mock-constants.js';

vi.mock('../../src/constants.js', () => createMockConstants());

import {
  fetchTimeoutForStreak,
  sweepDeadFetchPacks,
  FETCH_TIMEOUT,
  FETCH_RECOVERY_TIMEOUT,
  FETCH_STREAK_FOR_RECOVERY,
  FETCH_DEBRIS_MIN_AGE_MS,
} from '../../src/integrations/git-sync.js';

describe('fetchTimeoutForStreak', () => {
  it('keeps the fail-fast timeout below the streak threshold', () => {
    for (let s = 0; s < FETCH_STREAK_FOR_RECOVERY; s++) {
      expect(fetchTimeoutForStreak(s)).toBe(FETCH_TIMEOUT);
    }
  });

  it('widens to the recovery timeout at and beyond the threshold', () => {
    expect(fetchTimeoutForStreak(FETCH_STREAK_FOR_RECOVERY)).toBe(FETCH_RECOVERY_TIMEOUT);
    expect(fetchTimeoutForStreak(133)).toBe(FETCH_RECOVERY_TIMEOUT);
  });

  it('recovery timeout actually fits the measured post-compaction fetch (2m33s)', () => {
    expect(FETCH_RECOVERY_TIMEOUT).toBeGreaterThan(153_000);
  });
});

describe('sweepDeadFetchPacks', () => {
  let repoDir: string;
  let packDir: string;

  beforeEach(async () => {
    repoDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'wn-fetch-sweep-'));
    packDir = path.join(repoDir, '.git', 'objects', 'pack');
    await fsp.mkdir(packDir, { recursive: true });
  });

  afterEach(async () => {
    await fsp.rm(repoDir, { recursive: true, force: true });
  });

  function corpse(name: string, ageMs: number): string {
    const p = path.join(packDir, name);
    fs.writeFileSync(p, 'dead pack bytes');
    const t = new Date(Date.now() - ageMs);
    fs.utimesSync(p, t, t);
    return p;
  }

  it('deletes tmp_pack corpses older than the age gate', () => {
    const dead = corpse('tmp_pack_8EnV8G', FETCH_DEBRIS_MIN_AGE_MS + 60_000);
    expect(sweepDeadFetchPacks(repoDir)).toBe(1);
    expect(fs.existsSync(dead)).toBe(false);
  });

  it('never touches a fresh tmp_pack (could be a live transfer)', () => {
    const live = corpse('tmp_pack_xZvLjw', 10_000);
    expect(sweepDeadFetchPacks(repoDir)).toBe(0);
    expect(fs.existsSync(live)).toBe(true);
  });

  it('never touches real packs or indexes, whatever their age', () => {
    const pack = corpse('pack-0fecdd3b.pack', FETCH_DEBRIS_MIN_AGE_MS * 10);
    const idx = corpse('pack-0fecdd3b.idx', FETCH_DEBRIS_MIN_AGE_MS * 10);
    expect(sweepDeadFetchPacks(repoDir)).toBe(0);
    expect(fs.existsSync(pack)).toBe(true);
    expect(fs.existsSync(idx)).toBe(true);
  });

  it('is a no-op on a repo with no pack dir', () => {
    expect(sweepDeadFetchPacks(path.join(repoDir, 'nonexistent'))).toBe(0);
  });

  it('incident shape: a pile of old corpses goes, the in-flight one stays', () => {
    for (let i = 0; i < 5; i++) corpse(`tmp_pack_dead${i}`, FETCH_DEBRIS_MIN_AGE_MS + i * 30_000 + 1_000);
    const live = corpse('tmp_pack_current', 5_000);
    expect(sweepDeadFetchPacks(repoDir)).toBe(5);
    expect(fs.existsSync(live)).toBe(true);
  });
});
