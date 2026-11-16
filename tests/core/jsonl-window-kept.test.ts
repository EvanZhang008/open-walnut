/**
 * Kept windows (jsonl-window.ts readKeptJsonlLineWindow): a complete window is
 * read once per file incarnation, and a window that may still change never is
 * kept. A page of older history that missed the route's deadline left its read
 * finished in the background; keeping it is what lets the retry answer.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import {
  readKeptJsonlLineWindow,
  _resetKeptWindowsForTests,
  type JsonlRangeReader,
} from '../../src/core/jsonl-window.js';

/** An in-memory append-only file that counts the bytes read from it. */
function memFile(initial: string): { reader: JsonlRangeReader; append: (s: string) => void; overwrite: (s: string) => void; read: () => number } {
  let data = Buffer.from(initial);
  let read = 0;
  return {
    reader: {
      async readRangeBytes(_p, start, length) {
        const buf = data.subarray(start, start + length);
        read += buf.length;
        return { buf, fileSize: data.length, eof: start + buf.length >= data.length };
      },
    },
    append: (s) => { data = Buffer.concat([data, Buffer.from(s)]); },
    overwrite: (s) => { data = Buffer.from(s); },
    read: () => read,
  };
}

const line = (n: number) => JSON.stringify({ type: 'assistant', timestamp: `2026-01-01T00:00:${String(n).padStart(2, '0')}Z`, n });
const result = JSON.stringify({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 't', content: 'ok' }] } });

beforeEach(() => _resetKeptWindowsForTests());

describe('readKeptJsonlLineWindow', () => {
  it('a complete window is read once, then served without a read', async () => {
    const text = [line(1), line(2), line(3), line(4)].join('\n') + '\n';
    const f = memFile(text);
    const stop = line(1).length + 1;
    const first = await readKeptJsonlLineWindow(f.reader, 'p', 'h\u0000p\u0000e1', 0, stop, 1 << 20);
    expect(first).toBe(line(1));
    const before = f.read();
    expect(await readKeptJsonlLineWindow(f.reader, 'p', 'h\u0000p\u0000e1', 0, stop, 1 << 20)).toBe(line(1));
    expect(f.read()).toBe(before);
  });

  it('a window that ran into the end of the file is read again, and sees what was added', async () => {
    const f = memFile(line(1) + '\n');
    const stop = 1 << 20;
    expect(await readKeptJsonlLineWindow(f.reader, 'p', 'k', 0, stop, 1 << 20)).toBe(line(1));
    f.append(line(2) + '\n');
    expect(await readKeptJsonlLineWindow(f.reader, 'p', 'k', 0, stop, 1 << 20)).toBe(`${line(1)}\n${line(2)}`);
  });

  it('a window followed by a half-written line is not kept: that line may be its tool result', async () => {
    const head = line(1) + '\n';
    const f = memFile(head + result.slice(0, 20));
    const stop = head.length;
    expect(await readKeptJsonlLineWindow(f.reader, 'p', 'k', 0, stop, 1 << 20)).toBe(line(1));
    f.overwrite(head + result + '\n' + line(3) + '\n');
    // Whole now, the line is a tool result: it belongs to this window.
    expect(await readKeptJsonlLineWindow(f.reader, 'p', 'k', 0, stop, 1 << 20)).toBe(`${line(1)}\n${result}`);
  });

  it('without a file identity nothing is kept', async () => {
    const f = memFile([line(1), line(2)].join('\n') + '\n');
    const stop = line(1).length + 1;
    await readKeptJsonlLineWindow(f.reader, 'p', undefined, 0, stop, 1 << 20);
    const before = f.read();
    await readKeptJsonlLineWindow(f.reader, 'p', undefined, 0, stop, 1 << 20);
    expect(f.read()).toBeGreaterThan(before);
  });

  it('a head read of a window costs a short read, not a whole chunk', async () => {
    const big = Array.from({ length: 4000 }, (_, i) => line(i % 60)).join('\n') + '\n';
    expect(big.length).toBeGreaterThan(200 * 1024);
    const f = memFile(big);
    await readKeptJsonlLineWindow(f.reader, 'p', 'k', 1000, 1000 + 1024, 1 << 20);
    expect(f.read()).toBeLessThanOrEqual(64 * 1024);
  });
});
