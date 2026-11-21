/**
 * The weekly restore drill's schedule (src/core/backup/restore-drill-runtime.ts): with
 * the experiment off it holds no timer; on, it runs a drill when the last one is a week
 * old, keeps the result, reports a failure as a Walnut Health notice (never a popup)
 * and retires it at the next pass.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fsp from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createMockConstants } from '../../helpers/mock-constants.js';

vi.mock('../../../src/constants.js', () => createMockConstants());

import { startRestoreDrillRuntime, DRILL_EVERY_MS, DRILL_RETRY_MS, DRILL_NOTICE_SCOPE, type DrillRuntime } from '../../../src/core/backup/restore-drill-runtime.js';
import { readDrillRecord, writeDrillRecord, type DrillResult } from '../../../src/core/backup/restore-drill.js';
import { audienceOf } from '../../../src/core/notifications/audience.js';
import { EXPERIMENTAL_FEATURES } from '../../../src/core/experimental.js';
import type { BackupConfig } from '../../../src/core/backup/types.js';

const cfg: BackupConfig = { enabled: true, destination: { type: 'r2', bucket: 'b', account_id: '0'.repeat(32), access_key_id: 'AK', secret_access_key: 'S' }, encrypt: false };
const result = (ok: boolean, at: number): DrillResult => ({
  version: 1, at: new Date(at).toISOString(), durationMs: 5, ok, destination: 'r2://b/walnut-backup',
  checks: [{ id: 'databases', ok, detail: ok ? 'fine' : 'bad', ...(ok ? {} : { problems: ['tasks/tasks.sqlite: database disk image is malformed'] }) }],
  notInBackups: [], databases: [],
});

let home: string;
let runtime: DrillRuntime | null = null;
beforeEach(async () => { home = await fsp.mkdtemp(path.join(os.tmpdir(), 'walnut-drill-rt-')); });
afterEach(async () => { runtime?.stop(); runtime = null; await fsp.rm(home, { recursive: true, force: true }); });

describe('restore drill schedule', () => {
  it('the experiment exists and is off by default', () => {
    expect(EXPERIMENTAL_FEATURES.find((f) => f.id === 'restore_drill')).toMatchObject({ default: false });
  });

  it('flag off: no timer, and a check runs nothing', async () => {
    const run = vi.fn();
    runtime = startRestoreDrillRuntime({ dataDir: home, isOn: async () => false, backupConfig: async () => cfg, run, notify: vi.fn(), subscribe: false, tmpRoot: home });
    await runtime.reconcile();
    expect(runtime.armed()).toBe(false);
    expect(await runtime.check()).toBeNull();
    expect(run).not.toHaveBeenCalled();
  });

  it('turned on it arms a timer, turned off again it clears it', async () => {
    let on = true;
    runtime = startRestoreDrillRuntime({ dataDir: home, isOn: async () => on, backupConfig: async () => cfg, run: vi.fn(), notify: vi.fn(), subscribe: false, tmpRoot: home });
    await runtime.reconcile();
    expect(runtime.armed()).toBe(true);
    on = false;
    await runtime.reconcile();
    expect(runtime.armed()).toBe(false);
  });

  it('runs weekly, reports a failure to Walnut Health, and retires it at the next pass', async () => {
    let now = Date.parse('2026-11-21T10:00:00Z');
    const outcomes = [false, true];
    const run = vi.fn(async () => result(outcomes.shift()!, now));
    const notify = vi.fn(async () => true);
    const onRecovered = vi.fn();
    runtime = startRestoreDrillRuntime({ dataDir: home, isOn: async () => true, backupConfig: async () => cfg, run, notify, onRecovered, now: () => now, subscribe: false, tmpRoot: home, firstCheckMs: 3_600_000 });

    expect((await runtime.check())?.ok).toBe(false);
    expect(notify).toHaveBeenCalledTimes(1);
    const n = notify.mock.calls[0][0] as { title: string; body: string; dedupScope: string; needsYou?: string };
    expect(n).toMatchObject({ title: 'Restore drill failed', dedupScope: DRILL_NOTICE_SCOPE });
    expect(n.body).toContain('tasks/tasks.sqlite');
    expect(n.needsYou).toBeUndefined();
    expect(audienceOf({ kind: 'operation-error', dedupKey: `error:${n.dedupScope}` })).toBe('health');
    expect((await readDrillRecord(home))?.ok).toBe(false);

    // Inside the week: nothing runs.
    now += DRILL_EVERY_MS - 60_000;
    expect(await runtime.check()).toBeNull();
    expect(run).toHaveBeenCalledTimes(1);

    now += 120_000;
    expect((await runtime.check())?.ok).toBe(true);
    expect(onRecovered).toHaveBeenCalledTimes(1);
    expect(notify).toHaveBeenCalledTimes(1);
    expect((await readDrillRecord(home))?.ok).toBe(true);
  });

  it('a drill that could not run is tried again after a day, and said so', async () => {
    let now = Date.parse('2026-11-21T10:00:00Z');
    const run = vi.fn(async () => ({ ...result(false, now), checks: [], error: 'The destination did not answer.' }));
    const notify = vi.fn(async () => true);
    runtime = startRestoreDrillRuntime({ dataDir: home, isOn: async () => true, backupConfig: async () => cfg, run, notify, now: () => now, subscribe: false, tmpRoot: home });
    await runtime.check();
    expect(notify.mock.calls[0][0]).toMatchObject({ title: 'Restore drill could not run' });
    now += DRILL_RETRY_MS - 60_000;
    expect(await runtime.check()).toBeNull();
    now += 120_000;
    await runtime.check();
    expect(run).toHaveBeenCalledTimes(2);
  });

  it('a pass from the CLI retires the failure card at the next check, once', async () => {
    const now = Date.parse('2026-11-21T10:00:00Z');
    await writeDrillRecord(home, result(true, now - 3_600_000));
    const onRecovered = vi.fn();
    const run = vi.fn();
    runtime = startRestoreDrillRuntime({ dataDir: home, isOn: async () => true, backupConfig: async () => cfg, run, notify: vi.fn(), onRecovered, now: () => now, subscribe: false, tmpRoot: home });
    await runtime.check();
    await runtime.check();
    expect(onRecovered).toHaveBeenCalledTimes(1);
    expect(run).not.toHaveBeenCalled();
  });

  it('removes a killed drill\'s folder at start, flag on or off', async () => {
    const left = path.join(home, 'walnut-restore-drill-aaaaaa');
    await fsp.mkdir(left);
    await fsp.writeFile(path.join(left, 'drill-owner.json'), JSON.stringify({ pid: 999_999_999 }));
    runtime = startRestoreDrillRuntime({ dataDir: home, isOn: async () => false, backupConfig: async () => cfg, run: vi.fn(), notify: vi.fn(), subscribe: false, tmpRoot: home });
    for (let i = 0; i < 50 && (await fsp.stat(left).then(() => true, () => false)); i++) await new Promise((r) => setTimeout(r, 20));
    await expect(fsp.stat(left)).rejects.toThrow();
  });

  it('backups not set up: nothing runs', async () => {
    const run = vi.fn();
    runtime = startRestoreDrillRuntime({ dataDir: home, isOn: async () => true, backupConfig: async () => ({ ...cfg, enabled: false }), run, notify: vi.fn(), subscribe: false, tmpRoot: home });
    expect(await runtime.check()).toBeNull();
    expect(run).not.toHaveBeenCalled();
  });
});
