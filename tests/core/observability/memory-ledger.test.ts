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
  memoryHolderNames, SAMPLE_EVERY_MS, sampledStringChars, nudgeGcUnderPressure, GC_NUDGE_RSS_MB, GC_NUDGE_EVERY_MS, _resetMemoryLedgerForTesting,
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

  it('does nothing when turned off', () => {
    const gc = vi.fn();
    process.env.WALNUT_GC_NUDGE = '0';
    try { nudgeGcUnderPressure(1, gc, 99_999); } finally { delete process.env.WALNUT_GC_NUDGE; }
    expect(gc).not.toHaveBeenCalled();
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
  'src/model/providers/registry.ts',
  'src/providers/codex-endpoint-models.ts',
  'src/providers/daemon-connection.ts',
  'src/providers/desktop-app.ts',
  'src/providers/engine-model-probe.ts',
  'src/providers/session-cost-core.ts',
  'src/web/routes/chat-history.ts',
  'src/web/routes/org-avatars-v1.ts',
  'src/web/routes/slash-commands.ts',
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
        // The daemon twins run in another process; their caches are the daemon's own.
        if (rel === 'src/providers/daemon-source.ts' || rel === 'src/providers/daemon-standalone.ts') continue;
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
