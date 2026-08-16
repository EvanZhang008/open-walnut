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
import { CJK_RUN_RE, MIN_TERM_CHARS } from './cjk.js';
import { getMemoryStore, getNotesStore, getTaskStore, getSessionStore } from './qmd-store.js';
import { runQmdReadWork } from './qmd-work-queue.js';
import { timed } from './observability/metrics.js';
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

// Minimum QMD reranked score to include a result. This is QMD's blend of RRF
// position and reranker relevance, not a standalone confidence probability.
// No-rerank mode uses 1 / rank, so applying this threshold there would silently
// cap every interactive result set at six rows.
const MIN_RERANKED_BLEND_SCORE = 0.15;

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

export interface MemorySearchOptions {
  /**
   * QMD's local reranker quality pass. **Defaults to FALSE — opt IN, never out.**
   *
   * The reranker is a native llama.cpp cross-encoder. It does not merely cost
   * latency, it BLOCKS THE NODE EVENT LOOP while it scores, and every caller in
   * this process tree (web routes AND agent tools — the agent loop runs inside
   * the web server process) therefore froze the entire app when it ran. Measured
   * on a real vault: `memory_notes_search` 28.7s/2949ms-stall, `task_search`
   * 14.7s/609ms-stall, `/api/search?types=memory` 13-20s/11026ms-stall. Same
   * failure class as any sync native call on the event loop.
   *
   * It used to default to TRUE, which meant every new caller silently opted into
   * an app-wide freeze. The default is now safe-by-construction: you cannot
   * accidentally block the server, you can only deliberately choose to.
   *
   * Quality cost of it being off, measured A/B on 8 real queries: the #1 result
   * was IDENTICAL every time; only the mid/tail order shifts.
   *
   * Before setting this true: the caller must not be on the server's event loop
   * (move it to a worker, like the QMD index worker). Do not flip it on a route,
   * a tool, or anything the web process awaits.
   */
  rerank?: boolean;
  /** Candidate over-fetch before source/path filtering. Default 3. */
  overfetchMultiplier?: number;
}

/**
 * Cap on lex queries emitted per input query. Each list is one SYNCHRONOUS
 * better-sqlite3 FTS query PER COLLECTION (the memory store has ~9), on the
 * web server's event loop — so the real multiplier is cap × collections.
 * Measured ~3ms per FTS query on an 8k-doc index; 4 lists keeps the worst
 * case well under the event-loop budget while covering original + residue +
 * the two longest CJK runs.
 */
const MAX_LEX_QUERIES = 4;

/**
 * Split a query containing CJK into multiple lex queries so FTS5 keyword
 * search survives AND-annihilation.
 *
 * Why: the FTS index keeps a whole contiguous CJK run as ONE token (see
 * cjk.ts — e.g. doc text "能否自动重试" indexes as the single token
 * `能否自动重试`). QMD joins query terms with AND and matches each as a token
 * PREFIX — so query `timeout 自动重试` compiles to
 * `"timeout"* AND "自动重试"*`, the CJK term fails to prefix-match mid-run
 * tokens, and the AND annihilates the whole keyword lane (0 rows). Ranking
 * then falls back to vector-only, which is how unrelated docs reached #1.
 * The same annihilation hits pure-CJK multi-word queries (`超时 重试`), so the
 * split applies whenever a CJK query has 2+ terms, not only mixed-script.
 *
 * What actually carries the fix: the RESIDUE list (non-CJK words). A per-run
 * lex query like `"自动重试"*` still only matches when the run PREFIXES the
 * indexed token (`能否自动重试` → 0 rows), so the per-run lists help only on
 * prefix-aligned docs. Do NOT "simplify" this by dropping the residue list —
 * that reverts the bug. Each emitted list enters QMD's RRF fusion as an
 * independent ranked list (OR-ish semantics); QMD gives its 2x weight to the
 * first NON-EMPTY list, so when the original AND query returns 0 rows the
 * boost transfers to the residue list, which is the desired outcome.
 *
 * The vec lane deliberately stays ONE whole-sentence query — splitting it
 * would multiply embedBatch work and dilute the semantic signal.
 */
export function buildLexQueries(query: string): string[] {
  const q = query.trim();
  if (!q) return [];
  // Quoted phrases / negation are precise lex operator syntax — don't rewrite.
  // Note this also bails on CLI-flag-looking queries (`--verbose 重试`), which
  // degrade to the old single-list behavior rather than anything worse.
  if (q.includes('"') || /(^|\s)-\S/.test(q)) return [q];
  const allRuns = q.match(CJK_RUN_RE) ?? [];
  if (allRuns.length === 0) return [q];

  // Residue = non-CJK words. Keep only real alphanumeric tokens: CJK
  // punctuation (。，、) is Script=Common so "自动重试。" would otherwise emit
  // "。" as a lex list, and a bare digit residue ("重试3次" → "3") compiles to
  // `"3"*` which matches half the corpus — a junk RRF list that pushes noise up.
  const residueTokens = q
    .replace(CJK_RUN_RE, ' ')
    .split(/\s+/)
    .map((t) => t.replace(/[^\p{L}\p{N}'_-]/gu, ''))
    .filter((t) => t.length >= MIN_TERM_CHARS);
  const residue = residueTokens.join(' ');

  // No residue and at most one CJK run: single-term queries never
  // AND-annihilate, nothing to split.
  if (!residue && allRuns.length < 2) return [q];

  const out = [q];
  if (residue) out.push(residue);
  // Per-run lists. When the cap forces a choice, keep the LONGEST runs (most
  // selective — the ones worth the FTS cost), but emit survivors in original
  // query order so the list order mirrors what the user typed. Single-char
  // runs are noise prefixes and are skipped. splitQueryTerms keeps all 2+ char
  // runs for coverage ranking, so capped-out runs still count toward coverage;
  // they are just not lex-searched.
  const eligible = allRuns.filter((r) => r.length >= MIN_TERM_CHARS);
  const budget = Math.max(0, MAX_LEX_QUERIES - out.length);
  const kept = new Set(
    [...eligible].sort((a, b) => b.length - a.length).slice(0, budget),
  );
  for (const run of eligible) {
    if (kept.has(run)) out.push(run);
  }
  return out;
}

/**
 * Search memory and/or notes using multiple focused queries.
 *
 * Each query string becomes both a lex (BM25) and vec (vector) search in QMD's
 * RRF fusion pipeline. This gives much better recall than a single long query
 * because BM25 uses AND — missing one word excludes the document entirely.
 */
async function memoryNotesSearchUnlocked(
  queries: string | string[],
  sources?: string[],
  limit: number = 15,
  pathPrefix?: string,
  options: MemorySearchOptions = {},
): Promise<MemorySearchResult[]> {
  const queryList = Array.isArray(queries) ? queries : [queries];
  if (queryList.length === 0) return [];

  // Resolved ONCE: the two store-search paths below must agree, and the score
  // filter must match the score SEMANTICS this produces (reranked = blended
  // score; not reranked = 1/rank, where MIN_RERANKED_BLEND_SCORE would wrongly
  // truncate every result set to six rows). See MemorySearchOptions.rerank for
  // why the default is false.
  const rerank = options.rerank ?? false;

  // Optional path scoping: keep only results whose path WITHIN its collection
  // starts with this prefix (e.g. 'walnut/overview/history/' on memory_skill,
  // or '2026-06' on memory_daily as a cheap time filter). QMD virtual paths
  // are qmd://<collection>/<relative-path>, so matching the segment after the
  // collection is collection-root-relative and store-location independent.
  const normalizedPrefix = pathPrefix?.replace(/^\.?\//, '').trim() || undefined;
  const matchesPathPrefix = (virtualFile: string): boolean => {
    if (!normalizedPrefix) return true;
    const rel = virtualFile.replace(/^qmd:\/\/[^/]+\//, '');
    return rel.startsWith(normalizedPrefix);
  };

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
    ...buildLexQueries(q).map(lex => ({ type: 'lex' as const, query: lex })),
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
        // Over-fetch to allow post-filtering; a narrow path prefix discards
        // most hits, so fetch deeper when one is set.
        limit: storeLimit * (normalizedPrefix ? 8 : (options.overfetchMultiplier ?? 3)),
        rerank,
      });
      log.agent.info(`memory search ${storeLabel}: ${raw.length} results, queries=${queryList.length}`, {
        queries: queryList,
        top3: raw.slice(0, 3).map(r => ({ file: r.file?.slice(-50), score: r.score, title: r.title?.slice(0, 30) })),
      });

      const collectionSet = new Set(collections);
      return raw
        .filter(r => !rerank || r.score >= MIN_RERANKED_BLEND_SCORE)
        .filter(r => {
          // Post-filter to requested collections
          const m = r.file?.match(/^qmd:\/\/([^/]+)\//);
          return !m || collectionSet.size === 0 || collectionSet.has(m[1]);
        })
        .filter(r => matchesPathPrefix(r.file ?? ''))
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
        limit: storeLimit * (options.overfetchMultiplier ?? 3),
        rerank,
      });
      log.agent.info(`memory search ${sourceLabel}: ${raw.length} results, queries=${queryList.length}`, {
        queries: queryList,
        top3: raw.slice(0, 3).map(r => ({ file: r.file?.slice(-50), score: r.score, title: r.title?.slice(0, 30) })),
      });

      const config = SOURCE_WEIGHTS[sourceLabel];
      const weight = config?.weight ?? 1.0;

      return raw
        .filter(r => !rerank || r.score >= MIN_RERANKED_BLEND_SCORE)
        .filter(r => matchesPathPrefix(r.file ?? ''))
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

export function memoryNotesSearch(
  queries: string | string[],
  sources?: string[],
  limit: number = 15,
  pathPrefix?: string,
  options: MemorySearchOptions = {},
): Promise<MemorySearchResult[]> {
  // Metric wraps queue wait + search — end-to-end is what callers feel. A rerank
  // regression (the 5-28s freeze family) shows up here as a p90 cliff long
  // before a user files "search is slow".
  return timed('search.memory_notes', () => runQmdReadWork(() =>
    memoryNotesSearchUnlocked(queries, sources, limit, pathPrefix, options)),
  { rerank: String(options.rerank ?? false) });
}
