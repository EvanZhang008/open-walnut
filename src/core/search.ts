import path from 'node:path';
import { listTasks } from './task-manager.js';
import { listMemories, type MemoryEntry } from './memory.js';
import type { SearchMode } from './embedding/types.js';
import type { Task } from './types.js';

export interface SearchResult {
  type: 'task' | 'memory';
  title: string;
  snippet: string;
  path?: string;
  taskId?: string;
  parentTaskId?: string;  // populated for child tasks
  isAutoExpanded?: boolean; // true if included because parent matched (not direct hit)
  score: number;        // combined normalized score
  matchField: string;   // 'semantic' | field name of best keyword match
  keywordScore?: number;  // normalized BM25 contribution [0,1], undefined if no keyword match
  semanticScore?: number; // normalized cosine contribution [0,1], undefined if no vector match
}

export interface SearchOptions {
  limit?: number;
  types?: ('task' | 'memory')[];
  category?: string;
  mode?: SearchMode;
}

export function extractSnippet(
  content: string,
  query: string,
  contextChars: number = 40,
): string {
  const lower = content.toLowerCase();
  const terms = query
    .toLowerCase()
    .split(/\s+/)
    .filter((t) => t.length > 0);

  let firstIndex = -1;
  for (const term of terms) {
    const idx = lower.indexOf(term);
    if (idx !== -1 && (firstIndex === -1 || idx < firstIndex)) {
      firstIndex = idx;
    }
  }

  if (firstIndex === -1) {
    const plain = content.replace(/\n/g, ' ').trim();
    return plain.length > contextChars * 2
      ? plain.slice(0, contextChars * 2) + '...'
      : plain;
  }

  let start = Math.max(0, firstIndex - contextChars);
  let end = Math.min(content.length, firstIndex + contextChars);

  // Expand to word boundaries
  if (start > 0) {
    const spaceAfter = content.indexOf(' ', start);
    if (spaceAfter !== -1 && spaceAfter < firstIndex) {
      start = spaceAfter + 1;
    }
  }
  if (end < content.length) {
    const spaceBefore = content.lastIndexOf(' ', end);
    if (spaceBefore > firstIndex) {
      end = spaceBefore;
    }
  }

  let snippet = content.slice(start, end).replace(/\n/g, ' ').trim();
  if (start > 0) snippet = '...' + snippet;
  if (end < content.length) snippet = snippet + '...';

  return snippet;
}

export function scoreMatch(text: string, query: string, weight: number): number {
  if (!text) return 0;
  const lower = text.toLowerCase();
  const terms = query
    .toLowerCase()
    .split(/\s+/)
    .filter((t) => t.length > 0);

  if (terms.length === 0) return 0;

  let score = 0;
  for (const term of terms) {
    if (lower.includes(term)) {
      score += weight;
      // Bonus for exact word boundary match
      const regex = new RegExp(`\\b${escapeRegex(term)}\\b`, 'i');
      if (regex.test(text)) {
        score += weight * 0.5;
      }
      // TF bonus: multiple occurrences signal stronger relevance.
      // log(count) dampens: 8 hits ≈ 2× single hit, not 8×.
      const count = countOccurrences(lower, term);
      if (count > 1) {
        score += weight * 0.3 * Math.log(count);
      }
    }
  }
  return score;
}

function countOccurrences(text: string, term: string): number {
  let count = 0;
  let pos = 0;
  while ((pos = text.indexOf(term, pos)) !== -1) {
    count++;
    pos += term.length;
  }
  return count;
}

function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function recencyBonus(updatedAt: string): number {
  const now = Date.now();
  const updated = new Date(updatedAt).getTime();
  const daysAgo = (now - updated) / (1000 * 60 * 60 * 24);
  if (daysAgo > 30) return 0;
  return (30 - daysAgo) * 0.1;
}

// ── Reciprocal Rank Fusion ──

/**
 * Merge two ranked result lists using RRF.
 * alpha = BM25 weight (0-1), k = RRF constant (default 60).
 */
export function normalizedFuse(
  bm25Results: SearchResult[],
  vectorResults: SearchResult[],
  alpha: number = 0.4,
): SearchResult[] {
  // Build score maps
  const bm25Scores = new Map(bm25Results.map((r) => [resultKey(r), r.score]));
  const vecScores = new Map(vectorResults.map((r) => [resultKey(r), r.score]));

  // Min-max normalize BM25 scores to [0, 1]
  const bm25Vals = [...bm25Scores.values()];
  const bm25Min = Math.min(...bm25Vals);
  const bm25Max = Math.max(...bm25Vals);
  const bm25Range = bm25Max - bm25Min || 1;
  const bm25Norm = new Map<string, number>();
  for (const [k, v] of bm25Scores) {
    bm25Norm.set(k, bm25Vals.length === 1 ? 1.0 : (v - bm25Min) / bm25Range);
  }

  // Min-max normalize cosine scores to [0, 1] using result set min/max
  // (standard approach used by Weaviate, OpenSearch, Vespa, Airbnb)
  const vecVals = [...vecScores.values()];
  const vecMin = Math.min(...vecVals);
  const vecMax = Math.max(...vecVals);
  const vecRange = vecMax - vecMin || 1;
  const vecNorm = new Map<string, number>();
  for (const [k, v] of vecScores) {
    vecNorm.set(k, vecVals.length === 1 ? 1.0 : (v - vecMin) / vecRange);
  }

  // Collect all unique results; prefer BM25 object (richer snippets from keyword match)
  const allKeys = new Set([...bm25Scores.keys(), ...vecScores.keys()]);
  const resultMap = new Map<string, SearchResult>();
  for (const r of bm25Results) resultMap.set(resultKey(r), r);
  for (const r of vectorResults) {
    if (!resultMap.has(resultKey(r))) resultMap.set(resultKey(r), r);
  }

  // Weighted average: both lists contribute their normalized score
  // Results in only one list still get that list's contribution (no penalty)
  const scored: Array<{ key: string; score: number; bn?: number; vn?: number }> = [];
  for (const key of allKeys) {
    const bn = bm25Norm.get(key);
    const vn = vecNorm.get(key);
    let score: number;
    if (bn != null && vn != null) {
      score = alpha * bn + (1 - alpha) * vn; // found by both
    } else if (bn != null) {
      score = alpha * bn; // keyword only
    } else {
      score = (1 - alpha) * vn!; // semantic only — cross-language, related concepts
    }
    scored.push({ key, score, bn, vn });
  }

  scored.sort((a, b) => b.score - a.score);

  return scored.map((s) => {
    const result = resultMap.get(s.key)!;
    return {
      ...result,
      score: s.score,
      keywordScore: s.bn != null ? Math.round(s.bn * 1000) / 1000 : undefined,
      semanticScore: s.vn != null ? Math.round(s.vn * 1000) / 1000 : undefined,
    };
  });
}

function resultKey(r: SearchResult): string {
  return r.taskId ?? r.path ?? r.title;
}

// ── Vector search helpers ──

/**
 * Embed the query once via Ollama. Returns null if unavailable.
 * Uses 30m keep_alive to reduce cold-start frequency.
 */
async function embedQuery(query: string): Promise<Float32Array | null> {
  try {
    const { embed } = await import('./embedding/client.js');
    return await embed(query);
  } catch {
    return null;
  }
}

/**
 * Run vector search for both tasks and memory using a pre-computed query vector.
 * Single function avoids redundant dynamic imports and embed calls.
 */
async function vectorSearchAll(
  queryVec: Float32Array,
  query: string,
  tasks: Task[],
  searchTypes: ('task' | 'memory')[],
  limit: number,
  minCosine: number = 0.5,
): Promise<SearchResult[]> {
  try {
    const [{ getAllTaskEmbeddings, getAllChunkEmbeddings }, { topK, cosineSimilarity }] =
      await Promise.all([
        import('./embedding/store.js'),
        import('./embedding/cosine.js'),
      ]);

    const results: SearchResult[] = [];

    if (searchTypes.includes('task')) {
      const allEmbeddings = getAllTaskEmbeddings();
      if (allEmbeddings.length > 0) {
        const candidates = allEmbeddings.map((e) => ({
          id: e.task_id,
          embedding: e.embedding,
        }));
        const topResults = topK(queryVec, candidates, limit);
        const taskMap = new Map(tasks.map((t) => [t.id, t]));

        for (const r of topResults) {
          if (r.score <= minCosine) continue;
          const task = taskMap.get(r.id);
          results.push({
            type: 'task',
            title: task?.title ?? r.id,
            snippet: task ? extractSnippet(task.title + '. ' + (task.description || task.summary || ''), query) : '',
            taskId: r.id,
            parentTaskId: task?.parent_task_id,
            score: r.score,
            matchField: 'semantic',
          });
        }
      }
    }

    if (searchTypes.includes('memory')) {
      const allChunks = getAllChunkEmbeddings();
      if (allChunks.length > 0) {
        const scored = allChunks.map((e) => ({
          ...e,
          score: cosineSimilarity(queryVec, e.embedding),
        }));
        scored.sort((a, b) => b.score - a.score);

        for (const r of scored.slice(0, limit)) {
          if (r.score <= minCosine) continue;
          results.push({
            type: 'memory',
            title: path.basename(r.path, '.md'),
            snippet: extractSnippet(r.text, query),
            path: r.path,
            score: r.score,
            matchField: 'semantic',
          });
        }
      }
    }

    return results;
  } catch {
    return [];
  }
}

// ── BM25 keyword scoring ──

function bm25ScoreTasks(tasks: Task[], query: string): SearchResult[] {
  const results: SearchResult[] = [];
  for (const task of tasks) {
    let bestScore = 0;
    let matchField = '';

    const titleScore = scoreMatch(task.title, query, 3);
    if (titleScore > bestScore) { bestScore = titleScore; matchField = 'title'; }

    if (task.description) {
      const descScore = scoreMatch(task.description, query, 2.5);
      if (descScore > bestScore) { bestScore = descScore; matchField = 'description'; }
    }

    if (task.summary) {
      const sumScore = scoreMatch(task.summary, query, 2);
      if (sumScore > bestScore) { bestScore = sumScore; matchField = 'summary'; }
    }

    if (task.note) {
      const noteScore = scoreMatch(task.note, query, 1.5);
      if (noteScore > bestScore) { bestScore = noteScore; matchField = 'note'; }
    }

    const catScore = scoreMatch(task.category, query, 1);
    if (catScore > bestScore) { bestScore = catScore; matchField = 'category'; }

    const projScore = scoreMatch(task.project, query, 1);
    if (projScore > bestScore) { bestScore = projScore; matchField = 'project'; }

    if (task.tags?.length) {
      const tagsText = task.tags.join(' ');
      const tagScore = scoreMatch(tagsText, query, 2);
      if (tagScore > bestScore) { bestScore = tagScore; matchField = 'tags'; }
    }

    if (bestScore > 0) {
      const snippetSource =
        matchField === 'description' ? task.description
        : matchField === 'summary' ? task.summary
        : matchField === 'note' ? task.note
        : matchField === 'tags' ? (task.tags ?? []).join(', ')
        : task.title;
      results.push({
        type: 'task',
        title: task.title,
        snippet: extractSnippet(snippetSource, query),
        taskId: task.id,
        parentTaskId: task.parent_task_id,
        score: bestScore,
        matchField,
      });
    }
  }
  return results;
}

async function bm25ScoreMemory(
  query: string,
  limit: number,
  category?: string,
): Promise<SearchResult[]> {
  const results: SearchResult[] = [];

  // Try FTS5 first
  try {
    const { searchIndex } = await import('./memory-index.js');
    const ftsResults = searchIndex(query, limit);
    if (ftsResults.length > 0) {
      const maxFts = ftsResults[0].score;
      for (const r of ftsResults) {
        results.push({
          type: 'memory',
          title: path.basename(r.path, '.md'),
          snippet: extractSnippet(r.text, query),
          path: r.path,
          score: (r.score / maxFts) * 5,
          matchField: 'content',
        });
      }
      return results;
    }
  } catch { /* FTS unavailable */ }

  // Fallback: in-memory scan
  const memories: MemoryEntry[] = category ? listMemories(category) : listMemories();
  for (const mem of memories) {
    let bestScore = 0;
    let matchField = '';

    const titleScore = scoreMatch(mem.title, query, 3);
    if (titleScore > bestScore) { bestScore = titleScore; matchField = 'title'; }

    const contentScore = scoreMatch(mem.content, query, 1);
    if (contentScore > bestScore) { bestScore = contentScore; matchField = 'content'; }

    if (bestScore > 0) {
      bestScore += recencyBonus(mem.updatedAt);
      results.push({
        type: 'memory',
        title: mem.title,
        snippet: extractSnippet(mem.content, query),
        path: mem.path,
        score: bestScore,
        matchField,
      });
    }
  }
  return results;
}

// ── Main search function ──

export async function search(
  query: string,
  options: SearchOptions = {},
): Promise<SearchResult[]> {
  const limit = options.limit ?? 20;
  const types = options.types ?? ['task', 'memory'];
  const mode = options.mode ?? 'hybrid';

  const normalizedQuery = query.trim();
  if (normalizedQuery.length === 0) return [];

  // Load tasks once — shared by BM25, vector search, and child expansion
  const tasks = types.includes('task') ? await listTasks() : [];

  // ── keyword-only mode ──
  if (mode === 'keyword') {
    const bm25Results: SearchResult[] = [];
    if (types.includes('task')) bm25Results.push(...bm25ScoreTasks(tasks, normalizedQuery));
    if (types.includes('memory')) bm25Results.push(...await bm25ScoreMemory(normalizedQuery, limit, options.category));
    bm25Results.sort((a, b) => b.score - a.score);
    return expandChildTasks(bm25Results.slice(0, limit), tasks);
  }

  // ── semantic-only mode ──
  if (mode === 'semantic') {
    const queryVec = await embedQuery(normalizedQuery);
    if (!queryVec) return [];
    const vecResults = await vectorSearchAll(queryVec, normalizedQuery, tasks, types, limit, 0.5);
    vecResults.sort((a, b) => b.score - a.score);
    return expandChildTasks(vecResults.slice(0, limit), tasks);
  }

  // ── hybrid mode: run BM25 and vector in parallel ──
  const vecMinCosine = 0.3;
  const vecTopK = Math.max(limit * 3, 200);

  // Start BM25 and embedding concurrently
  const bm25Promise = (async () => {
    const results: SearchResult[] = [];
    if (types.includes('task')) results.push(...bm25ScoreTasks(tasks, normalizedQuery));
    if (types.includes('memory')) results.push(...await bm25ScoreMemory(normalizedQuery, limit, options.category));
    return results;
  })();

  const vectorPromise = (async () => {
    const queryVec = await embedQuery(normalizedQuery);
    if (!queryVec) return [];
    return vectorSearchAll(queryVec, normalizedQuery, tasks, types, vecTopK, vecMinCosine);
  })();

  const [bm25Results, vectorResults] = await Promise.all([bm25Promise, vectorPromise]);

  if (vectorResults.length === 0) {
    // No vector results (Ollama unavailable or empty index) — fall back to BM25
    bm25Results.sort((a, b) => b.score - a.score);
    return expandChildTasks(bm25Results.slice(0, limit), tasks);
  }

  // RRF fusion
  bm25Results.sort((a, b) => b.score - a.score);
  const fused = normalizedFuse(bm25Results, vectorResults, 0.4);
  return expandChildTasks(fused.slice(0, limit), tasks);
}

/**
 * Auto-expand child tasks for matched parents.
 * For each parent task in results, inserts its children right after it
 * (if not already present). Children are marked with isAutoExpanded=true.
 * Accepts pre-loaded tasks to avoid redundant disk reads.
 */
function expandChildTasks(results: SearchResult[], allTasks: Task[]): SearchResult[] {
  // Collect parent task IDs (tasks that are NOT children themselves)
  const taskResults = results.filter((r) => r.type === 'task' && !r.parentTaskId);
  if (taskResults.length === 0) return results;

  const parentFullIds = taskResults.map((r) => r.taskId!);
  const existingIds = new Set(results.filter((r) => r.taskId).map((r) => r.taskId!));

  // parent_task_id may be a prefix — resolve to full parent ID via prefix match
  const childrenByParent = new Map<string, typeof allTasks>();
  for (const task of allTasks) {
    if (!task.parent_task_id || existingIds.has(task.id)) continue;
    // Match: task.parent_task_id is a prefix of one of our parent full IDs
    const matchedParent = parentFullIds.find((pid) => pid.startsWith(task.parent_task_id!));
    if (matchedParent) {
      const children = childrenByParent.get(matchedParent) ?? [];
      children.push(task);
      childrenByParent.set(matchedParent, children);
    }
  }

  if (childrenByParent.size === 0) return results;

  // Insert children after their parent
  const expanded: SearchResult[] = [];
  for (const result of results) {
    expanded.push(result);
    if (result.type === 'task' && result.taskId && childrenByParent.has(result.taskId)) {
      const children = childrenByParent.get(result.taskId)!;
      for (const child of children) {
        expanded.push({
          type: 'task',
          title: child.title,
          snippet: '',
          taskId: child.id,
          parentTaskId: child.parent_task_id,
          isAutoExpanded: true,
          score: result.score * 0.9,
          matchField: 'child',
        });
      }
    }
  }

  return expanded;
}
