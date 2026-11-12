/**
 * The rules of src/core/sessions/live-sessions.ts (settings, what must stay alive, the order the
 * live limit stops sessions in) and how placement reads the live limit (judgeHost).
 */
import { describe, it, expect } from 'vitest';
import {
  DEFAULT_IDLE_EXIT_MINUTES, EVICT_MIN_QUIET_MS, evictionOrder, exitsLast, isLocalLiveProcess,
  localIdleExitMs, localLiveLimit, mustStay, type LiveRunnerView,
} from '../../../src/core/sessions/live-sessions.js';
import { judgeHost } from '../../../src/core/hosts/placement.js';
import type { HostLoad } from '../../../src/providers/host-facts-core.js';

const GB = 1024 ** 3;
const MIN = 60_000;

describe('settings', () => {
  it('idle exit: default 30 minutes, a set value, 0 = off, junk = default', () => {
    expect(localIdleExitMs(undefined)).toBe(DEFAULT_IDLE_EXIT_MINUTES * MIN);
    expect(localIdleExitMs({ local_idle_exit_minutes: 15 })).toBe(15 * MIN);
    expect(localIdleExitMs({ local_idle_exit_minutes: 0 })).toBeNull();
    expect(localIdleExitMs({ local_idle_exit_minutes: -5 })).toBe(30 * MIN);
    expect(localIdleExitMs({ local_idle_exit_minutes: 'x' as unknown as number })).toBe(30 * MIN);
  });

  it('live limit: one per 2.4 GB of memory, 4 to 64; a set value wins; 0 = none', () => {
    expect(localLiveLimit(undefined, 48 * GB)).toBe(20);
    expect(localLiveLimit(undefined, 16 * GB)).toBe(6);
    expect(localLiveLimit(undefined, 4 * GB)).toBe(4);
    expect(localLiveLimit(undefined, 512 * GB)).toBe(64);
    expect(localLiveLimit({ local_live_limit: 12 }, 48 * GB)).toBe(12);
    expect(localLiveLimit({ local_live_limit: 0 }, 48 * GB)).toBe(0);
  });
});

describe('what counts and what must stay', () => {
  it('a live process is a local record running or idle with a pid, not archived, not SDK or embedded', () => {
    const base = { host: undefined, archived: false, process_status: 'idle' as const, pid: 12, provider: undefined };
    expect(isLocalLiveProcess(base)).toBe(true);
    expect(isLocalLiveProcess({ ...base, process_status: 'running' })).toBe(true);
    expect(isLocalLiveProcess({ ...base, host: 'devbox' })).toBe(false);
    expect(isLocalLiveProcess({ ...base, process_status: 'stopped' })).toBe(false);
    expect(isLocalLiveProcess({ ...base, pid: undefined })).toBe(false);
    expect(isLocalLiveProcess({ ...base, archived: true })).toBe(false);
    expect(isLocalLiveProcess({ ...base, provider: 'sdk' as never })).toBe(false);
  });

  // Every signal the runner gives keeps the process alive: adding one to LiveRunnerView without a
  // branch in mustStay fails here.
  it.each<[keyof LiveRunnerView, string]>([
    ['isInTurn', 'turn'], ['hasWorkOutlivingTurn', 'own-work'], ['isCronArmed', 'loop'],
    ['hasPendingPermission', 'prompt'], ['isTeamActive', 'team'],
  ])('%s keeps it (%s)', (signal, reason) => {
    const runner: LiveRunnerView = { [signal]: () => true };
    expect(mustStay({ claudeSessionId: 's', process_status: 'idle' }, runner, false)).toBe(reason);
  });

  it('every runner signal is covered above', () => {
    const covered = ['isInTurn', 'hasWorkOutlivingTurn', 'isCronArmed', 'hasPendingPermission', 'isTeamActive'];
    const runner: Required<LiveRunnerView> = {
      isInTurn: () => null, hasWorkOutlivingTurn: () => false, isCronArmed: () => false,
      hasPendingPermission: () => false, isTeamActive: () => false,
    };
    expect(Object.keys(runner).sort()).toEqual(covered.sort());
    expect(mustStay({ claudeSessionId: 's', process_status: 'idle' }, runner, false)).toBeNull();
  });

  it('a running record the runner does not hold is in a turn; the user being there keeps it', () => {
    expect(mustStay({ claudeSessionId: 's', process_status: 'running' }, null, false)).toBe('turn');
    expect(mustStay({ claudeSessionId: 's', process_status: 'idle' }, null, false)).toBeNull();
    expect(mustStay({ claudeSessionId: 's', process_status: 'idle' }, null, true)).toBe('user-here');
    // The runner's own "not in a turn" beats a stale running record.
    expect(mustStay({ claudeSessionId: 's', process_status: 'running' }, { isInTurn: () => false }, false)).toBeNull();
  });

  it('Main and the VPs (and a router) go last', () => {
    expect(exitsLast({ org_role: 'main' })).toBe(true);
    expect(exitsLast({ org_role: 'lead' })).toBe(true);
    expect(exitsLast({ org_role: 'router' })).toBe(true);
    expect(exitsLast({})).toBe(false);
    expect(exitsLast(undefined)).toBe(false);
  });

  it('the stop order: others before org nodes, longest quiet first, none fresher than the floor', () => {
    const order = evictionOrder([
      { claudeSessionId: 'vp', quietMs: 90 * MIN, last: true },
      { claudeSessionId: 'w10', quietMs: 10 * MIN, last: false },
      { claudeSessionId: 'w40', quietMs: 40 * MIN, last: false },
      { claudeSessionId: 'fresh', quietMs: EVICT_MIN_QUIET_MS - 1, last: false },
    ]).map((c) => c.claudeSessionId);
    expect(order).toEqual(['w40', 'w10', 'vp']);
  });
});

describe('placement reads the live limit', () => {
  const load: HostLoad = {
    cpus: 14, load: [4, 4, 4], cpuBusy: 0.2, memTotalBytes: 48 * GB, memAvailBytes: 20 * GB,
    diskPath: '/x', diskFreeBytes: 200 * GB, diskTotalBytes: 1000 * GB, at: new Date().toISOString(),
  };

  it('under the limit: no effect', () => {
    const v = judgeHost('__local__', 'this Mac', load, 0, 7, undefined, undefined, { live: 10, pinned: 3, limit: 20 });
    expect([v.busy, v.full]).toEqual([false, false]);
  });

  it('at the limit with idle ones that can exit: busy (another host is preferred), never full', () => {
    const v = judgeHost('__local__', 'this Mac', load, 2, 7, undefined, undefined, { live: 22, pinned: 8, limit: 20 });
    expect(v.busy).toBe(true);
    expect(v.full).toBe(false);
    expect(v.reasons.join('; ')).toContain('22 live sessions (limit 20, 8 busy)');
  });

  it('the ones that must stay fill it: full, in words that do not change while a start waits', () => {
    const v = judgeHost('__local__', 'this Mac', load, 2, 7, undefined, undefined, { live: 21, pinned: 20, limit: 20 });
    expect(v.full).toBe(true);
    expect(v.fullReasons).toContain('all 20 live sessions busy');
    // Unknown load still keeps the live limit.
    const unknown = judgeHost('__local__', 'this Mac', undefined, 0, 7, undefined, undefined, { live: 21, pinned: 20, limit: 20 });
    expect(unknown.full).toBe(true);
  });

  it('no limit (0) or no count: as before', () => {
    expect(judgeHost('__local__', 'this Mac', load, 0, 7, undefined, undefined, { live: 50, pinned: 50, limit: 0 }).full).toBe(false);
    expect(judgeHost('__local__', 'this Mac', load, 0, 7).live).toBeUndefined();
  });
});
