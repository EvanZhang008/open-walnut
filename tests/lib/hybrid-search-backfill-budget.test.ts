/**
 * A backfill call stops when its time budget is spent (BackfillVectorsOptions
 * .budgetMs), between two passages, keeping what it embedded.
 *
 * 2026-10-05: one batch of 16 whale sessions (up to 40 passages each) ran for
 * about 110 minutes on a loaded machine, and the wiring's load-aware pause only
 * runs between batches. The worker fixture here takes holdMs per passage,
 * standing in for slow inference; the budget is a clock read between awaits,
 * and the inference stays in the worker process.
 */
import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import {
  expectedRows, makeTempDir, openTextIndex, paragraphs, passagesOfDoc, vecRows, type TextIndexHandle, type TextKnobs,
} from './text-embed-index.js';

const dirs: string[] = [];
const handles: TextIndexHandle[] = [];
function open(holdMs: number, knobs: TextKnobs = {}): TextIndexHandle {
  const dir = makeTempDir('wn-vec-budget-');
  dirs.push(dir);
  const h = openTextIndex(dir, { holdMs, ...knobs });
  handles.push(h);
  return h;
}
afterEach(async () => {
  for (const h of handles.splice(0)) await h.close();
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

describe('backfill batch budget', () => {
  it('a batch of whales yields between passages and resumes without re-embedding', async () => {
    const h = open(30);
    const docs = [0, 1, 2].map((i) => ({
      kind: 'session', ref: `whale-${i}`, title: `long session ${i}`, note: paragraphs(`s${i}`, 8), updatedAt: 10 - i,
    }));
    const ids = docs.map((d) => h.index.upsert(d).docId);
    const total = docs.reduce((n, d) => n + passagesOfDoc(d).length, 0);

    const first = await h.index.backfillVectors({ batchDocs: 16, budgetMs: 100 });
    expect(first.yielded).toBe('budget');
    expect(first.drained).toBe(false);
    expect(first.cursor).toBeNull(); // the incoming cursor: the window is listed again
    expect(first.docs).toBe(3);
    expect(first.passages).toBeGreaterThanOrEqual(1);
    expect(first.passages).toBeLessThan(total);
    // What the call embedded is kept (cover seqs, seq 0 only once complete).
    const keptAfterFirst = ids.reduce((n, id) => n + vecRows(h.index, id).length, 0);
    expect(keptAfterFirst).toBe(first.passages);

    let calls = 1;
    let r = first;
    while (!r.drained && calls < 500) {
      r = await h.index.backfillVectors({ batchDocs: 16, budgetMs: 100, cursor: r.cursor });
      calls++;
    }
    expect(r.drained).toBe(true);
    expect(calls).toBeGreaterThan(2);
    // Every passage embedded exactly once across all the yields.
    expect(h.embedded()).toHaveLength(total);
    expect(new Set(h.embedded()).size).toBe(total);
    docs.forEach((d, i) => expect(vecRows(h.index, ids[i]!)).toEqual(expectedRows(passagesOfDoc(d))));
  });

  it('single-passage docs yield between docs', async () => {
    const h = open(40);
    for (let i = 0; i < 6; i++) {
      h.index.upsert({ kind: 'note', ref: `n${i}`, title: `note ${i}`, note: `short body ${i}`, updatedAt: 10 - i });
    }
    const first = await h.index.backfillVectors({ batchDocs: 16, budgetMs: 60 });
    expect(first.yielded).toBe('budget');
    expect(first.embedded).toBeGreaterThanOrEqual(1);
    expect(first.embedded).toBeLessThan(6);
    expect(first.embedded).toBe(first.passages);
  });

  it('always moves forward: a zero budget still embeds one passage per call', async () => {
    const h = open(0);
    const doc = { kind: 'task', ref: 't', title: 'task', note: paragraphs('t', 4), updatedAt: 1 };
    const { docId } = h.index.upsert(doc);
    const n = passagesOfDoc(doc).length;
    let calls = 0;
    let r = await h.index.backfillVectors({ budgetMs: 0 });
    calls++;
    while (!r.drained && calls < 100) {
      expect(r.passages).toBe(1);
      r = await h.index.backfillVectors({ budgetMs: 0, cursor: r.cursor });
      calls++;
    }
    expect(r.drained).toBe(true);
    expect(calls).toBeGreaterThanOrEqual(n);
    expect(vecRows(h.index, docId)).toEqual(expectedRows(passagesOfDoc(doc)));
  });

  it('a batch whose docs all fail still stops at the budget', async () => {
    // The r1 gate: the budget counted only embedded passages, so 16 docs whose
    // passage failed twice each (two probes of 100 ms per doc) ran 2.5 to 2.8 s
    // past a 200 ms budget. It counts every passage tried now.
    const h = open(100, { errorOn: 'POISON' });
    for (let i = 0; i < 6; i++) {
      h.index.upsert({ kind: 'note', ref: `bad-${i}`, title: `note ${i}`, note: `POISON body ${i}`, updatedAt: 10 - i });
    }
    const zeros = () => (h.index.db.prepare(
      'SELECT COUNT(*) AS n FROM doc_vec WHERE seq = 0 AND vec = zeroblob(length(vec))',
    ).get() as { n: number }).n;
    const first = await h.index.backfillVectors({ batchDocs: 16, budgetMs: 150 });
    expect(first.yielded).toBe('budget');
    expect(first.passages).toBe(0);
    expect(zeros()).toBe(1); // one doc judged (two attempts, two probes), then the yield
    expect(h.embedded()).toHaveLength(2); // the two probes
    // The next call goes on with the rest, one judged doc per call.
    const second = await h.index.backfillVectors({ batchDocs: 16, budgetMs: 150, cursor: first.cursor });
    expect(second.yielded).toBe('budget');
    expect(zeros()).toBe(2);
  });

  it('no budget: the batch runs to its end, as before', async () => {
    const h = open(0);
    for (let i = 0; i < 3; i++) {
      h.index.upsert({ kind: 'task', ref: `t${i}`, title: `t${i}`, note: paragraphs(`b${i}`, 3), updatedAt: 5 - i });
    }
    const r = await h.index.backfillVectors({ batchDocs: 16 });
    expect(r.yielded).toBeUndefined();
    expect(r.embedded).toBe(3);
    expect(r.drained).toBe(true);
  });
});
