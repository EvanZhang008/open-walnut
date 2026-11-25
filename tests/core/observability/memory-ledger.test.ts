/**
 * Memory ledger (2026-11-20): every cache that grows with the user's data registers a budget,
 * the health tick warns when one is over it, and a new module-level cache cannot appear in
 * src/ without being put on the ledger or named here.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import {
  registerMemoryHolder, readMemoryHolders, memoryReport, sampleMemory, stringCharsOf,
  memoryHolderNames, SAMPLE_EVERY_MS, sampledStringChars, nudgeGcUnderPressure, GC_NUDGE_RSS_MB, GC_NUDGE_EVERY_MS, GC_NUDGE_RISE_MB, nudgeGcOnRise, _resetMemoryLedgerForTesting,
  writeHeapSnapshot, SNAPSHOT_EVERY_MS, copyCallerCounter,
  watchMemoryBurst, startMemoryBurstProbe, BURST_PROBE_EVERY_MS, BURST_HEAP_WALK_MB, registerBurstContext, onMemoryBurst, BURST_RISE_MB, BURST_WINDOW_MS, BURST_EVERY_MS,
} from '../../../src/core/observability/memory-ledger.js';
import { log } from '../../../src/logging/index.js';

const ROOT = path.resolve(__dirname, '../../..');

beforeEach(() => { _resetMemoryLedgerForTesting(); });

describe('readMemoryHolders', () => {
  it('counts chars as two bytes, sorts biggest first, flags over budget', () => {
    const offA = registerMemoryHolder({ name: 'test.a', budgetBytes: 100, read: () => ({ entries: 2, chars: 80 }) });
    const offB = registerMemoryHolder({ name: 'test.b', budgetBytes: 1000, read: () => ({ entries: 1, bytes: 10 }) });
    const offC = registerMemoryHolder({ name: 'test.c', budgetBytes: 1, read: () => { throw new Error('mid reset'); } });
    try {
      const rows = readMemoryHolders().filter((r) => r.name.startsWith('test.'));
      expect(rows.map((r) => [r.name, r.bytes, r.overBudget])).toEqual([
        ['test.a', 160, true], ['test.b', 10, false], ['test.c', 0, false],
      ]);
    } finally { offA(); offB(); offC(); }
  });
});

describe('sampleMemory', () => {
  it('logs one sample per interval and warns once an hour for a holder over budget', () => {
    const info = vi.spyOn(log.obs, 'info').mockImplementation(() => {});
    const warn = vi.spyOn(log.obs, 'warn').mockImplementation(() => {});
    const off = registerMemoryHolder({ name: 'test.over', budgetBytes: 1, read: () => ({ entries: 1, bytes: 10 * 1048576 }) });
    try {
      const t0 = 1_000_000_000;
      sampleMemory(t0);
      sampleMemory(t0 + 1000);
      expect(info.mock.calls.filter((c) => c[0] === 'memory sample')).toHaveLength(1);
      expect(warn.mock.calls.filter((c) => c[0] === 'memory holder over budget')).toHaveLength(1);
      sampleMemory(t0 + SAMPLE_EVERY_MS);
      expect(warn.mock.calls.filter((c) => c[0] === 'memory holder over budget')).toHaveLength(1);
      sampleMemory(t0 + 7 * SAMPLE_EVERY_MS);
      expect(warn.mock.calls.filter((c) => c[0] === 'memory holder over budget')).toHaveLength(2);
    } finally { off(); info.mockRestore(); warn.mockRestore(); }
  });
});

describe('copyCallerCounter', () => {
  it('names the readers that copy a store on the sample line, scaled back to calls', () => {
    const info = vi.spyOn(log.obs, 'info').mockImplementation(() => {});
    const note = copyCallerCounter('testCopies', 4, 2);
    function copyWholeStore(): void { note(); }
    function boardReader(): void { copyWholeStore(); }
    function slowRoute(): void { boardReader(); }
    try {
      for (let i = 0; i < 16; i++) slowRoute();
      sampleMemory(2_000_000_000);
      const line = info.mock.calls.find((c) => c[0] === 'memory sample')?.[1] as Record<string, string>;
      expect(line.testCopiesBy).toBe('boardReader<slowRoute=16');
    } finally { info.mockRestore(); }
  });
});

describe('memoryReport', () => {
  it('answers process numbers and every holder', async () => {
    const off = registerMemoryHolder({ name: 'test.r', budgetBytes: 1048576, read: () => ({ entries: 3, chars: 1048576 }) });
    try {
      const r = await memoryReport();
      expect(r.process.rssMb).toBeGreaterThan(0);
      expect(r.holders.find((h) => h.name === 'test.r')).toMatchObject({ entries: 3, mb: 2, budgetMb: 1, overBudget: true });
    } finally { off(); }
  });
});

describe('memoryReport heap walk', () => {
  it('walks the heap at most once a minute', async () => {
    const t0 = 5_000_000_000;
    const first = await memoryReport({ heap: true }, t0);
    const second = await memoryReport({ heap: true }, t0 + 1000);
    const third = await memoryReport({ heap: true }, t0 + 61_000);
    // Under Node there is no bun:jsc, so neither field appears; under Bun the second is refused.
    if (first.engine) {
      expect(first.heap?.objects).toBeGreaterThan(0);
      expect(second.heap).toBeUndefined();
      expect(second.heapSkipped).toMatch(/one walk a minute/);
      expect(third.heap?.objects).toBeGreaterThan(0);
    }
  });
});

describe('sampledStringChars', () => {
  it('scales a sample of every 8th row back up, and walks small lists whole', () => {
    const rows = Array.from({ length: 800 }, () => ({ t: 'x'.repeat(10) }));
    expect(sampledStringChars(rows)).toBe(800 * 11);
    expect(sampledStringChars([{ a: 'abc' }])).toBe(4);
    expect(sampledStringChars(null)).toBe(0);
  });
});

describe('nudgeGcUnderPressure', () => {
  it('asks for an async collection over the threshold, at most once per interval, and logs what it freed', () => {
    const info = vi.spyOn(log.obs, 'info').mockImplementation(() => {});
    const gc = vi.fn();
    try {
      const t0 = 9_000_000_000;
      nudgeGcUnderPressure(t0, gc, GC_NUDGE_RSS_MB - 1);
      expect(gc).not.toHaveBeenCalled();
      nudgeGcUnderPressure(t0, gc, GC_NUDGE_RSS_MB + 500);
      expect(gc).toHaveBeenCalledTimes(1);
      expect(gc).toHaveBeenCalledWith(false);
      nudgeGcUnderPressure(t0 + 30_000, gc, GC_NUDGE_RSS_MB + 100);
      expect(gc).toHaveBeenCalledTimes(1);
      expect(info).toHaveBeenCalledWith('memory gc nudge', { beforeMb: GC_NUDGE_RSS_MB + 500, afterMb: GC_NUDGE_RSS_MB + 100, freedMb: 400 });
      nudgeGcUnderPressure(t0 + GC_NUDGE_EVERY_MS, gc, GC_NUDGE_RSS_MB + 100);
      expect(gc).toHaveBeenCalledTimes(2);
    } finally { info.mockRestore(); }
  });

  it('asks again inside the interval while the footprint climbs GC_NUDGE_RISE_MB past the last nudge', () => {
    const info = vi.spyOn(log.obs, 'info').mockImplementation(() => {});
    const gc = vi.fn();
    try {
      const t0 = 9_100_000_000;
      nudgeGcUnderPressure(t0, gc, 3400);
      expect(gc).toHaveBeenCalledTimes(1);
      nudgeGcUnderPressure(t0 + 30_000, gc, 3400 + GC_NUDGE_RISE_MB - 1);
      expect(gc).toHaveBeenCalledTimes(1);
      nudgeGcUnderPressure(t0 + 60_000, gc, 8000);
      expect(gc).toHaveBeenCalledTimes(2);
      // Measured from the last nudge's reading, not the first one.
      nudgeGcUnderPressure(t0 + 90_000, gc, 8000 + GC_NUDGE_RISE_MB - 1);
      expect(gc).toHaveBeenCalledTimes(2);
      // Falling back leaves the interval in charge.
      nudgeGcUnderPressure(t0 + 120_000, gc, 4000);
      expect(gc).toHaveBeenCalledTimes(2);
      nudgeGcUnderPressure(t0 + 60_000 + GC_NUDGE_EVERY_MS, gc, 4000);
      expect(gc).toHaveBeenCalledTimes(3);
    } finally { info.mockRestore(); }
  });

  it('the fast probe asks as soon as the footprint is GC_NUDGE_RISE_MB over its lowest reading since the last ask', () => {
    const info = vi.spyOn(log.obs, 'info').mockImplementation(() => {});
    const gc = vi.fn();
    try {
      const t0 = 9_200_000_000;
      expect(nudgeGcOnRise(t0, gc, 2500)).toBe(false);
      expect(nudgeGcOnRise(t0 + 2_000, gc, 2500 + GC_NUDGE_RISE_MB - 1)).toBe(false);
      // 4 s into a climb, long before the 30 s tick (2026-11-23: 5.9 to 7.2 GB in 4 s).
      expect(nudgeGcOnRise(t0 + 4_000, gc, 2500 + GC_NUDGE_RISE_MB)).toBe(true);
      expect(gc).toHaveBeenCalledWith(false);
      // Not again within GC_NUDGE_MIN_GAP_MS, however far it climbs.
      expect(nudgeGcOnRise(t0 + 6_000, gc, 6000)).toBe(false);
      // The rise is measured from the lowest reading since the ask: down to 3 GB, then up 1 GB.
      expect(nudgeGcOnRise(t0 + 16_000, gc, 3000)).toBe(false);
      expect(nudgeGcOnRise(t0 + 18_000, gc, 3000 + GC_NUDGE_RISE_MB)).toBe(true);
      expect(gc).toHaveBeenCalledTimes(2);
      // Under the floor nothing is asked, whatever the rise.
      _resetMemoryLedgerForTesting();
      expect(nudgeGcOnRise(t0 + 40_000, gc, 100)).toBe(false);
      expect(nudgeGcOnRise(t0 + 42_000, gc, GC_NUDGE_RSS_MB - 1)).toBe(false);
      // What an ask gave back is logged at the next ask's reading, marked as the probe's.
      expect(info).toHaveBeenCalledWith('memory gc nudge', expect.objectContaining({ beforeMb: 2500 + GC_NUDGE_RISE_MB, via: 'rise' }));
    } finally { info.mockRestore(); }
  });

  it('does nothing when turned off', () => {
    const gc = vi.fn();
    process.env.WALNUT_GC_NUDGE = '0';
    try { nudgeGcUnderPressure(1, gc, 99_999); } finally { delete process.env.WALNUT_GC_NUDGE; }
    expect(gc).not.toHaveBeenCalled();
  });
});

describe('watchMemoryBurst', () => {
  it('logs what was in flight once the footprint rises past BURST_RISE_MB within the window, then holds off', async () => {
    const warn = vi.spyOn(log.obs, 'warn').mockImplementation(() => {});
    const off = registerBurstContext('test-context', () => [{ route: 'GET /api/example', ageMs: 1200 }]);
    try {
      const t = 10_000_000;
      expect(await watchMemoryBurst(t, 2000)).toBe(false);
      expect(await watchMemoryBurst(t + 30_000, 2000 + BURST_RISE_MB - 1)).toBe(false);
      expect(await watchMemoryBurst(t + 60_000, 2000 + BURST_RISE_MB + 500)).toBe(true);
      const line = warn.mock.calls.find((c) => c[0] === 'memory burst');
      expect(line?.[1]).toMatchObject({ lowMb: 2000, riseMb: BURST_RISE_MB + 500, context: { 'test-context': [{ route: 'GET /api/example' }] } });
      // Inside BURST_EVERY_MS a climb of less than BURST_RISE_MB past the last line logs nothing...
      expect(await watchMemoryBurst(t + 90_000, 2000 + BURST_RISE_MB * 2)).toBe(false);
      // ...and a new peak BURST_RISE_MB past it is logged, marked as one (2026-11-23: the line at
      // 3.1 GB held off the climb to 12.8 GB, and the peak named nothing).
      warn.mockClear();
      expect(await watchMemoryBurst(t + 120_000, 2000 + BURST_RISE_MB * 3)).toBe(true);
      expect(warn.mock.calls.find((c) => c[0] === 'memory burst')?.[1]).toMatchObject({ newPeak: true, lowMb: 2000 });
      expect(await watchMemoryBurst(t + 150_000, 2000 + BURST_RISE_MB * 3 + 500)).toBe(false);
      // A rise against a low older than the window does not count.
      expect(await watchMemoryBurst(t + 150_000 + BURST_EVERY_MS + BURST_WINDOW_MS, 2000 + BURST_RISE_MB * 3)).toBe(false);
    } finally { off(); warn.mockRestore(); }
  });

  it.runIf(!!process.versions.bun)('a peak past BURST_HEAP_WALK_MB says what the heap holds by type, once an hour', async () => {
    const warn = vi.spyOn(log.obs, 'warn').mockImplementation(() => {});
    try {
      const t = 20_000_000;
      await watchMemoryBurst(t, 2000);
      expect(await watchMemoryBurst(t + 30_000, BURST_HEAP_WALK_MB)).toBe(true);
      const heap = (warn.mock.calls.find((c) => c[0] === 'memory burst')?.[1] as { heap?: { objects: number; topTypes: Array<[string, number]> } }).heap;
      expect(heap?.objects).toBeGreaterThan(0);
      expect(heap?.topTypes.length).toBeGreaterThan(0);
      warn.mockClear();
      expect(await watchMemoryBurst(t + 60_000, BURST_HEAP_WALK_MB + BURST_RISE_MB)).toBe(true);
      expect(warn.mock.calls.find((c) => c[0] === 'memory burst')?.[1]).not.toHaveProperty('heap');
      // Inside the hour, a peak twice the walked one walks again (2026-11-23: 6.7 GB, then 15.7 GB).
      warn.mockClear();
      expect(await watchMemoryBurst(t + 90_000, BURST_HEAP_WALK_MB * 2)).toBe(true);
      expect(warn.mock.calls.find((c) => c[0] === 'memory burst')?.[1]).toHaveProperty('heap');
    } finally { warn.mockRestore(); }
  });

  it('a context reader that throws is named, not fatal', async () => {
    const warn = vi.spyOn(log.obs, 'warn').mockImplementation(() => {});
    const off = registerBurstContext('broken', () => { throw new Error('mid-reset'); });
    try {
      await watchMemoryBurst(0, 1000);
      expect(await watchMemoryBurst(1, 1000 + BURST_RISE_MB)).toBe(true);
      expect(warn.mock.calls.find((c) => c[0] === 'memory burst')?.[1]).toMatchObject({ context: { broken: 'unreadable: mid-reset' } });
    } finally { off(); warn.mockRestore(); }
  });
});

describe('onMemoryBurst', () => {
  it('hears each logged burst with its footprint and rise', async () => {
    const warn = vi.spyOn(log.obs, 'warn').mockImplementation(() => {})
    const heard: Array<{ rssMb: number; riseMb: number }> = []
    const off = onMemoryBurst((b) => { heard.push(b) })
    try {
      const t0 = 3_000_000_000
      await watchMemoryBurst(t0, 1000)
      await watchMemoryBurst(t0 + 2000, 1000 + BURST_RISE_MB + 500)
      expect(heard).toEqual([{ rssMb: 1000 + BURST_RISE_MB + 500, riseMb: BURST_RISE_MB + 500 }])
    } finally { off(); warn.mockRestore() }
  })
})

describe('startMemoryBurstProbe', () => {
  // 2026-11-23 17:09: the footprint went 0.9 to 5.8 GB and back within 30 s; the 30 s health
  // tick logged 3.2 GB after the peak. The probe must log the climb while it happens.
  it('logs a jump within one probe interval of it, between health ticks', async () => {
    vi.useFakeTimers();
    const warn = vi.spyOn(log.obs, 'warn').mockImplementation(() => {});
    let rss = 900;
    const stop = startMemoryBurstProbe(BURST_PROBE_EVERY_MS, () => rss);
    try {
      await vi.advanceTimersByTimeAsync(BURST_PROBE_EVERY_MS * 3);
      expect(warn.mock.calls.some((c) => c[0] === 'memory burst')).toBe(false);
      rss = 900 + BURST_RISE_MB + 100;
      await vi.advanceTimersByTimeAsync(BURST_PROBE_EVERY_MS);
      const line = warn.mock.calls.find((c) => c[0] === 'memory burst');
      expect(line?.[1]).toMatchObject({ lowMb: 900, riseMb: BURST_RISE_MB + 100 });
    } finally { stop(); warn.mockRestore(); vi.useRealTimers(); }
  });

  it('stops when asked and stays off with WALNUT_MEMORY_PROBE=0', async () => {
    vi.useFakeTimers();
    const read = vi.fn(() => 900);
    try {
      const stop = startMemoryBurstProbe(BURST_PROBE_EVERY_MS, read);
      await vi.advanceTimersByTimeAsync(BURST_PROBE_EVERY_MS * 2);
      const n = read.mock.calls.length;
      expect(n).toBeGreaterThan(0);
      stop();
      await vi.advanceTimersByTimeAsync(BURST_PROBE_EVERY_MS * 5);
      expect(read.mock.calls.length).toBe(n);
      vi.stubEnv('WALNUT_MEMORY_PROBE', '0');
      startMemoryBurstProbe(BURST_PROBE_EVERY_MS, read)();
      await vi.advanceTimersByTimeAsync(BURST_PROBE_EVERY_MS * 5);
      expect(read.mock.calls.length).toBe(n);
    } finally { vi.unstubAllEnvs(); vi.useRealTimers(); }
  });
});

describe('writeHeapSnapshot', () => {
  it('writes the snapshot into the folder, then refuses another inside SNAPSHOT_EVERY_MS', async () => {
    const dir = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'heap-snap-'));
    const snap = vi.fn(() => '{"snapshot":{}}');
    const first = await writeHeapSnapshot(dir, 1_000_000, snap);
    expect(first.ok).toBe(true);
    if (first.ok) {
      expect(path.dirname(first.path)).toBe(dir);
      expect(fs.readFileSync(first.path, 'utf8')).toBe('{"snapshot":{}}');
    }
    const again = await writeHeapSnapshot(dir, 1_000_000 + SNAPSHOT_EVERY_MS - 1, snap);
    expect(again.ok).toBe(false);
    expect(snap).toHaveBeenCalledTimes(1);
    const later = await writeHeapSnapshot(dir, 1_000_000 + SNAPSHOT_EVERY_MS, snap);
    expect(later.ok).toBe(true);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('says so when the runtime has no snapshot', async () => {
    const r = await writeHeapSnapshot('/nonexistent', 0, null);
    expect(r).toEqual({ ok: false, reason: expect.stringContaining('cannot') });
  });
});

describe('stringCharsOf', () => {
  it('sums strings and keys through arrays and objects, bounded by depth', () => {
    expect(stringCharsOf([{ a: 'xyz', b: [{ c: 'q' }] }])).toBe(1 + 3 + 1 + 1 + 1);
    expect(stringCharsOf({ a: { b: { c: { d: { e: 'deep' } } } } }, 2)).toBe(2);
    expect(stringCharsOf(null)).toBe(0);
  });
});

describe('the caches that grow with the user\'s data are on the ledger', () => {
  it('registers each of them when its module loads', async () => {
    await Promise.all([
      import('../../../src/core/session-history.js'),
      import('../../../src/core/session-changes.js'),
      import('../../../src/providers/acp-session-history.js'),
      import('../../../src/core/org/threads-sync.js'),
      import('../../../src/core/session-tracker.js'),
      import('../../../src/core/task-manager.js'),
    ]);
    expect(memoryHolderNames()).toEqual(expect.arrayContaining([
      'session-history.parsed', 'session-changes.diffs', 'acp-history.folds', 'threads.texts',
      'session-tracker.store', 'task-manager.store',
    ]));
    // Raising a cache's cap past this total is a decision, made here, not a side effect.
    const total = readMemoryHolders().filter((r) => !r.name.startsWith('test.')).reduce((n, r) => n + r.budgetBytes, 0);
    expect(total / 1048576).toBeLessThanOrEqual(800);
  });
});

/**
 * Module-level caches found before the ledger existed, not on it yet (small or keyed by a
 * bounded set). A NEW one fails below: put it on the ledger (registerMemoryHolder with a
 * budget) or, if it truly cannot grow with the user's data, add it here with that reason.
 */
const NOT_ON_LEDGER: readonly string[] = [
  'src/core/agents/engine-probe.ts',
  'src/core/agents/host-engines.ts',
  'src/core/ai/ai-conversations.ts',
  'src/core/attachment-replica.ts',
  'src/core/changes/stage-detail.ts',
  'src/core/components/index.ts',
  'src/core/diff-summary.ts',
  'src/core/drawings/list.ts',
  'src/core/host-replica-extras.ts',
  'src/core/host-replica.ts',
  'src/core/hosts/fleet.ts',
  'src/core/hosts/placement.ts',
  'src/core/leader/switch/home-paths.ts', // compiled globs of the path-rule table: one per glob in the static rules
  'src/core/link-tags.ts',
  'src/core/memory-safety.ts',
  'src/core/mention-sources/run.ts',
  'src/core/org/reply-thread-index.ts',
  'src/core/peers/capability-router.ts',
  'src/core/plugins/plugin-web-module.ts',
  'src/core/private-tasks/private-words.ts',
  'src/core/replication/kinds/boards.ts',
  'src/core/replication/kinds/conversation-bodies.ts',
  'src/core/replication/kinds/inbox.ts',
  'src/core/session-git-status.ts',
  'src/core/sessions/acp-caller-sid.ts',
  'src/core/sessions/delivery-ledger.ts', // a session's task for a ledger step, at most 2,000 sessions, each kept 10 minutes
  'src/core/sessions/instruction-diff.ts',
  'src/core/sessions/op-call-log.ts',
  'src/core/sessions/session-extras.ts',
  'src/core/sessions/session-find.ts',
  'src/core/sessions/session-record-recovery.ts',
  'src/core/ssh-config-scanner.ts',
  'src/core/task-search-agent.ts',
  'src/integrations/microsoft-todo.ts',
  'src/lib/hybrid-search/query.ts',
  'src/lib/linear-regex/unicode-property.ts',
  // One compiled statement per connection and fixed SQL text (no text is built from data), dropped with its connection.
  'src/lib/sqlite-prepared.ts',
  'src/model/providers/registry.ts',
  'src/providers/codex-endpoint-models.ts',
  'src/providers/daemon-connection.ts',
  'src/providers/desktop-app.ts',
  'src/providers/engine-model-probe.ts',
  'src/providers/session-cost-core.ts',
  'src/web/routes/chat-history.ts',
  'src/web/routes/org-avatars-v1.ts',
  'src/web/terminal/dtach-provision.ts',
  'src/web/ws/bridge-read-history.ts',
];

describe('ratchet: a new module-level cache goes on the ledger', () => {
  it('finds no unregistered cache outside the known list, and the list has no stale entry', () => {
    const decl = /^(const|let) [A-Za-z0-9_]*[Cc]ache[A-Za-z0-9_]*( *: *[^=]+)? *= *new (Map|Set|WeakMap)/m;
    const found: string[] = [];
    const walk = (dir: string): void => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) { walk(p); continue; }
        if (!/\.tsx?$/.test(e.name) || /\.test\./.test(e.name)) continue;
        const rel = path.relative(ROOT, p).split(path.sep).join('/');
        // The daemon runs in another process; its caches are the daemon's own.
        if (rel === 'src/providers/daemon-standalone.ts') continue;
        const text = fs.readFileSync(p, 'utf8');
        if (decl.test(text) && !text.includes('registerMemoryHolder(')) found.push(rel);
      }
    };
    walk(path.join(ROOT, 'src'));
    const known = new Set(NOT_ON_LEDGER);
    expect(found.filter((f) => !known.has(f)), 'new cache modules not on the memory ledger').toEqual([]);
    expect(NOT_ON_LEDGER.filter((f) => !found.includes(f)), 'stale entries: remove them from NOT_ON_LEDGER').toEqual([]);
  });
});
