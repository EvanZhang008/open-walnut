/**
 * The Mac app's automatic update, as the page decides it (web/src/components/layout/app-auto-update.ts),
 * driven with a fake shell state: download once per version when updates.auto is on, restart only
 * when downloaded and the server's idle gate is ready, once, and from one window (the claim).
 * Unsaved work is the hook's check after this says `restart` (gatherUnsavedWork), pinned in the
 * browser spec; here: nothing is decided without `updatesAuto`, and an error is never retried.
 */
import { describe, it, expect } from 'vitest';
import type { AppUpdateState } from '@/hooks/useAppUpdate';
import type { LiveUpdate } from '@/api/update';
import {
  AUTO_CLAIM_KEY, AUTO_CLAIM_MS, RESTART_ONCE_MS, claimHeldByOther, nextAutoStep, parseClaim, readClaim, readLastRestart,
  takeClaim, writeLastRestart, type AutoInput,
} from '@/components/layout/app-auto-update';

function shell(over: Partial<AppUpdateState> = {}): AppUpdateState {
  return {
    enabled: true, status: 'available', currentVersion: '1.0.0', hostArch: 'arm64', appArch: 'arm64', runningUnderArm64Translation: false,
    availableVersion: '1.1.0', downloadedVersion: null, downloadPercent: null, checkedAt: null, message: null, errorContext: null,
    canRetry: false, disabledReason: null, ...over,
  };
}
function live(over: Partial<LiveUpdate> = {}, ready = false): LiveUpdate {
  return {
    state: 'off', version: null, error: null, canInstall: false, held: null, updatesAuto: true,
    idle: { ready, userIdleMs: ready ? 700_000 : 1_000, turnsRunning: 0, waitingSince: null }, ...over,
  };
}
const NOW = 1_800_000_000_000;
const input = (over: Partial<AutoInput>): AutoInput => ({ shell: shell(), live: live(), done: new Set(), claim: null, owner: 'me', now: NOW, ...over });
const DOWNLOADED = shell({ status: 'downloaded', downloadedVersion: '1.1.0' });

class MemStore {
  map = new Map<string, string>();
  getItem(k: string) { return this.map.get(k) ?? null; }
  setItem(k: string, v: string) { this.map.set(k, v); }
}

describe('nextAutoStep', () => {
  it('available + updates.auto: download that version', () => {
    expect(nextAutoStep(input({}))).toEqual({ step: 'download', version: '1.1.0' });
  });

  it('nothing without updates.auto, without live (an older server), outside the app, or with the updater off', () => {
    expect(nextAutoStep(input({ live: live({ updatesAuto: false }) }))).toBeNull();
    expect(nextAutoStep(input({ live: undefined }))).toBeNull();
    expect(nextAutoStep(input({ shell: null }))).toBeNull();
    expect(nextAutoStep(input({ shell: shell({ enabled: false }) }))).toBeNull();
  });

  it('download once per version: done in this window means not again; a newer version is asked again', () => {
    expect(nextAutoStep(input({ done: new Set(['download:1.1.0']) }))).toBeNull();
    expect(nextAutoStep(input({ done: new Set(['download:1.1.0']), shell: shell({ availableVersion: '1.2.0' }) })))
      .toEqual({ step: 'download', version: '1.2.0' });
  });

  it('downloading, checking, up to date: nothing', () => {
    for (const status of ['downloading', 'checking', 'up-to-date', 'idle'] as const) {
      expect(nextAutoStep(input({ shell: shell({ status }) }))).toBeNull();
    }
  });

  it('downloaded: restart only when the server\'s idle gate is ready', () => {
    expect(nextAutoStep(input({ shell: DOWNLOADED, live: live({}, false) }))).toBeNull();
    expect(nextAutoStep(input({ shell: DOWNLOADED, live: live({}, true) }))).toEqual({ step: 'restart', version: '1.1.0' });
  });

  it('restart once: done in this window means never again for that version', () => {
    expect(nextAutoStep(input({ shell: DOWNLOADED, live: live({}, true), done: new Set(['restart:1.1.0']) }))).toBeNull();
  });

  it('after an automatic restart into a version, the app coming back on the same download does not restart again for hours', () => {
    const base = { shell: DOWNLOADED, live: live({}, true) };
    expect(nextAutoStep(input({ ...base, lastRestart: { version: '1.1.0', at: NOW - 60_000 } }))).toBeNull();
    expect(nextAutoStep(input({ ...base, lastRestart: { version: '1.1.0', at: NOW - RESTART_ONCE_MS - 1 } })))
      .toEqual({ step: 'restart', version: '1.1.0' });
    expect(nextAutoStep(input({ ...base, lastRestart: { version: '1.0.9', at: NOW - 60_000 } })))
      .toEqual({ step: 'restart', version: '1.1.0' });
    // The download step is not held by it.
    expect(nextAutoStep(input({ lastRestart: { version: '1.1.0', at: NOW } }))).toEqual({ step: 'download', version: '1.1.0' });
    const store = new MemStore();
    expect(readLastRestart(store)).toBeNull();
    writeLastRestart(store, '1.1.0', NOW);
    expect(readLastRestart(store)).toEqual({ version: '1.1.0', at: NOW });
  });

  it('a failed install or download is never retried by itself (the person retries)', () => {
    expect(nextAutoStep(input({ shell: shell({ status: 'error', errorContext: 'install', downloadedVersion: '1.1.0' }), live: live({}, true) }))).toBeNull();
    expect(nextAutoStep(input({ shell: shell({ status: 'error', errorContext: 'download' }) }))).toBeNull();
  });

  it('another window\'s fresh claim on the same step keeps this one out; a stale one, or another step, does not', () => {
    const claim = { step: 'restart' as const, version: '1.1.0', owner: 'other', at: NOW - 10_000 };
    expect(nextAutoStep(input({ shell: DOWNLOADED, live: live({}, true), claim }))).toBeNull();
    expect(nextAutoStep(input({ shell: DOWNLOADED, live: live({}, true), claim: { ...claim, at: NOW - AUTO_CLAIM_MS - 1 } })))
      .toEqual({ step: 'restart', version: '1.1.0' });
    expect(nextAutoStep(input({ shell: DOWNLOADED, live: live({}, true), claim: { ...claim, step: 'download' } })))
      .toEqual({ step: 'restart', version: '1.1.0' });
    expect(nextAutoStep(input({ shell: DOWNLOADED, live: live({}, true), claim: { ...claim, owner: 'me' } })))
      .toEqual({ step: 'restart', version: '1.1.0' });
  });

  it('a claim stamped far in the future (a clock set back) does not lock the windows out', () => {
    expect(claimHeldByOther({ step: 'restart', version: '1', owner: 'o', at: NOW + AUTO_CLAIM_MS + 1 }, 'me', NOW, { step: 'restart', version: '1' })).toBe(false);
  });
});

describe('the cross-window claim', () => {
  it('the first window takes it; a second one within the claim time cannot, after it can', () => {
    const store = new MemStore();
    const step = { step: 'restart' as const, version: '1.1.0' };
    expect(takeClaim(store, step, 'a', NOW)).toBe(true);
    expect(readClaim(store)).toEqual({ ...step, owner: 'a', at: NOW });
    expect(takeClaim(store, step, 'b', NOW + 1_000)).toBe(false);
    expect(takeClaim(store, step, 'b', NOW + AUTO_CLAIM_MS + 1)).toBe(true);
  });

  it('two windows writing at once: only the one whose write stayed goes on', () => {
    const store = new MemStore();
    const step = { step: 'restart' as const, version: '1.1.0' };
    // Window b's write lands right after a's read-back check would have run: emulate a's
    // read-back seeing b's write.
    const racing = { getItem: (k: string) => store.getItem(k), setItem: (k: string, v: string) => { store.setItem(k, v); store.setItem(k, JSON.stringify({ ...step, owner: 'b', at: NOW })); } };
    expect(takeClaim(racing, step, 'a', NOW)).toBe(false);
  });

  it('a garbled claim is no claim; no storage at all lets the window go on', () => {
    expect(parseClaim('{nope')).toBeNull();
    expect(parseClaim(JSON.stringify({ step: 'other', version: '1', owner: 'a', at: 1 }))).toBeNull();
    const store = new MemStore();
    store.setItem(AUTO_CLAIM_KEY, 'garbage');
    expect(readClaim(store)).toBeNull();
    expect(takeClaim(null, { step: 'download', version: '1' }, 'a', NOW)).toBe(true);
  });
});
