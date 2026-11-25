/**
 * Vectors for short texts that are no docs of the search index (a thread's title and ask, the
 * user's new message), from the search stack's own model (2026-11-25, the user on related threads:
 * "fuzzy match, or go through a vector database"). The model choice and when search by meaning is
 * on stay with wiring.ts: off in tests, on ephemeral servers, on a follower and wherever the
 * semantic lane is off, and then this answers null and callers use their word match alone.
 *
 * Only workers that already run are used, never one started for this: a worker is a full model
 * copy of about 2 GB, and the backfill releases its passage worker when a pass ends (review
 * 2026-11-25: a fork on nearly every message that opened a thread). The text side is a query (the
 * query worker, which searches keep up, with a deadline); the texts compared with it are passages
 * (the backfill's worker, while a pass runs), cached here by a hash of model and text, so a node's
 * threads are embedded once and not on every message. The passage batches go to the worker one
 * after another, so the backfill's own batches queue between them; one that outlives the caller's
 * deadline keeps running and fills the cache for the next call, and one whose worker went away is
 * dropped.
 */
import crypto from 'node:crypto';

export interface ShortTextEmbedder {
  /** The model's id: part of every cache key, so a model switch embeds again. */
  model: string;
  /** Which worker runs now: a lane that is false is not asked (it would start one). */
  running(): { query: boolean; passage: boolean };
  query(text: string, deadlineMs: number): Promise<Int8Array | null>;
  passages(texts: string[]): Promise<Int8Array[]>;
}

/** Cached passage vectors (about 1 KB each with the default model): a few thousand threads' worth. */
export const SHORT_VECTOR_CACHE_MAX = 4000;
/** Passages per worker job; the jobs go one after another, so the backfill's batches queue between them. */
const PASSAGE_BATCH = 16;
/** A text is cut here before it is embedded and hashed (the model reads about this many tokens of it). */
export const SHORT_TEXT_MAX_CHARS = 600;

let override: ShortTextEmbedder | null | undefined;
const cache = new Map<string, Int8Array>();
const inflight = new Map<string, Promise<void>>();

/** Test seam: the embedder every caller gets (null: none); undefined restores the search stack's. Clears the cache. */
export function setShortTextEmbedderForTests(e: ShortTextEmbedder | null | undefined): void {
  override = e;
  cache.clear();
  inflight.clear();
}

/** The search stack's embedder for short texts, or null when search by meaning is off here or its index is not open. Never throws. */
export async function shortTextEmbedder(): Promise<ShortTextEmbedder | null> {
  if (override !== undefined) return override;
  try {
    const wiring = await import('./wiring.js');
    // Only an index already open: a message's send never opens the database; its workers are asked
    // only while they run (SearchIndex.embedShortTexts).
    if (!wiring.isSearchV2Enabled() || !wiring.searchV2IndexOpen()) return null;
    const model = wiring.currentEmbedModelId();
    if (!model) return null;
    const { embedShortTexts } = wiring.getSearchV2Index();
    return { model, running: embedShortTexts.running, query: embedShortTexts.query, passages: embedShortTexts.passages };
  } catch {
    return null;
  }
}

export function shortText(text: string): string {
  return text.replace(/\s+/g, ' ').trim().slice(0, SHORT_TEXT_MAX_CHARS);
}

function keyOf(model: string, text: string): string {
  return crypto.createHash('sha1').update(model).update('\u0000').update(text).digest('hex');
}

function remember(key: string, vec: Int8Array): void {
  cache.delete(key);
  cache.set(key, vec);
  while (cache.size > SHORT_VECTOR_CACHE_MAX) {
    const oldest = cache.keys().next().value;
    if (oldest === undefined) break;
    cache.delete(oldest);
  }
}

/** How many vectors the cache holds now (tests, the related-threads log line). */
export function shortVectorsCached(): number {
  return cache.size;
}

/**
 * The passage vectors of `texts` (already cut with shortText) that are cached or embedded within
 * `deadlineMs`: a map from text to vector, missing what did not make it. The texts not cached go to
 * the passage worker only while it runs. Never throws.
 */
export async function passageVectors(e: ShortTextEmbedder, texts: readonly string[], deadlineMs: number): Promise<Map<string, Int8Array>> {
  const out = new Map<string, Int8Array>();
  const missing: Array<{ text: string; key: string }> = [];
  const waits: Array<Promise<void>> = [];
  for (const text of new Set(texts)) {
    const key = keyOf(e.model, text);
    const hit = cache.get(key);
    if (hit) { remember(key, hit); out.set(text, hit); continue; }
    const running = inflight.get(key);
    if (running) waits.push(running);
    else missing.push({ text, key });
  }
  let prev: Promise<void> = Promise.resolve();
  for (let i = 0; missing.length && e.running().passage && i < missing.length; i += PASSAGE_BATCH) {
    const batch = missing.slice(i, i + PASSAGE_BATCH);
    // Each batch after the last one, and only while the worker still runs (checked in the tick that submits it).
    const job = prev
      .then(async () => {
        if (!e.running().passage) return;
        const vecs = await e.passages(batch.map((b) => b.text));
        batch.forEach((b, j) => { if (vecs[j]) remember(b.key, vecs[j]); });
      })
      .catch(() => { /* the words lane stands alone this time; the next call asks again */ })
      .finally(() => { for (const b of batch) inflight.delete(b.key); });
    for (const b of batch) inflight.set(b.key, job);
    prev = job;
    waits.push(job);
  }
  if (waits.length) {
    let timer: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([Promise.all(waits), new Promise<void>((r) => { timer = setTimeout(r, Math.max(0, deadlineMs)); })]);
    clearTimeout(timer);
    for (const text of texts) {
      if (out.has(text)) continue;
      const vec = cache.get(keyOf(e.model, text));
      if (vec) out.set(text, vec);
    }
  }
  return out;
}

/** The query vector of `text` within `deadlineMs`, or null (also with no query worker running). Never throws. */
export async function queryVector(e: ShortTextEmbedder, text: string, deadlineMs: number): Promise<Int8Array | null> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    if (!e.running().query) return null;
    // The library keeps its own deadline; this one also bounds a fake or a hung call.
    return await Promise.race([
      e.query(text, deadlineMs),
      new Promise<null>((r) => { timer = setTimeout(() => r(null), Math.max(0, deadlineMs)); }),
    ]);
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}
