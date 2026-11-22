/**
 * json-io.ts: the memory ledger's lines name the data files that moved the most JSON
 * text lately (2026-11-21: JSON.parse inside readJsonFile was the largest cost in the
 * live server's kept CPU profiles, with no file named).
 */
import { describe, it, expect, beforeEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { noteJsonIo, jsonIoTop, JSON_IO_WINDOW_MS, _resetJsonIoForTesting } from '../../../src/core/observability/json-io.js';
import { readJsonFile, writeJsonFile } from '../../../src/utils/fs.js';

beforeEach(() => { _resetJsonIoForTesting(); });

describe('jsonIoTop', () => {
  it('sums reads and writes per file, biggest first, inside the window only', () => {
    const t = 1_000_000_000;
    // Events arrive in time order, as they do from readJsonFile and writeJsonFile.
    noteJsonIo('/d/old.json', true, 100 * 1048576, t - JSON_IO_WINDOW_MS - 1);
    noteJsonIo('/d/small.json', true, 1048576, t);
    noteJsonIo('/d/big.json', true, 4 * 1048576, t);
    noteJsonIo('/d/big.json', false, 2 * 1048576, t + 1);
    expect(jsonIoTop(10, t + 2)).toEqual([
      { file: '/d/big.json', reads: 1, readMB: 4, writes: 1, writeMB: 2 },
      { file: '/d/small.json', reads: 1, readMB: 1, writes: 0, writeMB: 0 },
    ]);
  });

  it('readJsonFile and writeJsonFile note what they parse and write', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'json-io-'));
    const file = path.join(dir, 'x.json');
    await writeJsonFile(file, { a: 'b'.repeat(1000) });
    await readJsonFile(file, {});
    const [row] = jsonIoTop();
    expect(row).toMatchObject({ file, reads: 1, writes: 1 });
    fs.rmSync(dir, { recursive: true, force: true });
  });
});
