import { log } from '../logging/index.js';
import { count, observe, timed } from './observability/metrics.js';
import { CLOUD_MODE } from '../constants.js';
import { CJK_CHAR_RE, splitQueryTerms, contentQueryTerms, termInText } from './cjk.js';
import { bus, EventNames } from './event-bus.js';
import { listTasks } from './task-manager.js';
import { listSessions } from './session-tracker.js';
import type { SessionRecord, Task } from './types.js';
import type { QuerySegments } from '../lib/hybrid-search/index.js';

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
  /** Whole-document query-term hit count from the QMD layer (see
   *  MemorySearchResult.coveredTermHits). Merge-ranking input, not API surface. */
  coveredTermHits?: number;
}

export interface SearchOptions {
  limit?: number;
  types?: ('task' | 'memory' | 'session')[];
}

/**
 * Cap on a QMD snippet handed back to a caller.
 *
 * QMD returns a whole matched chunk, and a session chunk is a transcript slice:
 * measured 2026-08-16, THREE session hits carried 9,831 chars (~2.5K tokens) of
 * raw turn-by-turn log. Every consumer pays that — an agent burns its context on
 * it, and the search UI renders a wall of text — for a relevance preview nobody
 * reads past the first line. The keyword lanes have always trimmed (extractSnippet);
 * the QMD lanes passed the chunk through untouched.
 */
const MAX_SNIPPET_CHARS = 400;

/** Trim a QMD chunk to a preview, preferring a cut at a line break. */
function capSnippet(snippet: string | undefined): string {
  if (!snippet) return '';
  const flat = snippet.replace(/\s+/g, ' ').trim();
  if (flat.length <= MAX_SNIPPET_CHARS) return flat;
  return flat.slice(0, MAX_SNIPPET_CHARS).trimEnd() + '…';
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

/**
 * Title-paraphrase lane: a deterministic score for "the query is a reworded
 * title". Humans and agents overwhelmingly query by paraphrasing what they
 * remember of the title, one or two synonyms off ("Helm chart CRD *upgrade
 * handling* in CDK" for the title "Helm CRD *update behavior* in CDK") — and
 * the QMD lanes lose exactly this shape: FTS AND-annihilates on the synonym,
 * and no-rerank scoring is 1/rank, so the true hit surfaces at #4 in its lane
 * with score 0.225 and drowns in the cross-store merge (2026-08-20 eval:
 * A08-A10 all MISS despite 4+ of the title's words appearing verbatim).
 *
 * Fires only when the query has >= 2 terms and at least half of them (and
 * >= 2 absolute) appear in the title. Returns a score in the 0.6..1.0 band —
 * deliberately comparable to the QMD lanes' 1/rank x source-weight scale, so
 * a full title paraphrase (1.0) ties the semantic #1 and a half match (0.8)
 * lands just under it. Single-term queries stay with FTS (which handles them
 * well) — firing there would surface every title containing one common word.
 */
export const TITLE_LANE_MIN_MATCHED = 2;
// 0.4, not 0.5: the cross-language paraphrase shape maxes out around 0.44
// (English query vs a Chinese title — only the title's Latin tokens can ever
// match, and the CJK runs dilute both fractions). The junk shape this guards
// against (two common words in a long unrelated title) scores ~0.16, so the
// gap stays wide; the 3-row cap bounds whatever lands between.
const TITLE_LANE_MIN_F1 = 0.4;

/** Liveness penalty for COMPLETED tasks in ranked search (2026-08-28).
 *
 * The engine's own recency component is 0.03-weighted with a 180-day
 * half-life — negligible — and phase never reaches the index, so pure text
 * relevance let 20x more finished history bury the one running task. This
 * additive penalty sinks stale completed matches WITHOUT the old binary
 * open-first partition (removed 2026-08-26 by user request): it applies at
 * the score level, below the coverage sort tier, so a full-coverage (exact)
 * completed match still wins — the "strong match is exempt" rule falls out
 * of the sort structure instead of a special case.
 *
 * Freshly completed ≈ no penalty; half the max at 14 days; full 0.12 for old
 * history. Running/TODO/AGENT_COMPLETE (awaiting the human) pay nothing. */
export const LIVENESS_PENALTY_MAX = 0.12;
export const LIVENESS_HALF_LIFE_DAYS = 14;

export function completedLivenessPenalty(
  task: { phase?: string; status?: string; completed_at?: string; updated_at?: string },
  now: number = Date.now(),
): number {
  const done = task.phase === 'COMPLETE' || task.status === 'done';
  if (!done) return 0;
  const stamp = Date.parse(task.completed_at ?? task.updated_at ?? '');
  const ageDays = Number.isNaN(stamp) ? Infinity : Math.max(0, (now - stamp) / 86_400_000);
  return -LIVENESS_PENALTY_MAX * (1 - Math.exp(-ageDays * Math.LN2 / LIVENESS_HALF_LIFE_DAYS));
}

export function titleMatchScore(title: string | undefined, query: string): number {
  if (!title) return 0;
  // Stopword-free terms: an agent-phrased query ("WHICH task removed THE star
  // rating system FROM tasks") is half glue, and glue words dilute the query-
  // side fraction below the threshold for exactly the paraphrase shape this
  // lane exists to catch.
  const terms = contentQueryTerms(query);
  if (terms.length < TITLE_LANE_MIN_MATCHED) return 0;
  const hay = title.toLowerCase();
  const matched = terms.filter((t) => termInText(hay, t)).length;
  if (matched < TITLE_LANE_MIN_MATCHED) return 0;
  // Bidirectional F1, not one-way query coverage. One-way breaks the
  // cross-language paraphrase: an English query against the Chinese title
  // "云端Walnut迁移架构调查+设计(plan)" can only ever match the title's TWO Latin
  // tokens — 2/5 query coverage fails a flat threshold even though the query
  // matched 100% of the title vocabulary it could. The title-side fraction
  // tells those apart from a long title that happens to contain two common
  // words (2/20 title coverage → F1 0.16, stays out).
  const fq = matched / terms.length;
  const titleTermCount = Math.max(1, contentQueryTerms(title).length);
  const ft = Math.min(1, matched / titleTermCount);
  const f1 = (2 * fq * ft) / (fq + ft);
  if (f1 < TITLE_LANE_MIN_F1) return 0;
  return 0.6 + 0.4 * f1;
}

/** Cap on rows the title lane may add per type — a broad two-word query
 * ("walnut task") half-matches dozens of titles; a handful of rows surfaces
 * the lane without flooding the merged page. 5, not 3: cross-language titles
 * bottom out at the 0.76 score band where ties are common, and a 3-row cap
 * dropped the right doc on a tie (A08, 2026-08-20). */
const TITLE_LANE_MAX_ROWS = 5;

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
      // A session hit must carry its owning task: "which TASK did X?" is the
      // question users actually ask, and a hit that names only the session
      // leaves the answer one un-navigable hop away (2026-08-16 eval: the
      // agent found the session, then could not name the task).
      ...(session.taskId ? { taskId: session.taskId } : {}),
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
          ...(session.taskId ? { taskId: session.taskId } : {}),
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
            ...(session.taskId ? { taskId: session.taskId } : {}),
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

// ── query-result memo ──

/**
 * Short-TTL memo in front of search().
 *
 * One /api/search is not one search: it fans out into three hybrid lanes plus a
 * full task + session store read, and identical queries arrive in bursts —
 * the AI-search child re-asks the same question while it reasons, the browser
 * re-issues on focus/mount, and a human editing a query re-submits prefixes it
 * already sent. Measured on the live server under load (2026-08-30): the same
 * query repeated back-to-back cost 1.08s and 1.37s after a 4.5s cold run, i.e.
 * the repeat paid full price for an answer that had not changed.
 *
 * 20s, not minutes: the index is written continuously (event-bus upserts debounce
 * at 2s), so a memo long enough to matter for a burst is still short enough that
 * a task created mid-session shows up in the next search a human would notice.
 */
export const SEARCH_RESULT_CACHE_TTL_MS = 20_000;
export const SEARCH_RESULT_CACHE_CAP = 100;

export interface TtlLru<V> {
  get(key: string): V | undefined;
  set(key: string, value: V): void;
  clear(): void;
  readonly size: number;
}

/**
 * Insertion-ordered Map as a TTL+LRU: `get` re-inserts (youngest end) but never
 * refreshes the stamp — a hot key must still go stale on schedule, otherwise a
 * repeatedly-queried term could serve a minutes-old answer forever.
 */
export function createTtlLru<V>(
  options: { ttlMs: number; cap: number; now?: () => number },
): TtlLru<V> {
  const now = options.now ?? Date.now;
  const entries = new Map<string, { value: V; at: number }>();
  const evictOldest = () => {
    for (const oldest of entries.keys()) { entries.delete(oldest); break; }
  };
  return {
    get(key) {
      const hit = entries.get(key);
      if (!hit) return undefined;
      if (now() - hit.at >= options.ttlMs) {
        entries.delete(key);
        return undefined;
      }
      entries.delete(key);
      entries.set(key, hit);
      return hit.value;
    },
    set(key, value) {
      entries.delete(key);
      entries.set(key, { value, at: now() });
      while (entries.size > options.cap) evictOldest();
    },
    clear() { entries.clear(); },
    get size() { return entries.size; },
  };
}

const resultCache = createTtlLru<SearchResult[]>({
  ttlMs: SEARCH_RESULT_CACHE_TTL_MS,
  cap: SEARCH_RESULT_CACHE_CAP,
});

/** Test hook / safety valve; the bus subscriber below calls it on every write. */
export function clearSearchResultCache(): void {
  resultCache.clear();
}

/**
 * Writes that change what a search would return. Without invalidation the memo's
 * own 20s TTL IS the staleness window, and that window is user-visible: the memo
 * also fronts the frozen `/api/v1/search` the iOS app calls, whose global section
 * renders ONLY server hits (the web TodoPanel hides the same gap behind its own
 * client-side substring match). Create a task, search its exact title within 20s,
 * and the memoized pre-create answer comes back even though the index has it.
 *
 * These are exactly the events the search-v2 indexer syncs on (src/core/search/
 * wiring.ts), so a clear here can never run ahead of the index. A whole-cache
 * clear is the right granularity at cap 100 — the entries are keyed by query text,
 * so there is no way to tell which of them a given task/session could appear in.
 */
const CACHE_INVALIDATING_EVENTS: readonly string[] = [
  EventNames.TASK_CREATED,
  EventNames.TASK_UPDATED,
  EventNames.TASK_COMPLETED,
  EventNames.TASK_DELETED,
  EventNames.SESSION_STARTED,
  EventNames.SESSION_CONTENT_UPDATED,
  EventNames.SESSION_RESULT,
  EventNames.SESSION_ERROR,
  EventNames.SESSION_DELETED,
];

let resultCacheInvalidationBound = false;

/**
 * Bound lazily, the first time an answer is actually memoized: importing this
 * module must not register a bus subscriber in a process that only ever reads
 * (CLI, agent tools), and a process with the memo off needs no invalidation.
 * `interest` keeps the subscriber from being woken by streaming events.
 */
function bindResultCacheInvalidation(): void {
  if (resultCacheInvalidationBound) return;
  resultCacheInvalidationBound = true;
  try {
    bus.subscribe(
      'search-result-cache',
      (event) => { if (CACHE_INVALIDATING_EVENTS.includes(event.name)) resultCache.clear(); },
      { global: true, interest: [...CACHE_INVALIDATING_EVENTS] },
    );
  } catch { /* invalidation is hygiene — never break search over it */ }
}

/**
 * Cache key. Case is PRESERVED on purpose: the query reaches FTS tokenization
 * and snippet extraction, so 'CDK' and 'cdk' are not provably the same request.
 * Whitespace collapse IS provably safe (every lane splits on /\s+/ anyway).
 */
export function searchResultCacheKey(
  query: string,
  types: ReadonlyArray<string>,
  limit: number,
): string {
  return `${limit}\u0000${[...types].sort().join(',')}\u0000${query.trim().replace(/\s+/g, ' ')}`;
}

function resultCacheEnabled(): boolean {
  const flag = process.env.WALNUT_SEARCH_RESULT_CACHE;
  if (flag === '1') return true;
  if (flag === '0') return false;
  // OFF by default under vitest: the suite mutates its mocked stores between
  // two identical queries (and asserts a THROW on the second), so a memo would
  // serve the previous test's answer. Tests that want it set the flag.
  return !process.env.VITEST && process.env.NODE_ENV !== 'test';
}

// ── Main search function ──

export async function search(
  query: string,
  options: SearchOptions = {},
): Promise<SearchResult[]> {
  const types = options.types ?? DEFAULT_SEARCH_TYPES;
  const limit = options.limit ?? 20;
  // Metric per lane combo (bounded: a handful of type sets exist in the UI).
  const laneLabel = types.slice().sort().join(',');
  // Timed by hand, not via timed(): a memo hit and a real search differ by two
  // orders of magnitude, so ONE unlabelled series would go bimodal and
  // search.global p50/p90 would sink as the hit rate climbs — hiding a real
  // regression in the miss path. timed() takes its labels up front, and the
  // hit/miss decision only exists inside the measured block, hence `cached`
  // as a label here ('off' = memo disabled, so the label stays bounded at 3).
  const startedAt = performance.now();
  let cached: 'hit' | 'miss' | 'off' = 'off';
  let failed = false;
  try {
    // Memo INSIDE the timer: a cache hit is still an /api/search latency, and
    // hiding it would make search.global look better than the app feels.
    const memoable = resultCacheEnabled() && query.trim().length > 0;
    const key = memoable ? searchResultCacheKey(query, types, limit) : '';
    if (memoable) {
      const hit = resultCache.get(key);
      if (hit) {
        cached = 'hit';
        count('search.result_cache', 1, { result: 'hit' });
        // Defensive copy: callers decorate rows in place (score penalties,
        // isAutoExpanded, slim-mode enrichment), and a memo that hands out its
        // own array would accumulate every caller's edits.
        return hit.map((row) => ({ ...row }));
      }
      cached = 'miss';
      count('search.result_cache', 1, { result: 'miss' });
    }
    const results = await searchInner(query, options);
    // Store the copy, hand out the fresh array (nothing else references it yet).
    if (memoable) {
      bindResultCacheInvalidation();
      resultCache.set(key, results.map((row) => ({ ...row })));
    }
    return results;
  } catch (err) {
    failed = true;
    throw err;
  } finally {
    const labels = { types: laneLabel, cached };
    observe('search.global', performance.now() - startedAt, labels);
    if (failed) count('search.global.error', 1, labels);
  }
}

/**
 * Lazy loader for the v2 lane, plus one-time registration of the hybrid
 * library's timing observer.
 *
 * Dynamic import on purpose: a static one would drag better-sqlite3 (and the
 * embed worker chain) into every consumer of this module — CLI, agent tools,
 * and the WALNUT_SEARCH_V2=0 rollback path that must never touch it.
 * The library cannot import walnut's metrics registry (it is a standalone
 * directory, gated by tests/lib/hybrid-search-boundary.test.ts), so the host
 * registers a callback and owns where the numbers land.
 */
let hybridObserverInstalled = false;
async function loadSearchV2Lane() {
  const [wiring, lib] = await Promise.all([
    import('./search/wiring.js'),
    import('../lib/hybrid-search/index.js'),
  ]);
  if (!hybridObserverInstalled) {
    hybridObserverInstalled = true;
    lib.setQuerySegmentObserver(publishHybridSegments);
  }
  return wiring.searchV2Lane;
}

/** Label values are fixed enum strings (5 semantic states x 4 embed sources at
 *  most) — the registry caps at 500 series process-wide. */
function publishHybridSegments(seg: QuerySegments): void {
  observe('search.hybrid.keyword_ms', seg.keywordMs);
  observe('search.hybrid.embed_ms', seg.embedMs);
  observe('search.hybrid.rescore_ms', seg.rescoreMs);
  observe('search.hybrid.total_ms', seg.totalMs);
  count('search.hybrid.query', 1, { semantic: seg.semantic, embed: seg.embedSource });
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
  // Search v2 (hybrid-search lib) replaces the three QMD legs below unless the
  // flag opts out (=0 → QMD rollback path). Env check duplicated from
  // wiring.isSearchV2Enabled() so the opted-out path never loads the wiring
  // module (and its better-sqlite3 chain).
  const v2Enabled = qmdEnabled && process.env.WALNUT_SEARCH_V2 !== '0';
  // v2's coverage component is a fraction over ITS tokenization of the query;
  // the merge below wants a hit count over contentQueryTerms. Same terms in
  // practice — reconstruct the count from the fraction.
  const mergeTermCount = contentQueryTerms(normalizedQuery).length;
  const v2CoveredHits = (coverageFrac: number): number | undefined =>
    mergeTermCount > 1
      ? Math.min(mergeTermCount, Math.round(coverageFrac * mergeTermCount))
      : undefined;

  // Tasks loaded lazily — only when needed for BM25 fallback or child expansion.
  // Timed because the whole-store read is a peer of the hybrid lanes in this
  // request's budget: without its own series, a tail spent in the task store
  // looks identical to a tail spent in the index.
  let tasks: Task[] | null = null;
  async function getTasks(): Promise<Task[]> {
    if (!tasks) tasks = await timed('search.stores.tasks', () => listTasks());
    return tasks;
  }

  let sessions: SessionRecord[] | null = null;
  async function getSessions(): Promise<SessionRecord[]> {
    if (!sessions) sessions = await timed('search.stores.sessions', () => listSessions());
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

    // Title-paraphrase lane (see titleMatchScore). Runs before QMD so a task
    // whose title the user is clearly reworsing can't be displaced by 1/rank
    // scores from semantically-adjacent noise.
    const titleHits = allTasks
      .map((t) => ({ task: t, score: titleMatchScore(t.title, normalizedQuery) }))
      .filter((h) => h.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, TITLE_LANE_MAX_ROWS);
    for (const h of titleHits) {
      appendTaskResult({
        type: 'task',
        title: h.task.title,
        snippet: extractSnippet(h.task.title, normalizedQuery),
        taskId: h.task.id,
        parentTaskId: h.task.parent_task_id,
        score: h.score,
        matchField: 'title',
      });
    }

    // Exact references returned above. Partial references remain pinned first,
    // but still merge semantic matches instead of suppressing the whole result set.
    if (!qmdEnabled) {
      for (const result of bm25ScoreTasks(allTasks, normalizedQuery)) {
        appendTaskResult(result);
      }
    } else try {
      if (v2Enabled) {
        const searchV2Lane = await loadSearchV2Lane();
        for (const hit of await searchV2Lane(normalizedQuery, { kinds: ['task'], limit })) {
          appendTaskResult({
            type: 'task',
            title: hit.title,
            snippet: extractSnippet(hit.text, normalizedQuery),
            taskId: hit.ref,
            score: hit.score,
            matchField: 'task',
            coveredTermHits: v2CoveredHits(hit.components.coverage),
          });
        }
      } else {
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
            snippet: capSnippet(r.snippet),
            taskId: r.taskId,
            score: r.finalScore,
            matchField: 'task',
            coveredTermHits: r.coveredTermHits,
          });
        }
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
    // Liveness: sink stale completed tasks within their coverage tier.
    // References are untouched in practice — isReference sorts above score.
    const taskById = new Map(allTasks.map((t) => [t.id, t]));
    for (const row of taskResults) {
      const owner = row.taskId ? taskById.get(row.taskId) : undefined;
      if (owner) row.score += completedLivenessPenalty(owner);
    }
    results.push(...taskResults);
  }

  // Session search: delegate to QMD
  if (types.includes('session')) {
    const referenceResults = searchSessionReferences(await getSessions(), normalizedQuery);
    results.push(...referenceResults);

    // Title-paraphrase lane, session leg (same rationale as the task leg).
    const seenForTitle = new Set(results.map((r) => r.sessionId).filter(Boolean));
    const sessionTitleHits = (await getSessions())
      .map((s) => ({ s, score: titleMatchScore(s.title, normalizedQuery) }))
      .filter((h) => h.score > 0 && !seenForTitle.has(h.s.claudeSessionId))
      .sort((a, b) => b.score - a.score)
      .slice(0, TITLE_LANE_MAX_ROWS);
    for (const h of sessionTitleHits) {
      results.push({
        type: 'session',
        title: h.s.title || h.s.claudeSessionId,
        snippet: extractSnippet(h.s.title ?? '', normalizedQuery),
        sessionId: h.s.claudeSessionId,
        ...(h.s.taskId ? { taskId: h.s.taskId } : {}),
        score: h.score,
        matchField: 'title',
      });
    }
    // Dedup set for the lanes below: reference hits AND title-lane hits.
    const seenSessionIds = new Set(
      results.filter((r) => r.type === 'session' && r.sessionId).map((r) => r.sessionId),
    );
    if (!qmdEnabled) {
      results.push(...bm25ScoreSessions(await getSessions(), normalizedQuery)
        .filter((result) => !seenSessionIds.has(result.sessionId)));
    } else try {
      // Join the owning task from the record so every session hit answers
      // "which task?" too (see the taskId note in bm25ScoreSessions). One
      // already-cached listSessions() read, no per-hit I/O.
      const taskBySession = new Map(
        (await getSessions()).map((s) => [s.claudeSessionId, s.taskId]),
      );
      if (v2Enabled) {
        const searchV2Lane = await loadSearchV2Lane();
        for (const hit of await searchV2Lane(normalizedQuery, { kinds: ['session'], limit })) {
          if (seenSessionIds.has(hit.ref)) continue;
          const ownerTaskId = taskBySession.get(hit.ref);
          results.push({
            type: 'session',
            title: hit.title || hit.ref,
            snippet: extractSnippet(hit.text, normalizedQuery),
            sessionId: hit.ref,
            ...(ownerTaskId ? { taskId: ownerTaskId } : {}),
            score: hit.score,
            matchField: 'session',
            coveredTermHits: v2CoveredHits(hit.components.coverage),
          });
        }
      } else {
        const { memoryNotesSearch } = await import('./memory-search.js');
        const qmdResults = await memoryNotesSearch(
          normalizedQuery,
          ['session'],
          limit,
          undefined,
          { rerank: false, overfetchMultiplier: 1 },
        );
        for (const r of qmdResults) {
          if (seenSessionIds.has(r.sessionId)) continue;
          const ownerTaskId = r.sessionId ? taskBySession.get(r.sessionId) : undefined;
          results.push({
            type: 'session',
            title: r.title,
            snippet: capSnippet(r.snippet),
            sessionId: r.sessionId,
            ...(ownerTaskId ? { taskId: ownerTaskId } : {}),
            score: r.finalScore,
            matchField: r.source,
            coveredTermHits: r.coveredTermHits,
          });
        }
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.agent.warn('QMD session search failed — falling back to metadata keyword search', {
        query: normalizedQuery,
        error: msg,
      });
      qmdFailure ??= err;
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
      if (v2Enabled) {
        const searchV2Lane = await loadSearchV2Lane();
        // The memory leg has always been the whole file-backed universe (the
        // QMD default sources spanned memory + notes + skills); matchField
        // carries the v2 kind so callers can still tell them apart.
        for (const hit of await searchV2Lane(normalizedQuery, { kinds: ['memory', 'note', 'skill'], limit })) {
          results.push({
            type: 'memory',
            title: hit.title,
            snippet: extractSnippet(hit.text, normalizedQuery),
            path: hit.ref,
            score: hit.score,
            matchField: hit.kind,
            coveredTermHits: v2CoveredHits(hit.components.coverage),
          });
        }
      } else {
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
            snippet: capSnippet(r.snippet),
            path: r.filepath,
            score: r.finalScore,
            matchField: r.source,
            coveredTermHits: r.coveredTermHits,
          });
        }
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

  // Multi-term queries: rank by term coverage before per-store score.
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
  //
  // Originally CJK-only, widened to ALL multi-term queries (2026-08-20 eval):
  // the same cross-store incomparability let "aihub progress log"
  // (memory_skill, matched 1 of 5 terms, score 1.2) outrank the session
  // titled "Helm CRD update behavior in CDK" (matched 4 of 5, title lane
  // 0.846) on every English paraphrase query — A09/A10 stuck at #4-#5 purely
  // because the merge sorted by scores from different scales. The old
  // Latin-skip rationale ("their FTS lane ANDs correctly") is true WITHIN a
  // store but was never true ACROSS stores, which is where this sort runs.
  // Stopword-free terms so agent-phrased glue ("which…from…") doesn't dilute
  // every candidate's fraction equally except the right one's.
  const coverage = new Map<SearchResult, number>();
  {
    const terms = contentQueryTerms(normalizedQuery);
    if (terms.length > 1) {
      for (const result of results) {
        // Whole-document hit count from the QMD layer when available; the
        // title+snippet scan is the fallback for lanes that never had the
        // body (references, title lane, BM25 fallback). The snippet is ONE
        // chunk of a transcript and routinely misses terms the document
        // contains, which made coverage punish exactly the right docs.
        let hits = result.coveredTermHits;
        if (hits === undefined) {
          const haystack = `${result.title}\n${result.snippet}`.toLowerCase();
          hits = terms.filter((t) => termInText(haystack, t)).length;
        }
        coverage.set(result, Math.round((Math.min(hits, terms.length) / terms.length) * 4));
      }
    }
  }

  // Mega-doc guard on the coverage tiebreak: grab-bag docs (MEMORY.md, 40KB+
  // progress logs, whale transcripts) contain almost any term combination
  // SOMEWHERE, so raw coverage crowns them on every multi-term query. A
  // focused doc earning full coverage is signal; a junk drawer earning it is
  // base rate. Halve (floor) the coverage bucket of known grab-bag sources so
  // they still rank by score within their reduced tier but can't sweep the
  // page. Task docs and session docs are focused by construction (one task /
  // one session's work) and keep full credit.
  const GRAB_BAG_SOURCES = new Set([
    'memory_global', 'memory_skill', 'memory_daily', 'memory_compaction',
    // v2 kind for the skills tree (the v2 equivalent of memory_skill).
    'skill',
  ]);
  const effectiveCoverage = (r: SearchResult): number => {
    const c = coverage.get(r) ?? 0;
    return GRAB_BAG_SOURCES.has(r.matchField) ? Math.floor(c / 2) : c;
  };

  results.sort((a, b) =>
    Number(isReference(b)) - Number(isReference(a))
    || effectiveCoverage(b) - effectiveCoverage(a)
    || b.score - a.score);

  // Per-type floor on the merged page. Cross-store scores are 1/rank × source
  // weight — NOT comparable (memory_topic's 1.3 beats task's 1.0 at every
  // rank) — so one prolific store can legally fill the whole page and blank
  // out a lane the caller explicitly asked for. Guarantee each requested type
  // that HAS results at least a few visible rows; the remainder stays
  // score-ordered. floor = limit/(3×types), i.e. 2 rows/type at the default
  // limit 20 with 3 lanes — enough to surface the lane without distorting the
  // overall order. References are exempt (they outrank everything by design).
  const perTypeFloor = Math.max(1, Math.floor(limit / (3 * types.length)));
  const sliced = results.slice(0, limit);
  if (types.length > 1) {
    for (const type of types) {
      const have = sliced.filter((r) => r.type === type).length;
      if (have >= perTypeFloor) continue;
      const candidates = results
        .slice(limit)
        .filter((r) => r.type === type)
        .slice(0, perTypeFloor - have);
      if (candidates.length === 0) continue;
      // Evict the lowest-scored rows of over-represented types (never a
      // reference row, never a row of a still-under-floor type).
      for (const candidate of candidates) {
        for (let i = sliced.length - 1; i >= 0; i--) {
          const row = sliced[i];
          if (isReference(row) || row.type === type) continue;
          const rowTypeCount = sliced.filter((r) => r.type === row.type).length;
          if (rowTypeCount <= perTypeFloor) continue;
          sliced.splice(i, 1);
          sliced.push(candidate);
          break;
        }
      }
    }
  }

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

  // Insert children after their parent. Capped: expansion runs AFTER the
  // page is sliced, so every inserted child physically pushes real hits down
  // — a parent with 7 fork-children shoved the star-incident session from #4
  // to #11 (2026-08-20 eval). Two children signal "this task has sub-work";
  // the full fork family is one click away on the task itself.
  const MAX_EXPANDED_CHILDREN = 2;
  const expanded: SearchResult[] = [];
  for (const result of results) {
    expanded.push(result);
    if (result.type === 'task' && result.taskId && childrenByParent.has(result.taskId)) {
      const children = childrenByParent.get(result.taskId)!.slice(0, MAX_EXPANDED_CHILDREN);
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
