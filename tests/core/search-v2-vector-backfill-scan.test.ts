/**
 * Ratchet for the COST of the vector backfill's walk, not its output.
 *
 * The backfill used to ask "which docs have no vectors yet?" with a full
 * anti-join scan of `doc` on every batch. On the real index (11,894 docs,
 * 11,889 of them already vectorized, a 493MB file) that measured 590-1006 ms of
 * BLOCKED event loop per call — twice per cycle, every cycle, growing with the
 * doc count — and every HTTP request that landed inside one waited behind it.
 *
 * The fix has two halves, and both are asserted here because either one alone
 * regresses quietly:
 *   - a floor from the last drained pass, so the steady-state question is a
 *     range seek over the tail of doc_updated_id instead of a table sweep;
 *   - a scan budget per call, so even the periodic full self-heal pass never
 *     becomes one long synchronous statement.
 *
 * Correctness is asserted beside the cost: a doc that genuinely lacks vectors
 * must still get embedded without a restart, including when nothing but the
 * hourly full pass can notice it.
 *
 * Everything runs against a throwaway index under the OS temp dir — never the
 * real search.sqlite.
 */
import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  createSearchIndex,
  MISSING_VEC_SCAN_LIMIT,
  type MissingVecCursor,
  type SearchIndex,
} from '../../src/lib/hybrid-search/index.js';
import { createWriter } from '../../src/lib/hybrid-search/writer.js';
import { createVectorPassPlanner, type VectorPassPlanner } from '../../src/core/search/wiring.js';

const KINDS = {
  task: { weight: 1.0 },
  note: { weight: 1.0 },
  session: { weight: 0.9, chunkVectors: true },
};

/** Deterministic stand-in for the embed worker (shared with the lib tests). */
const FAKE_EMBEDDER = {
  modelId: 'fake/unit-x',
  dims: 4,
  workerPath: new URL('../lib/fixtures/fake-embed-worker.cjs', import.meta.url).pathname,
};

/** Chunked kinds go second, exactly as the wiring orders them. */
const CHUNKED_KINDS = ['session'];

const temps: string[] = [];
const opened: SearchIndex[] = [];

function openTempIndex(): SearchIndex {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wn-vecscan-'));
  temps.push(dir);
  const index = createSearchIndex({
    dbPath: path.join(dir, 'search.sqlite'),
    kinds: KINDS,
    embedder: FAKE_EMBEDDER,
  });
  opened.push(index);
  return index;
}

afterEach(() => {
  for (const index of opened) {
    try { index.close(); } catch { /* already closed */ }
  }
  opened.length = 0;
  for (const dir of temps) fs.rmSync(dir, { recursive: true, force: true });
  temps.length = 0;
});

interface PassStats {
  /** Docs embedded across both phases. */
  embedded: number;
  /** Doc rows the walk examined across both phases. */
  scanned: number;
  /** backfillVectors calls the pass took. */
  calls: number;
  /** Widest single call — the length of one blocked stretch. */
  widestCall: number;
  /** True when the planner made this a full self-heal walk. */
  full: boolean;
}

/**
 * One backfill pass, driven exactly like startSearchV2Wiring's timer loop:
 * light kinds first, then everything, one shared floor, planner told how it went.
 */
async function runPass(
  index: SearchIndex,
  planner: VectorPassPlanner,
  scanLimit = MISSING_VEC_SCAN_LIMIT,
): Promise<PassStats> {
  const floor = planner.beginPass();
  let cursor: MissingVecCursor | null = null;
  let phase: 'light' | 'all' = 'light';
  const stats: PassStats = { embedded: 0, scanned: 0, calls: 0, widestCall: 0, full: floor === null };
  for (let guard = 0; guard < 10_000; guard++) {
    const result = await index.backfillVectors({
      batchDocs: 16,
      cursor,
      excludeKinds: phase === 'light' ? CHUNKED_KINDS : undefined,
      minUpdatedAt: floor ?? undefined,
      scanLimit,
    });
    stats.calls++;
    stats.embedded += result.embedded;
    stats.scanned += result.scanned ?? 0;
    stats.widestCall = Math.max(stats.widestCall, result.scanned ?? 0);
    cursor = result.cursor;
    if (!result.drained) continue;
    if (phase === 'light') {
      phase = 'all';
      cursor = null;
      continue;
    }
    planner.passDrained();
    return stats;
  }
  throw new Error('pass never drained');
}

function vecCount(index: SearchIndex, docId: number): number {
  return (index.db.prepare('SELECT COUNT(*) AS n FROM doc_vec WHERE doc_id = ?')
    .get(docId) as { n: number }).n;
}

/** Docs old enough that the steady-state floor sits above all of them. */
function seedVectorizedDocs(index: SearchIndex, count: number, base: number): number[] {
  const writer = createWriter(index.db);
  const ids: number[] = [];
  for (let i = 0; i < count; i++) {
    const { docId } = index.upsert({
      kind: i % 5 === 0 ? 'session' : 'note',
      ref: `seed-${i}`,
      title: `seeded doc ${i}`,
      note: `body of seeded doc ${i}`,
      updatedAt: base - i * 60_000,
    });
    writer.writeVectors(docId, [new Int8Array(4).fill(1)]);
    ids.push(docId);
  }
  return ids;
}

describe('vector backfill walk cost', () => {
  it('a drained pass makes the next one a range seek, not a table sweep', async () => {
    // 600 docs = more than two scan windows, so a table sweep is unmistakable.
    const index = openTempIndex();
    const base = Date.now() - 24 * 3_600_000;
    seedVectorizedDocs(index, 600, base);
    const planner = createVectorPassPlanner();

    // Pass 1 has no earned floor, so it walks everything (both phases scan the
    // whole table: `kind` is filtered in JS on purpose, see writer.ts).
    const first = await runPass(index, planner);
    expect(first.full).toBe(true);
    expect(first.scanned).toBe(1200);
    expect(first.embedded).toBe(0);

    // Pass 2 rides the floor pass 1 earned. THIS is the regression guard: the
    // old anti-join query would examine all 600 rows again, per phase.
    const second = await runPass(index, planner);
    expect(second.full).toBe(false);
    expect(second.scanned).toBe(0);
    expect(second.calls).toBe(2); // one drain per phase, nothing in between
  });

  it('no single call examines more than the scan budget', async () => {
    const index = openTempIndex();
    seedVectorizedDocs(index, 600, Date.now() - 24 * 3_600_000);
    const planner = createVectorPassPlanner();

    const full = await runPass(index, planner, 128);
    expect(full.widestCall).toBeLessThanOrEqual(128);
    // Bounded steps mean MANY of them: 600 docs / 128 per window, twice.
    expect(full.calls).toBeGreaterThanOrEqual(2 * Math.ceil(600 / 128));
  });

  it('the walk prepares no unbounded anti-join over doc', () => {
    const index = openTempIndex();
    seedVectorizedDocs(index, 5, Date.now() - 24 * 3_600_000);
    const prepared: string[] = [];
    const spied = index.db as unknown as { prepare: (sql: string) => unknown };
    const real = spied.prepare.bind(index.db);
    spied.prepare = (sql: string) => { prepared.push(sql); return real(sql); };
    try {
      createWriter(index.db).listDocsMissingVectors(16, null, CHUNKED_KINDS);
    } finally {
      spied.prepare = real;
    }
    // The old shape: `FROM doc d WHERE NOT EXISTS (SELECT 1 FROM doc_vec …)`.
    expect(prepared.filter((sql) => /NOT EXISTS/i.test(sql) && /doc_vec/.test(sql))).toEqual([]);
    // The new shape: a floor-bounded, LIMIT-bounded slice of the walk index.
    expect(prepared.some((sql) => /FROM doc\b/.test(sql)
      && /updated_at >= \?/.test(sql) && /LIMIT \?/.test(sql))).toBe(true);
  });
});

describe('vector backfill correctness', () => {
  it('embeds a doc that has no vectors', async () => {
    const index = openTempIndex();
    const planner = createVectorPassPlanner();
    const { docId } = index.upsert({
      kind: 'note', ref: 'fresh', title: 'never embedded', note: 'body', updatedAt: Date.now(),
    });
    expect(vecCount(index, docId)).toBe(0);
    const pass = await runPass(index, planner);
    expect(pass.embedded).toBe(1);
    expect(vecCount(index, docId)).toBe(1);
  });

  it('a doc that loses its vectors after a drain is picked up by the next pass', async () => {
    const index = openTempIndex();
    const base = Date.now() - 24 * 3_600_000;
    seedVectorizedDocs(index, 40, base);
    const planner = createVectorPassPlanner();
    await runPass(index, planner); // arm the floor

    // Content change → upsert drops the vectors AND bumps updated_at to now.
    index.upsert({
      kind: 'note', ref: 'seed-7', title: 'seeded doc 7', note: 'rewritten body',
      updatedAt: Date.now(),
    });
    const recent = index.db.prepare('SELECT id FROM doc WHERE kind = ? AND ref = ?')
      .get('note', 'seed-7') as { id: number };
    expect(vecCount(index, recent.id)).toBe(0);
    planner.observeUpsert(Date.now());

    const afterRecent = await runPass(index, planner);
    expect(afterRecent.full).toBe(false); // still the cheap incremental walk
    expect(afterRecent.embedded).toBe(1);
    expect(vecCount(index, recent.id)).toBe(1);
  });

  it('an upsert whose timestamp predates the floor still gets reached', async () => {
    // A restored/synced file arrives with an OLD mtime, so wall-clock alone
    // would step over it. observeUpsert makes the floor follow the doc.
    const index = openTempIndex();
    const base = Date.now() - 24 * 3_600_000;
    seedVectorizedDocs(index, 40, base);
    const planner = createVectorPassPlanner();
    await runPass(index, planner);

    const staleTs = base - 500 * 60_000; // older than every seeded doc
    index.upsert({
      kind: 'note', ref: 'restored', title: 'restored from a backup', note: 'old body',
      updatedAt: staleTs,
    });
    planner.observeUpsert(staleTs);
    const restored = index.db.prepare('SELECT id FROM doc WHERE kind = ? AND ref = ?')
      .get('note', 'restored') as { id: number };

    const pass = await runPass(index, planner);
    expect(pass.full).toBe(false);
    expect(pass.embedded).toBe(1);
    expect(vecCount(index, restored.id)).toBe(1);
  });

  it('the periodic full pass still self-heals vectors that vanished silently', async () => {
    // The paths that clear doc_vec WITHOUT moving updated_at: an embed-model
    // swap at open, rebuildAll re-feeding docs with their original timestamps,
    // another process rebuilding the file. Only a full walk can see those.
    const index = openTempIndex();
    const base = Date.now() - 24 * 3_600_000;
    const ids = seedVectorizedDocs(index, 40, base);
    let clock = Date.now();
    const FULL_PASS_INTERVAL = 60 * 60_000;
    const planner = createVectorPassPlanner(() => clock, FULL_PASS_INTERVAL);
    await runPass(index, planner);

    const victim = ids[31]; // a single-vector 'note', so the count below is exact
    index.db.prepare('DELETE FROM doc_vec WHERE doc_id = ?').run(victim);
    expect(vecCount(index, victim)).toBe(0);

    // Ten minutes on: the incremental pass is cheap and blind to it.
    clock += 10 * 60_000;
    const blind = await runPass(index, planner);
    expect(blind.full).toBe(false);
    expect(blind.embedded).toBe(0);
    expect(vecCount(index, victim)).toBe(0);

    // An hour on: the self-heal walk runs and re-embeds it, no restart needed.
    clock += FULL_PASS_INTERVAL;
    const healed = await runPass(index, planner);
    expect(healed.full).toBe(true);
    expect(healed.scanned).toBe(80); // both phases walked all 40 docs
    expect(healed.embedded).toBe(1);
    expect(vecCount(index, victim)).toBe(1);
  });

  it('a rebuild forces the next pass to walk everything', async () => {
    const index = openTempIndex();
    const base = Date.now() - 24 * 3_600_000;
    seedVectorizedDocs(index, 30, base);
    const planner = createVectorPassPlanner();
    await runPass(index, planner);

    // rebuildAll's shape: every vector gone, every doc back with its own old
    // timestamp. requireFullPass() is what stops the floor from skipping them.
    index.db.prepare('DELETE FROM doc_vec').run();
    planner.requireFullPass();

    const pass = await runPass(index, planner);
    expect(pass.full).toBe(true);
    expect(pass.embedded).toBe(30);
  });
});

describe('createVectorPassPlanner', () => {
  it('only a drained pass earns a floor; an aborted one is retried at the old one', () => {
    let clock = 1_800_000_000_000;
    const planner = createVectorPassPlanner(() => clock, 60 * 60_000);
    expect(planner.beginPass()).toBeNull(); // nothing verified yet
    planner.passDrained();

    clock += 10 * 60_000;
    const armed = planner.beginPass();
    expect(armed).not.toBeNull();
    planner.passAborted();

    // The retry may not start any higher than the pass that failed.
    clock += 60_000;
    const retry = planner.beginPass();
    expect(retry).toBe(armed);
  });

  it('an upsert seen mid-pass counts for the NEXT pass, not the one walking', () => {
    let clock = 1_800_000_000_000;
    const planner = createVectorPassPlanner(() => clock, 60 * 60_000);
    planner.beginPass();
    planner.passDrained();

    clock += 10 * 60_000;
    planner.beginPass();          // pass 2 starts…
    planner.observeUpsert(1_000); // …and a very old doc lands while it walks
    planner.passDrained();        // pass 2 drains without having seen it

    clock += 10 * 60_000;
    expect(planner.beginPass()).toBe(1_000); // pass 3 reaches back for it
  });

  it('a rebuild mid-pass keeps that pass from arming a floor', () => {
    let clock = 1_800_000_000_000;
    const planner = createVectorPassPlanner(() => clock, 60 * 60_000);
    planner.beginPass();
    planner.passDrained();

    clock += 10 * 60_000;
    planner.beginPass();
    planner.requireFullPass(); // the index was rebuilt under this walk
    planner.passDrained();     // its verdict describes a state that is gone

    clock += 10 * 60_000;
    expect(planner.beginPass()).toBeNull();
  });

  it('goes full again once the self-heal interval elapses, not before', () => {
    let clock = 1_800_000_000_000;
    const planner = createVectorPassPlanner(() => clock, 60 * 60_000);
    planner.beginPass();
    planner.passDrained();
    for (let i = 0; i < 5; i++) {
      clock += 10 * 60_000;
      expect(planner.beginPass()).not.toBeNull();
      planner.passDrained();
    }
    clock += 10 * 60_000;
    expect(planner.beginPass()).toBeNull();
  });
});
