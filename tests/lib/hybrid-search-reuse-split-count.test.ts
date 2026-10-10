/**
 * How often a real index splits a doc (passagesForDoc) around a change: the
 * backfill splits it once to embed it and keeps the keys, so the doc's next
 * change splits only its new text (vector-reuse.ts). The r1 gate measured the
 * reuse splitting both texts inside the upsert transaction, on the host thread.
 * passagesForDoc is wrapped (not replaced) through a module mock to count calls.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';

const calls = vi.hoisted(() => ({ n: 0 }));
vi.mock('../../src/lib/hybrid-search/chunk.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../src/lib/hybrid-search/chunk.js')>();
  return {
    ...real,
    passagesForDoc: (...args: Parameters<typeof real.passagesForDoc>) => { calls.n++; return real.passagesForDoc(...args); },
  };
});

const { drainBackfill, expectedRows, makeTempDir, openTextIndex, paragraphs, passagesOfDoc, vecRows } =
  await import('./text-embed-index.js');

const dirs: string[] = [];
const closers: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const c of closers.splice(0)) await c();
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

describe('a doc the backfill embedded', () => {
  it('splits once at its next change', async () => {
    const dir = makeTempDir('wn-split-count-');
    dirs.push(dir);
    const h = openTextIndex(dir);
    closers.push(() => h.close());
    const v1 = { kind: 'session', ref: 's', title: 'session', note: paragraphs('s', 6), updatedAt: 1 };
    const { docId } = h.index.upsert(v1);
    await drainBackfill(h.index);
    expect(vecRows(h.index, docId)).toEqual(expectedRows(passagesOfDoc(v1)));

    const before = calls.n;
    const v2 = { ...v1, note: `${v1.note}\n\n${paragraphs('t', 1)}`, updatedAt: 2 };
    const r = h.index.upsert(v2);
    // passagesOfDoc above runs through the mock too: count only the upsert.
    expect(calls.n - before).toBe(1);
    expect(r.reusedVectors).toBe(passagesOfDoc(v1).length - 1);
  });
});
