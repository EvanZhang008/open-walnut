/**
 * "Use this restored data" (src/core/backup/restore-switch.ts): asked while
 * Walnut runs, done at the next start. Every state a start can find is here:
 * the plain switch, a start that died between the two renames, a second rename
 * that fails (the old folder comes back), a restored folder gone, and nothing
 * asked. The current data folder is never deleted.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fsp from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {
  applyPendingSwitch, cancelSwitch, deletePreviousData, lastSwitchDone, lastSwitchError, readPendingSwitch, requestSwitch, switchMarkerPath,
} from '../../../src/core/backup/restore-switch.js';
import { machineIdPath } from '../../../src/core/backup/local-state.js';

let root: string;
let home: string;
let restored: string;

const put = async (p: string, body: string) => {
  await fsp.mkdir(path.dirname(p), { recursive: true });
  await fsp.writeFile(p, body);
};
const read = (p: string) => fsp.readFile(p, 'utf8');
const exists = (p: string) => fsp.stat(p).then(() => true, () => false);

beforeEach(async () => {
  root = await fsp.mkdtemp(path.join(os.tmpdir(), 'walnut-switch-'));
  home = path.join(root, '.open-walnut');
  restored = path.join(root, 'open-walnut-restored-2026-11-04T10-00-00');
  await put(path.join(home, 'notes', 'a.md'), 'live');
  await put(machineIdPath(home), `${'a'.repeat(32)}\n`);
  await put(path.join(restored, 'notes', 'a.md'), 'restored');
});
afterEach(async () => {
  await fsp.rm(root, { recursive: true, force: true });
});

describe('restore switch', () => {
  it('nothing asked: a start changes nothing', async () => {
    expect(await applyPendingSwitch(home)).toEqual({ kind: 'none' });
    expect(await read(path.join(home, 'notes', 'a.md'))).toBe('live');
  });

  it('asked, then a start: the restored folder is the data folder, the old one kept aside, the writer id kept', async () => {
    const p = await requestSwitch(home, restored, new Date('2026-11-04T10:05:00Z'));
    expect(p.aside).toBe(`${home}-before-restore-2026-11-04T10-05-00`);
    expect(await readPendingSwitch(home)).toMatchObject({ restored, aside: p.aside });
    // Nothing moves while Walnut runs.
    expect(await read(path.join(home, 'notes', 'a.md'))).toBe('live');

    const out = await applyPendingSwitch(home);
    expect(out).toEqual({ kind: 'switched', aside: p.aside });
    expect(await read(path.join(home, 'notes', 'a.md'))).toBe('restored');
    expect(await read(path.join(p.aside, 'notes', 'a.md'))).toBe('live');
    expect(await exists(restored)).toBe(false);
    expect((await read(machineIdPath(home))).trim()).toBe('a'.repeat(32));
    expect(await exists(switchMarkerPath(home))).toBe(false);
    // The pane says it once: where the previous data went. Done clears it.
    expect(await lastSwitchDone(home)).toMatchObject({ restored, aside: p.aside });
    // A second start does nothing more.
    expect(await applyPendingSwitch(home)).toEqual({ kind: 'none' });
    await cancelSwitch(home);
    expect(await lastSwitchDone(home)).toBeNull();
  });

  it('deletes only the folder the last switch set aside, when asked', async () => {
    await expect(deletePreviousData(home)).rejects.toThrow(/No data set aside/);
    const p = await requestSwitch(home, restored);
    await applyPendingSwitch(home);
    // A tampered note naming another folder is refused, and nothing is deleted.
    const done = JSON.parse(await read(`${home}.restore-switch-done.json`));
    await fsp.writeFile(`${home}.restore-switch-done.json`, JSON.stringify({ ...done, aside: path.join(root, 'elsewhere') }));
    await fsp.mkdir(path.join(root, 'elsewhere'));
    await expect(deletePreviousData(home)).rejects.toThrow(/leaves it alone/);
    expect(await exists(path.join(root, 'elsewhere'))).toBe(true);
    await fsp.writeFile(`${home}.restore-switch-done.json`, JSON.stringify(done));
    expect(await deletePreviousData(home)).toBe(p.aside);
    expect(await exists(p.aside)).toBe(false);
    expect(await read(path.join(home, 'notes', 'a.md'))).toBe('restored');
    expect(await lastSwitchDone(home)).toBeNull();
  });

  it('a start that died between the two renames finishes the switch', async () => {
    const p = await requestSwitch(home, restored);
    await fsp.rename(home, p.aside);
    expect(await applyPendingSwitch(home)).toMatchObject({ kind: 'switched' });
    expect(await read(path.join(home, 'notes', 'a.md'))).toBe('restored');
    expect(await read(path.join(p.aside, 'notes', 'a.md'))).toBe('live');
  });

  it('the second rename fails: the old folder is put back and the reason kept', async () => {
    const p = await requestSwitch(home, restored);
    let n = 0;
    const flaky = {
      rename: async (a: string, b: string) => {
        n++;
        if (n === 2) throw Object.assign(new Error('EXDEV: cross-device link not permitted'), { code: 'EXDEV' });
        return fsp.rename(a, b);
      },
    };
    const out = await applyPendingSwitch(home, flaky);
    expect(out.kind).toBe('failed');
    expect(await read(path.join(home, 'notes', 'a.md'))).toBe('live');
    expect(await exists(p.aside)).toBe(false);
    expect(await exists(restored)).toBe(true);
    expect(await lastSwitchError(home)).toMatch(/EXDEV.*kept its data folder/);
    expect(await exists(switchMarkerPath(home))).toBe(false);
  });

  it('the restored folder went missing: the data folder stays, the request goes', async () => {
    await requestSwitch(home, restored);
    await fsp.rm(restored, { recursive: true });
    const out = await applyPendingSwitch(home);
    expect(out.kind).toBe('failed');
    expect(await read(path.join(home, 'notes', 'a.md'))).toBe('live');
    expect(await readPendingSwitch(home)).toBeNull();
  });

  it('refuses a folder inside the data folder, an empty one, or one that is gone; cancel drops the request', async () => {
    await expect(requestSwitch(home, path.join(home, 'notes'))).rejects.toThrow(/apart from the data folder/);
    const empty = path.join(root, 'empty');
    await fsp.mkdir(empty);
    await expect(requestSwitch(home, empty)).rejects.toThrow(/empty/);
    await expect(requestSwitch(home, path.join(root, 'nope'))).rejects.toThrow(/not there/);
    await requestSwitch(home, restored);
    await cancelSwitch(home);
    expect(await applyPendingSwitch(home)).toEqual({ kind: 'none' });
    expect(await read(path.join(home, 'notes', 'a.md'))).toBe('live');
  });

  it('two asks in one second never pick an aside name that exists', async () => {
    const at = new Date('2026-11-04T10:05:00Z');
    await fsp.mkdir(`${home}-before-restore-2026-11-04T10-05-00`);
    const p = await requestSwitch(home, restored, at);
    expect(p.aside).toBe(`${home}-before-restore-2026-11-04T10-05-00-2`);
  });

  it('waits while the Walnut that asked still runs; goes once it is gone', async () => {
    const p = await requestSwitch(home, restored);
    // Seen from another process (a second start beside the asking server).
    const marker = JSON.parse(await read(switchMarkerPath(home)));
    await fsp.writeFile(switchMarkerPath(home), JSON.stringify({ ...marker, pid: 4242, started: 'Tue Nov 4 10:00:00 2026' }));
    const alive = { alive: () => true, started: async () => 'Tue Nov 4 10:00:00 2026' };
    expect(await applyPendingSwitch(home, alive)).toEqual({ kind: 'waiting' });
    expect(await read(path.join(home, 'notes', 'a.md'))).toBe('live');
    expect(await readPendingSwitch(home)).not.toBeNull();
    // Its pid now belongs to another process (started at another time): it is gone.
    const reused = { alive: () => true, started: async () => 'Wed Nov 5 08:00:00 2026' };
    expect(await applyPendingSwitch(home, reused)).toEqual({ kind: 'switched', aside: p.aside });
  });

  it('a request older than a day is dropped, never done', async () => {
    await requestSwitch(home, restored, new Date('2026-11-01T10:00:00Z'));
    const out = await applyPendingSwitch(home, { now: () => Date.parse('2026-11-04T10:00:00Z') });
    expect(out.kind).toBe('failed');
    expect(await read(path.join(home, 'notes', 'a.md'))).toBe('live');
    expect(await lastSwitchError(home)).toMatch(/more than a day ago/);
    // The user read it: cancel drops the note too.
    await cancelSwitch(home);
    expect(await lastSwitchError(home)).toBeNull();
  });

  it('refuses a data folder that is a link', async () => {
    const real = path.join(root, 'real-home');
    await fsp.rename(home, real);
    await fsp.symlink(real, home);
    await expect(requestSwitch(home, restored)).rejects.toThrow(/link/);
  });

  it('putting the old folder back fails too: the request stays, the outcome is fatal, and the next start finishes', async () => {
    const p = await requestSwitch(home, restored);
    let n = 0;
    const broken = { rename: async (a: string, b: string) => { n++; if (n >= 2) throw new Error('EIO'); return fsp.rename(a, b); } };
    const out = await applyPendingSwitch(home, broken);
    expect(out).toMatchObject({ kind: 'failed', fatal: true });
    expect(await exists(home)).toBe(false);
    expect(await read(path.join(p.aside, 'notes', 'a.md'))).toBe('live');
    expect(await readPendingSwitch(home)).not.toBeNull();
    expect(await applyPendingSwitch(home)).toMatchObject({ kind: 'switched' });
    expect(await read(path.join(home, 'notes', 'a.md'))).toBe('restored');
  });
});

