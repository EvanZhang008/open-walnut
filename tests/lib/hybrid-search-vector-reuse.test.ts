/**
 * A content change keeps the vectors of the passages whose text it did not
 * change (src/lib/hybrid-search/vector-reuse.ts, writer.ts upsert step 5).
 *
 * The embedder is the text-dependent fixture: each vector is a function of its
 * passage text and the worker logs every text it embeds, so each test checks
 * two things: which passages were embedded (only the changed ones), and that
 * every stored vector is the embedding of the passage text at its seq (no
 * vector lands on the wrong passage). Indexes live under the OS temp dir.
 */
import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import { createSearchIndex } from '../../src/lib/hybrid-search/index.js';
import { createWriter } from '../../src/lib/hybrid-search/writer.js';
import {
  remapVectors, reusableVectors, passageKey,
} from '../../src/lib/hybrid-search/vector-reuse.js';
import {
  drainBackfill, expectedRows, keysOf, makeTempDir, openTextIndex, paragraphs, passagesOfDoc,
  TEXT_KINDS, vecRows, type TextIndexHandle,
} from './text-embed-index.js';

const dirs: string[] = [];
const handles: TextIndexHandle[] = [];
function open(knobs: { holdMs?: number } = {}): TextIndexHandle {
  const dir = makeTempDir('wn-vec-reuse-');
  dirs.push(dir);
  const h = openTextIndex(dir, knobs);
  handles.push(h);
  return h;
}
afterEach(async () => {
  for (const h of handles.splice(0)) await h.close();
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

const buf = (...v: number[]) => Buffer.from(Int8Array.from(v).buffer);

describe('reusableVectors / remapVectors', () => {
  it('maps stored vectors by passage text, wherever the passage moved', () => {
    const reuse = reusableVectors(['d', 'a', 'b'], [
      { seq: 0, vec: buf(1, 1, 1, 1) }, { seq: 1, vec: buf(2, 2, 2, 2) }, { seq: 2, vec: buf(3, 3, 3, 3) },
    ])!;
    // 'a' moved from seq 1 to seq 2, 'b' is gone, 'c' is new, the digest changed.
    const plan = remapVectors(['d2', 'c', 'a'], reuse);
    expect(plan.rows).toEqual([{ seq: 2, vec: buf(2, 2, 2, 2) }]);
    expect(plan.complete).toBe(false);
  });

  it('restores seq 0 only when every seq is covered', () => {
    const rows = [{ seq: 0, vec: buf(1, 0, 0, 0) }, { seq: 1, vec: buf(0, 1, 0, 0) }];
    const reuse = reusableVectors(['d', 'a'], rows)!;
    expect(remapVectors(['d', 'a'], reuse)).toEqual({ rows: [{ seq: 1, vec: rows[1]!.vec }, { seq: 0, vec: rows[0]!.vec }], complete: true });
    // Same digest, one cover passage new: seq 0 waits, so the doc stays listed.
    expect(remapVectors(['d', 'a', 'z'], reuse).rows.map((r) => r.seq)).toEqual([1]);
  });

  it('never carries a zero vector (quarantine or empty-doc sentinel)', () => {
    expect(reusableVectors(['only'], [{ seq: 0, vec: buf(0, 0, 0, 0) }])).toBeNull();
  });

  it('distrusts rows that do not fit the old layout', () => {
    // A seq past the old passage count, or a complete doc with a hole: these
    // vectors describe some other text (an embed that raced an upsert).
    expect(reusableVectors(['d', 'a'], [{ seq: 2, vec: buf(1, 1, 1, 1) }])).toBeNull();
    expect(reusableVectors(['d', 'a', 'b'], [
      { seq: 0, vec: buf(1, 1, 1, 1) }, { seq: 2, vec: buf(1, 1, 1, 1) },
    ])).toBeNull();
    // A partial doc (no seq 0) is fine: its rows are an interrupted embed.
    expect(reusableVectors(['d', 'a', 'b'], [{ seq: 2, vec: buf(5, 5, 5, 5) }])!
      .get(passageKey('b'))).toEqual(buf(5, 5, 5, 5));
  });
});

describe('content change on a real index', () => {
  it('a growing note re-embeds only the passages whose text changed', async () => {
    const h = open();
    const v1 = { kind: 'task', ref: 'grow', title: 'rotate the marina keys', note: paragraphs('log', 12), updatedAt: 1 };
    const { docId } = h.index.upsert(v1);
    await drainBackfill(h.index);
    const p1 = passagesOfDoc(v1);
    expect(p1.length).toBeGreaterThan(5);
    expect(vecRows(h.index, docId)).toEqual(expectedRows(p1));

    const v2 = { ...v1, note: v1.note + '\n\n' + paragraphs('later', 2), updatedAt: 2 };
    const res = h.index.upsert(v2);
    const p2 = passagesOfDoc(v2);
    const fresh = p2.filter((p) => !p1.includes(p));
    expect(res.reusedVectors).toBe(p2.length - fresh.length - 1); // all kept but seq 0
    const before = h.embedded().length;
    await drainBackfill(h.index);
    const embeddedNow = h.embedded().slice(before);
    // The new passages, plus seq 0: it is restored only when every passage
    // is, so the doc stays listed until the new ones exist. Its text did not
    // change here (the digest leads with the start of the note).
    expect(p1).toContain(p2[0]);
    expect(embeddedNow.sort()).toEqual(keysOf([...fresh, p2[0]!]).sort());
    expect(embeddedNow.length).toBeLessThan(p2.length / 2);
    expect(vecRows(h.index, docId)).toEqual(expectedRows(p2));
  });

  it('a change to meta only keeps every vector and embeds nothing', async () => {
    const h = open();
    const v1 = { kind: 'session', ref: 's1', title: 'search work', note: paragraphs('turn', 8), meta: 'Project: one', updatedAt: 1 };
    const { docId } = h.index.upsert(v1);
    await drainBackfill(h.index);
    const p = passagesOfDoc(v1);
    const before = h.embedded().length;
    const res = h.index.upsert({ ...v1, meta: 'Project: two', updatedAt: 2 });
    expect(res.changed).toBe(true);
    expect(res.reusedVectors).toBe(p.length);
    await drainBackfill(h.index);
    expect(h.embedded().length).toBe(before);
    expect(vecRows(h.index, docId)).toEqual(expectedRows(p));
  });

  it('a single-passage doc whose text changed is embedded again', async () => {
    const h = open();
    const { docId } = h.index.upsert({ kind: 'note', ref: 'n1', title: 'short', note: 'first body', updatedAt: 1 });
    await drainBackfill(h.index);
    const v2 = { kind: 'note', ref: 'n1', title: 'short', note: 'second body', updatedAt: 2 };
    expect(h.index.upsert(v2).reusedVectors).toBe(0);
    await drainBackfill(h.index);
    expect(vecRows(h.index, docId)).toEqual(expectedRows(passagesOfDoc(v2)));
  });

  it('a quarantined doc is retried after a change, not carried over', async () => {
    const h = open();
    const v1 = { kind: 'note', ref: 'q', title: 'poison', note: 'body', updatedAt: 1 };
    const { docId } = h.index.upsert(v1);
    createWriter(h.index.db).writeVectors(docId, [new Int8Array(4)]); // the zero sentinel
    h.index.upsert({ ...v1, meta: 'Tags: retry', updatedAt: 2 });
    expect(vecRows(h.index, docId)).toEqual([]);
    await drainBackfill(h.index);
    expect(vecRows(h.index, docId)).toEqual(expectedRows(passagesOfDoc(v1)));
  });

  it('a keyword-only index drops every vector on a change, as before', () => {
    const index = createSearchIndex({ dbPath: ':memory:', kinds: TEXT_KINDS });
    const { docId } = index.upsert({ kind: 'note', ref: 'k', title: 'kw', note: 'body', updatedAt: 1 });
    createWriter(index.db).writeVectors(docId, [Int8Array.from([1, 2, 3, 4])]);
    expect(index.upsert({ kind: 'note', ref: 'k', title: 'kw', note: 'body', meta: 'm', updatedAt: 2 }).reusedVectors)
      .toBeUndefined();
    expect(vecRows(index, docId)).toEqual([]);
    index.close();
  });

  // The bound as a literal (REUSE_MAX_TEXT_CHARS): a test that reads the
  // constant moves with it, so a 640,000-char bound passed it (the r1 gate's C4).
  const BOUND = 64_000;

  it('the size bound is 64,000 characters of title, summary and note, inclusive', async () => {
    const h = open();
    const sized = (ref: string, chars: number) =>
      ({ kind: 'task', ref, title: ref, note: paragraphs(ref, 80).slice(0, chars - ref.length), updatedAt: 1 });
    const at = sized('at-bound', BOUND);
    const over = sized('past-bound', BOUND + 1);
    expect(at.title.length + at.note.length).toBe(BOUND);
    expect(over.title.length + over.note.length).toBe(BOUND + 1);
    h.index.upsert(at);
    h.index.upsert(over);
    await drainBackfill(h.index);
    // A change to meta only: every vector of the doc at the bound stays.
    expect(h.index.upsert({ ...at, meta: 'Tags: x', updatedAt: 2 }).reusedVectors).toBe(passagesOfDoc(at).length);
    expect(h.index.upsert({ ...over, meta: 'Tags: x', updatedAt: 2 }).reusedVectors).toBeUndefined();
  });

  it('a doc past the size bound skips the reuse (its upsert stays cheap)', async () => {
    const h = open();
    const big = { kind: 'task', ref: 'big', title: 'big', note: paragraphs('wide', Math.ceil(BOUND / 900) + 2), updatedAt: 1 };
    const { docId } = h.index.upsert(big);
    await drainBackfill(h.index);
    expect(h.index.upsert({ ...big, meta: 'Tags: x', updatedAt: 2 }).reusedVectors).toBeUndefined();
    expect(vecRows(h.index, docId)).toEqual([]);

    // A doc under the bound that grows past it: the new text is not split either.
    const small = { kind: 'task', ref: 'grows', title: 'grows', note: paragraphs('g', 6), updatedAt: 1 };
    const grows = h.index.upsert(small).docId;
    await drainBackfill(h.index);
    expect(vecRows(h.index, grows).length).toBeGreaterThan(1);
    const huge = { ...small, note: small.note + '\n\n' + paragraphs('more', Math.ceil(BOUND / 900)), updatedAt: 2 };
    expect(h.index.upsert(huge).reusedVectors).toBe(0);
    expect(vecRows(h.index, grows)).toEqual([]);
  });
});

describe('a changed upsert splits the doc once', () => {
  // The r1 gate: the reuse split the old AND the new text inside the upsert's
  // transaction, on the host thread. The keys of a doc's last split are kept.
  it('reads the old side from the keys its last split kept, for the 256 most recent docs', () => {
    const index = createSearchIndex({ dbPath: ':memory:', kinds: TEXT_KINDS });
    let splits = 0;
    const writer = createWriter(index.db, {
      passagesOf: (d) => { splits++; return passagesOfDoc(d); },
    });
    const hashOf = (id: number) => (index.db.prepare('SELECT hash FROM doc WHERE id = ?').get(id) as { hash: string }).hash;
    type Text = { kind: string; ref: string; title: string; note: string; updatedAt: number };
    const vectorize = (id: number, d: Text) =>
      writer.writeVectors(id, expectedRows(passagesOfDoc(d)).map((r) => Int8Array.from(r.vec)));
    const grow = (d: Text, label: string): Text => ({ ...d, note: `${d.note}\n\n${paragraphs(label, 1)}`, updatedAt: d.updatedAt + 1 });
    const change = (d: Text) => { const before = splits; const r = writer.upsert(d); vectorize(r.docId, d); return { ...r, splits: splits - before }; };

    let v = { kind: 'task', ref: 'once', title: 'grows', note: paragraphs('s', 6), updatedAt: 1 };
    const id = writer.upsert(v).docId;
    expect(splits).toBe(0); // a new doc has no vectors to keep
    vectorize(id, v);
    // First change in this writer: both sides are split.
    v = grow(v, 'a');
    const first = change(v);
    expect(first.splits).toBe(2);
    expect(first.reusedVectors).toBeGreaterThan(0);
    // Every later one: only the new text.
    v = grow(v, 'b');
    expect(change(v).splits).toBe(1);

    // What the backfill split is kept too.
    let w = { kind: 'session', ref: 'kept', title: 'session', note: paragraphs('w', 6), updatedAt: 1 };
    const wid = writer.upsert(w).docId;
    vectorize(wid, w);
    writer.notePassages(wid, w.kind, hashOf(wid), passagesOfDoc(w));
    w = grow(w, 'c');
    expect(change(w).splits).toBe(1);

    // 255 other docs since: still kept. Each change moves the doc to the
    // newest end, so the next one evicted is another doc; 256 more evict it.
    const others = (from: number, n: number) => {
      for (let i = 0; i < n; i++) writer.notePassages(1_000_000 + from + i, 'task', 'h', ['x']);
    };
    others(0, 255);
    w = grow(w, 'd');
    expect(change(w).splits).toBe(1);
    others(1_000, 1);
    w = grow(w, 'd2');
    expect(change(w).splits).toBe(1);
    others(2_000, 256);
    w = grow(w, 'e');
    expect(change(w).splits).toBe(2);

    // Keys are trusted only for the text and kind they were split from. A
    // change that found no vectors kept nothing (no reuse ran), so the keys
    // held for the doc are of an older text: the next change splits it again,
    // and maps the right vectors.
    index.db.prepare('DELETE FROM doc_vec WHERE doc_id = ?').run(wid);
    w = grow(w, 'f');
    expect(writer.upsert(w).reusedVectors).toBeUndefined();
    vectorize(wid, w);
    const g = grow(w, 'g');
    const afterGap = change(g);
    expect(afterGap.splits).toBe(2);
    expect(afterGap.reusedVectors).toBe(passagesOfDoc(w).length - 1); // all but the digest
    // Keys noted under another kind (another policy) are not used.
    writer.notePassages(wid, 'task', hashOf(wid), passagesOfDoc({ ...g, kind: 'task' }));
    expect(change(grow(g, 'h')).splits).toBe(2);
    index.close();
  });
});

describe('the values a change reuses through the keys it kept', () => {
  // The r2 gate's NE7: restore() keeping the right keys in reversed order
  // passed every count above, and search would then match text the doc no
  // longer has. So each reused row is checked against a fresh embedding of
  // the passage now at its seq, computed here from the text.
  it('every reused vector is the embedding of the passage at its seq, across three changes', () => {
    const index = createSearchIndex({ dbPath: ':memory:', kinds: TEXT_KINDS });
    let splits = 0;
    const writer = createWriter(index.db, { passagesOf: (d) => { splits++; return passagesOfDoc(d); } });
    type Text = { kind: string; ref: string; title: string; note: string; updatedAt: number };
    const vectorize = (id: number, d: Text) =>
      writer.writeVectors(id, expectedRows(passagesOfDoc(d)).map((r) => Int8Array.from(r.vec)));
    const change = (d: Text) => {
      const before = splits;
      const r = writer.upsert(d);
      const fresh = new Map(expectedRows(passagesOfDoc(d)).map((x) => [x.seq, JSON.stringify(x.vec)]));
      const rows = vecRows(index, r.docId);
      const wrong = rows.filter((row) => fresh.get(row.seq) !== JSON.stringify(row.vec)).map((row) => row.seq);
      vectorize(r.docId, d);
      return { splits: splits - before, reused: r.reusedVectors ?? 0, rows: rows.length, wrong };
    };
    let v: Text = { kind: 'task', ref: 'values', title: 'moves', note: paragraphs('s', 6), updatedAt: 1 };
    const id = writer.upsert(v).docId;
    vectorize(id, v);
    // A paragraph in front moves every passage one seq; the first change splits both sides.
    v = { ...v, note: `${paragraphs('front', 1)}\n\n${v.note}`, updatedAt: 2 };
    const first = change(v);
    expect(first).toMatchObject({ splits: 2, wrong: [] });
    expect(first.rows).toBeGreaterThan(3);
    // The next two read the old side from the keys restore() kept: one split each.
    v = { ...v, note: `${v.note}\n\n${paragraphs('tail', 1)}`, updatedAt: 3 };
    const second = change(v);
    expect(second).toMatchObject({ splits: 1, wrong: [] });
    expect(second.rows).toBeGreaterThan(3);
    v = { ...v, note: `${paragraphs('head', 1)}\n\n${v.note}`, updatedAt: 4 };
    const third = change(v);
    expect(third).toMatchObject({ splits: 1, wrong: [] });
    expect(third.rows).toBeGreaterThan(3);
    expect([first.reused, second.reused, third.reused]).toEqual([first.rows, second.rows, third.rows]);
    index.close();
  });
});

describe('an embed that races an upsert', () => {
  it('does not store vectors of the text the upsert replaced', async () => {
    const h = open({ holdMs: 60 });
    const v1 = { kind: 'task', ref: 'race', title: 'moving target', note: paragraphs('old', 6), updatedAt: 1 };
    const { docId } = h.index.upsert(v1);
    const run = h.index.backfillVectors({ batchDocs: 16 });
    await new Promise((r) => setTimeout(r, 150)); // a few passages in
    const v2 = { ...v1, note: paragraphs('new', 6), updatedAt: 2 };
    h.index.upsert(v2);
    const r = await run;
    // The late write was refused and not counted: before the hash guard it
    // stored v1's vectors with seq 0, and v2's text was never embedded.
    expect(r.embedded).toBe(0);
    expect(vecRows(h.index, docId)).toEqual([]);
    const p2 = passagesOfDoc(v2);
    await drainBackfill(h.index);
    expect(vecRows(h.index, docId)).toEqual(expectedRows(p2));
  });
});

describe('an embed that races an upsert (single passage)', () => {
  it('does not store the old text\'s vector', async () => {
    const h = open({ holdMs: 400 });
    const v1 = { kind: 'note', ref: 'one', title: 'one passage', note: 'the old body', updatedAt: 1 };
    const { docId } = h.index.upsert(v1);
    // The call lists its docs (with v1's hash) before its first await; the
    // write comes after the worker's 400 ms, so this upsert lands in between.
    const run = h.index.backfillVectors({ batchDocs: 16 });
    await new Promise((r) => setTimeout(r, 100));
    const v2 = { ...v1, note: 'the new body', updatedAt: 2 };
    h.index.upsert(v2);
    expect((await run).embedded).toBe(0);
    expect(vecRows(h.index, docId)).toEqual([]);
    await drainBackfill(h.index);
    expect(vecRows(h.index, docId)).toEqual(expectedRows(passagesOfDoc(v2)));
  });
});

describe('the worker stopping in the middle of a doc', () => {
  it('keeps the finished passages, counts no failure, and a restart embeds only the rest', async () => {
    const h = open({ holdMs: 40 });
    const doc = { kind: 'task', ref: 'whale', title: 'long task', note: paragraphs('w', 10), updatedAt: 1 };
    const { docId } = h.index.upsert(doc);
    const p = passagesOfDoc(doc);
    const run = h.index.backfillVectors({ batchDocs: 16 });
    // Stop once a few passages are done (the worker's start-up time varies
    // with machine load, so wait on the work, not on a clock).
    for (let i = 0; i < 400 && h.embedded().length < 3; i++) await new Promise((r) => setTimeout(r, 25));
    expect(h.embedded().length).toBeGreaterThanOrEqual(3);
    await h.index.stopEmbedder(); // the deploy's shutdown
    const r = await run;
    expect(r.drained).toBe(false);
    expect(r).not.toHaveProperty('stalled'); // a stop is the host's doing, not a sick worker
    const kept = vecRows(h.index, docId);
    expect(kept.length).toBeGreaterThan(0);
    expect(kept.some((row) => row.seq === 0)).toBe(false); // not complete, so still listed
    expect(kept.every((row) => row.vec.some((x) => x !== 0))).toBe(true); // nothing quarantined
    // A later call on the stopped index holds instead of failing every doc.
    expect(await h.index.backfillVectors()).toEqual({ embedded: 0, drained: false, cursor: null });

    const restarted = h.reopen();
    const before = h.embedded().length;
    await drainBackfill(restarted);
    expect(h.embedded().length - before).toBe(p.length - kept.length);
    expect(vecRows(restarted, docId)).toEqual(expectedRows(p));
  });
});
