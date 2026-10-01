/**
 * downloadGgmlModel (src/core/stt/setup.ts) against a tiny local HTTP server
 * serving a slow three-chunk body, so no test touches the network.
 *
 * Pinned: a slow link still reports (a heartbeat every PROGRESS_HEARTBEAT_MS,
 * even when the percent has not moved 2 points), a response with NO
 * Content-Length reports megabytes instead of staying silent, and a download
 * whose client went away stops and leaves no partial file behind.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import http from 'node:http';
import { mkdtemp, rm, readdir, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { downloadGgmlModel, progressGate } from '../../src/core/stt/setup.js';
import { eventQueue } from '../../src/core/stt/setup-stream.js';
import type { SetupEvent } from '../../src/core/stt/setup-stream.js';

let dir: string;
let server: http.Server | null = null;

beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'stt-dl-')); });
afterEach(async () => {
  if (server) await new Promise<void>((r) => { server!.closeAllConnections?.(); server!.close(() => r()); });
  server = null;
  await rm(dir, { recursive: true, force: true });
});

const CHUNK = 100_000;

/** Three chunks, `gapMs` apart; with `length` the Content-Length header is sent. */
function slowServer(opts: { gapMs: number; length: boolean }): Promise<string> {
  server = http.createServer(async (_req, res) => {
    res.writeHead(200, opts.length ? { 'Content-Length': String(CHUNK * 3) } : {});
    for (let i = 0; i < 3; i++) {
      if (res.destroyed) return;
      res.write(Buffer.alloc(CHUNK, i + 1));
      await new Promise((r) => setTimeout(r, opts.gapMs));
    }
    res.end();
  });
  return new Promise((resolve) => server!.listen(0, '127.0.0.1', () => {
    resolve(`http://127.0.0.1:${(server!.address() as { port: number }).port}/model.bin`);
  }));
}

async function collect(gen: AsyncGenerator<SetupEvent>, onEvent?: (e: SetupEvent) => void): Promise<SetupEvent[]> {
  const out: SetupEvent[] = [];
  for await (const e of gen) { out.push(e); onEvent?.(e); }
  return out;
}

describe('downloadGgmlModel', () => {
  it('without Content-Length, still reports the megabytes arriving', async () => {
    const url = await slowServer({ gapMs: 150, length: false });
    const events = await collect(downloadGgmlModel(url, dir, 'model.bin', { heartbeatMs: 50 }));
    const mid = events.filter((e) => e.type === 'progress' && /MB downloaded$/.test(e.message ?? ''));
    expect(mid.length).toBeGreaterThanOrEqual(2);
    expect(mid.every((e) => e.percent === undefined)).toBe(true);
    expect(events.at(-1)).toMatchObject({ type: 'done', path: join(dir, 'model.bin') });
    expect((await readFile(join(dir, 'model.bin'))).length).toBe(CHUNK * 3);
  });

  it('with Content-Length, reports percent and never 100 before the file is complete', async () => {
    const url = await slowServer({ gapMs: 50, length: true });
    const events = await collect(downloadGgmlModel(url, dir, 'model.bin', { heartbeatMs: 10_000 }));
    const percents = events.filter((e) => e.type === 'progress').map((e) => e.percent!);
    // TCP may split or merge the three chunks, so pin the shape, not exact values:
    // rising, real movement in between, and 100 only once, at the very end.
    expect(percents.every((p, i) => i === 0 || p > percents[i - 1])).toBe(true);
    expect(percents.some((p) => p > 0 && p < 99)).toBe(true);
    expect(percents.filter((p) => p === 100)).toHaveLength(1);
    expect(percents.at(-1)).toBe(100);
  });

  it('stops when the client goes away and removes the partial file', async () => {
    const url = await slowServer({ gapMs: 400, length: true });
    const ctl = new AbortController();
    const events = await collect(downloadGgmlModel(url, dir, 'model.bin', { signal: ctl.signal, heartbeatMs: 10_000 }), (e) => {
      if (e.type === 'progress' && (e.percent ?? 0) > 0) ctl.abort();
    });
    expect(events.at(-1)?.type).toBe('error');
    expect(await readdir(dir)).toEqual([]);
  });

  it('a consumer that stops iterating early (route break) also cleans up', async () => {
    const url = await slowServer({ gapMs: 400, length: true });
    for await (const e of downloadGgmlModel(url, dir, 'model.bin', { heartbeatMs: 10_000 })) {
      if (e.type === 'progress' && (e.percent ?? 0) > 0) break;
    }
    expect(await readdir(dir)).toEqual([]);
  });
});

describe('progressGate', () => {
  it('reports on 2-point moves and on the heartbeat, never more often', () => {
    let now = 0;
    const gate = progressGate(2_000, () => now);
    expect(gate(0)).toBe(true);        // first report
    expect(gate(1)).toBe(false);       // moved 1 point, 0 ms later
    now = 1_000;
    expect(gate(2)).toBe(true);        // moved 2 points
    now = 2_500;
    expect(gate(2)).toBe(false);       // stuck, only 1.5 s since the last report
    now = 3_100;
    expect(gate(2)).toBe(true);        // stuck, but 2 s passed: heartbeat
    now = 5_200;
    expect(gate(undefined)).toBe(true); // unknown size: time-based only
    expect(gate(undefined)).toBe(false);
  });
});

describe('eventQueue', () => {
  it('delivers pushes live and ends on close', async () => {
    const q = eventQueue<number>();
    const seen: number[] = [];
    const drained = (async () => { for await (const n of q.drain()) seen.push(n); })();
    q.push(1);
    await new Promise((r) => setTimeout(r, 10));
    expect(seen).toEqual([1]);
    q.push(2);
    q.close();
    q.push(3); // after close: dropped
    await drained;
    expect(seen).toEqual([1, 2]);
  });
});
