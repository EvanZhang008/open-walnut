/**
 * Vector reuse across a content change (writer.ts, upsert step 5).
 *
 * A changed doc used to lose EVERY vector, so a session that gained two turns
 * paid for all of its passages again: up to 40 inferences of a 1400-char
 * passage, minutes on a loaded machine, every time the 10-minute session sync
 * re-read it. Most of those passages had the same text as before. Measured on
 * synthetic transcripts through the real body builder and splitter
 * (buildIndexedContent + passagesForDoc): a growing session keeps about 77% of
 * its passages, or 39% once its transcript is past the 4 MB tail read (the
 * window's start moves, and with it every "## Turn N" header); a task note that
 * gains a paragraph keeps 79 to 97%; a change to meta only (project, tags,
 * host) keeps all of them.
 *
 * Nothing new is stored, so this needs no schema change. A passage's identity
 * is the hash of its TEXT, computed from the stored doc row before the update:
 * stored vector `seq` is the embedding of `passagesOf(old doc)[seq]`, because
 * every vector write is guarded by the doc's content hash (writer.ts). Rows
 * written before that guard existed may hold an embed that raced an upsert;
 * reusableVectors drops a doc's rows when their layout shows it.
 * After the update, each new passage whose text hash has a stored vector gets
 * that vector at its new seq. seq 0 is restored only when EVERY new seq got
 * one, so seq 0 still means "fully vectored" and the backfill's resume path
 * (storedVecSeqs) embeds exactly the passages that are missing.
 *
 * Splitting runs on the host thread, inside the upsert's transaction, so a
 * change splits once: the passage keys a doc was last split into (the new text
 * of its previous change, or the text the backfill embedded) are kept by doc id
 * and content hash for the most recent KEY_CACHE_DOCS docs, and the old side is
 * split again only when they are not there (the first change of a doc in a
 * process).
 */

import { createHash } from 'node:crypto';
import type { SearchDb } from './db.js';

/**
 * Docs longer than this (title + summary + note) skip the reuse and lose their
 * vectors as before. The upsert runs on the host's event loop, and the reuse
 * splits the new text into passages (and the old one when its keys are not
 * kept) and copies the kept rows. Measured on one changed session upsert: p50
 * 0.9 ms without the reuse, 2.9 ms with it at 50 KB, 6.7 ms at 95 KB. The worst
 * shape under the bound, a 63.9k-character note of 3-character paragraphs, took
 * 141 ms an upsert with the old splitter and takes 4.4 ms, 2.9 to 3.5 ms when
 * its keys are kept (measured 2026-10-09, load 16 to 20). A session body is
 * capped at 50 KB, so this bound covers sessions; very large notes keep losing
 * all their vectors on a change, as before.
 */
export const REUSE_MAX_TEXT_CHARS = 64_000;

/** Docs whose last passage keys are kept (about 40 keys of 40 hex chars each
 *  at most): the ones a sync is changing now. */
export const KEY_CACHE_DOCS = 256;

export interface StoredVecRow {
  seq: number;
  vec: Buffer;
}

export interface DocText {
  title: string;
  summary: string;
  note: string;
}

/** A doc's passage texts in seq order, under the index's passage policy. */
export type PassagesOf = (doc: DocText & { kind: string }) => string[];

export function docTextChars(doc: DocText): number {
  return doc.title.length + doc.summary.length + doc.note.length;
}

export function passageKey(text: string): string {
  return createHash('sha1').update(text).digest('hex');
}

/** The quarantine and empty-doc sentinel: never carried over, so a content
 *  change still retries a doc that failed to embed. */
function isZeroVector(vec: Buffer): boolean {
  for (let i = 0; i < vec.length; i++) if (vec[i] !== 0) return false;
  return true;
}

/**
 * Stored vectors keyed by the text hash of the passage each one embeds, or
 * null when the rows cannot be trusted to describe `oldPassages`. Before writes
 * were hash-guarded, an embed that raced an upsert could leave one version's
 * vectors on the next version's text; when the passage count moved in between,
 * the rows say so (a seq past the old layout, or a "complete" doc whose seqs
 * are not exactly 0..n-1), and nothing of such a doc is reused.
 */
export function reusableVectors(
  oldPassages: string[],
  rows: StoredVecRow[],
): Map<string, Buffer> | null {
  return reusableVectorsByKey(oldPassages.map(passageKey), rows);
}

/** reusableVectors, from the old passages' keys. */
export function reusableVectorsByKey(
  oldKeys: string[],
  rows: StoredVecRow[],
): Map<string, Buffer> | null {
  const n = oldKeys.length;
  if (n === 0 || rows.length === 0) return null;
  if (rows.some((r) => r.seq < 0 || r.seq >= n)) return null;
  if (rows.some((r) => r.seq === 0) && rows.length !== n) return null;
  const out = new Map<string, Buffer>();
  for (const row of rows) {
    if (isZeroVector(row.vec)) continue;
    out.set(oldKeys[row.seq]!, row.vec);
  }
  return out.size > 0 ? out : null;
}

export interface RemapPlan {
  rows: StoredVecRow[];
  /** Every new seq got a stored vector, seq 0 included: no inference needed. */
  complete: boolean;
}

/** The new doc's vector rows built from reusable ones (see the header). */
export function remapVectors(newPassages: string[], reuse: Map<string, Buffer>): RemapPlan {
  return remapVectorsByKey(newPassages.map(passageKey), reuse);
}

/** remapVectors, from the new passages' keys. */
export function remapVectorsByKey(newKeys: string[], reuse: Map<string, Buffer>): RemapPlan {
  const rows: StoredVecRow[] = [];
  let covered = newKeys.length > 0;
  for (let seq = 1; seq < newKeys.length; seq++) {
    const vec = reuse.get(newKeys[seq]!);
    if (vec) rows.push({ seq, vec });
    else covered = false;
  }
  const digest = newKeys.length > 0 ? reuse.get(newKeys[0]!) : undefined;
  const complete = covered && digest !== undefined;
  if (complete) rows.push({ seq: 0, vec: digest });
  return { rows, complete };
}

export interface VectorReuse {
  /** Reusable vectors of a doc about to change. Call BEFORE the doc row is
   *  updated: the stored seqs describe the old text. */
  collect(docId: number): Map<string, Buffer> | null;
  /** Write the reusable rows at the new text's seqs (after the doc's vectors
   *  were dropped). `hash` is the doc's new content hash. Returns how many
   *  vectors were kept. */
  restore(
    docId: number,
    doc: { kind: string; title: string; summary?: string; note?: string },
    hash: string,
    reuse: Map<string, Buffer>,
  ): number;
  /** The passages of a doc's text at `hash`, split elsewhere (the backfill):
   *  kept so its next change does not split that text again. */
  remember(docId: number, kind: string, hash: string, passages: string[]): void;
}

/** The writer's side of the reuse, inside its upsert transaction. */
export function createVectorReuse(db: SearchDb, passagesOf: PassagesOf): VectorReuse {
  const selectRows = db.prepare(`SELECT seq, vec FROM doc_vec WHERE doc_id = ?`);
  const selectText = db.prepare(`SELECT kind, title, summary, note, hash FROM doc WHERE id = ?`);
  const insertVec = db.prepare(`INSERT OR REPLACE INTO doc_vec (doc_id, seq, vec) VALUES (?, ?, ?)`);
  // Insertion order is recency: a hit or a write moves the doc to the end.
  const keyCache = new Map<number, { kind: string; hash: string; keys: string[] }>();
  const keep = (docId: number, kind: string, hash: string, keys: string[]): void => {
    keyCache.delete(docId);
    keyCache.set(docId, { kind, hash, keys });
    if (keyCache.size > KEY_CACHE_DOCS) keyCache.delete(keyCache.keys().next().value!);
  };
  return {
    collect(docId) {
      const rows = selectRows.all(docId) as StoredVecRow[];
      if (rows.length === 0) return null;
      const old = selectText.get(docId) as (DocText & { kind: string; hash: string }) | undefined;
      if (!old || docTextChars(old) > REUSE_MAX_TEXT_CHARS) return null;
      // The hash covers every text field, and the kind picks the policy: the
      // same pair is the same passages.
      const kept = keyCache.get(docId);
      const oldKeys = kept && kept.hash === old.hash && kept.kind === old.kind
        ? kept.keys
        : passagesOf(old).map(passageKey);
      return reusableVectorsByKey(oldKeys, rows);
    },
    restore(docId, doc, hash, reuse) {
      const text = { kind: doc.kind, title: doc.title, summary: doc.summary ?? '', note: doc.note ?? '' };
      if (docTextChars(text) > REUSE_MAX_TEXT_CHARS) return 0;
      const newKeys = passagesOf(text).map(passageKey);
      keep(docId, doc.kind, hash, newKeys);
      const plan = remapVectorsByKey(newKeys, reuse);
      for (const row of plan.rows) insertVec.run(docId, row.seq, row.vec);
      return plan.rows.length;
    },
    remember(docId, kind, hash, passages) {
      keep(docId, kind, hash, passages.map(passageKey));
    },
  };
}
