/**
 * When the vector backfill gives up on a doc (the zero-vector quarantine).
 *
 * Before: any doc that failed twice in one process was quarantined, whatever
 * failed. A worker that crashed or could not start failed every doc, so after
 * two passes every doc still missing vectors held a zero vector, which nothing
 * retried until its content changed: semantic search silently lost those docs
 * for good, for a fault that was the worker's. Now a doc is quarantined only
 * when the SAME passage fails twice in a row and the worker answers a probe
 * after each failure, a failure the probe does not explain away stalls the
 * walk instead, and every quarantine is retried once by the next process.
 *
 * The worker is the text fixture with failure knobs: crashJobs (numbered jobs
 * crash, whatever their text: an unhealthy worker), crashOn and errorOn (a text
 * that kills the worker or gets an error reply: a doc that is the cause), and
 * stoppingOn (the reply of a worker that is stopping: never the doc's fault),
 * and poisonFile (crashOn read from a file, so a test can fix the cause without
 * changing the knobs: they ride in the model id, and a new model id wipes every
 * vector at open).
 */
import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { EMBED_HEALTH_PROBE_TEXT, type LogFn, type SearchIndex } from '../../src/lib/hybrid-search/index.js';
import { createWriter } from '../../src/lib/hybrid-search/writer.js';
import { passageKey } from '../../src/lib/hybrid-search/vector-reuse.js';
import {
  drainBackfill, expectedRows, makeTempDir, openTextIndex, paragraphs, passagesOfDoc, vecRows,
  type TextIndexHandle, type TextKnobs,
} from './text-embed-index.js';

const dirs: string[] = [];
const handles: TextIndexHandle[] = [];
function open(knobs: (dir: string) => TextKnobs = () => ({}), logger?: LogFn): TextIndexHandle {
  const dir = makeTempDir('wn-quarantine-');
  dirs.push(dir);
  const h = openTextIndex(dir, knobs(dir), logger);
  handles.push(h);
  return h;
}
afterEach(async () => {
  for (const h of handles.splice(0)) await h.close();
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

const PROBE = passageKey(EMBED_HEALTH_PROBE_TEXT);
const probes = (h: TextIndexHandle) => h.embedded().filter((k) => k === PROBE).length;
const zeroMarkers = (index: SearchIndex) => (index.db.prepare(
  'SELECT COUNT(*) AS n FROM doc_vec WHERE seq = 0 AND vec = zeroblob(length(vec))',
).get() as { n: number }).n;
const idOf = (index: SearchIndex, ref: string) =>
  (index.db.prepare('SELECT id FROM doc WHERE ref = ?').get(ref) as { id: number }).id;

const note = (ref: string, body: string, updatedAt: number) =>
  ({ kind: 'note', ref, title: `note ${ref}`, note: body, updatedAt });

describe('an unhealthy worker never quarantines a doc', () => {
  it('three crashes in a row: the walk stalls, no doc is blamed, and the next process embeds them', async () => {
    const h = open((dir) => ({ jobFile: path.join(dir, 'jobs'), crashJobs: 3 }));
    const docs = [note('a', 'first body', 3), note('b', 'second body', 2), note('c', 'third body', 1)];
    for (const d of docs) h.index.upsert(d);
    // Crash 1 on doc a, crash 2 on the probe after it; crash 3 on the retry
    // next call disables the lane, after which nothing can start at all.
    for (let call = 0; call < 4; call++) {
      const r = await h.index.backfillVectors({ batchDocs: 16 });
      expect(r).toMatchObject({ embedded: 0, drained: false, stalled: true });
    }
    expect(zeroMarkers(h.index)).toBe(0);
    for (const d of docs) expect(vecRows(h.index, idOf(h.index, d.ref))).toEqual([]);

    const restarted = h.reopen();
    await drainBackfill(restarted);
    for (const d of docs) expect(vecRows(restarted, idOf(restarted, d.ref))).toEqual(expectedRows(passagesOfDoc(d)));
    expect(zeroMarkers(restarted)).toBe(0);
  });

  it('one unrelated crash costs a probe and a retry, and the doc is embedded', async () => {
    const h = open((dir) => ({ jobFile: path.join(dir, 'jobs'), crashJobs: 1 }));
    const docs = [note('a', 'first body', 2), note('b', 'second body', 1)];
    for (const d of docs) h.index.upsert(d);
    await drainBackfill(h.index);
    expect(probes(h)).toBe(1);
    expect(zeroMarkers(h.index)).toBe(0);
    for (const d of docs) expect(vecRows(h.index, idOf(h.index, d.ref))).toEqual(expectedRows(passagesOfDoc(d)));
  });

  // A worker that cannot start at all: hybrid-search-semantic.test.ts.

  it('a run the worker refused because it was stopping blames no doc, even when the probe answers', async () => {
    const h = open(() => ({ stoppingOn: 'LATE' }));
    h.index.upsert(note('late', 'LATE arrival', 1));
    for (let call = 0; call < 2; call++) {
      expect(await h.index.backfillVectors()).toMatchObject({ embedded: 0, drained: false, stalled: true });
    }
    expect(zeroMarkers(h.index)).toBe(0);
    expect(probes(h)).toBe(0);
  });

  it('a worker that dies in the middle of a long doc keeps the finished passages and blames nothing', async () => {
    // Jobs 4 and 5 crash: the fourth passage, then the probe after it.
    const h = open((dir) => ({ jobFile: path.join(dir, 'jobs'), crashFrom: 3, crashJobs: 2 }));
    const doc = { kind: 'task', ref: 'long', title: 'long task', note: paragraphs('w', 8), updatedAt: 1 };
    const { docId } = h.index.upsert(doc);
    const p = passagesOfDoc(doc);
    expect(await h.index.backfillVectors()).toMatchObject({ stalled: true, passages: 3 });
    expect(vecRows(h.index, docId)).toHaveLength(3);
    expect(zeroMarkers(h.index)).toBe(0);
    const restarted = h.reopen();
    const before = h.embedded().length;
    await drainBackfill(restarted);
    expect(h.embedded().length - before).toBe(p.length - 3);
    expect(vecRows(restarted, docId)).toEqual(expectedRows(p));
  });
});

describe('a doc that is the cause is quarantined', () => {
  it.each([
    ['crashes the worker', { crashOn: 'POISON' }],
    ['gets an error reply', { errorOn: 'POISON' }],
  ])('a doc whose passage %s twice, between working probes', async (_name, knobs) => {
    const h = open(() => knobs);
    const docs = [note('good-1', 'plain body one', 3), note('bad', 'POISON payload', 2), note('good-2', 'plain body two', 1)];
    for (const d of docs) h.index.upsert(d);
    const pass = await drainBackfill(h.index);
    expect(pass.embedded).toBe(2);
    expect(probes(h)).toBe(2); // one after each failure of the bad passage
    expect(vecRows(h.index, idOf(h.index, 'bad'))).toEqual([{ seq: 0, vec: [0, 0, 0, 0] }]);
    for (const ref of ['good-1', 'good-2']) {
      expect(vecRows(h.index, idOf(h.index, ref))).toEqual(expectedRows(passagesOfDoc(docs.find((d) => d.ref === ref)!)));
    }
  });

  it('a bad passage inside a long doc quarantines that doc, not its neighbours', async () => {
    const h = open(() => ({ crashOn: 'POISON' }));
    const bad = { kind: 'task', ref: 'bad-long', title: 'long', note: paragraphs('x', 6) + '\n\nPOISON payload', updatedAt: 2 };
    const good = { kind: 'task', ref: 'good-long', title: 'other', note: paragraphs('y', 6), updatedAt: 1 };
    h.index.upsert(bad);
    h.index.upsert(good);
    await drainBackfill(h.index);
    expect(vecRows(h.index, idOf(h.index, 'bad-long'))).toEqual([{ seq: 0, vec: [0, 0, 0, 0] }]);
    expect(vecRows(h.index, idOf(h.index, 'good-long'))).toEqual(expectedRows(passagesOfDoc(good)));
  });
});

describe('a quarantine write is hash-checked', () => {
  it('a doc edited while its failing passage is judged is not quarantined, and its new text embeds', async () => {
    const logs: string[] = [];
    // Error replies come at once and every probe takes 300 ms: the edit lands
    // between the first probe and the second.
    const h = open(() => ({ errorOn: 'POISON', holdMs: 300 }), (_level, msg) => { logs.push(msg); });
    const v1 = note('edited', 'POISON first body', 1);
    const v2 = note('edited', 'a clean second body', 2);
    const id = h.index.upsert(v1).docId;
    const run = h.index.backfillVectors({ batchDocs: 16 });
    for (let i = 0; i < 2_000 && probes(h) < 1; i++) await new Promise((r) => setTimeout(r, 5));
    expect(probes(h)).toBe(1);
    h.index.upsert(v2);
    const res = await run;
    expect(res.stalled).toBeUndefined();
    expect(probes(h)).toBe(2); // the doc was judged the cause, under its old text
    expect(zeroMarkers(h.index)).toBe(0);
    expect(logs.some((m) => m.includes('doc quarantined'))).toBe(false);
    expect(logs.filter((m) => m.includes('changed while it was judged: not quarantined'))).toHaveLength(1);
    await drainBackfill(h.index);
    expect(vecRows(h.index, id)).toEqual(expectedRows(passagesOfDoc(v2)));
  });
});

describe('a quarantine expires', () => {
  it('lasts for the rest of the process, and the next process retries it once', async () => {
    let poisonFile = '';
    const h = open((dir) => {
      poisonFile = path.join(dir, 'poison');
      fs.writeFileSync(poisonFile, 'POISON');
      return { poisonFile };
    });
    const bad = note('bad', 'POISON payload', 1);
    h.index.upsert(bad);
    h.index.upsert(note('good', 'plain body', 2));
    await drainBackfill(h.index);
    expect(zeroMarkers(h.index)).toBe(1);
    // Same process: not retried, the worker never sees the doc again.
    let seen = h.embedded().length;
    await drainBackfill(h.index);
    expect(h.embedded().length).toBe(seen);

    // Next process, still bad: retried once (two attempts, two probes), then left
    // alone. Nothing else is re-embedded: only the zero marker is handed out again.
    const second = h.reopen();
    expect(second.vectorsWiped).toBe(false);
    await drainBackfill(second);
    expect(h.embedded().length - seen).toBe(2);
    expect(zeroMarkers(second)).toBe(1);
    seen = h.embedded().length;
    await drainBackfill(second);
    expect(h.embedded().length).toBe(seen);

    // Next process, cause gone (the model or the machine was the problem after
    // all), the same knobs: the stored vectors and the marker survive the open.
    fs.rmSync(poisonFile);
    const third = h.reopen();
    expect(third.vectorsWiped).toBe(false);
    expect(zeroMarkers(third)).toBe(1);
    await drainBackfill(third);
    expect(zeroMarkers(third)).toBe(0);
    expect(vecRows(third, idOf(third, 'bad'))).toEqual(expectedRows(passagesOfDoc(bad)));
  });

  it('zero markers an older version wrote over real docs are retried after the upgrade', async () => {
    const h = open();
    const short = note('old', 'a body that an old worker failed on', 2);
    const long = { kind: 'task', ref: 'old-long', title: 'long', note: paragraphs('z', 6), updatedAt: 1 };
    // What the old rule left behind: the zero vector alone, written by another process.
    for (const doc of [short, long]) {
      createWriter(h.index.db).writeVectors(h.index.upsert(doc).docId, [new Int8Array(4)]);
    }
    await drainBackfill(h.index);
    expect(zeroMarkers(h.index)).toBe(0);
    for (const doc of [short, long]) {
      expect(vecRows(h.index, idOf(h.index, doc.ref))).toEqual(expectedRows(passagesOfDoc(doc)));
    }
  });

  it('an empty doc keeps its marker without inference, checked once per process', async () => {
    const h = open();
    const { docId } = h.index.upsert({ kind: 'session', ref: 'empty', title: '', note: '', updatedAt: 1 });
    await drainBackfill(h.index);
    expect(vecRows(h.index, docId)).toEqual([{ seq: 0, vec: [0, 0, 0, 0] }]);
    expect(h.embedded()).toEqual([]);
    expect((await h.index.backfillVectors()).docs).toBeUndefined(); // not listed again
    const restarted = h.reopen();
    await drainBackfill(restarted);
    expect(vecRows(restarted, docId)).toEqual([{ seq: 0, vec: [0, 0, 0, 0] }]);
    expect(h.embedded()).toEqual([]);
  });
});
