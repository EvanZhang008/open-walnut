/**
 * The slow-call sampler: a watcher thread takes one OS stack sample while a timed
 * call holds the loop thread, and the loop logs where its main thread sat.
 *
 * macOS `sample` is not on the test hosts, so a stand-in script writes a real
 * report's shape to the -file path it is given; the watcher thread, the shared
 * "call running now" stamp, the rate limit and the log line are the real ones.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from '../../src/lib/sqlite.js';
import { log } from '../../src/logging/index.js';
import { installBlockingCallTiming, _resetBlockingCallsForTesting } from '../../src/core/blocking-calls.js';
import { parseSampleMainThread, slowCallSamplerOnline, slowCallSamplerSkips, startSlowCallSampler, _stopSlowCallSamplerForTesting } from '../../src/core/slow-call-sampler.js';

const FIXTURE = path.join(__dirname, '../fixtures/stall-sample/sample-sqlite-wait.txt');

afterEach(async () => {
  await _stopSlowCallSamplerForTesting();
  _resetBlockingCallsForTesting();
  vi.restoreAllMocks();
});

/** A stand-in for /usr/bin/sample: copies the fixture to the path after -file, and counts its runs. */
function fakeSampler(dir: string): { bin: string; runs: () => number } {
  const bin = path.join(dir, 'sample');
  const runs = path.join(dir, 'runs');
  fs.writeFileSync(bin, `#!/bin/sh\necho x >> '${runs}'\nwhile [ "$#" -gt 0 ]; do [ "$1" = -file ] && cp '${FIXTURE}' "$2"; shift; done\n`, { mode: 0o755 });
  return { bin, runs: () => (fs.existsSync(runs) ? fs.readFileSync(runs, 'utf8').trim().split('\n').length : 0) };
}

/** One transaction that keeps the loop thread about `ms` in SQLite (one timed call: the statements are inside it). */
function slowStatement(db: ReturnType<typeof Database>, ms: number): void {
  const step = db.prepare('WITH RECURSIVE c(x) AS (SELECT 1 UNION ALL SELECT x + 1 FROM c WHERE x < 20000) SELECT sum(x) FROM c');
  db.transaction(() => {
    const until = performance.now() + ms;
    while (performance.now() < until) step.get();
  })();
}

describe('parseSampleMainThread', () => {
  it('names the main thread leaf frames, heaviest first, with the SQLite frame above each', () => {
    const top = parseSampleMainThread(fs.readFileSync(FIXTURE, 'utf8'));
    expect(top[0]).toEqual({ frame: 'pread (libsystem_kernel.dylib)', n: 790, sqlite: 'sqlite3BtreeInsert' });
    // The waits under a SQLite frame come first, then the loop's own idle wait.
    expect(top.map((t) => t.frame)).toEqual(['pread (libsystem_kernel.dylib)', 'fcntl (libsystem_kernel.dylib)', 'kevent64 (libsystem_kernel.dylib)']);
    // Another thread's frames are not the main thread's.
    expect(top.some((t) => t.frame.startsWith('__psynch_cvwait'))).toBe(false);
  });

  it('returns nothing for a report without a main thread', () => {
    expect(parseSampleMainThread('Call graph:\n    3 Thread_1: worker\n')).toEqual([]);
  });
});

describe('startSlowCallSampler', () => {
  it('does not start off macOS', () => {
    expect(startSlowCallSampler({ platform: 'linux' })).toBe(false);
  });

  it('samples the process while one SQLite call holds the loop, and logs the main thread frames with the call', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'slow-call-sampler-'));
    const fake = fakeSampler(dir);
    const warn = vi.spyOn(log.web, 'warn').mockImplementation(() => {});
    installBlockingCallTiming();
    expect(startSlowCallSampler({ platform: 'darwin', bin: fake.bin, dir: path.join(dir, 'out'), afterMs: 100, gapMs: 0 })).toBe(true);
    await slowCallSamplerOnline();
    const db = Database(':memory:');
    slowStatement(db, 400);
    await vi.waitFor(() => {
      const line = warn.mock.calls.find((c) => c[0] === 'loop thread sampled in a slow call');
      expect(line).toBeDefined();
      const data = line![1] as { kind: string; heldMsAtSample: number; call?: string; callMs?: number; top: Array<{ frame: string }>; file: string };
      expect(data.kind).toBe('sqlite');
      expect(data.heldMsAtSample).toBeGreaterThanOrEqual(100);
      // The outer call (the transaction), not a statement inside it.
      expect(data.call).toBe('transaction');
      expect(data.callMs).toBeGreaterThanOrEqual(300);
      expect(data.top[0].frame).toBe('pread (libsystem_kernel.dylib)');
      expect(fs.existsSync(data.file)).toBe(true);
    }, { timeout: 10_000 });
    db.close();
  });

  it('holds its gap and its per-boot cap: a slow call past them is counted, not sampled', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'slow-call-sampler-'));
    const fake = fakeSampler(dir);
    const warn = vi.spyOn(log.web, 'warn').mockImplementation(() => {});
    const sampled = () => warn.mock.calls.filter((c) => c[0] === 'loop thread sampled in a slow call').length;
    installBlockingCallTiming();
    startSlowCallSampler({ platform: 'darwin', bin: fake.bin, dir: path.join(dir, 'out'), afterMs: 100, gapMs: 60_000, max: 5 });
    await slowCallSamplerOnline();
    const db = Database(':memory:');
    slowStatement(db, 300);
    // The line comes once the sample is done (the watcher looks again only then).
    await vi.waitFor(() => expect(sampled()).toBe(1), { timeout: 10_000 });
    slowStatement(db, 300);
    await vi.waitFor(() => expect(slowCallSamplerSkips().gap).toBe(1), { timeout: 10_000 });
    expect(fake.runs()).toBe(1);
    await _stopSlowCallSamplerForTesting();
    startSlowCallSampler({ platform: 'darwin', bin: fake.bin, dir: path.join(dir, 'out'), afterMs: 100, gapMs: 0, max: 0 });
    await slowCallSamplerOnline();
    slowStatement(db, 300);
    await vi.waitFor(() => expect(slowCallSamplerSkips().max).toBe(1), { timeout: 10_000 });
    expect(fake.runs()).toBe(1);
    db.close();
  });

  it('takes no sample for calls shorter than its threshold, and one for the first that is longer', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'slow-call-sampler-'));
    const fake = fakeSampler(dir);
    vi.spyOn(log.web, 'warn').mockImplementation(() => {});
    installBlockingCallTiming();
    startSlowCallSampler({ platform: 'darwin', bin: fake.bin, dir: path.join(dir, 'out'), afterMs: 150, gapMs: 0 });
    await slowCallSamplerOnline();
    const db = Database(':memory:');
    for (let i = 0; i < 10; i++) slowStatement(db, 30);
    // The positive control: the watcher runs and does sample a call past the threshold, once.
    slowStatement(db, 400);
    await vi.waitFor(() => expect(fake.runs()).toBe(1), { timeout: 10_000 });
    expect(slowCallSamplerSkips()).toEqual({ gap: 0, max: 0 });
    db.close();
  });
});
