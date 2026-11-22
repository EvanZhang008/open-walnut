/**
 * readJsonFileKept: a looking reader's JSON is parsed once per version of the file and shared,
 * frozen (2026-11-21: session-requests.json was parsed about 1,000 times in 10 minutes on the
 * live server while it changed a dozen times).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { readJsonFileKept, _resetJsonKeptForTesting } from '../../src/utils/json-kept.js';
import { writeJsonFile } from '../../src/utils/fs.js';
import { _resetJsonIoForTesting, jsonIoTop } from '../../src/core/observability/json-io.js';

let dir: string;
let file: string;
const reads = () => jsonIoTop(50).find((r) => r.file === file)?.reads ?? 0;
/** Past the racy window: a file changed this moment is read, never kept (json-kept.ts RACY_MS). */
const settle = () => new Promise((r) => setTimeout(r, 150));

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'json-kept-'));
  file = path.join(dir, 'store.json');
  _resetJsonKeptForTesting();
  _resetJsonIoForTesting();
});
afterEach(async () => { await fs.rm(dir, { recursive: true, force: true }); });

describe('readJsonFileKept', () => {
  it('parses the file once while it is unchanged, and every reader gets the same value', async () => {
    await writeJsonFile(file, { rows: [{ id: 'a' }] });
    await settle();
    const first = await readJsonFileKept(file, { rows: [] as { id: string }[] });
    for (let i = 0; i < 10; i += 1) expect(await readJsonFileKept(file, { rows: [] as { id: string }[] })).toBe(first);
    expect(reads()).toBe(1);
  });

  it('a file changed a moment ago is read every time (an in-place rewrite in the same clock tick keeps its stamp)', async () => {
    await writeJsonFile(file, { rows: [{ id: 'a' }] });
    await readJsonFileKept(file, { rows: [] });
    await readJsonFileKept(file, { rows: [] });
    expect(reads()).toBe(2);
  });

  it('a file that exists and cannot be read is never kept, and a caller that asked for errors gets one', async () => {
    await writeJsonFile(file, { rows: [{ id: 'a' }] });
    await settle();
    await fs.chmod(file, 0o000);
    try {
      expect(await readJsonFileKept(file, { rows: [] as { id: string }[] })).toEqual({ rows: [] });
      await expect(readJsonFileKept(file, { rows: [] }, { readErrors: 'throw' })).rejects.toThrow();
    } finally {
      await fs.chmod(file, 0o600);
    }
    expect((await readJsonFileKept(file, { rows: [] as { id: string }[] })).rows[0]!.id).toBe('a');
  });

  it('reads the new text after any write: an atomic write, an in-place rewrite of the same size', async () => {
    await writeJsonFile(file, { rows: [{ id: 'a' }] });
    expect((await readJsonFileKept(file, { rows: [] as { id: string }[] })).rows[0]!.id).toBe('a');
    await writeJsonFile(file, { rows: [{ id: 'b' }] });
    expect((await readJsonFileKept(file, { rows: [] as { id: string }[] })).rows[0]!.id).toBe('b');
    // Same size, same inode: the mtime and ctime still move.
    await settle();
    expect((await readJsonFileKept(file, { rows: [] as { id: string }[] })).rows[0]!.id).toBe('b');
    await fs.writeFile(file, (await fs.readFile(file, 'utf-8')).replace('"b"', '"c"'));
    expect((await readJsonFileKept(file, { rows: [] as { id: string }[] })).rows[0]!.id).toBe('c');
  });

  it('a missing file is the fallback, and a file that appears later is read', async () => {
    expect(await readJsonFileKept(file, { rows: [] })).toEqual({ rows: [] });
    await writeJsonFile(file, { rows: [{ id: 'new' }] });
    expect(await readJsonFileKept(file, { rows: [] })).toEqual({ rows: [{ id: 'new' }] });
  });

  it('the shared value is frozen all the way down: a caller that changes it throws, others never see it', async () => {
    await writeJsonFile(file, { rows: [{ id: 'a', tags: ['x'] }] });
    await settle();
    const v = await readJsonFileKept(file, { rows: [] as { id: string; tags: string[] }[] }) as { rows: { id: string; tags: string[] }[] };
    expect(() => { v.rows[0]!.id = 'changed'; }).toThrow(TypeError);
    expect(() => { v.rows[0]!.tags.push('y'); }).toThrow(TypeError);
    expect(() => { v.rows.push({ id: 'b', tags: [] }); }).toThrow(TypeError);
    expect((await readJsonFileKept(file, { rows: [] as { id: string }[] })).rows[0]!.id).toBe('a');
  });

  it('a corrupt file throws and is never kept', async () => {
    await fs.writeFile(file, '{"rows": [');
    await expect(readJsonFileKept(file, { rows: [] })).rejects.toThrow(/Failed to parse/);
    await writeJsonFile(file, { rows: [] });
    expect(await readJsonFileKept(file, { rows: [{ id: 'fallback' }] })).toEqual({ rows: [] });
  });
});

describe('the hot files a looking reader parses go through readJsonFileKept', () => {
  // A file the live server parsed hundreds of times in 10 minutes (the memory ledger's jsonTop
  // line names them). A new reader of one that calls readJsonFile parses it on every call again.
  const HOT = [
    { src: 'src/core/session-requests.ts', file: 'REQUESTS_FILE' },
    { src: 'src/core/human-inbox/store.ts', file: 'INDEX_FILE' },
  ];
  it.each(HOT)('$src reads $file only through the kept reader (writes keep their own copy)', async ({ src, file }) => {
    const text = await fs.readFile(path.resolve(__dirname, '../..', src), 'utf-8');
    expect(text).not.toMatch(new RegExp(`readJsonFile<[^>]*>\\(\\s*${file}\\b`));
    expect(text).toMatch(/readJsonFileKept</);
  });
});
