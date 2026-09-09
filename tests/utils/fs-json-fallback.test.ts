/**
 * readJsonFile / updateJsonFile hand back a COPY of the fallback, never the caller's
 * object (src/utils/fs.ts).
 *
 * The bug this pins was invisible to every test: a caller keeps a shared
 * `const EMPTY = { rows: [] }`, passes it as the fallback, and mutates what it read
 * inside the mutate callback (the normal shape). The host used to return `EMPTY` itself,
 * so that mutation landed on the shared object and every later read of any missing file
 * with the same fallback started from the poisoned value. The plugin-api test fake always
 * cloned, so a plugin author's own tests could not reproduce it and a real plugin lost an
 * approved row to it.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fsp from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { readJsonFile, updateJsonFile } from '../../src/utils/fs.js';

interface Store { rows: string[] }

let tmpDir: string;

beforeEach(async () => {
  tmpDir = path.join(os.tmpdir(), `fs-json-fallback-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  await fsp.mkdir(tmpDir, { recursive: true });
});

afterEach(async () => {
  await fsp.rm(tmpDir, { recursive: true, force: true });
});

describe('readJsonFile fallback copying', () => {
  it('two sequential updates on a missing file cannot see each other through a shared fallback', async () => {
    // The plugin author's module-level constant.
    const EMPTY: Store = { rows: [] };
    const file = path.join(tmpDir, 'state.json');

    const first = await updateJsonFile<Store>(file, EMPTY, (current) => {
      current.rows.push('approved-post');
      return current;
    });
    expect(first.rows).toEqual(['approved-post']);

    // The file goes away (a wipe, a fresh data dir, a different store name). The next
    // update must start from an EMPTY store, not from the first one's rows.
    await fsp.rm(file, { force: true });

    const second = await updateJsonFile<Store>(file, EMPTY, (current) => {
      current.rows.push('second-post');
      return current;
    });

    expect(second.rows).toEqual(['second-post']);
    // The caller's constant is untouched, so every later reader still starts empty.
    expect(EMPTY).toEqual({ rows: [] });
  });

  it('keeps one shared fallback clean across two different missing files', async () => {
    const EMPTY: Store = { rows: [] };

    await updateJsonFile<Store>(path.join(tmpDir, 'a.json'), EMPTY, (current) => {
      current.rows.push('from-a');
      return current;
    });
    const b = await updateJsonFile<Store>(path.join(tmpDir, 'b.json'), EMPTY, (current) => {
      current.rows.push('from-b');
      return current;
    });

    expect(b.rows).toEqual(['from-b']);
    expect(EMPTY).toEqual({ rows: [] });
  });

  it('returns a copy on ENOENT, deeply', async () => {
    const fallback = { rows: ['seed'], nested: { list: [1] } };

    const read = await readJsonFile(path.join(tmpDir, 'missing.json'), fallback);

    expect(read).toEqual(fallback);
    expect(read).not.toBe(fallback);
    // Shallow copying would still share the arrays, which is where the rows live.
    expect(read.rows).not.toBe(fallback.rows);
    expect(read.nested).not.toBe(fallback.nested);
    read.rows.push('mutated');
    read.nested.list.push(2);
    expect(fallback).toEqual({ rows: ['seed'], nested: { list: [1] } });
  });

  it('returns a copy when the read fails for a reason other than ENOENT', async () => {
    // A directory where a file was expected: readFile answers EISDIR, which the host
    // treats as "use the fallback" rather than throwing.
    const asDirectory = path.join(tmpDir, 'store-dir.json');
    await fsp.mkdir(asDirectory);
    const fallback: Store = { rows: [] };

    const read = await readJsonFile(asDirectory, fallback);

    expect(read).toEqual({ rows: [] });
    expect(read).not.toBe(fallback);
    read.rows.push('leak');
    expect(fallback).toEqual({ rows: [] });
  });

  it('returns a copy for an empty file (truncated write)', async () => {
    const file = path.join(tmpDir, 'empty.json');
    await fsp.writeFile(file, '   \n', 'utf-8');
    const fallback: Store = { rows: [] };

    const read = await readJsonFile(file, fallback);

    expect(read).not.toBe(fallback);
    read.rows.push('leak');
    expect(fallback).toEqual({ rows: [] });
  });

  it('hands back an uncloneable fallback unchanged instead of throwing', async () => {
    // structuredClone rejects a function. A read must not become a DataCloneError just
    // because a plugin passed a fallback holding a callback: the caller keeps the old
    // aliasing behaviour, which is the lesser problem.
    const fallback = { rows: [] as string[], onDone: () => undefined };

    const read = await readJsonFile(path.join(tmpDir, 'missing.json'), fallback);

    expect(read).toBe(fallback);
    expect(typeof read.onDone).toBe('function');
  });

  it('leaves a primitive fallback alone', async () => {
    expect(await readJsonFile(path.join(tmpDir, 'missing.json'), null)).toBe(null);
    expect(await readJsonFile(path.join(tmpDir, 'missing.json'), 'none')).toBe('none');
  });
});
