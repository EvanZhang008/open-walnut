/**
 * What a server restart costs the vector backfill.
 *
 * A start with no floor forces a full pass (a fresh planner trusts none), and a
 * day of deploys meant 25 starts on 2026-10-06; a clean stop now leaves its
 * floor in the index for the next start (the last block). A full pass WALKS every doc, but it
 * embeds only docs with no seq-0 vector, and a doc loses its vectors only when
 * its content hash changes (writer.ts): the boot re-feed (file sweep, session
 * events) of unchanged content keeps every vector. That is pinned here, beside
 * the two kinds of change a boot does see: new text (only its new passages are
 * embedded) and a meta-only change (nothing is embedded).
 *
 * The embedder is the text-dependent fixture (vectors follow the passage text,
 * every embedded text is logged); the index is a temp file reopened as a
 * restarted host would open it.
 */
import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import {
  createVectorPassPlanner, LIGHT_PHASE_MAX_NOTE_CHARS, saveVectorPassSnapshot, takeVectorPassSnapshot,
} from '../../src/core/search/wiring.js';
import type { Doc, MissingVecCursor, SearchIndex } from '../../src/lib/hybrid-search/index.js';
import {
  expectedRows, keysOf, makeTempDir, openTextIndex, paragraphs, passagesOfDoc, vecRows, type TextIndexHandle,
} from '../lib/text-embed-index.js';

const dirs: string[] = [];
const handles: TextIndexHandle[] = [];
afterEach(async () => {
  for (const h of handles.splice(0)) await h.close();
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

/** One pass as startSearchV2Wiring drives it: light phase, then all. */
async function runPass(index: SearchIndex, planner = createVectorPassPlanner()) {
  const floor = planner.beginPass();
  const stats = { full: floor === null, scanned: 0, embedded: 0 };
  for (const phase of ['light', 'all'] as const) {
    let cursor: MissingVecCursor | null = null;
    for (let guard = 0; ; guard++) {
      if (guard > 1_000) throw new Error('pass never drained');
      const r = await index.backfillVectors({
        batchDocs: 16, cursor, minUpdatedAt: floor ?? undefined,
        maxNoteChars: phase === 'light' ? LIGHT_PHASE_MAX_NOTE_CHARS : undefined,
      });
      stats.scanned += r.scanned ?? 0;
      stats.embedded += r.embedded;
      cursor = r.cursor;
      if (r.drained) break;
    }
  }
  planner.passDrained();
  return stats;
}

function corpus(base: number): Doc[] {
  const docs: Doc[] = [];
  for (let i = 0; i < 24; i++) {
    docs.push({ kind: 'note', ref: `note-${i}`, title: `note ${i}`, note: `short body ${i}`, updatedAt: base - i * 60_000 });
  }
  for (let i = 0; i < 6; i++) {
    docs.push({
      kind: 'session', ref: `session-${i}`, title: `session ${i}`, note: paragraphs(`turns${i}`, 7),
      meta: 'Host: local', updatedAt: base - (30 + i) * 60_000,
    });
  }
  return docs;
}

describe('a restart re-embeds only what changed', () => {
  it('the boot full pass walks every doc and embeds none whose content is unchanged', async () => {
    const dir = makeTempDir('wn-restart-scan-');
    dirs.push(dir);
    const h = openTextIndex(dir);
    handles.push(h);
    const base = Date.now() - 3_600_000;
    const docs = corpus(base);
    for (const d of docs) h.index.upsert(d);
    const firstBoot = await runPass(h.index);
    const allPassages = docs.flatMap((d) => passagesOfDoc(d));
    expect(firstBoot.full).toBe(true);
    expect(firstBoot.embedded).toBe(docs.length);
    expect(h.embedded()).toHaveLength(allPassages.length);

    // Restart: same file, a fresh process. The boot re-feeds docs as the file
    // sweep and session events do: most unchanged, one session with two new
    // turns, one with only its host changed.
    const restarted = h.reopen();
    const grown = { ...docs[24]!, note: docs[24]!.note + '\n\n' + paragraphs('newturns', 2), updatedAt: Date.now() };
    const moved = { ...docs[25]!, meta: 'Host: remote', updatedAt: Date.now() };
    const before = h.embedded().length;
    for (const d of docs) {
      if (d.ref === grown.ref) expect(restarted.upsert(grown).changed).toBe(true);
      else if (d.ref === moved.ref) expect(restarted.upsert(moved).reusedVectors).toBe(passagesOfDoc(moved).length);
      else expect(restarted.upsert(d).changed).toBe(false);
    }

    const secondBoot = await runPass(restarted); // fresh planner: a full pass
    expect(secondBoot.full).toBe(true);
    expect(secondBoot.scanned).toBe(2 * docs.length); // both phases walk the whole table
    expect(secondBoot.embedded).toBe(1); // the grown session, nothing else
    const p1 = passagesOfDoc(docs[24]!);
    const p2 = passagesOfDoc(grown);
    const newOnes = p2.filter((p) => !p1.includes(p));
    expect(newOnes.length).toBeGreaterThan(0);
    // Its new passages, and its seq 0 (restored only once the doc is complete).
    expect(h.embedded().slice(before).sort()).toEqual(keysOf([...newOnes, p2[0]!]).sort());
    for (const d of [grown, moved]) {
      const id = (restarted.db.prepare('SELECT id FROM doc WHERE kind = ? AND ref = ?').get(d.kind, d.ref) as { id: number }).id;
      expect(vecRows(restarted, id)).toEqual(expectedRows(passagesOfDoc(d)));
    }
  });
});

describe('a clean stop hands its floor to the next start', () => {
  it('the next start walks from the floor, and still embeds an old-timestamp doc written before the stop', async () => {
    const dir = makeTempDir('wn-restart-floor-');
    dirs.push(dir);
    const h = openTextIndex(dir);
    handles.push(h);
    const base = Date.now() - 3_600_000;
    const docs = corpus(base);
    for (const d of docs) h.index.upsert(d);
    const planner = createVectorPassPlanner();
    expect((await runPass(h.index, planner)).full).toBe(true);

    // After the drain, the process writes a doc whose timestamp is far below
    // the floor (a note restored with its old mtime) and then stops cleanly.
    const restored = { ...docs[3]!, note: 'restored text that needs a vector', updatedAt: base - 86_400_000 };
    expect(h.index.upsert(restored).changed).toBe(true);
    planner.observeUpsert(restored.updatedAt);
    planner.passAborted();
    saveVectorPassSnapshot(h.index, planner);

    const restarted = h.reopen();
    const snap = takeVectorPassSnapshot(restarted);
    expect(snap).not.toBeNull();
    expect(snap!.low).toBe(restored.updatedAt);
    // Taken, not copied: a crash after this start leaves nothing to trust.
    expect(takeVectorPassSnapshot(restarted)).toBeNull();

    const next = createVectorPassPlanner();
    next.restore(snap!);
    const before = h.embedded().length;
    const boot = await runPass(restarted, next);
    expect(boot.full).toBe(false);
    expect(boot.embedded).toBe(1);
    expect(h.embedded().slice(before)).toEqual(keysOf(passagesOfDoc(restored)));
  });

  it('a start with no record, or a broken one, walks everything', async () => {
    const dir = makeTempDir('wn-restart-floor-');
    dirs.push(dir);
    const h = openTextIndex(dir);
    handles.push(h);
    expect(takeVectorPassSnapshot(h.index)).toBeNull();
    h.index.writeHostMeta('walnut.vec-pass.v1', '{not json');
    expect(takeVectorPassSnapshot(h.index)).toBeNull();
    // Written under a clock that ran ahead: the floor would hold the walk off.
    const ahead = Date.now() + 3_600_000;
    h.index.writeHostMeta('walnut.vec-pass.v1', JSON.stringify({ floor: ahead, fullAt: ahead, low: null }));
    expect(takeVectorPassSnapshot(h.index)).toBeNull();
    // A planner that never drained has no floor to hand over.
    saveVectorPassSnapshot(h.index, createVectorPassPlanner());
    expect(h.index.readHostMeta('walnut.vec-pass.v1')).toBeNull();
    expect(createVectorPassPlanner().beginPass()).toBeNull();
  });
});
