/**
 * Placement by load (src/core/hosts/placement.ts): the caps, the choice, and what stays
 * on the Mac. The hosts' numbers come through the prober seam; config and the session
 * store are real (an empty store: no session in a turn).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fsp from 'node:fs/promises';
import { createMockConstants } from '../../helpers/mock-constants.js';

const cfg = vi.hoisted(() => ({ hosts: {} as Record<string, unknown>, session_limits: undefined as Record<string, number> | undefined }));
vi.mock('../../../src/constants.js', () => createMockConstants('placement'));
vi.mock('../../../src/core/config-manager.js', async (orig) => {
  const real = await orig<typeof import('../../../src/core/config-manager.js')>();
  return { ...real, getConfig: async () => ({ ...(await real.getConfig()), hosts: cfg.hosts, ...(cfg.session_limits ? { session_limits: cfg.session_limits } : {}) }) };
});

import { WALNUT_HOME } from '../../../src/constants.js';
import { __setHostLoadProberForTesting, choosePlacement, judgeHost, macOnlyReason, placementCaps } from '../../../src/core/hosts/placement.js';
import type { HostLoad } from '../../../src/providers/host-facts-core.js';

const GB = 1024 ** 3;
function load(over: Partial<HostLoad> & { load1?: number } = {}): HostLoad {
  const { load1, ...rest } = over;
  return {
    cpus: 14, load: [load1 ?? 4, 4, 4], cpuBusy: 0.2, memTotalBytes: 48 * GB, memAvailBytes: 20 * GB,
    diskPath: '/x', diskFreeBytes: 200 * GB, diskTotalBytes: 1000 * GB, at: new Date().toISOString(), ...rest,
  };
}

let loads: Record<string, HostLoad | Error> = {};
beforeEach(async () => {
  await fsp.rm(WALNUT_HOME, { recursive: true, force: true });
  await fsp.mkdir(WALNUT_HOME, { recursive: true });
  cfg.hosts = { cloud: { hostname: 'cloud', enabled: true }, spare: { hostname: 'spare', enabled: true } };
  cfg.session_limits = undefined;
  loads = {};
  __setHostLoadProberForTesting(async (host) => {
    const v = loads[host];
    if (!v) throw new Error('not connected');
    if (v instanceof Error) throw v;
    return v;
  });
});
afterEach(() => { __setHostLoadProberForTesting(null); });

describe('judgeHost', () => {
  const caps = placementCaps({});
  it('names every cap a host is over, in plain words', () => {
    // 2026-10-31 on the Mac: load 600 on 14 CPUs, 20 GB free, 14 sessions.
    const v = judgeHost('__local__', 'this Mac', load({ load1: 600, diskFreeBytes: 19 * GB, cpuBusy: 0.97, memAvailBytes: 1 * GB }), 14, 7, caps);
    expect(v.busy).toBe(true);
    expect(v.score).toBe(0);
    expect(v.reasons).toEqual([
      'load 600 on 14 CPUs (42.86 per CPU, cap 3)', 'CPU 97% busy', '2% memory available',
      '19.0 GB disk free (floor 20 GB)', '14 sessions in a turn (limit 7)',
    ]);
  });
  it('a host under every cap has room, more for more idle cores', () => {
    const small = judgeHost('a', 'a', load({ cpus: 4, load1: 1 }), 0, 20, caps);
    const big = judgeHost('b', 'b', load({ cpus: 48, load1: 2 }), 0, 20, caps);
    expect(small.busy || big.busy).toBe(false);
    expect(big.score).toBeGreaterThan(small.score);
  });
  it('a host that did not answer is unknown, never room', () => {
    expect(judgeHost('c', 'c', undefined, 0, 20, caps, 'no answer in 4 s')).toMatchObject({ known: false, busy: true, score: 0, reasons: ['its load is unknown (no answer in 4 s)'] });
  });
  it('the caps follow the env', () => {
    expect(placementCaps({ WALNUT_PLACE_MAX_LOAD_PER_CPU: '10', WALNUT_PLACE_MIN_DISK_GB: '5' })).toMatchObject({ loadPerCpu: 10, diskFreeBytes: 5 * GB });
  });
});

describe('macOnlyReason', () => {
  it.each([
    ['Fix the iOS share sheet', undefined],
    ['Check the Mac app window on WebKit', undefined],
    ['Take a look at my screen', undefined],
    ['Rebuild the simulator lane', undefined],
    ['Check the load watchdog on the Mac', undefined],
    ['Free disk on macOS', undefined],
    ['Parser speedup', '/Users/me/walnut/ios-native/Sources'],
  ])('%s stays on the Mac', (text, cwd) => {
    expect(macOnlyReason(text, cwd)).toBeTruthy();
  });
  it('ordinary server work does not', () => {
    expect(macOnlyReason('Speed up the task search ranking\nrun the vitest suite', '/Users/me/walnut')).toBeNull();
    // "ios" inside a word is not iOS.
    expect(macOnlyReason('Fix the bios clock and the radios list', undefined)).toBeNull();
  });
  it('a tag pins it', () => {
    expect(macOnlyReason('anything', undefined, ['mac-only'])).toBeTruthy();
  });
});

describe('choosePlacement', () => {
  it('the Mac overloaded and clouddev idle: the start goes to clouddev, saying why with the numbers', async () => {
    loads = { __local__: load({ load1: 600 }), cloud: load({ cpus: 48, load1: 3 }), spare: load({ cpus: 8, load1: 2 }) };
    const d = await choosePlacement({ defaultHost: '', text: 'Speed up the parser', cwd: '/work/marina' });
    expect(d).toMatchObject({ host: 'cloud', moved: true, from: '__local__' });
    expect(d!.reason).toMatch(/^this Mac is overloaded \(load 600 on 14 CPUs .*\); cloud has room \(load 3 on 48 CPUs, 0 of 20 sessions in a turn, 200 GB free\)$/);
  });
  it('the default host with room keeps it, even when another has more', async () => {
    loads = { __local__: load({ load1: 10 }), cloud: load({ cpus: 48, load1: 1 }) };
    expect(await choosePlacement({ defaultHost: '', text: 'x', cwd: '/w' })).toMatchObject({ host: '', moved: false, reason: 'this Mac has room' });
  });
  it('never past a cap when another host is free; when none is, it stays and says so', async () => {
    loads = { __local__: load({ load1: 600 }), cloud: load({ load1: 900 }), spare: new Error('no answer') };
    const d = await choosePlacement({ defaultHost: '', text: 'x', cwd: '/w' });
    expect(d).toMatchObject({ host: '', moved: false });
    expect(d!.reason).toContain('and no other host has room');
  });
  it('a host that cannot take the work is skipped for the next one', async () => {
    loads = { __local__: load({ load1: 600 }), cloud: load({ cpus: 48, load1: 1 }), spare: load({ cpus: 8, load1: 1 }) };
    const d = await choosePlacement({ defaultHost: '', text: 'x', cwd: '/w', eligible: async (h) => (h === 'cloud' ? 'codex is not installed' : null) });
    expect(d).toMatchObject({ host: 'spare', moved: true });
    expect(d!.hosts.find((h) => h.host === 'cloud')!.reasons).toContain('not eligible: codex is not installed');
  });
  it('Mac-only work stays on the overloaded Mac', async () => {
    loads = { __local__: load({ load1: 600 }), cloud: load({ cpus: 48, load1: 1 }) };
    const d = await choosePlacement({ defaultHost: '', text: 'Ship the iOS build to TestFlight', cwd: '/w' });
    expect(d).toMatchObject({ host: '', moved: false });
    expect(d!.reason).toMatch(/^stays on this Mac: it mentions "iOS"/);
  });
  it('a remote default host that is overloaded hands work to the Mac when it has room', async () => {
    loads = { __local__: load({ load1: 2 }), cloud: load({ cpus: 48, load1: 400 }), spare: load({ load1: 300 }) };
    expect(await choosePlacement({ defaultHost: 'cloud', text: 'x', cwd: '/w' })).toMatchObject({ host: '', moved: true, from: 'cloud' });
  });
  it('the running-session limit is a cap too, and a host marked place:false is never chosen', async () => {
    cfg.hosts = { cloud: { hostname: 'cloud', enabled: true, place: false }, spare: { hostname: 'spare', enabled: true } };
    cfg.session_limits = { spare: 1 };
    loads = { __local__: load({ load1: 600 }), cloud: load({ cpus: 48, load1: 1 }), spare: load({ cpus: 8, load1: 1 }) };
    // spare has room (no session in a turn in this store); cloud is out by config.
    expect(await choosePlacement({ defaultHost: '', text: 'x', cwd: '/w' })).toMatchObject({ host: 'spare', moved: true });
  });
  it('WALNUT_PLACE_BY_LOAD=0 turns it off', async () => {
    loads = { __local__: load({ load1: 600 }), cloud: load({ cpus: 48, load1: 1 }) };
    process.env.WALNUT_PLACE_BY_LOAD = '0';
    try { expect(await choosePlacement({ defaultHost: '', text: 'x', cwd: '/w' })).toBeNull(); } finally { delete process.env.WALNUT_PLACE_BY_LOAD; }
  });
});
