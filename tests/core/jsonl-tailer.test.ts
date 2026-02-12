/**
 * Unit tests for JsonlTailer — file-based JSONL tailing engine.
 *
 * Tests verify:
 *   - Reading existing content on start
 *   - Live tailing of appended content
 *   - Partial line buffering (incomplete lines held until newline)
 *   - flush() processing remaining buffer
 *   - start(fromOffset) skips already-read bytes
 *   - stop() cleans up resources
 *   - currentOffset tracks position
 *   - Empty/blank lines are skipped
 *   - Graceful handling of missing file
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { JsonlTailer } from '../../src/core/jsonl-tailer.js';

let tmpDir: string;

beforeEach(async () => {
  tmpDir = path.join(os.tmpdir(), `tailer-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  await fsp.mkdir(tmpDir, { recursive: true });
});

afterEach(async () => {
  await fsp.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
});

describe('JsonlTailer', () => {
  it('reads existing content on start', () => {
    const filePath = path.join(tmpDir, 'existing.jsonl');
    fs.writeFileSync(filePath, '{"a":1}\n{"b":2}\n');

    const lines: string[] = [];
    const tailer = new JsonlTailer(filePath, (line) => lines.push(line));
    tailer.start();
    tailer.stop();

    expect(lines).toEqual(['{"a":1}', '{"b":2}']);
  });

  it('tails new content appended after start', async () => {
    const filePath = path.join(tmpDir, 'live.jsonl');
    fs.writeFileSync(filePath, '');

    const lines: string[] = [];
    const tailer = new JsonlTailer(filePath, (line) => lines.push(line));
    tailer.start();

    // Append content
    fs.appendFileSync(filePath, '{"line":1}\n');
    // Manually trigger read (don't wait for poll timer)
    tailer.readNewData();

    expect(lines).toEqual(['{"line":1}']);

    fs.appendFileSync(filePath, '{"line":2}\n');
    tailer.readNewData();

    expect(lines).toEqual(['{"line":1}', '{"line":2}']);

    tailer.stop();
  });

  it('buffers partial lines until newline arrives', () => {
    const filePath = path.join(tmpDir, 'partial.jsonl');
    fs.writeFileSync(filePath, '{"partial":tr');

    const lines: string[] = [];
    const tailer = new JsonlTailer(filePath, (line) => lines.push(line));
    tailer.start();

    // No complete line yet
    expect(lines).toEqual([]);

    // Complete the line
    fs.appendFileSync(filePath, 'ue}\n');
    tailer.readNewData();

    expect(lines).toEqual(['{"partial":true}']);

    tailer.stop();
  });

  it('flush() processes remaining partial line', () => {
    const filePath = path.join(tmpDir, 'flush.jsonl');
    fs.writeFileSync(filePath, '{"complete":1}\n{"no-newline":2}');

    const lines: string[] = [];
    const tailer = new JsonlTailer(filePath, (line) => lines.push(line));
    tailer.start();

    // Only the complete line should be delivered
    expect(lines).toEqual(['{"complete":1}']);

    // Flush delivers the remaining partial line
    tailer.flush();
    expect(lines).toEqual(['{"complete":1}', '{"no-newline":2}']);

    tailer.stop();
  });

  it('start(fromOffset) skips already-read bytes', () => {
    const filePath = path.join(tmpDir, 'offset.jsonl');
    const line1 = '{"first":1}\n';
    const line2 = '{"second":2}\n';
    fs.writeFileSync(filePath, line1 + line2);

    const lines: string[] = [];
    const tailer = new JsonlTailer(filePath, (line) => lines.push(line));
    // Start from offset past the first line
    tailer.start(Buffer.byteLength(line1));

    expect(lines).toEqual(['{"second":2}']);

    tailer.stop();
  });

  it('currentOffset tracks byte position', () => {
    const filePath = path.join(tmpDir, 'offset-track.jsonl');
    const content = '{"a":1}\n{"b":2}\n';
    fs.writeFileSync(filePath, content);

    const tailer = new JsonlTailer(filePath, () => {});
    tailer.start();

    expect(tailer.currentOffset).toBe(Buffer.byteLength(content));

    tailer.stop();
  });

  it('skips empty and blank lines', () => {
    const filePath = path.join(tmpDir, 'blanks.jsonl');
    fs.writeFileSync(filePath, '{"a":1}\n\n   \n{"b":2}\n');

    const lines: string[] = [];
    const tailer = new JsonlTailer(filePath, (line) => lines.push(line));
    tailer.start();
    tailer.stop();

    expect(lines).toEqual(['{"a":1}', '{"b":2}']);
  });

  it('handles missing file gracefully (no throw)', () => {
    const filePath = path.join(tmpDir, 'nonexistent.jsonl');

    const lines: string[] = [];
    const tailer = new JsonlTailer(filePath, (line) => lines.push(line));
    tailer.start(); // Should not throw
    tailer.stop();

    expect(lines).toEqual([]);
  });

  it('stop() cleans up and prevents further reads', () => {
    const filePath = path.join(tmpDir, 'stoptest.jsonl');
    fs.writeFileSync(filePath, '{"before":1}\n');

    const lines: string[] = [];
    const tailer = new JsonlTailer(filePath, (line) => lines.push(line));
    tailer.start();
    expect(lines).toEqual(['{"before":1}']);

    tailer.stop();

    // Append after stop — should not be read
    fs.appendFileSync(filePath, '{"after":2}\n');
    tailer.readNewData(); // Manually call — should no-op (fd is null)

    expect(lines).toEqual(['{"before":1}']);
  });

  it('can be restarted after stop', () => {
    const filePath = path.join(tmpDir, 'restart.jsonl');
    fs.writeFileSync(filePath, '{"round1":1}\n');

    const lines: string[] = [];
    const tailer = new JsonlTailer(filePath, (line) => lines.push(line));

    tailer.start();
    expect(lines).toEqual(['{"round1":1}']);
    tailer.stop();

    // Append more content
    fs.appendFileSync(filePath, '{"round2":2}\n');

    // Restart from beginning
    tailer.start(0);
    tailer.stop();

    expect(lines).toEqual(['{"round1":1}', '{"round1":1}', '{"round2":2}']);
  });

  it('handles multi-byte UTF-8 content correctly', () => {
    const filePath = path.join(tmpDir, 'utf8.jsonl');
    const line = '{"emoji":"🎉","text":"日本語"}\n';
    fs.writeFileSync(filePath, line);

    const lines: string[] = [];
    const tailer = new JsonlTailer(filePath, (l) => lines.push(l));
    tailer.start();
    tailer.stop();

    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0])).toEqual({ emoji: '🎉', text: '日本語' });
    expect(tailer.currentOffset).toBe(Buffer.byteLength(line));
  });
});
