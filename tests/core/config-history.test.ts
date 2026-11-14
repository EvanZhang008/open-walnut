/**
 * Dated copies of config.yaml (src/core/config-history.ts), through the real write
 * path (updateConfig / saveConfig in a temp WALNUT_HOME). 2026-11-14: one bad write
 * dropped most of the `session` section and copied the cut-down file over
 * config.yaml.bak in the same step, so the only backup went with it.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import yaml from 'js-yaml';
import { createMockConstants } from '../helpers/mock-constants.js';

vi.mock('../../src/constants.js', () => createMockConstants());

import { WALNUT_HOME, CONFIG_FILE } from '../../src/constants.js';
import {
  refreshConfigBackup,
  saveConfig,
  updateConfig,
  _resetWriteLockForTest,
  _setConfigTimingsForTest,
  _configRepairIdleForTest,
} from '../../src/core/config-manager.js';
import {
  CONFIG_HISTORY_DIR_NAME,
  _setConfigHistoryClockForTest,
  configHistoryDir,
  configHistoryFileName,
  configHistorySeed,
  configHistoryToDelete,
  listConfigHistory,
  parseConfigHistoryName,
  recordConfigVersion,
  type ConfigHistoryEntry,
} from '../../src/core/config-history.js';
import { ConfigUnreadableError } from '../../src/core/config-store.js';
import { _resetServerRoleForTesting } from '../../src/core/server-role.js';

const HISTORY = () => configHistoryDir();
const BAK = `${CONFIG_FILE}.bak`;
const DAY = 86_400_000;

async function copies(): Promise<Array<ConfigHistoryEntry & { content: string }>> {
  const entries = await listConfigHistory();
  return Promise.all(entries.map(async (e) => ({ ...e, content: await fs.readFile(path.join(HISTORY(), e.name), 'utf-8') })));
}

beforeEach(async () => {
  _resetWriteLockForTest();
  _setConfigTimingsForTest({ quietMs: 100, settleMs: 50, readRetryMs: 20, lateWriteWatchMs: 100 });
  _setConfigHistoryClockForTest(null);
  await fs.rm(WALNUT_HOME, { recursive: true, force: true });
  await fs.mkdir(WALNUT_HOME, { recursive: true });
});

afterEach(async () => {
  await _configRepairIdleForTest();
  _setConfigTimingsForTest(null);
  _setConfigHistoryClockForTest(null);
  await fs.rm(WALNUT_HOME, { recursive: true, force: true });
});

describe('config.yaml history through the write path', () => {
  it('lives beside config.yaml', () => {
    expect(HISTORY()).toBe(path.join(path.dirname(CONFIG_FILE), CONFIG_HISTORY_DIR_NAME));
    expect(CONFIG_HISTORY_DIR_NAME).toBe('config.yaml.history');
  });

  it('the incident: a write that drops most of a section leaves an older copy with the whole section', async () => {
    const session = { default_host: 'box', idle_minutes: 30, effort: 'high', cron_policy: 'session-only', max_turns: 80 };
    await fs.writeFile(CONFIG_FILE, yaml.dump({ version: 1, session }), 'utf-8');
    await updateConfig({ user: { name: 'Sam' } } as any);
    // The bad write: a full replace that keeps one key of the section.
    await saveConfig({ version: 1, user: { name: 'Sam' }, session: { default_host: 'box' } } as any);
    await _configRepairIdleForTest();

    // The sidecar followed the bad write, as it always did.
    expect((yaml.load(await fs.readFile(BAK, 'utf-8')) as any).session).toEqual({ default_host: 'box' });
    const all = await copies();
    expect(all.at(-1)!.content).toBe(await fs.readFile(CONFIG_FILE, 'utf-8'));
    const good = all.filter((c) => (yaml.load(c.content) as any).session?.max_turns === 80);
    expect(good.length).toBeGreaterThan(0);
    expect((yaml.load(good.at(-1)!.content) as any).session).toEqual(session);
  });

  it('the first write after an upgrade keeps the content it replaced, byte for byte, dated before it', async () => {
    const before = '# kept by hand\nversion: 1\nuser:\n  name: Old\n';
    await fs.writeFile(CONFIG_FILE, before, 'utf-8');
    await updateConfig({ user: { name: 'New' } } as any);
    const all = await copies();
    expect(all).toHaveLength(2);
    expect(all[0]!.content).toBe(before);
    expect(all[1]!.content).toBe(await fs.readFile(CONFIG_FILE, 'utf-8'));
    expect(all[0]!.at).toBeLessThan(all[1]!.at);
    expect(all[0]!.name < all[1]!.name).toBe(true);
  });

  it('a first run (no file before) keeps just the content written', async () => {
    await updateConfig({ user: { name: 'First' } } as any);
    const all = await copies();
    expect(all).toHaveLength(1);
    expect(all[0]!.content).toBe(await fs.readFile(CONFIG_FILE, 'utf-8'));
  });

  it('identical consecutive writes add no copy', async () => {
    const doc = { version: 1, user: { name: 'Same' } } as any;
    await saveConfig(doc);
    const first = (await copies()).map((c) => c.name);
    await saveConfig(doc);
    await saveConfig(doc);
    await updateConfig({ user: { name: 'Same' } } as any);
    expect((await copies()).map((c) => c.name)).toEqual(first);
    await updateConfig({ user: { name: 'Other' } } as any);
    expect(await copies()).toHaveLength(first.length + 1);
  });

  it('a config flipping between two states keeps two copies, and the version before the flipping stays', async () => {
    await updateConfig({ user: { name: 'Before' } } as any);
    const before = (await copies()).at(-1)!.content;
    for (let i = 0; i < 12; i++) await updateConfig({ user: { name: i % 2 ? 'Flip' : 'Flop' } } as any);
    const all = await copies();
    expect(all.map((c) => c.content)).toContain(before);
    expect(new Set(all.map((c) => c.content)).size).toBe(all.length);
    expect(all.at(-1)!.content).toBe(await fs.readFile(CONFIG_FILE, 'utf-8'));
    expect(all.filter((c) => /Flip|Flop/.test(c.content))).toHaveLength(2);
  });

  it('retention with a fixed clock: 30 writes over 12 days keep the 10 newest and the oldest and newest of each of the last 7 days', async () => {
    const T0 = Date.parse('2026-11-01T00:00:00.000Z');
    // Write i lands on day DAYS[i] (UTC), a few hours and minutes in.
    const DAYS = [0, 0, 0, 1, 1, 2, 2, 2, 3, 3, 4, 4, 4, 5, 5, 6, 6, 6, 7, 7, 8, 8, 8, 9, 9, 10, 10, 10, 11, 11];
    let now = T0;
    _setConfigHistoryClockForTest(() => now);
    for (let i = 0; i < DAYS.length; i++) {
      now = T0 + DAYS[i]! * DAY + (i % 3) * 3_600_000 + i * 60_000;
      await updateConfig({ user: { name: `v${i}` } } as any);
    }
    await _configRepairIdleForTest();
    const kept = (await copies()).map((c) => (yaml.load(c.content) as any).user.name);
    // 10 newest: v20..v29. Newest of days 11..5: v29, v27, v24, v22, v19, v17, v14.
    // Oldest of days 11..5: v28, v25, v23, v20, v18, v15, v13.
    expect(kept).toEqual(['v13', 'v14', 'v15', 'v17', 'v18', 'v19', 'v20', 'v21', 'v22', 'v23', 'v24', 'v25', 'v26', 'v27', 'v28', 'v29']);
    // Each copy is dated by the clock it was written under.
    const last = (await listConfigHistory()).at(-1)!;
    expect(last.at).toBe(T0 + 11 * DAY + (29 % 3) * 3_600_000 + 29 * 60_000);
  });

  it('a good copy, one bad write, then 15 more writes the same day: the day\'s first (good) copy stays', async () => {
    let now = Date.parse('2026-11-14T08:00:00.000Z');
    _setConfigHistoryClockForTest(() => now);
    const session = { default_host: 'box', idle_minutes: 30, effort: 'high', max_turns: 80 };
    await saveConfig({ version: 1, user: { name: 'good' }, session } as any);
    now += 60_000;
    await saveConfig({ version: 1, user: { name: 'bad' }, session: { default_host: 'box' } } as any);
    for (let i = 0; i < 15; i++) {
      now += 60_000;
      await updateConfig({ user: { name: `after${i}` } } as any);
    }
    await _configRepairIdleForTest();
    const all = await copies();
    expect(all).toHaveLength(11); // the day's oldest, plus the 10 newest
    expect((yaml.load(all[0]!.content) as any).session).toEqual(session);
    expect((yaml.load(all[0]!.content) as any).user.name).toBe('good');
  });

  it('an outside edit Walnut accepts becomes the newest copy', async () => {
    await updateConfig({ user: { name: 'Walnut' } } as any);
    const edit = `${await fs.readFile(CONFIG_FILE, 'utf-8')}# edited by hand\n`;
    await fs.writeFile(CONFIG_FILE, edit, 'utf-8');
    expect(await refreshConfigBackup()).toBe(true);
    const all = await copies();
    expect(all).toHaveLength(2);
    expect(all.at(-1)!.content).toBe(edit);
    expect(await fs.readFile(BAK, 'utf-8')).toBe(edit);
  });

  it('the first outside edit after an upgrade keeps the backup it replaces first', async () => {
    const before = 'version: 1\nuser:\n  name: Before\n';
    const edit = 'version: 1\nuser:\n  name: Edited\n';
    await fs.writeFile(BAK, before, 'utf-8');
    await fs.writeFile(CONFIG_FILE, edit, 'utf-8');
    expect(await refreshConfigBackup()).toBe(true);
    const all = await copies();
    expect(all.map((c) => c.content)).toEqual([before, edit]);
  });

  it('the prune removes an hour-old write temp of a copy, and nothing else it did not name', async () => {
    await updateConfig({ user: { name: 'A' } } as any);
    const [copy] = await listConfigHistory();
    const old = path.join(HISTORY(), `${copy!.name}.tmp-4242-mh3k2a`);
    const fresh = path.join(HISTORY(), `${copy!.name}.tmp-4243-mh3k2b`);
    const stranger = path.join(HISTORY(), 'notes.txt.tmp-4242-mh3k2a');
    for (const f of [old, fresh, stranger]) await fs.writeFile(f, 'private_note: x\n', 'utf-8');
    const twoHoursAgo = new Date(Date.now() - 2 * 3_600_000);
    await fs.utimes(old, twoHoursAgo, twoHoursAgo);
    await fs.utimes(stranger, twoHoursAgo, twoHoursAgo);
    await updateConfig({ user: { name: 'B' } } as any);
    await _configRepairIdleForTest();
    await expect(fs.stat(old)).rejects.toThrow();
    await expect(fs.stat(fresh)).resolves.toBeTruthy();
    await expect(fs.stat(stranger)).resolves.toBeTruthy();
  });

  it('the folder is owner only and every copy has config.yaml\'s mode', async () => {
    await fs.writeFile(CONFIG_FILE, 'version: 1\n', { encoding: 'utf-8', mode: 0o644 });
    await fs.mkdir(HISTORY(), { mode: 0o755 });
    await fs.chmod(HISTORY(), 0o755);
    await updateConfig({ user: { name: 'Private' } } as any);
    expect((await fs.stat(HISTORY())).mode & 0o777).toBe(0o700);
    const all = await copies();
    expect(all.length).toBe(2);
    for (const c of all) expect((await fs.stat(path.join(HISTORY(), c.name))).mode & 0o777).toBe(0o600);
    // No write temps left behind.
    expect((await fs.readdir(HISTORY())).filter((n) => n.includes('.tmp-'))).toEqual([]);
  });

  it('a history that cannot be written never fails the config write', async () => {
    await fs.writeFile(HISTORY(), 'not a folder', 'utf-8');
    await updateConfig({ user: { name: 'Still' } } as any);
    await _configRepairIdleForTest();
    expect((yaml.load(await fs.readFile(CONFIG_FILE, 'utf-8')) as any).user.name).toBe('Still');
    expect((yaml.load(await fs.readFile(BAK, 'utf-8')) as any).user.name).toBe('Still');
    expect(await fs.readFile(HISTORY(), 'utf-8')).toBe('not a folder');
  });

  it('the prune leaves files it did not name alone', async () => {
    await fs.mkdir(HISTORY(), { recursive: true });
    const strangers = ['notes.txt', 'config-old.yaml', 'config-20261101T000000.000Z-zzzzzzzzzzzz.yaml'];
    for (const n of strangers) await fs.writeFile(path.join(HISTORY(), n), 'x', 'utf-8');
    for (let i = 0; i < 14; i++) await updateConfig({ user: { name: `n${i}` } } as any);
    await _configRepairIdleForTest();
    const names = await fs.readdir(HISTORY());
    for (const n of strangers) expect(names).toContain(n);
    // All 14 on one day: the day's oldest and the 10 newest.
    const kept = (await copies()).map((c) => (yaml.load(c.content) as any).user.name);
    expect(kept).toEqual(['n0', 'n4', 'n5', 'n6', 'n7', 'n8', 'n9', 'n10', 'n11', 'n12', 'n13']);
  });

  it('a host replica writes no config and keeps no history', async () => {
    const saved = { role: process.env.WALNUT_ROLE, placement: process.env.WALNUT_PLACEMENT, host: process.env.WALNUT_HOST_SERVER };
    Object.assign(process.env, { WALNUT_ROLE: 'replica', WALNUT_PLACEMENT: 'host', WALNUT_HOST_SERVER: '1' });
    _resetServerRoleForTesting();
    try {
      await fs.writeFile(CONFIG_FILE, 'version: 1\n', 'utf-8');
      await expect(updateConfig({ user: { name: 'R' } } as any)).rejects.toThrow();
      // The history's own check, not only the write lock's refusal in front of it.
      expect(await configHistorySeed(CONFIG_FILE)).toBeNull();
      expect(await recordConfigVersion('version: 2\n', { content: 'version: 1\n', mtimeMs: Date.now() })).toBe(false);
      await expect(fs.stat(HISTORY())).rejects.toThrow();
    } finally {
      for (const [k, v] of [['WALNUT_ROLE', saved.role], ['WALNUT_PLACEMENT', saved.placement], ['WALNUT_HOST_SERVER', saved.host]] as const) {
        if (v === undefined) delete process.env[k]; else process.env[k] = v;
      }
      _resetServerRoleForTesting();
    }
  });

  it('the refusal of an unreadable file names the history as a place to restore from', () => {
    expect(new ConfigUnreadableError('bad').message).toContain('config.yaml.history/');
    expect(new ConfigUnreadableError('bad').message).toContain('config.yaml.bak');
  });
});

describe('configHistoryToDelete (pure, fixed clock)', () => {
  const entry = (iso: string, n: number): ConfigHistoryEntry => {
    const at = Date.parse(iso);
    const hash = n.toString(16).padStart(12, '0');
    return { name: configHistoryFileName(at, hash), at, hash };
  };

  it('names round-trip and sort by time', () => {
    const a = entry('2026-11-14T23:59:59.999Z', 1);
    expect(a.name).toBe('config-20261114T235959.999Z-000000000001.yaml');
    expect(parseConfigHistoryName(a.name)).toEqual(a);
    expect(parseConfigHistoryName('config-20261314T000000.000Z-000000000001.yaml')).toBeNull();
    expect(parseConfigHistoryName(`${a.name}.tmp-1-x`)).toBeNull();
    expect(a.name < entry('2026-11-15T00:00:00.000Z', 0).name).toBe(true);
  });

  it('keeps everything up to the 10 newest', () => {
    const list = Array.from({ length: 10 }, (_, i) => entry(`2026-11-0${(i % 9) + 1}T10:00:00.000Z`, i));
    expect(configHistoryToDelete(list)).toEqual([]);
    expect(configHistoryToDelete([])).toEqual([]);
  });

  it('counts days in UTC and keeps the oldest and newest of each of the 7 most recent days with copies', () => {
    const list: ConfigHistoryEntry[] = [];
    let n = 0;
    // Days 1..9 each get an early and a late copy; day 3's late one is 23:59:59.999Z.
    for (let d = 1; d <= 9; d++) {
      list.push(entry(`2026-11-0${d}T00:00:00.000Z`, n++));
      list.push(entry(`2026-11-0${d}T${d === 3 ? '23:59:59.999' : '12:00:00.000'}Z`, n++));
    }
    const doomed = new Set(configHistoryToDelete(list));
    const keptIso = list.filter((e) => !doomed.has(e.name)).map((e) => new Date(e.at).toISOString());
    expect(keptIso).toEqual([
      '2026-11-03T00:00:00.000Z', // oldest of day 3 (the 7th most recent day)
      '2026-11-03T23:59:59.999Z', // newest of day 3
      '2026-11-04T00:00:00.000Z',
      '2026-11-04T12:00:00.000Z',
      // 10 newest: days 5..9, both copies each
      '2026-11-05T00:00:00.000Z', '2026-11-05T12:00:00.000Z',
      '2026-11-06T00:00:00.000Z', '2026-11-06T12:00:00.000Z',
      '2026-11-07T00:00:00.000Z', '2026-11-07T12:00:00.000Z',
      '2026-11-08T00:00:00.000Z', '2026-11-08T12:00:00.000Z',
      '2026-11-09T00:00:00.000Z', '2026-11-09T12:00:00.000Z',
    ]);
  });

  it('never deletes the only copy, whatever its age', () => {
    expect(configHistoryToDelete([entry('2001-01-01T00:00:00.000Z', 1)])).toEqual([]);
  });
});
