/**
 * A search index on a temp file whose embedder is the text-dependent fixture
 * (fixtures/text-embed-worker.cjs): every vector is a function of its passage
 * text, and the worker logs the hash of each text it embeds. Tests read both to
 * tell which passages were embedded and whether each stored vector is the
 * embedding of the passage text at its seq.
 */
import fs from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import {
  createSearchIndex, passagesForDoc, PASSAGE_MAX_CHARS, type KindConfig, type LogFn, type SearchIndex,
} from '../../src/lib/hybrid-search/index.js';
import { passageKey } from '../../src/lib/hybrid-search/vector-reuse.js';

const require = createRequire(import.meta.url);
const { textVec } = require('./fixtures/text-vec.cjs') as { textVec: (text: string) => Int8Array };
const TEXT_WORKER = new URL('./fixtures/text-embed-worker.cjs', import.meta.url).pathname;

export const TEXT_KINDS: Record<string, KindConfig> = {
  task: { weight: 1.0 },
  note: { weight: 1.0 },
  session: { weight: 0.9, passages: { overflow: 'tail' } },
};

/** Fixture knobs (fixtures/text-embed-worker.cjs). */
export interface TextKnobs {
  holdMs?: number;
  crashOn?: string;
  errorOn?: string;
  stoppingOn?: string;
  crashFrom?: number;
  crashJobs?: number;
  jobFile?: string;
  poisonFile?: string;
}

export interface TextIndexHandle {
  index: SearchIndex;
  dbPath: string;
  /** Hashes of every text the worker embedded so far, in order. */
  embedded(): string[];
  /** Same index file, as a restarted host would open it (optionally with
   *  other worker knobs: the machine or the model changed meanwhile). */
  reopen(knobs?: TextKnobs): SearchIndex;
  close(): Promise<void>;
}

export function makeTempDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

export function openTextIndex(dir: string, firstKnobs: TextKnobs = {}, logger?: LogFn): TextIndexHandle {
  const dbPath = path.join(dir, 'search.sqlite');
  const logFile = path.join(dir, 'embedded.log');
  const open = (knobs: TextKnobs) => createSearchIndex({
    dbPath,
    kinds: TEXT_KINDS,
    logger,
    embedder: {
      modelId: 'fake/text:' + JSON.stringify({ logFile, ...knobs }),
      dims: 4,
      workerPath: TEXT_WORKER,
    },
  });
  const handles: SearchIndex[] = [open(firstKnobs)];
  return {
    get index() { return handles[handles.length - 1]!; },
    dbPath,
    embedded: () => (fs.existsSync(logFile)
      ? fs.readFileSync(logFile, 'utf8').split('\n').filter(Boolean)
      : []),
    reopen(knobs = firstKnobs) {
      const next = open(knobs);
      handles.push(next);
      return next;
    },
    async close() {
      for (const h of handles) {
        await h.stopEmbedder().catch(() => {});
        try { h.close(); } catch { /* already closed */ }
      }
    },
  };
}

export function passagesOfDoc(doc: { kind: string; title: string; summary?: string; note?: string }): string[] {
  return passagesForDoc(
    { title: doc.title, summary: doc.summary ?? '', note: doc.note ?? '' },
    TEXT_KINDS[doc.kind]?.passages,
  ).passages;
}

export const keysOf = (passages: string[]): string[] => passages.map(passageKey);

export function vecRows(index: SearchIndex, docId: number): Array<{ seq: number; vec: number[] }> {
  return (index.db.prepare('SELECT seq, vec FROM doc_vec WHERE doc_id = ? ORDER BY seq').all(docId) as
    Array<{ seq: number; vec: Buffer }>).map((r) => ({ seq: r.seq, vec: [...new Int8Array(r.vec.buffer, r.vec.byteOffset, r.vec.byteLength)] }));
}

/** The stored rows as they must be: seq i holds textVec(passages[i]). */
export function expectedRows(passages: string[]): Array<{ seq: number; vec: number[] }> {
  return passages.map((p, seq) => ({ seq, vec: [...textVec(p)] }));
}

/** The wiring's light-phase bound (LIGHT_PHASE_MAX_NOTE_CHARS, wiring.ts). */
const LIGHT_MAX_NOTE_CHARS = PASSAGE_MAX_CHARS * 2;

/** Drain the missing-vectors walk the way the wiring does (light, then all). */
export async function drainBackfill(
  index: SearchIndex,
  extra: { budgetMs?: number } = {},
): Promise<{ calls: number; embedded: number; scanned: number; yields: number }> {
  const out = { calls: 0, embedded: 0, scanned: 0, yields: 0 };
  let cursor = null;
  for (const phase of ['light', 'all'] as const) {
    cursor = null;
    for (let guard = 0; guard < 2_000; guard++) {
      const r = await index.backfillVectors({
        batchDocs: 16, cursor, maxNoteChars: phase === 'light' ? LIGHT_MAX_NOTE_CHARS : undefined, ...extra,
      });
      out.calls++;
      out.embedded += r.embedded;
      out.scanned += r.scanned ?? 0;
      if (r.yielded) out.yields++;
      if (r.stalled) throw new Error('backfill stalled: the embed worker is not working');
      cursor = r.cursor;
      if (r.drained) break;
      if (guard === 1_999) throw new Error('backfill never drained');
    }
  }
  return out;
}

/** A body of `count` paragraphs, each about `chars` long, distinct by label. */
export function paragraphs(label: string, count: number, chars = 900): string {
  const words = 'retry window worker budget passage vector index marina cedar lantern'.split(' ');
  const out: string[] = [];
  for (let i = 0; i < count; i++) {
    let p = `${label} part ${i}:`;
    for (let w = 0; p.length < chars; w++) p += ' ' + words[(i * 7 + w) % words.length];
    out.push(p);
  }
  return out.join('\n\n');
}
