/**
 * Placement by load (src/core/hosts/placement.ts): the caps, the choice, and what stays
 * on the Mac. The hosts' numbers come through the prober seam; config and the session
 * store are real (an empty store: no session in a turn).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fsp from 'node:fs/promises';
import { createMockConstants } from '../../helpers/mock-constants.js';

const cfg = vi.hoisted(() => ({ hosts: {} as Record<string, unknown>, session_limits: undefined as Record<string, number> | undefined, placement_weights: undefined as Record<string, number> | undefined }));
vi.mock('../../../src/constants.js', () => createMockConstants('placement'));
vi.mock('../../../src/core/config-manager.js', async (orig) => {
  const real = await orig<typeof import('../../../src/core/config-manager.js')>();
  return { ...real, getConfig: async () => ({ ...(await real.getConfig()), hosts: cfg.hosts, ...(cfg.session_limits ? { session_limits: cfg.session_limits } : {}), ...(cfg.placement_weights ? { placement_weights: cfg.placement_weights } : {}) }) };
});

import { WALNUT_HOME } from '../../../src/constants.js';
import { __setHostLoadProberForTesting, choosePlacement, hostLoads, hostSlots, judgeHost, localLoadPerCpu, macOnlyReason, placementCaps, placementWeight } from '../../../src/core/hosts/placement.js';
import os from 'node:os';
import { HostsFullError, __resetHostAdmissionForTesting, __setWaitStepForTesting, admitHostStart, holdSlotFor, isAutomaticStart, slotHoldersOn } from '../../../src/core/sessions/host-admission.js';
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
  cfg.placement_weights = undefined;
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
  it('reports the cores idle now beside the load, which counts threads, not CPU used', () => {
    // 2026-11-07 on the Mac: load 53 on 14 CPUs with 45% of the CPU idle.
    expect(judgeHost('m', 'm', load({ load1: 53, cpuBusy: 0.55 }), 0, 20, caps).freeCpus).toBe(6.3);
    expect(judgeHost('m', 'm', load({ cpuBusy: null }), 0, 20, caps).freeCpus).toBeNull();
  });
  it('a host that did not answer is unknown, never room', () => {
    expect(judgeHost('c', 'c', undefined, 0, 20, caps, 'no answer in 4 s')).toMatchObject({ known: false, busy: true, score: 0, reasons: ['its load is unknown (no answer in 4 s)'] });
  });
  it('over the cap, the load is judged by our own share of it; other apps alone never fill a host', () => {
    // 2026-11-08 on the Mac: load 98 on 14 CPUs, mostly a music app and a security agent; our
    // processes held 10 of 50 runnable threads.
    const mac = judgeHost('__local__', 'this Mac', load({ load1: 98, cpuBusy: 0.6, ownThreads: { ours: 10, others: 40 } }), 0, 7, caps);
    expect(mac).toMatchObject({ busy: false, full: false, loadPerCpu: 7, ownLoadPerCpu: 1.4 });
    expect(mac.score).toBeGreaterThan(0);
    // Our own work over the cap still holds a start, and the words say whose load it is.
    const ours = judgeHost('__local__', 'this Mac', load({ load1: 98, ownThreads: { ours: 45, others: 5 } }), 0, 7, caps);
    expect(ours).toMatchObject({ busy: true, full: true, fullReasons: ['load past 6 per CPU'] });
    expect(ours.reasons[0]).toBe('our share of the load 88.2 on 14 CPUs (6.3 per CPU, cap 3; whole load 98)');
    // No share (Linux, an older daemon), or nothing but ours: the whole load, as before.
    expect(judgeHost('c', 'c', load({ load1: 98 }), 0, 7, caps)).toMatchObject({ full: true, fullReasons: ['load past 6 per CPU'] });
    expect(judgeHost('c', 'c', load({ load1: 98, ownThreads: { ours: 9, others: 0 } }), 0, 7, caps).full).toBe(true);
    expect(judgeHost('c', 'c', load({ load1: 98, ownThreads: null }), 0, 7, caps).ownLoadPerCpu).toBeUndefined();
    // Other apps' CPU still counts: a CPU 97% busy is over its cap whatever the share.
    expect(judgeHost('m', 'm', load({ load1: 98, cpuBusy: 0.97, ownThreads: { ours: 10, others: 40 } }), 0, 7, caps).reasons).toEqual(['CPU 97% busy']);
  });
  it('the caps follow the env', () => {
    expect(placementCaps({ WALNUT_PLACE_MAX_LOAD_PER_CPU: '10', WALNUT_PLACE_MIN_DISK_GB: '5' })).toMatchObject({ loadPerCpu: 10, diskFreeBytes: 5 * GB });
  });
});

describe('localLoadPerCpu (restart recovery reads it)', () => {
  it('callers at once share one probe, and the share of that read scales the load over the line', async () => {
    let probes = 0;
    __setHostLoadProberForTesting(async () => { probes++; await new Promise((r) => setTimeout(r, 20)); return load({ ownThreads: { ours: 1, others: 3 } }); });
    const whole = os.loadavg()[0] / Math.max(1, os.cpus().length);
    // Before any read: the whole load. Many callers (one per queued session) start one probe.
    for (let i = 0; i < 20; i++) expect(localLoadPerCpu(0)).toBeCloseTo(whole, 1);
    await new Promise((r) => setTimeout(r, 60));
    expect(probes).toBe(1);
    expect(localLoadPerCpu(0)).toBeCloseTo(os.loadavg()[0] / Math.max(1, os.cpus().length) / 4, 1);
    // Under the line no probe is asked for and the load is the whole load.
    __setHostLoadProberForTesting(async () => { probes++; return load(); });
    expect(localLoadPerCpu(1e9)).toBeCloseTo(os.loadavg()[0] / Math.max(1, os.cpus().length), 1);
    await new Promise((r) => setTimeout(r, 20));
    expect(probes).toBe(1);
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
    expect(d!.reason).toMatch(/^this Mac is overloaded \(load 600 on 14 CPUs .*\); cloud has room \(load 3 on 48 CPUs, 0 of 16 sessions in a turn, 200 GB free\)$/);
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
    // None can: the reason names the hosts with room and why they cannot, never "no other host has room" (review round 6).
    const none = await choosePlacement({ defaultHost: '', text: 'x', cwd: '/w', eligible: async (h) => (h === 'cloud' ? 'codex is not installed' : 'it has no checkout of /w') });
    expect(none).toMatchObject({ host: '', moved: false });
    expect(none!.reason).toMatch(/^this Mac is overloaded \(.*\); cloud has room but codex is not installed; spare has room but it has no checkout of \/w$/);
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

// The files a task names (hosts/named-paths.ts): a host without them never takes the work.
describe('choosePlacement with the files a task names', () => {
  const BRIEF = '/home/me/.local/state/open-walnut/tasks/dc666739/review-brief-codex.md';
  /** Which named paths each host has. */
  let on: Record<string, string[] | null> = {};
  const checkPaths = async (host: string, paths: string[]) => {
    const has = on[host];
    if (has === null) return null;
    return { present: paths.filter((p) => (has ?? []).includes(p)), missing: paths.filter((p) => !(has ?? []).includes(p)) };
  };
  beforeEach(() => { on = {}; });

  it('2026-11-05: the Mac overloaded, the brief on clouddev only: clouddev takes it, not the roomier Mac without it', async () => {
    loads = { __local__: load({ load1: 116.5 }), cloud: load({ cpus: 48, load1: 30 }), spare: load({ cpus: 10, load1: 1.4 }) };
    on = { cloud: [BRIEF] };
    const d = await choosePlacement({ defaultHost: '', text: `Read the brief at ${BRIEF}`, cwd: '/w', paths: [BRIEF], checkPaths });
    expect(d).toMatchObject({ host: 'cloud', moved: true, forFiles: true });
    expect(d!.reason.startsWith(`this Mac does not have ${BRIEF}, which the task names; cloud has it (load 30 on 48 CPUs`)).toBe(true);
    expect(d!.hosts.find((h) => h.host === 'spare')!.reasons).toContain(`it does not have ${BRIEF}, which the task names`);
  });
  it('the host the start would use has room but not the file: it goes where the file is', async () => {
    loads = { __local__: load({ load1: 2 }), cloud: load({ cpus: 48, load1: 3 }), spare: load({ cpus: 8, load1: 1 }) };
    on = { cloud: [BRIEF] };
    expect(await choosePlacement({ defaultHost: '', text: 'x', cwd: '/w', paths: [BRIEF], checkPaths })).toMatchObject({ host: 'cloud', moved: true, forFiles: true });
  });
  it('a busy host with the file still beats hosts without it; an unknown one never', async () => {
    loads = { __local__: load({ load1: 2 }), cloud: load({ cpus: 48, load1: 400 }), spare: new Error('no answer') };
    on = { cloud: [BRIEF], spare: [BRIEF] };
    const d = await choosePlacement({ defaultHost: '', text: 'x', cwd: '/w', paths: [BRIEF], checkPaths });
    expect(d).toMatchObject({ host: 'cloud', moved: true });
    expect(d!.reason).toContain('; busy: load 400 on 48 CPUs');
  });
  it('the file only where the start would run: an overloaded host keeps the work rather than send it without it', async () => {
    loads = { __local__: load({ load1: 600 }), cloud: load({ cpus: 48, load1: 1 }), spare: load({ cpus: 8, load1: 1 }) };
    on = { __local__: [BRIEF] };
    const d = await choosePlacement({ defaultHost: '', text: 'x', cwd: '/w', paths: [BRIEF], checkPaths });
    expect(d).toMatchObject({ host: '', moved: false });
    expect(d!.reason).toContain('and no other host has room');
  });
  it('load chooses among the hosts with the most of the files', async () => {
    const B = '/srv/data/b.csv';
    loads = { __local__: load({ load1: 600 }), cloud: load({ cpus: 48, load1: 1 }), spare: load({ cpus: 8, load1: 1 }) };
    on = { __local__: [BRIEF, B], cloud: [BRIEF], spare: [BRIEF, B] };
    expect(await choosePlacement({ defaultHost: '', text: 'x', cwd: '/w', paths: [BRIEF, B], checkPaths })).toMatchObject({ host: 'spare', moved: true });
  });
  it('a path no host has asks for nothing (a file still to be written)', async () => {
    loads = { __local__: load({ load1: 600 }), cloud: load({ cpus: 48, load1: 1 }) };
    expect(await choosePlacement({ defaultHost: '', text: 'x', cwd: '/w', paths: ['/x/new/file.md'], checkPaths })).toMatchObject({ host: 'cloud', moved: true });
    expect((await choosePlacement({ defaultHost: '', text: 'x', cwd: '/w', paths: ['/x/new/file.md'], checkPaths }))!.forFiles).toBeUndefined();
  });
  it('a host that could not be asked has none of them; the start\'s own host keeps what it could not check', async () => {
    loads = { __local__: load({ load1: 600 }), cloud: load({ cpus: 48, load1: 1 }), spare: load({ cpus: 8, load1: 1 }) };
    on = { __local__: null, cloud: null, spare: [BRIEF] };
    expect(await choosePlacement({ defaultHost: '', text: 'x', cwd: '/w', paths: [BRIEF], checkPaths })).toMatchObject({ host: 'spare', moved: true });
    // Only its own host unchecked and nobody else with it: no reason to move for the file.
    on = { __local__: null, cloud: [], spare: [] };
    loads.__local__ = load({ load1: 2 });
    __setHostLoadProberForTesting(async (host) => loads[host] as never);
    expect(await choosePlacement({ defaultHost: '', text: 'x', cwd: '/w', paths: [BRIEF], checkPaths })).toMatchObject({ host: '', moved: false, reason: 'this Mac has room' });
  });
  it('the file host that cannot take the work is skipped; none left, the start stays and says why', async () => {
    loads = { __local__: load({ load1: 2 }), cloud: load({ cpus: 48, load1: 3 }) };
    on = { cloud: [BRIEF] };
    const asked: Array<[string, boolean]> = [];
    const d = await choosePlacement({ defaultHost: '', text: 'x', cwd: '/w', paths: [BRIEF], checkPaths, eligible: async (h, why) => { asked.push([h, why.forFiles]); return 'codex is not installed'; } });
    expect(asked).toEqual([['cloud', true]]);
    expect(d).toMatchObject({ host: '', moved: false });
    expect(d!.reason).toBe(`this Mac does not have ${BRIEF}, which the task names, and no host that has it and every file it has can take the work; it stays`);
  });
  it('any other named file only keeps a move off a host without it: a host with room keeps the work', async () => {
    // Review round 1: "/Applications/Walnut.app" on both Macs, not on clouddev, must not pull clouddev's work to a Mac.
    const APP = '/Applications/Walnut.app';
    loads = { __local__: load({ load1: 2 }), cloud: load({ cpus: 48, load1: 3 }), spare: load({ cpus: 8, load1: 1 }) };
    on = { __local__: [APP], spare: [APP] };
    expect(await choosePlacement({ defaultHost: 'cloud', text: 'x', cwd: '/w', paths: [APP], checkPaths })).toMatchObject({ host: 'cloud', moved: false, reason: 'cloud has room' });
    // Overloaded, it may go, but never to a host with fewer of them than it has.
    on = { cloud: [APP] };
    loads.cloud = load({ cpus: 48, load1: 400 });
    __setHostLoadProberForTesting(async (host) => loads[host] as never);
    const d = await choosePlacement({ defaultHost: 'cloud', text: 'x', cwd: '/w', paths: [APP], checkPaths });
    expect(d).toMatchObject({ host: 'cloud', moved: false });
    expect(d!.hosts.find((h) => h.host === 'spare')!.reasons).toContain(`it does not have ${APP}, which the task names`);
  });
  it('a files move goes only to a host with every named file the start\'s host lacks (review round 5, Sol)', async () => {
    const DATA = '/data/input.csv';
    loads = { __local__: load({ load1: 2 }), cloud: load({ cpus: 48, load1: 3 }), spare: load({ cpus: 8, load1: 1 }) };
    // The brief only on cloud, the data only on spare: neither has both, so it stays.
    on = { cloud: [BRIEF], spare: [DATA] };
    const d = await choosePlacement({ defaultHost: '', text: 'x', cwd: '/w', paths: [BRIEF, DATA], checkPaths });
    expect(d).toMatchObject({ host: '', moved: false });
    expect(d!.reason).toMatch(/every file it lacks and every file it has can take the work; it stays$/);
    expect(d!.hosts.find((h) => h.host === 'cloud')!.reasons).toContain(`it does not have ${DATA}, which the task names`);
    // Any other named path it lacks counts too: spare has the brief and the app, cloud only the brief.
    const APP = '/Applications/Tool.app';
    on = { cloud: [BRIEF], spare: [BRIEF, APP] };
    expect(await choosePlacement({ defaultHost: '', text: 'x', cwd: '/w', paths: [BRIEF, APP], checkPaths })).toMatchObject({ host: 'spare', moved: true, forFiles: true });
  });
  it('a document the task names that only another host has takes the work there, even from a host with room (review round 5)', async () => {
    const PLAN = '/srv/projects/repo/docs/plan.md';
    loads = { __local__: load({ load1: 2 }), cloud: load({ cpus: 48, load1: 3 }), spare: load({ cpus: 8, load1: 1 }) };
    on = { cloud: [PLAN] };
    expect(await choosePlacement({ defaultHost: '', text: `Follow ${PLAN}`, cwd: '/w', paths: [PLAN], checkPaths })).toMatchObject({ host: 'cloud', moved: true, forFiles: true });
    // A folder, an app or source code is a place, not a file the work reads: it moves nothing.
    for (const p of ['/srv/projects/repo/docs', '/Applications/Walnut.app', '/srv/projects/repo/src/a.ts', '/usr/share/doc/x.md']) {
      on = { cloud: [p] };
      expect(await choosePlacement({ defaultHost: '', text: `See ${p}`, cwd: '/w', paths: [p], checkPaths })).toMatchObject({ host: '', moved: false, reason: 'this Mac has room' });
    }
  });
  it('the host the start would use has every file and room: no other host is asked', async () => {
    loads = { __local__: load({ load1: 2 }), cloud: load({ cpus: 48, load1: 3 }) };
    on = { __local__: [BRIEF], cloud: [BRIEF] };
    const asked: string[] = [];
    const counting = async (host: string, paths: string[]) => { asked.push(host); return checkPaths(host, paths); };
    expect(await choosePlacement({ defaultHost: '', text: 'x', cwd: '/w', paths: [BRIEF], checkPaths: counting })).toMatchObject({ host: '', moved: false });
    expect(asked).toEqual(['__local__']);
  });
  it('a host that will never take work (weight 0) does not count as having the files', async () => {
    cfg.placement_weights = { cloud: 0 };
    loads = { __local__: load({ load1: 2 }), cloud: load({ cpus: 48, load1: 3 }), spare: load({ cpus: 8, load1: 1 }) };
    on = { cloud: [BRIEF] };
    const d = await choosePlacement({ defaultHost: '', text: 'x', cwd: '/w', paths: [BRIEF], checkPaths });
    expect(d).toMatchObject({ host: '', moved: false });
  });
  it('another file never makes up for one the host leaves behind (review round 1, Sol)', async () => {
    const A = '/home/me/.local/state/open-walnut/tasks/task-a/brief.md';
    const B = '/home/me/.local/state/open-walnut/tasks/task-b/plan.md';
    const C = '/srv/data/c.csv';
    // Overloaded, it has A; cloud has only B (as many files, not the same): no move for load.
    loads = { __local__: load({ load1: 600 }), cloud: load({ cpus: 48, load1: 1 }) };
    on = { __local__: [A], cloud: [B, C] };
    const d = await choosePlacement({ defaultHost: '', text: 'x', cwd: '/w', paths: [A, B, C], checkPaths });
    expect(d).toMatchObject({ host: '', moved: false });
    // No host has every file it names: it stays (no move for load either).
    expect(d!.reason).toMatch(/it stays$/);
    expect(d!.hosts.find((h) => h.host === 'cloud')!.reasons).toContain(`it does not have ${A}, which the task names`);
    // With A as well, cloud takes it for B.
    on = { __local__: [A], cloud: [A, B] };
    expect(await choosePlacement({ defaultHost: '', text: 'x', cwd: '/w', paths: [A, B], checkPaths })).toMatchObject({ host: 'cloud', moved: true, forFiles: true });
    // A plain file the host has, the other lacks: never a load move there.
    on = { __local__: [C], cloud: [] };
    expect(await choosePlacement({ defaultHost: '', text: 'x', cwd: '/w', paths: [C], checkPaths })).toMatchObject({ host: '', moved: false });
  });
  it('the start\'s own host could not be asked: no host that lacks a named file takes it (review round 2, Sol)', async () => {
    const OUT = '/srv/brief/outside.md';
    loads = { __local__: load({ load1: 600 }), cloud: load({ cpus: 48, load1: 1 }) };
    on = { __local__: null, cloud: [] };
    expect(await choosePlacement({ defaultHost: '', text: 'x', cwd: '/w', paths: [OUT], checkPaths })).toMatchObject({ host: '', moved: false });
    on = { __local__: null, cloud: [OUT] };
    expect(await choosePlacement({ defaultHost: '', text: 'x', cwd: '/w', paths: [OUT], checkPaths })).toMatchObject({ host: 'cloud', moved: true });
  });
  it('no host with its brief can take it: it stays, never to a host without the brief (review round 4, Sol)', async () => {
    loads = { __local__: load({ load1: 600 }), cloud: load({ cpus: 48, load1: 1 }), spare: load({ cpus: 8, load1: 1 }) };
    on = { cloud: [BRIEF] };
    const d = await choosePlacement({ defaultHost: '', text: 'x', cwd: '/w', paths: [BRIEF], checkPaths, eligible: async (h) => (h === 'cloud' ? 'codex is not installed' : null) });
    expect(d).toMatchObject({ host: '', moved: false });
    expect(d!.reason).toMatch(/and no host that has it and every file it has can take the work; it stays$/);
  });
  it('two briefs on two hosts, each with one: no host has both, so it stays (review round 4, Sol)', async () => {
    const B2 = '/home/u/.local/state/open-walnut/tasks/parent/second.md';
    loads = { __local__: load({ load1: 2 }), cloud: load({ cpus: 48, load1: 1 }), spare: load({ cpus: 8, load1: 1 }) };
    on = { cloud: [BRIEF], spare: [B2] };
    expect(await choosePlacement({ defaultHost: '', text: 'x', cwd: '/w', paths: [BRIEF, B2], checkPaths })).toMatchObject({ host: '', moved: false });
    on = { cloud: [BRIEF, B2], spare: [B2] };
    expect(await choosePlacement({ defaultHost: '', text: 'x', cwd: '/w', paths: [BRIEF, B2], checkPaths })).toMatchObject({ host: 'cloud', moved: true, forFiles: true });
  });
  it('Mac-only work stays on the Mac whatever files it names', async () => {
    loads = { __local__: load({ load1: 2 }), cloud: load({ cpus: 48, load1: 3 }) };
    on = { cloud: [BRIEF] };
    expect(await choosePlacement({ defaultHost: '', text: 'Ship the iOS build', cwd: '/w', paths: [BRIEF], checkPaths })).toMatchObject({ host: '', moved: false });
  });
});

// Every automatic choice of host for a first start goes through choosePlacement with the
// files the task names; a new caller without them could send work where its files are not.
describe('placement callers pass the named files', () => {
  it('each choosePlacement call names paths and checkPaths', async () => {
    const { execFileSync } = await import('node:child_process');
    const path = await import('node:path');
    const root = path.resolve(__dirname, '../../..');
    const files = execFileSync('git', ['ls-files', '--', 'src/*.ts', 'src/**/*.ts'], { cwd: root }).toString('utf8').split('\n').filter(Boolean);
    const calls: Array<{ file: string; body: string }> = [];
    for (const file of files) {
      const text = await fsp.readFile(path.join(root, file), 'utf8');
      for (const m of text.matchAll(/\bchoosePlacement\(\{/g)) calls.push({ file, body: text.slice(m.index!, m.index! + 4000) });
    }
    expect(calls.map((c) => c.file)).toEqual(['src/core/sessions/start-placement.ts']);
    for (const c of calls) {
      expect(c.body, c.file).toMatch(/\bpaths\b/);
      expect(c.body, c.file).toMatch(/\bcheckPaths\b/);
    }
  });
});

// The per-machine preference (Prefer 100 / Normal 50 / Less often 25 / Manual only 0).
describe('placement weights', () => {
  it('reads config, 0 for place:false, 50 by default', () => {
    expect(placementWeight('cloud', {})).toBe(50);
    expect(placementWeight('cloud', { placement_weights: { cloud: 100 } })).toBe(100);
    expect(placementWeight('__local__', { placement_weights: { local: 25 } })).toBe(25);
    expect(placementWeight('cloud', { hosts: { cloud: { place: false } }, placement_weights: { cloud: 100 } })).toBe(0);
    expect(placementWeight('cloud', { placement_weights: { cloud: -3 } })).toBe(50);
  });
  it('a preferred host wins over a roomier one, and the weight is in the host list', async () => {
    loads = { __local__: load({ load1: 600 }), cloud: load({ cpus: 48, load1: 3 }), spare: load({ cpus: 16, load1: 1 }) };
    // Unweighted, cloud has the most room.
    expect(await choosePlacement({ defaultHost: '', text: 'x', cwd: '/w' })).toMatchObject({ host: 'cloud', moved: true });
    cfg.placement_weights = { spare: 100, cloud: 25 };
    __setHostLoadProberForTesting(async (host) => loads[host] as never);
    expect(await choosePlacement({ defaultHost: '', text: 'x', cwd: '/w' })).toMatchObject({ host: 'spare', moved: true });
    const views = await hostLoads();
    expect(views.find((h) => h.host === 'spare')).toMatchObject({ weight: 100 });
    expect(views.find((h) => h.host === '__local__')).toMatchObject({ weight: 50 });
  });
  it('weight 0 is never a place to go, even when it is the only host with room', async () => {
    loads = { __local__: load({ load1: 600 }), cloud: load({ cpus: 48, load1: 3 }), spare: load({ load1: 900 }) };
    cfg.placement_weights = { cloud: 0 };
    const d = await choosePlacement({ defaultHost: '', text: 'x', cwd: '/w' });
    expect(d).toMatchObject({ host: '', moved: false });
    expect(d!.reason).toContain('no other host has room');
  });
});

// 2026-11-05, the user: "per host can handle x amount ... make limit per host, and auto able
// to assign based on each host". Each host's slots come from its own size.
describe('each host\'s slots', () => {
  const dflt = (k: string) => (k === 'local' ? 7 : 20);
  it('one per two CPUs and per 3 GB of memory, whichever is fewer, 2 to 32; the host\'s setting wins', () => {
    // The user's hosts on 2026-11-05: this Mac, clouddev, olddev, home-pc.
    expect(hostSlots('local', { cpus: 14, memTotalBytes: 36 * GB }, undefined, dflt)).toBe(7);
    expect(hostSlots('clouddev', { cpus: 48, memTotalBytes: 184 * GB }, undefined, dflt)).toBe(24);
    expect(hostSlots('olddev', { cpus: 16, memTotalBytes: 64 * GB }, undefined, dflt)).toBe(8);
    expect(hostSlots('home-pc', { cpus: 4, memTotalBytes: 16 * GB }, undefined, dflt)).toBe(2);
    // Memory is the smaller one: 16 CPUs with 12 GB.
    expect(hostSlots('small', { cpus: 16, memTotalBytes: 12 * GB }, undefined, dflt)).toBe(4);
    expect(hostSlots('tiny', { cpus: 1, memTotalBytes: 2 * GB }, undefined, dflt)).toBe(2);
    expect(hostSlots('huge', { cpus: 256, memTotalBytes: 2048 * GB }, undefined, dflt)).toBe(32);
    expect(hostSlots('clouddev', { cpus: 48, memTotalBytes: 184 * GB }, { clouddev: 40 }, dflt)).toBe(40);
    expect(hostSlots('local', { cpus: 14, memTotalBytes: 36 * GB }, { local: 0 }, dflt)).toBe(1);
    // Numbers unknown: the old default.
    expect(hostSlots('local', undefined, undefined, dflt)).toBe(7);
    expect(hostSlots('cloud', { cpus: 0, memTotalBytes: 0 }, undefined, dflt)).toBe(20);
  });

  it('full (no room for an automatic start) is slots, memory, or load past twice its cap, in words without numbers', () => {
    const caps = placementCaps({});
    // Over the load cap but under twice it: busy (placement looks elsewhere), not full.
    expect(judgeHost('m', 'm', load({ load1: 56 }), 0, 7, caps)).toMatchObject({ busy: true, full: false, fullReasons: [] });
    const a = judgeHost('m', 'm', load({ load1: 100, memAvailBytes: 1 * GB }), 7, 7, caps);
    const b = judgeHost('m', 'm', load({ load1: 300, memAvailBytes: 0.5 * GB }), 9, 7, caps);
    expect(a).toMatchObject({ full: true, fullReasons: ['all 7 slots taken', 'memory nearly full', 'load past 6 per CPU'] });
    // The same words at other numbers: a queued entry is not written again on every drain.
    expect(b.fullReasons).toEqual(a.fullReasons);
    expect(judgeHost('m', 'm', undefined, 0, 7, caps)).toMatchObject({ known: false, full: false });
  });

  it('hostLoads judges each host against its own slots, counting the starts admitted there', async () => {
    __resetHostAdmissionForTesting();
    loads = { __local__: load({ cpus: 14, memTotalBytes: 36 * GB }), cloud: load({ cpus: 48, memTotalBytes: 184 * GB }), spare: load({ cpus: 4, memTotalBytes: 16 * GB, load1: 1 }) };
    const before = await hostLoads();
    expect(before.map((h) => [h.host, h.runningLimit, h.running])).toEqual([['__local__', 7, 0], ['cloud', 24, 0], ['spare', 2, 0]]);
    const a = await admitHostStart('t-a', 'spare', { automatic: true });
    const b = await admitHostStart('t-b', 'spare', { automatic: true });
    const spare = (await hostLoads({ hosts: ['spare'] }))[0];
    expect(spare).toMatchObject({ running: 2, busy: true });
    expect(spare.reasons).toEqual(['2 sessions in a turn (limit 2)']);
    // Full: an automatic start waits, a person's start goes.
    const full = await admitHostStart('t-c', 'spare', { automatic: true }).catch((e: unknown) => e);
    expect(full).toBeInstanceOf(HostsFullError);
    expect((full as HostsFullError).detail).toEqual({ taskId: 't-c', host: 'spare', label: 'spare', reason: 'all 2 slots taken', running: [], cap: 2 });
    const person = await admitHostStart('t-d', 'spare', { automatic: false });
    // A settled start gives its slot back (released twice is still once).
    a(); a(); b(); person();
    expect((await hostLoads({ hosts: ['spare'] }))[0]).toMatchObject({ running: 0, busy: false });
  });

  it('a slot is a turn: a session that only waits after its turn (a wakeup, a background land) holds none (2026-11-06, the VP)', async () => {
    __resetHostAdmissionForTesting();
    cfg.session_limits = { spare: 2 };
    loads = { __local__: load(), cloud: load({ cpus: 48, load1: 3 }), spare: load({ load1: 1 }) };
    const tracker = await import('../../../src/core/session-tracker.js');
    const { sessionRunner } = await import('../../../src/providers/claude-code-session.js');
    const rec = (id: string) => ({ claudeSessionId: id, taskId: `task-${id}`, host: 'spare', process_status: 'running' }) as never;
    const active = vi.spyOn(tracker, 'getActiveSessionsByHost').mockResolvedValue({ spare: [rec('turning'), rec('parked')] });
    const turn = vi.spyOn(sessionRunner, 'isInTurn').mockImplementation((sid: string) => (sid === 'parked' ? false : sid === 'turning' ? true : null));
    try {
      // Both read running; only the one in a turn takes a slot, so one is free.
      expect((await hostLoads({ hosts: ['spare'] }))[0]).toMatchObject({ running: 1, runningLimit: 2, full: false });
      (await admitHostStart('t-next', 'spare', { automatic: true }))(0);
      // One this server holds no runner for counts (it may be in a turn).
      active.mockResolvedValue({ spare: [rec('turning'), rec('elsewhere')] });
      expect((await hostLoads({ hosts: ['spare'] }))[0]).toMatchObject({ running: 2, full: true });
    } finally {
      active.mockRestore();
      turn.mockRestore();
      __resetHostAdmissionForTesting();
    }
  });

  it('a host whose load cannot be read is still held to its slots (review round 3, Sol)', async () => {
    __resetHostAdmissionForTesting();
    cfg.session_limits = { spare: 1 };
    loads = { __local__: load(), cloud: load({ cpus: 48, load1: 3 }) };
    expect(judgeHost('x', 'x', undefined, 2, 2)).toMatchObject({ known: false, full: true, fullReasons: ['all 2 slots taken'] });
    const one = await admitHostStart('u-1', 'spare', { automatic: true });
    expect(await admitHostStart('u-2', 'spare', { automatic: true }).catch((e: unknown) => e)).toBeInstanceOf(HostsFullError);
    one();
    (await admitHostStart('u-3', 'spare', { automatic: true }))();
  });

  it('a start that waits for room (a routine\'s run) asks again until a slot frees, and says it gave up past its wait', async () => {
    __resetHostAdmissionForTesting();
    __setWaitStepForTesting(10);
    cfg.session_limits = { spare: 1 };
    loads = { __local__: load(), cloud: load({ cpus: 48, load1: 3 }), spare: load({ load1: 1 }) };
    const busy = await admitHostStart('w-run', 'spare', { automatic: true });
    setTimeout(() => busy(0), 50);
    const got = await admitHostStart('w-wait', 'spare', { automatic: true, waitMs: 5_000 });
    got(0);
    // Past its wait it gives up with the same refusal.
    const hold = await admitHostStart('w-run2', 'spare', { automatic: true });
    const late = await admitHostStart('w-late', 'spare', { automatic: true, waitMs: 30 }).catch((e: unknown) => e) as HostsFullError;
    expect(late).toBeInstanceOf(HostsFullError);
    // It says it gave up, not that it waits (review round 5).
    expect(late.message).toBe('Not started: spare had no room for 1 second (all 1 slots taken).');
    hold(0);
    __setWaitStepForTesting(null);
    expect(await isAutomaticStart({ source: 'org-autostart' })).toBe(true);
    expect(await isAutomaticStart({ source: 'engine-switch' })).toBe(false);
    // The Org page's Retry runs through the org's path, but it is the user's click.
    expect(await isAutomaticStart({ source: 'org-autostart', byPerson: true })).toBe(false);
    expect(await isAutomaticStart({ source: 'api-v1' })).toBe(false);
  });

  it('a settled start holds its slot for as long as asked, and a task is counted once', async () => {
    __resetHostAdmissionForTesting();
    cfg.session_limits = { spare: 2 };
    loads = { __local__: load(), cloud: load({ cpus: 48, load1: 3 }), spare: load({ load1: 1 }) };
    const a = await admitHostStart('h-a', 'spare', { automatic: true });
    // Settled with its record not yet running: still counted for the hold.
    a(60_000);
    a(0);
    expect(slotHoldersOn('spare')).toEqual(['h-a']);
    // The same task again (a retry) is one slot, not two.
    const again = await admitHostStart('h-a', 'spare', { automatic: true });
    expect((await hostLoads({ hosts: ['spare'] }))[0]).toMatchObject({ running: 1, full: false });
    again(0);
    // A hold that ran out gives the slot back.
    const b = await admitHostStart('h-b', 'spare', { automatic: true });
    b(1);
    await vi.waitFor(() => expect(slotHoldersOn('spare')).toEqual(['h-a']));
  });

  it('a start admitted before its task existed hands its slot on to the task it made (a routine\'s new run; review round 5, Sol)', async () => {
    __resetHostAdmissionForTesting();
    cfg.session_limits = { spare: 1 };
    loads = { __local__: load(), cloud: load({ cpus: 48, load1: 3 }), spare: load({ load1: 1 }) };
    const slot = await admitHostStart('routine-run:sid-1', 'spare', { automatic: true });
    holdSlotFor('spare', 'task-made', 60_000);
    slot(0);
    expect(slotHoldersOn('spare')).toEqual(['task-made']);
    // The next routine's run finds the one slot taken.
    expect(await admitHostStart('routine-run:sid-2', 'spare', { automatic: true }).catch((e: unknown) => e)).toBeInstanceOf(HostsFullError);
    __resetHostAdmissionForTesting();
  });

  it('starts racing for the same host admit exactly its free slots (one turn\'s ten task_create calls)', async () => {
    __resetHostAdmissionForTesting();
    cfg.session_limits = { cloud: 3 };
    loads = { __local__: load(), cloud: load({ cpus: 48, load1: 3 }), spare: load() };
    const tries = await Promise.allSettled(Array.from({ length: 10 }, (_, i) => admitHostStart(`race-${i}`, 'cloud', { automatic: true })));
    expect(tries.filter((t) => t.status === 'fulfilled')).toHaveLength(3);
    const refused = tries.filter((t): t is PromiseRejectedResult => t.status === 'rejected');
    expect(refused).toHaveLength(7);
    for (const r of refused) expect(r.reason).toBeInstanceOf(HostsFullError);
    for (const t of tries) if (t.status === 'fulfilled') t.value();
    // A host whose numbers are unknown admits (the start itself says when it cannot be reached).
    loads = { __local__: load() };
    __setHostLoadProberForTesting(async (host) => { const v = loads[host]; if (!v) throw new Error('not connected'); return v as HostLoad; });
    const open = await admitHostStart('unknown-host', 'cloud', { automatic: true });
    open();
  });

  it('a full host with another that has room: the start goes to the one with room', async () => {
    __resetHostAdmissionForTesting();
    cfg.session_limits = { local: 1 };
    loads = { __local__: load({ load1: 1 }), cloud: load({ cpus: 48, load1: 3, memTotalBytes: 184 * GB }), spare: load({ cpus: 8, load1: 2 }) };
    const held = await admitHostStart('holds-the-mac', '__local__', { automatic: true });
    const d = await choosePlacement({ defaultHost: '', text: 'Speed up the parser', cwd: '/work/marina' });
    expect(d).toMatchObject({ host: 'cloud', moved: true });
    expect(d!.reason).toMatch(/^this Mac is overloaded \(1 sessions in a turn \(limit 1\)\); cloud has room/);
    held();
  });
});
