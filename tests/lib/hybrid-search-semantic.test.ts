/**
 * Semantic-layer logic tests — everything EXCEPT real model inference (that
 * runs in the golden eval): chunking, int8 cosine, vector storage/self-heal,
 * and searchSemantic's degrade ladder (disabled → timeout → keyword order).
 */
import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  createSearchIndex,
  cosineInt8,
  passagesForDoc,
} from '../../src/lib/hybrid-search/index.js';
import {
  MAX_CHUNKS_PER_DOC,
  PASSAGE_MAX_CHARS,
  PASSAGE_TOKEN_BUDGET,
  SEQ0_LEAD_SHARE,
  estimateTokens,
  splitToBudget,
} from '../../src/lib/hybrid-search/chunk.js';

const KINDS = {
  task: { weight: 1.0 },
  session: { weight: 0.9, passages: { overflow: 'tail' as const } },
};

/** Non-whitespace characters, the unit the COVER invariant is stated in. */
const dense = (s: string): string => s.replace(/\s+/g, '');

describe('passagesForDoc', () => {
  it('collapses a doc that fits one budget into a single passage', () => {
    // coverFrom 0 means passages[0] IS the cover, so no near-duplicate vector
    // is stored. Most docs in a real index take this path.
    const r = passagesForDoc({ title: 'T', summary: 'S', note: 'short note' });
    expect(r.passages).toHaveLength(1);
    expect(r.coverFrom).toBe(0);
    expect(r.droppedChars).toBe(0);
    expect(dense(r.passages[0])).toBe(dense('TSshort note'));
  });

  it('seq 0 is a digest that carries BODY text, not just title+summary', () => {
    // RECALL invariant: the semantic recall lane reads only seq 0, so a head-only
    // seq 0 would make a long doc undiscoverable by paraphrase.
    const r = passagesForDoc({
      title: 'Head',
      summary: 'Summary',
      note: `BODYLEAD ${'word '.repeat(2000)}`,
    });
    expect(r.coverFrom).toBe(1);
    expect(r.passages[0].startsWith('Head\nSummary')).toBe(true);
    expect(r.passages[0]).toContain('BODYLEAD');
    expect(estimateTokens(r.passages[0])).toBeLessThanOrEqual(PASSAGE_TOKEN_BUDGET);
  });

  it('an oversized head cannot crowd the body out of seq 0', () => {
    // A real task title+summary reached 14,390 chars. Clipping the head in the
    // digest is what stops the original bug reappearing one field over.
    const summary = 'S'.repeat(14_290);
    const r = passagesForDoc({ title: 'T'.repeat(100), summary, note: `NOTESTART ${'b '.repeat(3000)}` });
    expect(r.passages[0]).toContain('NOTESTART');
    const leadTokens = estimateTokens(r.passages[0].slice(r.passages[0].indexOf('NOTESTART')));
    expect(leadTokens).toBeGreaterThan(PASSAGE_TOKEN_BUDGET * SEQ0_LEAD_SHARE * 0.5);
    // The clipped remainder of the summary is still covered by seq >= 1.
    expect(dense(r.passages.slice(1).join('')).includes(dense(summary))).toBe(true);
    expect(r.droppedChars).toBe(0);
  });

  it('covers every character of the body when inside the cap', () => {
    const para = 'word '.repeat(100).trim();
    const doc = { title: 'Head', summary: 'Sum', note: Array(5).fill(para).join('\n\n') };
    const r = passagesForDoc(doc);
    expect(r.droppedChars).toBe(0);
    expect(dense(r.passages.slice(r.coverFrom).join('')))
      .toBe(dense(doc.title + doc.summary + doc.note));
  });

  it('hard-splits an unbroken wall and respects the per-doc cap', () => {
    const r = passagesForDoc({
      title: 'W',
      note: 'x'.repeat(PASSAGE_MAX_CHARS * (MAX_CHUNKS_PER_DOC + 10)),
    });
    expect(r.passages.length).toBe(MAX_CHUNKS_PER_DOC);
    // Over the cap text IS lost — but it comes back as a number rather than
    // disappearing, which is the whole point of droppedChars.
    expect(r.droppedChars).toBeGreaterThan(0);
  });

  it('empty doc yields no passages', () => {
    const r = passagesForDoc({ title: '', note: '' });
    expect(r.passages).toEqual([]);
    expect(r.droppedChars).toBe(0);
  });

  // Paragraphs comfortably under one budget, so they accumulate the way a real
  // structured note does. Enough of them to blow the per-doc cap several times.
  const MARKED_PARAS = 200;
  const markedNote = (): string => Array.from(
    { length: MARKED_PARAS },
    (_, i) => `marker-${i} ${'word '.repeat(120)}`,
  ).join('\n\n');

  it('overflow "tail" keeps the newest chunks (chronological bodies)', () => {
    const r = passagesForDoc({ title: 'Head', note: markedNote() }, { overflow: 'tail' });
    expect(r.passages.length).toBe(MAX_CHUNKS_PER_DOC);
    expect(r.passages[0].startsWith('Head')).toBe(true);
    const body = r.passages.slice(1).join('\n');
    expect(body).not.toContain('marker-0 ');
    expect(body).toContain(`marker-${MARKED_PARAS - 1} `);
    expect(r.droppedChars).toBeGreaterThan(0);
  });

  it('overflow "spread" keeps BOTH ends (structured bodies)', () => {
    // A task note is goal-at-the-top plus log-at-the-bottom, so a tail-only cap
    // would drop the plan — the half a "what was this task about" query needs.
    const r = passagesForDoc({ title: 'Head', note: markedNote() }, { overflow: 'spread' });
    expect(r.passages.length).toBe(MAX_CHUNKS_PER_DOC);
    const body = r.passages.slice(1).join('\n');
    expect(body).toContain('marker-0 ');
    expect(body).toContain(`marker-${MARKED_PARAS - 1} `);
    // And it samples across the middle rather than clustering at one end.
    const kept = [...body.matchAll(/marker-(\d+) /g)].map((m) => Number(m[1]));
    expect(Math.max(...kept) - Math.min(...kept)).toBeGreaterThan(MARKED_PARAS * 0.8);
  });

  it('budgets CJK by TOKENS, so a Chinese body is not silently halved', () => {
    // CJK is ~1 token per char against the tokenizer's 512 cap, so the old
    // 1400-char chunk lost ~63% of its content INSIDE the embedder, and the
    // last-token pooling made the resulting vector describe only the prefix.
    const note = `${'\u8fd9\u662f\u4e00\u6bb5\u4e2d\u6587\u6b63\u6587\u5185\u5bb9\u3002'.repeat(60)}\n\n`.repeat(10);
    const r = passagesForDoc({ title: '\u6807\u9898', note });
    for (const passage of r.passages) {
      expect(estimateTokens(passage)).toBeLessThanOrEqual(PASSAGE_TOKEN_BUDGET);
      expect(passage.length).toBeLessThanOrEqual(PASSAGE_MAX_CHARS);
    }
    // Chinese chunks land near the token budget in CHARS, well under 1400.
    const coverLens = r.passages.slice(1).map((p) => p.length);
    expect(Math.max(...coverLens)).toBeLessThan(PASSAGE_MAX_CHARS * 0.6);
    expect(r.droppedChars).toBe(0);
  });

  it('property: no character of the body is unreachable, and every passage fits both caps', () => {
    // The invariant the whole change exists to establish. Fuzzed across scripts,
    // paragraph shapes and the degenerate cases that broke the old chunker.
    let seed = 12345;
    const rnd = (n: number): number => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return seed % n;
    };
    const pieces = ['word ', '\u4e2d\u6587\u5b57 ', 'CamelCaseToken ', 'x', '\u3042\u304b ', '-_. '];
    for (let i = 0; i < 200; i++) {
      const paraCount = rnd(8) + 1;
      const paras: string[] = [];
      for (let j = 0; j < paraCount; j++) {
        let para = '';
        const len = rnd(2500) + 1;
        while (para.length < len) para += pieces[rnd(pieces.length)];
        paras.push(para);
      }
      if (rnd(5) === 0) paras.push('y'.repeat(3000));       // unbroken wall
      const note = paras.join(rnd(2) === 0 ? '\n\n' : '\n\n\n\n\n');
      const doc = {
        title: rnd(4) === 0 ? '' : 'T'.repeat(rnd(120) + 1),
        summary: rnd(3) === 0 ? '' : 'S'.repeat(rnd(1500)),
        note: rnd(6) === 0 ? '' : note,
      };
      const r = passagesForDoc(doc, { overflow: rnd(2) === 0 ? 'tail' : 'spread' });
      for (const passage of r.passages) {
        expect(estimateTokens(passage)).toBeLessThanOrEqual(PASSAGE_TOKEN_BUDGET);
        expect(passage.length).toBeLessThanOrEqual(PASSAGE_MAX_CHARS);
      }
      const want = dense(doc.title + doc.summary + doc.note);
      const got = dense(r.passages.slice(r.coverFrom).join(''));
      if (r.droppedChars === 0) {
        expect(got).toBe(want);
      } else {
        // Only the cap may drop text, and it must account for every character.
        expect(got.length + r.droppedChars).toBe(want.length);
        const chunks = splitToBudget([doc.title, doc.summary, doc.note].filter((x) => x).join('\n\n'));
        expect(chunks.length + 1).toBeGreaterThan(MAX_CHUNKS_PER_DOC);
      }
    }
  });
});

describe('cosineInt8', () => {
  it('is 1 for identical vectors, -1 for opposite, 0 for orthogonal/zero', () => {
    const a = new Int8Array([100, 50, -30]);
    const neg = new Int8Array([-100, -50, 30]);
    expect(cosineInt8(a, a)).toBeCloseTo(1, 6);
    expect(cosineInt8(a, neg)).toBeCloseTo(-1, 6);
    expect(cosineInt8(new Int8Array([127, 0]), new Int8Array([0, 127]))).toBe(0);
    expect(cosineInt8(a, new Int8Array(3))).toBe(0);
  });
});

describe('vector storage', () => {
  it('writeVectors + listDocsMissingVectors + upsert self-heal', () => {
    const index = createSearchIndex({ dbPath: ':memory:', kinds: KINDS });
    const { docId } = index.upsert({
      kind: 'task', ref: 't1', title: 'Alpha work', note: 'body', updatedAt: 1,
    });
    const w = indexWriterView(index);
    expect(w.listDocsMissingVectors(10).docs.map((d) => d.id)).toContain(docId);

    w.writeVectors(docId, [new Int8Array(4).fill(1), new Int8Array(4).fill(2)]);
    expect(w.listDocsMissingVectors(10).docs).toHaveLength(0);
    expect(vecCount(index)).toBe(2);

    // Content change drops vectors → doc is missing again (self-heal queue).
    index.upsert({ kind: 'task', ref: 't1', title: 'Alpha work v2', note: 'body', updatedAt: 2 });
    expect(vecCount(index)).toBe(0);
    expect(w.listDocsMissingVectors(10).docs.map((d) => d.id)).toContain(docId);

    // Timestamp-only change keeps them.
    w.writeVectors(docId, [new Int8Array(4).fill(3)]);
    index.upsert({ kind: 'task', ref: 't1', title: 'Alpha work v2', note: 'body', updatedAt: 3 });
    expect(vecCount(index)).toBe(1);
    index.close();
  });

  it('remove cascades vectors away', () => {
    const index = createSearchIndex({ dbPath: ':memory:', kinds: KINDS });
    const { docId } = index.upsert({ kind: 'task', ref: 't1', title: 'Gone soon', updatedAt: 1 });
    indexWriterView(index).writeVectors(docId, [new Int8Array(4).fill(1)]);
    index.remove('task', 't1');
    expect(vecCount(index)).toBe(0);
    index.close();
  });

  it('keyset cursor resumes the missing-vectors walk without revisiting', () => {
    const index = createSearchIndex({ dbPath: ':memory:', kinds: KINDS });
    const ids: number[] = [];
    for (let i = 0; i < 5; i++) {
      ids.push(index.upsert({
        kind: 'task', ref: `t${i}`, title: `Doc ${i}`, updatedAt: 100 + i,
      }).docId);
    }
    const w = indexWriterView(index);
    const page1 = w.listDocsMissingVectors(2);
    expect(page1.docs).toHaveLength(2);
    expect(page1.cursor).not.toBeNull();
    const page2 = w.listDocsMissingVectors(2, page1.cursor);
    expect(page2.docs).toHaveLength(2);
    const page3 = w.listDocsMissingVectors(2, page2.cursor);
    expect(page3.docs).toHaveLength(1);
    const all = [...page1.docs, ...page2.docs, ...page3.docs].map((d) => d.id).sort();
    expect(all).toEqual([...ids].sort()); // every doc exactly once
    // Walk order is updated_at DESC — newest first.
    expect(page1.docs.map((d) => d.ref)).toContain('t4');
    index.close();
  });
});

describe('searchSemantic degrade ladder', () => {
  it('no embedder → keyword order, semantic=disabled; backfill drains as no-op', async () => {
    const index = createSearchIndex({ dbPath: ':memory:', kinds: KINDS });
    index.upsert({ kind: 'task', ref: 't1', title: 'retry timeout fix', updatedAt: 1 });
    const hits = await index.searchSemantic('retry timeout');
    expect(hits[0].ref).toBe('t1');
    expect(hits[0].semantic).toBe('disabled');
    expect(await index.backfillVectors()).toEqual({ embedded: 0, drained: true, cursor: null });
    index.close();
  });

  it('embedder configured but worker unavailable → timeout marker, keyword order intact', async () => {
    const index = createSearchIndex({
      dbPath: ':memory:',
      kinds: KINDS,
      embedder: {
        modelId: 'no/such-model',
        dims: 4,
        workerPath: '/nonexistent/embed-worker.js',
      },
    });
    index.upsert({ kind: 'task', ref: 't1', title: 'retry timeout fix', updatedAt: 1 });
    index.upsert({ kind: 'task', ref: 't2', title: 'unrelated doc about retry', updatedAt: 1 });
    const hits = await index.searchSemantic('retry timeout', { semanticDeadlineMs: 200 });
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0].ref).toBe('t1');
    expect(hits[0].semantic).toBe('timeout');
    // sync search still works beside it
    expect(index.search('retry')[0].semantic).toBe('skipped');
    index.close();
  });

  it('semanticDeadlineMs 0 skips the rescore entirely', async () => {
    const index = createSearchIndex({
      dbPath: ':memory:',
      kinds: KINDS,
      embedder: { modelId: 'no/such-model', dims: 4, workerPath: '/nonexistent.js' },
    });
    index.upsert({ kind: 'task', ref: 't1', title: 'retry timeout fix', updatedAt: 1 });
    const hits = await index.searchSemantic('retry', { semanticDeadlineMs: 0 });
    expect(hits[0].semantic).toBe('skipped');
    index.close();
  });

  it('a doc whose embed keeps failing is quarantined instead of wedging the backfill', async () => {
    const index = createSearchIndex({
      dbPath: ':memory:',
      kinds: KINDS,
      embedder: { modelId: 'no/such-model', dims: 4, workerPath: '/nonexistent.js' },
    });
    index.upsert({ kind: 'task', ref: 'poison', title: 'never embeds', updatedAt: 1 });
    // Failure 1: retried next pass; failure 2: quarantined with a zero vector.
    const first = await index.backfillVectors();
    expect(first.embedded).toBe(0);
    const second = await index.backfillVectors();
    expect(second.embedded).toBe(0);
    expect(vecCount(index)).toBe(1); // the zero sentinel
    expect((await index.backfillVectors()).drained).toBe(true);
    index.close();
  });
});

// ── helpers ──

import type { SearchIndex } from '../../src/lib/hybrid-search/index.js';
import { createWriter } from '../../src/lib/hybrid-search/writer.js';

/** The writer surface for a live index (same db handle). */
describe('identifier ownership (keyword layer)', () => {
  it('a doc found by its OWN ref outranks prose quoting the id', () => {
    const index = createSearchIndex({ dbPath: ':memory:', kinds: KINDS });
    const now = Date.now();
    // The referent: its id appears in NO text field of its own.
    index.upsert({ kind: 'task', ref: 'mt9zz9zz-aaaa', title: 'Fix the reconciler', updatedAt: now });
    // The quoter: mentions the id in prose AND carries it as an identifier.
    index.upsert({
      kind: 'task', ref: 'mt0other-bbbb', title: 'Investigate mt9zz9zz-aaaa regression',
      note: 'Root cause traced to mt9zz9zz-aaaa, see details.',
      identifiers: ['mt9zz9zz-aaaa'], updatedAt: now,
    });
    const hits = index.search('mt9zz9zz-aaaa');
    expect(hits[0].ref).toBe('mt9zz9zz-aaaa');
    expect(hits[0].components.selfIdent).toBe(1);
    expect(hits[1].components.selfIdent).toBe(0);
    index.close();
  });

  it('an identifier PREFIX still finds and ranks the owning doc', () => {
    const index = createSearchIndex({ dbPath: ':memory:', kinds: KINDS });
    const now = Date.now();
    index.upsert({ kind: 'task', ref: 'mt9zz9zz-aaaa', title: 'Fix the reconciler', updatedAt: now });
    index.upsert({
      kind: 'task', ref: 'mt0other-bbbb', title: 'Unrelated work',
      identifiers: ['b3f9a1c2d4e5f60718293a4b5c6d7e8f90a1b2c3'], updatedAt: now,
    });
    // Prefix of the doc's own ref (humans paste id prefixes).
    expect(index.search('mt9zz9zz')[0]?.ref).toBe('mt9zz9zz-aaaa');
    // Prefix of a mentioned identifier (SHA prefix → the task that made it).
    expect(index.search('b3f9a1c2d4e5')[0]?.ref).toBe('mt0other-bbbb');
    index.close();
  });
});

describe('rescore guards (fake worker: query always embeds to [127,0,0,0])', () => {
  const FAKE_EMBEDDER = {
    modelId: 'fake/unit-x',
    dims: 4,
    workerPath: new URL('./fixtures/fake-embed-worker.cjs', import.meta.url).pathname,
  };

  it('span confidence: near-duplicate pool keeps keyword (recency) order', async () => {
    // Three docs identical except age. Cosines OPPOSE recency but live in a
    // tiny span (~0.02) — min-max would stretch that noise to the full blend
    // weight and flip the order; the span confidence must keep it scaled to
    // ~0.2·(span/SPAN_REF), below the recency gap.
    const index = createSearchIndex({ dbPath: ':memory:', kinds: KINDS, embedder: FAKE_EMBEDDER });
    const now = Date.now();
    const w = indexWriterView(index);
    const mk = (ref: string, updatedAt: number) =>
      index.upsert({ kind: 'task', ref, title: 'orbit telemetry alert', note: 'same body', updatedAt }).docId;
    // newest → lowest cosine, oldest → highest, span ~0.004 (pure noise);
    // ages 0/30/60 days so recency still carries a real keyword gap.
    w.writeVectors(mk('newest', now), [new Int8Array([127, 12, 0, 0])]);
    w.writeVectors(mk('middle', now - 30 * 24 * 3600 * 1000), [new Int8Array([127, 8, 0, 0])]);
    w.writeVectors(mk('oldest', now - 60 * 24 * 3600 * 1000), [new Int8Array([127, 0, 0, 0])]);
    const hits = await index.searchSemantic('orbit telemetry', { semanticDeadlineMs: 5000 });
    expect(hits.map((h) => h.ref)).toEqual(['newest', 'middle', 'oldest']);
    expect(hits[0].semantic).toBe('ok');
    index.close();
  });

  it('demotion cap: a keyword-rank-1 doc never sinks below limit/2 + 1', async () => {
    // 13 keyword-tied docs; the newest (keyword rank 1 via recency) gets an
    // ORTHOGONAL vector (cos 0) while every filler gets cos 1 — a full-width
    // span, so without the cap the target lands dead last. The rescore may
    // promote fillers freely, but the cap floors the target at index cap (5).
    const index = createSearchIndex({ dbPath: ':memory:', kinds: KINDS, embedder: FAKE_EMBEDDER });
    const now = Date.now();
    const w = indexWriterView(index);
    const target = index.upsert({
      kind: 'task', ref: 'target', title: 'orbit telemetry alert', note: 'same body', updatedAt: now,
    }).docId;
    w.writeVectors(target, [new Int8Array([0, 127, 0, 0])]);
    for (let i = 0; i < 12; i++) {
      const id = index.upsert({
        kind: 'task', ref: `filler-${i}`, title: 'orbit telemetry alert', note: 'same body',
        updatedAt: now - (i + 1) * 24 * 3600 * 1000,
      }).docId;
      w.writeVectors(id, [new Int8Array([127, 0, 0, 0])]);
    }
    const hits = await index.searchSemantic('orbit telemetry', { limit: 10, semanticDeadlineMs: 5000 });
    expect(hits).toHaveLength(10);
    expect(hits.findIndex((h) => h.ref === 'target')).toBe(5); // kwRank 0 + cap 5
    index.close();
  });

  it('recall slot cap: keyword-less neighbours never crowd out keyword evidence', async () => {
    // 12 CJK-only docs embed identically to the query (cos 1) while 10
    // keyword docs carry real-but-partial term coverage (one of two query
    // terms — the typo/vague query shape) and weaker vectors, so every KNN
    // neighbour outscores them. Unbounded, the recall lane would take every
    // page slot (2026-08-24: live typo/vague queries returned 10/10 KNN
    // neighbours); the cap holds it to ⌈limit/4⌉.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hs-slotcap-'));
    const index = createSearchIndex({
      dbPath: path.join(dir, 'search.sqlite'), kinds: KINDS, embedder: FAKE_EMBEDDER,
    });
    const now = Date.now();
    const w = indexWriterView(index);
    // Corpus padding: keeps 'orbit' (10 docs) under the 15% df gate so the
    // keyword docs actually enter the relaxed lane.
    for (let i = 0; i < 60; i++) {
      index.upsert({
        kind: 'task', ref: `pad-${i}`, title: `unrelated filler item ${i}`,
        updatedAt: now - (i + 100) * 24 * 3600 * 1000,
      });
    }
    for (let i = 0; i < 10; i++) {
      const { docId } = index.upsert({
        kind: 'task', ref: `kw-${i}`, title: 'orbit alert stream', note: 'same body',
        updatedAt: now - i * 3600 * 1000,
      });
      w.writeVectors(docId, [new Int8Array([90, 90, 0, 0])]); // decent, not top
    }
    for (let i = 0; i < 12; i++) {
      const { docId } = index.upsert({
        kind: 'task', ref: `knn-${i}`, title: `完全无关标题${i}`, note: '没有英文词',
        updatedAt: now - i * 3600 * 1000,
      });
      w.writeVectors(docId, [new Int8Array([127, 0, 0, 0])]); // cos 1 vs query
    }
    const hits = await index.searchSemantic('orbit telemetry', { limit: 10, semanticDeadlineMs: 5000 });
    expect(hits).toHaveLength(10);
    const recallCount = hits.filter((h) => h.ref.startsWith('knn-')).length;
    expect(recallCount).toBeGreaterThan(0); // still admitted…
    expect(recallCount).toBeLessThanOrEqual(3); // …but bounded to ⌈10/4⌉
    expect(hits.filter((h) => h.ref.startsWith('kw-')).length).toBe(10 - recallCount);
    index.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('backfill yields the worker to a live query (quiet window)', async () => {
    const index = createSearchIndex({ dbPath: ':memory:', kinds: KINDS, embedder: FAKE_EMBEDDER });
    index.upsert({ kind: 'task', ref: 't1', title: 'alpha work', updatedAt: 1 });
    // No query yet → backfill embeds freely.
    const first = await index.backfillVectors();
    expect(first.embedded).toBe(1);
    index.upsert({ kind: 'task', ref: 't2', title: 'beta work', updatedAt: 2 });
    // A query marks the worker hot; the very next backfill call must yield
    // without embedding and hand back the INCOMING cursor so nothing skips.
    await index.searchSemantic('alpha', { semanticDeadlineMs: 5000 });
    const yielded = await index.backfillVectors();
    expect(yielded).toEqual({ embedded: 0, drained: false, cursor: null });
    expect(vecCount(index)).toBe(1); // t2 still waiting, not skipped
    index.close();
  });

  it('semantic recall admits a doc with ZERO keyword overlap (file-backed db)', async () => {
    // Cross-lingual shape: the query shares no token with the doc, so the
    // keyword pool is empty — only the worker's level-0 KNN can reach it.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hs-recall-'));
    const dbPath = path.join(dir, 'search.sqlite');
    const index = createSearchIndex({ dbPath, kinds: KINDS, embedder: FAKE_EMBEDDER });
    const w = indexWriterView(index);
    const { docId } = index.upsert({
      kind: 'task', ref: 'unreachable', title: '完全无关的标题', note: '没有任何英文词',
      updatedAt: Date.now(),
    });
    w.writeVectors(docId, [new Int8Array([127, 0, 0, 0])]); // seq 0 = doc-level
    const hits = await index.searchSemantic('orbit telemetry', { semanticDeadlineMs: 5000 });
    expect(hits.map((h) => h.ref)).toContain('unreachable');
    expect(hits[0].components.cosine).toBeCloseTo(1, 3);
    index.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

function indexWriterView(index: SearchIndex) {
  return createWriter(index.db);
}

function vecCount(index: SearchIndex): number {
  return (index.db.prepare('SELECT COUNT(*) AS n FROM doc_vec').get() as { n: number }).n;
}
