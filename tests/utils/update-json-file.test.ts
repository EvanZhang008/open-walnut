/**
 * Unit tests for updateJsonFile (src/utils/fs.ts) — the locked read-modify-write
 * primitive for JSON files that can have more than one writer.
 *
 * Contract under test:
 *   - basic RMW round-trip (returned value === persisted value)
 *   - two concurrent updates on the same file BOTH land (no lost update)
 *   - mutate-in-place (returning undefined) persists the mutated object
 *   - fallback is used when the file doesn't exist
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fsp from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { updateJsonFile, readJsonFile } from '../../src/utils/fs.js';

let tmpDir: string;

beforeEach(async () => {
  tmpDir = path.join(os.tmpdir(), `update-json-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  await fsp.mkdir(tmpDir, { recursive: true });
});

afterEach(async () => {
  await fsp.rm(tmpDir, { recursive: true, force: true });
});

describe('updateJsonFile', () => {
  it('performs a basic read-modify-write round-trip', async () => {
    const file = path.join(tmpDir, 'store.json');
    await fsp.writeFile(file, JSON.stringify({ count: 1 }), 'utf-8');

    const result = await updateJsonFile<{ count: number }>(file, { count: 0 }, (current) => ({
      count: current.count + 1,
    }));

    expect(result).toEqual({ count: 2 });
    // Persisted value matches the returned value.
    const onDisk = await readJsonFile<{ count: number }>(file, { count: -1 });
    expect(onDisk).toEqual({ count: 2 });
  });

  it('two concurrent updates on the same file both land (no lost update)', async () => {
    const file = path.join(tmpDir, 'concurrent.json');
    type Store = Record<string, number>;

    // Each mutation touches a DIFFERENT key; with an unlocked read→write pair
    // one of them would clobber the other (stale-snapshot lost update).
    await Promise.all([
      updateJsonFile<Store>(file, {}, (s) => { s.a = 1; return s; }),
      updateJsonFile<Store>(file, {}, (s) => { s.b = 2; return s; }),
    ]);

    const onDisk = await readJsonFile<Store>(file, {});
    expect(onDisk).toEqual({ a: 1, b: 2 });
  });

  it('mutate-in-place (returning undefined) persists the mutated object', async () => {
    const file = path.join(tmpDir, 'in-place.json');
    await fsp.writeFile(file, JSON.stringify({ items: ['x'] }), 'utf-8');

    const result = await updateJsonFile<{ items: string[] }>(file, { items: [] }, (current) => {
      current.items.push('y');
      // no return — "mutated in place"
    });

    expect(result.items).toEqual(['x', 'y']);
    const onDisk = await readJsonFile<{ items: string[] }>(file, { items: [] });
    expect(onDisk.items).toEqual(['x', 'y']);
  });

  it('uses the fallback when the file does not exist (and creates it)', async () => {
    const file = path.join(tmpDir, 'missing.json');

    const result = await updateJsonFile<{ seen: boolean; n: number }>(
      file,
      { seen: false, n: 0 },
      (current) => {
        expect(current).toEqual({ seen: false, n: 0 }); // fresh fallback
        return { seen: true, n: 1 };
      },
    );

    expect(result).toEqual({ seen: true, n: 1 });
    const onDisk = await readJsonFile<{ seen: boolean; n: number }>(file, { seen: false, n: -1 });
    expect(onDisk).toEqual({ seen: true, n: 1 });
  });

  it('supports async mutate callbacks', async () => {
    const file = path.join(tmpDir, 'async.json');
    const result = await updateJsonFile<number[]>(file, [], async (current) => {
      await new Promise((r) => setTimeout(r, 5));
      current.push(42);
    });
    expect(result).toEqual([42]);
    expect(await readJsonFile<number[]>(file, [])).toEqual([42]);
  });

  it('releases the lock on mutate failure (next update succeeds)', async () => {
    const file = path.join(tmpDir, 'throw.json');
    await expect(
      updateJsonFile<{ v: number }>(file, { v: 0 }, () => { throw new Error('boom'); }),
    ).rejects.toThrow('boom');
    // A failed mutate must not persist anything...
    await expect(fsp.stat(file)).rejects.toMatchObject({ code: 'ENOENT' });
    // ...and must not leave the lock held.
    const result = await updateJsonFile<{ v: number }>(file, { v: 0 }, (s) => ({ v: s.v + 1 }));
    expect(result).toEqual({ v: 1 });
  });
});
