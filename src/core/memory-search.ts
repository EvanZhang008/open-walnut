/**
 * Memory + Notes search via QMD hybrid search.
 *
 * Strategy: search each store ONCE (not per-collection) so QMD can globally
 * rank results across collections. Then apply source weights and temporal decay.
 *
 * Accepts multiple queries — each becomes a lex + vec search in QMD's RRF fusion,
 * dramatically improving recall for keyword-miss cases (e.g. doc says "travel" but
 * query says "trip"). The caller (Claude) generates focused 2-4 word queries.
 */
import { getMemoryStore, getNotesStore, getTaskStore, getSessionStore } from './qmd-store.js';
import { temporalDecay } from './temporal-decay.js';
import { log } from '../logging/index.js';
import type { HybridQueryResult } from '@tobilu/qmd';

// Source weights and decay config — applied AFTER QMD global ranking.
// Keys use full source names (memory_* / note_*) to avoid ambiguity.
const SOURCE_WEIGHTS: Record<string, { weight: number; decays: boolean; halfLife?: number }> = {
  memory_topic:      { weight: 1.3, decays: false },
  memory_global:     { weight: 1.3, decays: false },
  memory_project:    { weight: 1.1, decays: false },
  memory_daily:      { weight: 1.0, decays: true, halfLife: 30 },
  memory_repo:       { weight: 1.1, decays: false },
  memory_compaction: { weight: 0.8, decays: true, halfLife: 30 },
  memory_session:    { weight: 0.8, decays: true, halfLife: 14 },
  // Skills are distilled stable knowledge — high weight, no decay.
  memory_skill:      { weight: 1.2, decays: false },
  // ONE whole-vault collection (qmd-store.ts widened the notes store from 4 PARA
  // folders to a single `vault` collection). Source name is `note_vault`.
  // BEHAVIOR CHANGE (surfaced): the old per-folder bias (note_resources=0.9,
  // note_archive=0.5) and the Archive includeByDefault:false exclusion are gone —
  // archived/resource notes are now searched at full weight. If folder-prefix
  // down-weighting is wanted later, derive it from the `path` prefix at rank time.
  note_vault:        { weight: 1.0, decays: false },
  task:              { weight: 1.0, decays: false },
  session:           { weight: 0.9, decays: true, halfLife: 30 },
};

// Minimum QMD score to include a result (filters out noise)
const MIN_SCORE = 0.15;

export interface MemorySearchResult {
  filepath: string;
  title: string;
  snippet: string;
  score: number;
  finalScore: number;
  source: string;
  collection: string;
  taskId?: string;
  sessionId?: string;
}

/**
 * Search memory and/or notes using multiple focused queries.
 *
 * Each query string becomes both a lex (BM25) and vec (vector) search in QMD's
 * RRF fusion pipeline. This gives much better recall than a single long query
 * because BM25 uses AND — missing one word excludes the document entirely.
 */
export async function memoryNotesSearch(
  queries: string | string[],
  sources?: string[],
  limit: number = 15,
): Promise<MemorySearchResult[]> {
  const queryList = Array.isArray(queries) ? queries : [queries];
  if (queryList.length === 0) return [];

  // Determine which stores to search
  const activeSources = sources ?? Object.keys(SOURCE_WEIGHTS).filter(s => s.startsWith('memory_'));
  const wantMemory = activeSources.some(s => s.startsWith('memory_'));
  const wantNotes = activeSources.some(s => s.startsWith('note_'));
  const wantTask = activeSources.includes('task');
  const wantSession = activeSources.includes('session');

  // Collections to include per store (strip prefix for QMD)
  const memoryCollections = activeSources
    .filter(s => s.startsWith('memory_'))
    .map(s => s.replace('memory_', ''));
  const notesCollections = activeSources
    .filter(s => s.startsWith('note_'))
    .map(s => s.replace('note_', ''));

  const hasBoth = wantMemory && wantNotes;
  const memoryLimit = hasBoth ? Math.ceil(limit * 0.6) : limit;
  const notesLimit = hasBoth ? Math.max(2, limit - memoryLimit) : limit;

  // Convert query strings to QMD ExpandedQuery format.
  // Each query becomes both a lex (BM25 keyword) and vec (vector similarity) search.
  // QMD's RRF fusion merges all ranked lists — more queries = better recall.
  //
  // Vec queries do NOT support structured search operators (negation `-term`,
  // grouping `(...)`, etc.). Passing them through causes QMD to throw
  // "Negation (-term) is not supported in vec/hyde queries", which silently
  // drops all results. Strip operators for vec; keep raw query for lex
  // (which handles them natively).
  const sanitizeForVec = (q: string): string =>
    q.replace(/-/g, ' ')                  // strip all dashes (negation and hyphenation)
     .replace(/[()><!~^"]/g, ' ')         // strip structured search operators
     .replace(/\s{2,}/g, ' ')             // collapse whitespace
     .trim();

  const expandedQueries = queryList.flatMap(q => [
    { type: 'lex' as const, query: q },
    { type: 'vec' as const, query: sanitizeForVec(q) },
  ]);

  async function searchStore(
    storeFn: () => ReturnType<typeof getMemoryStore>,
    storeLabel: string,
    collections: string[],
    storeLimit: number,
  ): Promise<MemorySearchResult[]> {
    if (collections.length === 0) return [];
    try {
      const store = await storeFn();
      const raw: HybridQueryResult[] = await store.search({
        queries: expandedQueries,
        limit: storeLimit * 3, // over-fetch to allow filtering
        rerank: true,
      });
      log.agent.info(`memory search ${storeLabel}: ${raw.length} results, queries=${queryList.length}`, {
        queries: queryList,
        top3: raw.slice(0, 3).map(r => ({ file: r.file?.slice(-50), score: r.score, title: r.title?.slice(0, 30) })),
      });

      const collectionSet = new Set(collections);
      return raw
        .filter(r => r.score >= MIN_SCORE)
        .filter(r => {
          // Post-filter to requested collections
          const m = r.file?.match(/^qmd:\/\/([^/]+)\//);
          return !m || collectionSet.size === 0 || collectionSet.has(m[1]);
        })
        .map((r) => {
          const virtualFile = r.file ?? '';
          const absPath = store.internal.resolveVirtualPath(virtualFile) ?? virtualFile;
          const match = virtualFile.match(/^qmd:\/\/([^/]+)\//);
          const collection = match?.[1] ?? '';
          const sourcePrefix = storeLabel === 'memory' ? 'memory_' : 'note_';
          const source = `${sourcePrefix}${collection}`;
          const config = SOURCE_WEIGHTS[source];
          const weight = config?.weight ?? 1.0;
          const decay = config?.decays ? temporalDecay(virtualFile, config.halfLife ?? 30) : 1.0;

          return {
            filepath: absPath,
            title: r.title ?? '',
            snippet: r.bestChunk ?? '',
            score: r.score ?? 0,
            source,
            collection,
            finalScore: (r.score ?? 0) * weight * decay,
          };
        })
        .sort((a, b) => b.finalScore - a.finalScore)
        .slice(0, storeLimit);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes('Dimension mismatch')) {
        log.agent.error(`memory search ${storeLabel}: embedding dimension mismatch — run re-index from Settings`, { error: msg });
      } else {
        log.agent.warn(`memory search ${storeLabel} failed`, { error: msg });
      }
      // Rethrow so callers (search.ts) can detect failure and fall back.
      // Previously this returned [] which made failures invisible — the caller
      // couldn't distinguish "QMD searched and found nothing" from "QMD crashed".
      throw err;
    }
  }

  // Search single-collection stores (task, session) — no collection filtering needed
  async function searchSingleStore(
    storeFn: () => ReturnType<typeof getMemoryStore>,
    sourceLabel: string,
    storeLimit: number,
    idExtractor?: (virtualPath: string) => string | undefined,
  ): Promise<MemorySearchResult[]> {
    try {
      const store = await storeFn();
      const raw: HybridQueryResult[] = await store.search({
        queries: expandedQueries,
        limit: storeLimit * 3,
        rerank: true,
      });
      log.agent.info(`memory search ${sourceLabel}: ${raw.length} results, queries=${queryList.length}`, {
        queries: queryList,
        top3: raw.slice(0, 3).map(r => ({ file: r.file?.slice(-50), score: r.score, title: r.title?.slice(0, 30) })),
      });

      const config = SOURCE_WEIGHTS[sourceLabel];
      const weight = config?.weight ?? 1.0;

      return raw
        .filter(r => r.score >= MIN_SCORE)
        .map((r) => {
          const virtualFile = r.file ?? '';
          const decay = config?.decays ? temporalDecay(virtualFile, config.halfLife ?? 30) : 1.0;
          const extractedId = idExtractor?.(virtualFile);

          return {
            filepath: virtualFile,
            title: r.title ?? '',
            snippet: r.bestChunk ?? '',
            score: r.score ?? 0,
            source: sourceLabel,
            collection: sourceLabel,
            finalScore: (r.score ?? 0) * weight * decay,
            ...(sourceLabel === 'task' && extractedId ? { taskId: extractedId } : {}),
            ...(sourceLabel === 'session' && extractedId ? { sessionId: extractedId } : {}),
          };
        })
        .sort((a, b) => b.finalScore - a.finalScore)
        .slice(0, storeLimit);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.agent.warn(`memory search ${sourceLabel} failed`, { error: msg });
      throw err;
    }
  }

  // Extract taskId from virtual path: "task-mm6ovgtn-e1b8" → "mm6ovgtn-e1b8"
  const extractTaskId = (vp: string): string | undefined => {
    const m = vp.match(/^(?:qmd:\/\/[^/]+\/)?task-(.+)$/);
    return m?.[1];
  };

  // Extract sessionId from virtual path: "sess-abc123" → "abc123"
  const extractSessionId = (vp: string): string | undefined => {
    const m = vp.match(/^(?:qmd:\/\/[^/]+\/)?sess-(.+)$/);
    return m?.[1];
  };

  // Search all stores in parallel. allSettled isolates per-store failures so one
  // broken store doesn't kill results from healthy stores.
  const settled = await Promise.allSettled([
    wantMemory ? searchStore(getMemoryStore, 'memory', memoryCollections, memoryLimit) : Promise.resolve([]),
    wantNotes ? searchStore(getNotesStore, 'notes', notesCollections, notesLimit) : Promise.resolve([]),
    wantTask ? searchSingleStore(getTaskStore, 'task', limit, extractTaskId) : Promise.resolve([]),
    wantSession ? searchSingleStore(getSessionStore, 'session', limit, extractSessionId) : Promise.resolve([]),
  ]);

  const results: MemorySearchResult[] = [];
  const storeLabels = ['memory', 'notes', 'task', 'session'];
  const wanted = [wantMemory, wantNotes, wantTask, wantSession];
  let anyWantedFailed = false;

  for (let i = 0; i < settled.length; i++) {
    const s = settled[i];
    if (s.status === 'fulfilled') {
      results.push(...s.value);
    } else if (wanted[i]) {
      // A store the caller explicitly asked for failed — propagate so caller
      // can fall back (e.g. search.ts falls back to BM25 for tasks).
      anyWantedFailed = true;
    }
  }

  if (anyWantedFailed && results.length === 0) {
    // All requested stores failed — throw so caller can fall back
    const failedStores = storeLabels.filter((_, i) => wanted[i] && settled[i].status === 'rejected');
    throw new Error(`QMD search failed for: ${failedStores.join(', ')}`);
  }

  return results
    .sort((a, b) => b.finalScore - a.finalScore)
    .slice(0, limit);
}
