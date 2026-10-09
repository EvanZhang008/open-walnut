/**
 * Index-to-index copy (src/lib/hybrid-search/replica.ts): a copy fed from a
 * source's export answers keyword AND semantic searches without embedding a
 * single passage, carries the source's hash, identifiers and vectors exactly,
 * and keeps a per-doc stamp that any local write drops.
 *
 * Both indexes use the text-dependent fixture embedder, each with its own log,
 * so a test can tell which texts the copy embedded (only queries).
 */
import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { createSearchIndex, type SearchIndex } from '../../src/lib/hybrid-search/index.js';
import {
  drainBackfill, makeTempDir, openTextIndex, paragraphs, TEXT_KINDS, vecRows, type TextIndexHandle,
} from './text-embed-index.js';

const dirs: string[] = [];
const handles: TextIndexHandle[] = [];
const extra: SearchIndex[] = [];
function open(): TextIndexHandle {
  const dir = makeTempDir('wn-replica-');
  dirs.push(dir);
  const h = openTextIndex(dir);
  handles.push(h);
  return h;
}
afterEach(async () => {
  for (const i of extra.splice(0)) { await i.stopEmbedder().catch(() => {}); try { i.close(); } catch { /* closed */ } }
  for (const h of handles.splice(0)) await h.close();
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

const NOTE = paragraphs('lantern', 4);

function seed(index: SearchIndex): void {
  index.upsert({
    kind: 'task', ref: 't-1', title: 'Rotate the cedar gateway certificate',
    summary: 'Before Friday', note: 'Renew with the marina tool.', updatedAt: 1_000,
    identifiers: ['t-1', 'CR-AB12'],
  });
  index.upsert({ kind: 'note', ref: '/home/notes/lantern.md', title: 'Lantern notes', note: NOTE, updatedAt: 2_000 });
  index.upsert({ kind: 'session', ref: 's-1', title: 'Debug the retry window', note: 'worker budget passage', updatedAt: 3_000 });
}

function allStates(index: SearchIndex) {
  const out: ReturnType<SearchIndex['replica']['states']> = [];
  for (let after = 0; ;) {
    const slice = index.replica.states(after, 2);
    if (slice.length === 0) return out;
    out.push(...slice);
    after = slice[slice.length - 1]!.id;
  }
}

function copyAll(source: SearchIndex, target: SearchIndex, tag = (h: string, v: string) => `${h.slice(0, 16)}${v}`) {
  const states = allStates(source);
  const docs = source.replica.exportDocs(states.map((s) => ({ kind: s.kind, ref: s.ref })));
  const byKey = new Map(states.map((s) => [`${s.kind}:${s.ref}`, s]));
  return target.replica.importDocs(docs.map((d) => {
    const s = byKey.get(`${d.kind}:${d.ref}`)!;
    return { ...d, tag: tag(s.hash, s.vec) };
  }));
}

const docRow = (index: SearchIndex, kind: string, ref: string) => index.db.prepare(
  'SELECT id, title, summary, note, meta, updated_at, hash FROM doc WHERE kind = ? AND ref = ?',
).get(kind, ref) as { id: number; title: string; summary: string; note: string; meta: string; updated_at: number; hash: string };
const idents = (index: SearchIndex, docId: number) => (index.db.prepare(
  'SELECT token FROM ident WHERE doc_id = ? ORDER BY token',
).all(docId) as Array<{ token: string }>).map((r) => r.token);
const tagMap = (index: SearchIndex) => new Map(index.replica.tags(0, 1_000).map((t) => [`${t.kind}:${t.ref}`, t.tag]));

describe('index-to-index copy', () => {
  it('a copy answers keyword and semantic searches without embedding a passage', async () => {
    const src = open();
    seed(src.index);
    await drainBackfill(src.index);
    const copy = open();
    const r = copyAll(src.index, copy.index);
    expect(r).toEqual({ stored: 3, keptVectors: 0 });

    for (const [kind, ref] of [['task', 't-1'], ['note', '/home/notes/lantern.md'], ['session', 's-1']] as const) {
      const a = docRow(src.index, kind, ref);
      const b = docRow(copy.index, kind, ref);
      expect({ ...b, id: 0 }).toEqual({ ...a, id: 0 });
      expect(idents(copy.index, b.id)).toEqual(idents(src.index, a.id));
      expect(vecRows(copy.index, b.id)).toEqual(vecRows(src.index, a.id));
    }
    expect(vecRows(copy.index, docRow(copy.index, 'note', '/home/notes/lantern.md').id).length).toBeGreaterThan(1);

    // Keyword lanes, identifier lane included, from the copy's own FTS rows.
    expect(copy.index.search('cedar gateway')[0]?.ref).toBe('t-1');
    expect(copy.index.search('cr-ab12')[0]?.ref).toBe('t-1');
    // Semantic: a query equal to a stored passage's text has cosine 1 with it.
    const q = 'Debug the retry window\n\nworker budget passage';
    const hits = await copy.index.searchSemantic(q, { semanticDeadlineMs: 10_000 });
    expect(hits[0]?.ref).toBe('s-1');
    expect(hits[0]?.semantic).toBe('ok');
    // The copy embedded the query and nothing else.
    expect(copy.embedded()).toHaveLength(1);
  });

  it('states name every doc with its hash and vector state, in id slices', async () => {
    const src = open();
    seed(src.index);
    src.index.upsert({ kind: 'note', ref: '/home/notes/empty.md', title: '', updatedAt: 4_000 });
    expect(allStates(src.index).map((s) => s.vec)).toEqual(['n', 'n', 'n', 'n']);
    await drainBackfill(src.index);
    const states = allStates(src.index);
    expect(states.map((s) => [s.ref, s.vec])).toEqual([
      ['t-1', 'v'], ['/home/notes/lantern.md', 'v'], ['s-1', 'v'], ['/home/notes/empty.md', 'z'],
    ]);
    expect(states[0]!.hash).toBe(docRow(src.index, 'task', 't-1').hash);
    expect(src.index.replica.statesOf([states[1]!.id, 999_999]).map((s) => s.ref)).toEqual(['/home/notes/lantern.md']);
  });

  it('every copied doc carries its stamp; a local change drops it, an unchanged upsert keeps it', async () => {
    const src = open();
    seed(src.index);
    await drainBackfill(src.index);
    const copy = open();
    copyAll(src.index, copy.index);
    expect([...tagMap(copy.index).keys()].sort()).toEqual(['note:/home/notes/lantern.md', 'session:s-1', 'task:t-1']);

    // The same doc written again (a local serializer producing the same text): stamp stays.
    copy.index.upsert({
      kind: 'task', ref: 't-1', title: 'Rotate the cedar gateway certificate',
      summary: 'Before Friday', note: 'Renew with the marina tool.', updatedAt: 1_500,
      identifiers: ['t-1', 'CR-AB12'],
    });
    expect(tagMap(copy.index).has('task:t-1')).toBe(true);
    // A local edit: the doc is no longer the source's copy.
    copy.index.upsert({ kind: 'task', ref: 't-1', title: 'Rotate it, edited here', updatedAt: 1_600 });
    expect(tagMap(copy.index).has('task:t-1')).toBe(false);
    copy.index.remove('session', 's-1');
    expect([...tagMap(copy.index).keys()]).toEqual(['note:/home/notes/lantern.md']);
  });

  it('same text arriving with fewer vectors keeps the copy\'s set; new text or a complete set replaces it', async () => {
    const src = open();
    seed(src.index);
    await drainBackfill(src.index);
    const copy = open();
    copyAll(src.index, copy.index);
    const copyNote = docRow(copy.index, 'note', '/home/notes/lantern.md').id;
    const full = vecRows(copy.index, copyNote);

    // The source rebuilt its index: same docs, same hashes, no vectors yet.
    await src.index.rebuildAll([
      { kind: 'note', ref: '/home/notes/lantern.md', title: 'Lantern notes', note: NOTE, updatedAt: 2_000 },
    ]);
    expect(allStates(src.index).map((s) => s.vec)).toEqual(['n']);
    const r = copyAll(src.index, copy.index, () => 'rebuilt');
    expect(r).toEqual({ stored: 1, keptVectors: 1 });
    expect(vecRows(copy.index, copyNote)).toEqual(full);
    expect(tagMap(copy.index).get('note:/home/notes/lantern.md')).toBe('rebuilt');

    // Re-embedded on the source: the complete set replaces (here: equal bytes).
    await drainBackfill(src.index);
    expect(copyAll(src.index, copy.index).keptVectors).toBe(0);
    expect(vecRows(copy.index, copyNote)).toEqual(full);

    // New text with no vectors yet: the old vectors describe text that is gone.
    src.index.upsert({ kind: 'note', ref: '/home/notes/lantern.md', title: 'Lantern notes', note: 'rewritten', updatedAt: 5_000 });
    copyAll(src.index, copy.index);
    expect(vecRows(copy.index, copyNote)).toEqual([]);
    expect(copy.index.search('rewritten')[0]?.ref).toBe('/home/notes/lantern.md');
    // The old body's words left the copy's FTS with it.
    expect(copy.index.search('budget', { kinds: ['note'] })).toEqual([]);
  });

  it('the change listener hears every write that moves a doc\'s text or vectors', async () => {
    const dir = makeTempDir('wn-replica-listen-');
    dirs.push(dir);
    const heard: Array<number | null> = [];
    const index = createSearchIndex({ dbPath: path.join(dir, 's.sqlite'), kinds: TEXT_KINDS, onDocChange: (id) => heard.push(id) });
    extra.push(index);
    const a = index.upsert({ kind: 'task', ref: 'a', title: 'one', updatedAt: 1 });
    index.upsert({ kind: 'task', ref: 'a', title: 'one', updatedAt: 2 }); // unchanged text: not heard
    index.upsert({ kind: 'task', ref: 'a', title: 'two', updatedAt: 3 });
    index.remove('task', 'a');
    await index.rebuildAll([]);
    index.replica.importDocs([{
      kind: 'task', ref: 'b', title: 'b', summary: '', note: '', meta: '', updatedAt: 1, hash: 'h'.repeat(40),
      idents: [], vectors: [], tag: 'x',
    }]);
    expect(heard.slice(0, 4)).toEqual([a.docId, a.docId, a.docId, null]);
    expect(heard).toHaveLength(5);
  });

  it('vectors dropped at open (another model) drop every stamp too', async () => {
    const src = open();
    seed(src.index);
    await drainBackfill(src.index);
    const copy = open();
    copyAll(src.index, copy.index);
    const dbPath = copy.dbPath;
    await copy.close();
    const other = createSearchIndex({
      dbPath, kinds: TEXT_KINDS,
      embedder: { modelId: 'fake/other-model', dims: 4, workerPath: new URL('./fixtures/text-embed-worker.cjs', import.meta.url).pathname },
    });
    extra.push(other);
    expect(other.vectorsWiped).toBe(true);
    expect(other.replica.tags(0, 100)).toEqual([]);
    expect(other.stats().docs).toBe(3);
  });
});
