import { log } from '../logging/index.js';
import { timed } from './observability/metrics.js';
import { CLOUD_MODE } from '../constants.js';
import { CJK_CHAR_RE, splitQueryTerms } from './cjk.js';
import { listTasks } from './task-manager.js';
import { listSessions } from './session-tracker.js';
import type { SessionRecord, Task } from './types.js';

export interface SearchResult {
  type: 'task' | 'memory' | 'session';
  title: string;
  snippet: string;
  path?: string;
  taskId?: string;
  sessionId?: string;
  parentTaskId?: string;  // populated for child tasks
  isAutoExpanded?: boolean; // true if included because parent matched (not direct hit)
  score: number;
  matchField: string;   // field name of best keyword match
}

export interface SearchOptions {
  limit?: number;
  types?: ('task' | 'memory' | 'session')[];
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

// ── BM25 keyword scoring — fallback when QMD task store is unavailable ──

export function bm25ScoreTasks(tasks: Task[], query: string): SearchResult[] {
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

    const projScore = scoreMatch(task.project || '', query, 1);
    if (projScore > bestScore) { bestScore = projScore; matchField = 'project'; }

    if (task.tags?.length) {
      const tagsText = task.tags.join(' ');
      const tagScore = scoreMatch(tagsText, query, 2);
      if (tagScore > bestScore) { bestScore = tagScore; matchField = 'tags'; }
    }

    // Searchable IDs and links — exact-match friendly with high weight
    const idScore = scoreMatch(task.id, query, 3);
    if (idScore > bestScore) { bestScore = idScore; matchField = 'id'; }

    if (task.session_id) {
      const sessionScore = scoreMatch(task.session_id, query, 3);
      if (sessionScore > bestScore) { bestScore = sessionScore; matchField = 'session_id'; }
    }

    // Legacy session_ids array — may still hold older session IDs
    if (task.session_ids?.length) {
      const legacyText = task.session_ids.join(' ');
      const legacyScore = scoreMatch(legacyText, query, 3);
      if (legacyScore > bestScore) { bestScore = legacyScore; matchField = 'session_id'; }
    }

    if (task.external_url) {
      const extScore = scoreMatch(task.external_url, query, 2);
      if (extScore > bestScore) { bestScore = extScore; matchField = 'external_url'; }
    }

    if (bestScore > 0) {
      const snippetSource =
        matchField === 'description' ? task.description
        : matchField === 'summary' ? task.summary
        : matchField === 'note' ? task.note
        : matchField === 'tags' ? (task.tags ?? []).join(', ')
        : matchField === 'id' ? task.id
        : matchField === 'session_id' ? (task.session_id ?? (task.session_ids ?? []).join(', '))
        : matchField === 'external_url' ? task.external_url!
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

export function bm25ScoreSessions(
  sessions: SessionRecord[],
  query: string,
): SearchResult[] {
  const results: SearchResult[] = [];
  for (const session of sessions) {
    const candidates: Array<[string, string | undefined, number]> = [
      ['title', session.title, 3],
      ['description', session.description, 2.5],
      ['summary', session.summary, 2],
      ['planContent', session.planContent, 1.5],
      ['project', session.project, 1],
      ['cwd', session.cwd, 0.75],
    ];
    let bestScore = 0;
    let matchField = '';
    let snippetSource = '';
    for (const [field, value, weight] of candidates) {
      if (!value) continue;
      const score = scoreMatch(value, query, weight);
      if (score > bestScore) {
        bestScore = score;
        matchField = field;
        snippetSource = value;
      }
    }
    if (bestScore === 0) continue;
    results.push({
      type: 'session',
      title: session.title || session.claudeSessionId,
      snippet: extractSnippet(snippetSource, query),
      sessionId: session.claudeSessionId,
      score: bestScore,
      matchField,
    });
  }
  return results.sort((a, b) => b.score - a.score);
}

const MIN_PARTIAL_REFERENCE_LENGTH = 8;

function referenceMatchScore(
  value: string | undefined,
  query: string,
  kind: 'id' | 'url' = 'id',
): number {
  if (!value) return 0;
  const normalizedValue = value.toLowerCase();
  if (normalizedValue === query) return 1;
  if (query.length < MIN_PARTIAL_REFERENCE_LENGTH) return 0;
  if (/\s/.test(query)) return 0;
  if (kind === 'url' && !/^https?:\/\//.test(query)) return 0;
  return normalizedValue.startsWith(query) ? 0.99 : 0;
}

/**
 * Deterministic identifier lane beside QMD. Opaque task/session IDs and URLs
 * are poor embedding inputs, but copied references must always resolve.
 */
export function searchTaskReferences(tasks: Task[], rawQuery: string): SearchResult[] {
  const query = rawQuery.trim().toLowerCase();
  if (!query) return [];

  const results: SearchResult[] = [];
  for (const task of tasks) {
    const candidates: Array<{ field: 'id' | 'session_id' | 'external_url'; value?: string }> = [
      { field: 'id', value: task.id },
      { field: 'session_id', value: task.session_id },
      ...(task.session_ids ?? []).map((value) => ({ field: 'session_id' as const, value })),
      { field: 'session_id', value: task.plan_session_id },
      { field: 'session_id', value: task.exec_session_id },
      { field: 'external_url', value: task.external_url },
    ];

    let best: { field: 'id' | 'session_id' | 'external_url'; value: string; score: number } | undefined;
    for (const candidate of candidates) {
      const score = referenceMatchScore(
        candidate.value,
        query,
        candidate.field === 'external_url' ? 'url' : 'id',
      );
      if (candidate.value && score > (best?.score ?? 0)) {
        best = { ...candidate, value: candidate.value, score };
      }
    }
    if (!best) continue;

    results.push({
      type: 'task',
      title: task.title,
      snippet: extractSnippet(best.value, rawQuery),
      taskId: task.id,
      ...(best.field === 'session_id' ? { sessionId: best.value } : {}),
      parentTaskId: task.parent_task_id,
      score: best.score,
      matchField: best.field,
    });
  }

  return results.sort((a, b) => b.score - a.score);
}

export function searchSessionReferences(
  sessions: SessionRecord[],
  rawQuery: string,
): SearchResult[] {
  const query = rawQuery.trim().toLowerCase();
  if (!query) return [];

  return sessions
    .map((session): SearchResult | null => {
      const idScore = referenceMatchScore(session.claudeSessionId, query);
      if (idScore > 0) {
        return {
          type: 'session',
          title: session.title || session.claudeSessionId,
          snippet: session.claudeSessionId,
          sessionId: session.claudeSessionId,
          score: idScore,
          matchField: 'session_id',
        };
      }
      // Commit SHA lane (2026-08-15 star incident): commitShas is the
      // structured commit→session→task link the indexer backfills. A pasted
      // SHA must resolve deterministically — as an embedding input it is
      // noise, and BM25 ranked the right session #7. Prefix match both ways
      // (7-char short SHA query vs 40-char stored, and vice versa).
      for (const sha of session.commitShas ?? []) {
        const score = referenceMatchScore(sha, query)
          || (query.length >= MIN_PARTIAL_REFERENCE_LENGTH && sha.startsWith(query) ? 0.99 : 0)
          || (sha.length >= 7 && query.startsWith(sha) && /^[0-9a-f]+$/.test(query) ? 0.99 : 0);
        if (score > 0) {
          return {
            type: 'session',
            title: session.title || session.claudeSessionId,
            snippet: `commit ${sha}`,
            sessionId: session.claudeSessionId,
            score,
            matchField: 'commit_sha',
          };
        }
      }
      return null;
    })
    .filter((result): result is SearchResult => result !== null)
    .sort((a, b) => b.score - a.score);
}

/**
 * Resolve a copied session reference back to its owning task from the
 * authoritative SessionRecord.taskId relation. This repairs discovery for
 * legacy or partially-linked tasks whose session slot/history fields are empty.
 */
export function searchSessionTaskReferences(
  tasks: Task[],
  sessions: SessionRecord[],
  rawQuery: string,
): SearchResult[] {
  const query = rawQuery.trim().toLowerCase();
  if (!query) return [];

  const tasksById = new Map(tasks.map((task) => [task.id, task]));
  const bestByTask = new Map<string, SearchResult>();
  // Reuse the id + commit-SHA reference lanes: a hit on EITHER resolves to the
  // owning task, so "which task made commit X?" is a one-hop lookup.
  for (const hit of searchSessionReferences(sessions, rawQuery)) {
    const session = sessions.find((s) => s.claudeSessionId === hit.sessionId);
    if (!session?.taskId) continue;
    const task = tasksById.get(session.taskId);
    if (!task) continue;

    const existing = bestByTask.get(task.id);
    if (existing && existing.score >= hit.score) continue;
    bestByTask.set(task.id, {
      type: 'task',
      title: task.title,
      snippet: hit.snippet,
      taskId: task.id,
      sessionId: session.claudeSessionId,
      parentTaskId: task.parent_task_id,
      score: hit.score,
      matchField: hit.matchField,
    });
  }

  return [...bestByTask.values()].sort((a, b) => b.score - a.score);
}

/**
 * Resolve task IDs, task URLs, and task-owning session IDs consistently across
 * HTTP and agent search. SessionRecord.taskId wins over stale task-side links.
 */
export function searchTaskAndSessionReferences(
  tasks: Task[],
  sessions: SessionRecord[],
  rawQuery: string,
): SearchResult[] {
  const taskReferences = searchTaskReferences(tasks, rawQuery);
  const sessionOwners = searchSessionTaskReferences(tasks, sessions, rawQuery);
  const authoritativeSessionIds = new Set(
    sessionOwners
      .map((result) => result.sessionId?.toLowerCase())
      .filter((sessionId): sessionId is string => Boolean(sessionId)),
  );
  const merged = [
    ...taskReferences.filter((result) =>
      result.matchField !== 'session_id'
      || !result.sessionId
      || !authoritativeSessionIds.has(result.sessionId.toLowerCase())),
    ...sessionOwners,
  ];

  const bestByTask = new Map<string, SearchResult>();
  for (const result of merged) {
    if (!result.taskId) continue;
    const existing = bestByTask.get(result.taskId);
    if (!existing || result.score > existing.score) {
      bestByTask.set(result.taskId, result);
    }
  }
  return [...bestByTask.values()].sort((a, b) => b.score - a.score);
}

// ── Main search function ──

export async function search(
  query: string,
  options: SearchOptions = {},
): Promise<SearchResult[]> {
  // Metric per lane combo (bounded: a handful of type sets exist in the UI).
  const laneLabel = (options.types ?? DEFAULT_SEARCH_TYPES).slice().sort().join(',');
  return timed('search.global', () => searchInner(query, options), { types: laneLabel });
}

/**
 * Default search lanes when the caller doesn't pick.
 *
 * Sessions are IN by default (2026-08-15): "which task retired the star
 * system?" was unanswerable through every search front door because the
 * transcript content — the only place the answer lived — sat in a session
 * index no default query ever consulted. Task titles/summaries routinely
 * under-describe what actually happened (fork-inherited titles, one summary
 * field overwritten by later topics); the transcript is the ground truth, so
 * the default must include it.
 */
export const DEFAULT_SEARCH_TYPES: ReadonlyArray<'task' | 'memory' | 'session'> = ['task', 'memory', 'session'];

async function searchInner(
  query: string,
  options: SearchOptions = {},
): Promise<SearchResult[]> {
  const limit = options.limit ?? 20;
  const types = options.types ?? DEFAULT_SEARCH_TYPES;

  const normalizedQuery = query.trim();
  if (normalizedQuery.length === 0) return [];

  const results: SearchResult[] = [];
  let qmdFailure: unknown;
  const qmdEnabled =
    process.env.WALNUT_DISABLE_SEARCH !== '1'
    && !CLOUD_MODE;

  // Tasks loaded lazily — only when needed for BM25 fallback or child expansion
  let tasks: Task[] | null = null;
  async function getTasks(): Promise<Task[]> {
    if (!tasks) tasks = await listTasks();
    return tasks;
  }

  let sessions: SessionRecord[] | null = null;
  async function getSessions(): Promise<SessionRecord[]> {
    if (!sessions) sessions = await listSessions();
    return sessions;
  }

  // Exact copied references are navigation commands, not semantic queries.
  // Resolve them before QMD/memory search so unrelated high-similarity content
  // cannot displace or surround the authoritative target.
  if (types.includes('task')) {
    const allTasks = await getTasks();
    const exactTasks = searchTaskAndSessionReferences(
      allTasks,
      await getSessions(),
      normalizedQuery,
    ).filter((result) => result.score === 1);
    if (exactTasks.length > 0) {
      return exactTasks.slice(0, limit);
    }
  }
  if (types.includes('session')) {
    const exactSessions = searchSessionReferences(await getSessions(), normalizedQuery)
      .filter((result) => result.score === 1);
    if (exactSessions.length > 0) return exactSessions.slice(0, limit);
  }

  // Task search: deterministic references take precedence over QMD's BM25 +
  // vector ranking. QMD intentionally indexes human-readable task content, not
  // opaque IDs, so an identifier hit should not trigger semantic noise.
  if (types.includes('task')) {
    const taskResults: SearchResult[] = [];
    const seenTaskIds = new Set<string>();
    const appendTaskResult = (result: SearchResult) => {
      if (result.taskId && seenTaskIds.has(result.taskId)) return;
      if (result.taskId) seenTaskIds.add(result.taskId);
      taskResults.push(result);
    };

    const allTasks = await getTasks();
    const referenceResults = searchTaskAndSessionReferences(
      allTasks,
      await getSessions(),
      normalizedQuery,
    );
    for (const result of referenceResults) {
      appendTaskResult(result);
    }

    // Exact references returned above. Partial references remain pinned first,
    // but still merge semantic matches instead of suppressing the whole result set.
    if (!qmdEnabled) {
      for (const result of bm25ScoreTasks(allTasks, normalizedQuery)) {
        appendTaskResult(result);
      }
    } else try {
      const { memoryNotesSearch } = await import('./memory-search.js');
      const qmdResults = await memoryNotesSearch(
        normalizedQuery,
        ['task'],
        limit,
        undefined,
        { rerank: false, overfetchMultiplier: 1 },
      );
      for (const r of qmdResults) {
        appendTaskResult({
          type: 'task',
          title: r.title,
          snippet: r.snippet,
          taskId: r.taskId,
          score: r.finalScore,
          matchField: 'task',
        });
      }
    } catch (err) {
      // QMD task search failed — fall back to BM25 keyword search.
      const msg = err instanceof Error ? err.message : String(err);
      log.agent.warn('QMD task search failed — falling back to BM25 keyword search', { query: normalizedQuery, error: msg });
      qmdFailure ??= err;
      for (const result of bm25ScoreTasks(allTasks, normalizedQuery)) {
        appendTaskResult(result);
      }
    }
    results.push(...taskResults);
  }

  // Session search: delegate to QMD
  if (types.includes('session')) {
    const referenceResults = searchSessionReferences(await getSessions(), normalizedQuery);
    results.push(...referenceResults);
    if (!qmdEnabled) {
      const seenSessionIds = new Set(referenceResults.map((result) => result.sessionId));
      results.push(...bm25ScoreSessions(await getSessions(), normalizedQuery)
        .filter((result) => !seenSessionIds.has(result.sessionId)));
    } else try {
      const { memoryNotesSearch } = await import('./memory-search.js');
      const qmdResults = await memoryNotesSearch(
        normalizedQuery,
        ['session'],
        limit,
        undefined,
        { rerank: false, overfetchMultiplier: 1 },
      );
      for (const r of qmdResults) {
        if (referenceResults.some((result) => result.sessionId === r.sessionId)) continue;
        results.push({
          type: 'session',
          title: r.title,
          snippet: r.snippet,
          sessionId: r.sessionId,
          score: r.finalScore,
          matchField: r.source,
        });
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.agent.warn('QMD session search failed — falling back to metadata keyword search', {
        query: normalizedQuery,
        error: msg,
      });
      qmdFailure ??= err;
      const seenSessionIds = new Set(referenceResults.map((result) => result.sessionId));
      results.push(...bm25ScoreSessions(await getSessions(), normalizedQuery)
        .filter((result) => !seenSessionIds.has(result.sessionId)));
    }
  }

  // Memory search: delegate to QMD.
  //
  // rerank:false like the task/session legs above. This was the LAST interactive
  // leg still running QMD's local llama.cpp cross-encoder, and it was the worst
  // offender: measured 11–20s on a cold query, and because llama.cpp scoring is a
  // native call it PINNED THE EVENT LOOP for ~11s (`event-loop blocked (probe
  // late) lateByMs:11026`) — i.e. one search in the box froze every route for the
  // whole app. That violates the "never block the web server" rule outright.
  //
  // Measured quality cost of dropping it (4 real queries, top-10): the #1 hit was
  // identical every time, top-5 overlap 3–5 of 5. Not free, but nowhere near
  // worth 11s of app-wide freeze on a keystroke path.
  if (types.includes('memory') && qmdEnabled) {
    try {
      const { memoryNotesSearch } = await import('./memory-search.js');
      const qmdResults = await memoryNotesSearch(
        normalizedQuery,
        undefined,
        limit,
        undefined,
        { rerank: false, overfetchMultiplier: 1 },
      );
      for (const r of qmdResults) {
        results.push({
          type: 'memory',
          title: r.title,
          snippet: r.snippet,
          path: r.filepath,
          score: r.finalScore,
          matchField: r.source,
        });
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.agent.warn('QMD memory search failed — no memory results', { query: normalizedQuery, error: msg });
      qmdFailure ??= err;
    }
  }

  // A total QMD outage must not look like an authoritative empty result. The
  // browser preserves its immediate local matches when this request fails.
  if (results.length === 0 && qmdFailure) throw qmdFailure;

  const isReference = (result: SearchResult): boolean =>
    result.matchField === 'id'
    || result.matchField === 'session_id'
    || result.matchField === 'commit_sha'
    || result.matchField === 'external_url';

  // CJK multi-term queries: rank by term coverage before per-store score.
  // Each store ranks independently and no-rerank scores are 1/rank × source
  // weight (SOURCE_WEIGHTS in memory-search.ts), so cross-store scores are
  // NOT comparable — a memory doc matching only "timeout" at store-rank #1
  // (1.0 × 1.1) would outrank the task matching EVERY term at store-rank #2
  // (0.5). Docs covering more of the query are what a human means by a
  // multi-term query, so coverage wins the merge.
  //
  // Graded (hits/terms), not all-or-nothing: the haystack is title + QMD's
  // bestChunk — a single chunk, not the whole doc — so on long queries even
  // the best doc usually misses a term or two in its selected chunk, and a
  // binary rule would silently never fire. Buckets (×4, rounded) absorb
  // one-term noise so near-ties fall through to the score comparator.
  // Latin-only queries skip this (coverage stays 0 for all — no-op tiebreak):
  // their FTS lane already ANDs correctly, so per-store score order is
  // meaningful and coverage would only add chunk-selection noise.
  const coverage = new Map<SearchResult, number>();
  if (CJK_CHAR_RE.test(normalizedQuery)) {
    const terms = splitQueryTerms(normalizedQuery);
    if (terms.length > 1) {
      for (const result of results) {
        const haystack = `${result.title}\n${result.snippet}`.toLowerCase();
        const hits = terms.filter((t) => haystack.includes(t)).length;
        coverage.set(result, Math.round((hits / terms.length) * 4));
      }
    }
  }

  results.sort((a, b) =>
    Number(isReference(b)) - Number(isReference(a))
    || (coverage.get(b) ?? 0) - (coverage.get(a) ?? 0)
    || b.score - a.score);
  const sliced = results.slice(0, limit);

  // Keep child task expansion for task results (lazy-loads tasks only if needed)
  if (types.includes('task')) {
    const allTasks = await getTasks();
    return expandChildTasks(sliced, allTasks);
  }
  return sliced;
}

/**
 * Auto-expand child tasks for matched parents.
 * For each parent task in results, inserts its children right after it
 * (if not already present). Children are marked with isAutoExpanded=true.
 * Accepts pre-loaded tasks to avoid redundant disk reads.
 */
export function expandChildTasks(results: SearchResult[], allTasks: Task[]): SearchResult[] {
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
