/**
 * Agent tool: memory_notes_search
 * Hybrid search (keyword lanes + semantic rescore) over the search index.
 */
import path from 'node:path';
import type { ToolDefinition } from '../tools.js';
import {
  extractSnippet,
  searchSessionReferences,
  searchTaskAndSessionReferences,
} from '../../core/search.js';
import { listTasks } from '../../core/task-manager.js';
import { listSessions } from '../../core/session-tracker.js';
import { GLOBAL_SKILLS_DIR, MEMORY_DIR, NOTES_DIR } from '../../constants.js';

/**
 * One row of tool output. The shape is the tool's stable contract (it predates
 * the single-index engine): `source`/`collection` name the logical bucket a hit
 * came from, recovered from the file path — see classifyFileHit.
 */
interface SearchRow {
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

/** Tool source names → index doc kinds. Every memory_* collection except
 *  skills is one v2 kind ('memory', the whole memory dir); the collection is
 *  recovered from the path afterwards so `sources`/`path` filters still work. */
const SOURCE_KIND: Record<string, 'memory' | 'skill' | 'note' | 'task' | 'session'> = {
  memory_daily: 'memory', memory_topic: 'memory', memory_project: 'memory', memory_repo: 'memory',
  memory_compaction: 'memory', memory_global: 'memory', memory_session: 'memory',
  memory_skill: 'skill',
  note_vault: 'note',
  task: 'task',
  session: 'session',
};
const MEMORY_DIR_SOURCE: Record<string, string> = {
  daily: 'memory_daily', topics: 'memory_topic', projects: 'memory_project', repos: 'memory_repo',
  compaction: 'memory_compaction', sessions: 'memory_session',
};

/** Name the tool's `source` bucket and collection-relative path of a file hit.
 *  The bucket names are the tool's own schema (memory_daily, note_vault, …) and
 *  stay stable; they map onto the index's five kinds. */
function classifyFileHit(kind: 'memory' | 'skill' | 'note', absPath: string): { source: string; rel: string } {
  if (kind === 'note') return { source: 'note_vault', rel: path.relative(NOTES_DIR, absPath) };
  if (kind === 'skill') return { source: 'memory_skill', rel: path.relative(GLOBAL_SKILLS_DIR, absPath) };
  const rel = path.relative(MEMORY_DIR, absPath);
  if (rel === 'MEMORY.md') return { source: 'memory_global', rel };
  const top = rel.split(path.sep)[0] ?? '';
  return { source: MEMORY_DIR_SOURCE[top] ?? 'memory_topic', rel: rel.split(path.sep).slice(1).join('/') };
}

/**
 * Index leg: sources default to all memory buckets; `path` is
 * collection-relative. Each query runs once and a doc keeps its best score
 * across queries (the cross-query merge).
 */
async function searchIndexSemantic(
  queries: string[],
  sources: string[] | undefined,
  limit: number,
  pathPrefix: string | undefined,
): Promise<SearchRow[]> {
  const { searchV2Lane } = await import('../../core/search/wiring.js');
  const active = sources ?? Object.keys(SOURCE_KIND).filter((s) => s.startsWith('memory_'));
  const wanted = new Set(active);
  const kinds = [...new Set(active.map((s) => SOURCE_KIND[s]).filter(Boolean))];
  if (kinds.length === 0) return [];

  const best = new Map<string, SearchRow>();
  for (const query of queries) {
    for (const hit of await searchV2Lane(query, { kinds, limit: limit * 2 })) {
      let result: SearchRow;
      if (hit.kind === 'task' || hit.kind === 'session') {
        result = {
          // Tasks and sessions are rows, not files. `filepath` is a stable
          // synthetic handle so a caller can dedupe hits; taskId/sessionId
          // below are what actually opens one.
          filepath: hit.kind === 'task' ? `task://${hit.ref}` : `session://${hit.ref}`,
          title: hit.title,
          snippet: extractSnippet(hit.text, query),
          score: hit.score,
          finalScore: hit.score,
          source: hit.kind,
          collection: hit.kind,
          ...(hit.kind === 'task' ? { taskId: hit.ref } : { sessionId: hit.ref }),
        };
      } else {
        const { source, rel } = classifyFileHit(hit.kind as 'memory' | 'skill' | 'note', hit.ref);
        if (!wanted.has(source)) continue;
        if (pathPrefix && !rel.startsWith(pathPrefix)) continue;
        result = {
          filepath: hit.ref,
          title: hit.title,
          snippet: extractSnippet(hit.text, query),
          score: hit.score,
          finalScore: hit.score,
          source,
          collection: source.replace(/^(memory|note)_/, ''),
        };
      }
      const key = `${hit.kind}:${hit.ref}`;
      const prev = best.get(key);
      if (!prev || result.finalScore > prev.finalScore) best.set(key, result);
    }
  }
  return [...best.values()].sort((a, b) => b.finalScore - a.finalScore).slice(0, limit);
}

export const memoryNotesSearchTool: ToolDefinition = {
  name: 'memory_notes_search',
  description: `Hybrid search (BM25 + vector + re-ranking) across two knowledge stores.

## Stores

**Memory** (AI recall) — what happened, decisions made, conversation history. Written by AI. Changes often. Time-sensitive.
  Collections:
    daily — daily conversation logs, one file per day
    topic — curated wiki pages on recurring themes (e.g. architecture decisions, workflows)
    project — per-project working notes tied to specific tasks
    global — top-level MEMORY.md with critical rules and user preferences
    repo — per-repository environment knowledge
    skill — skill library: SKILL.md bodies AND support files (references/*.md, per-category overview history logs)
    compaction — archived conversation summaries from context compaction
    session — per-session notes

**Notes** (user reference library) — long-term documents, personal knowledge base. Written by user and AI. Mostly permanent.
  Collection:
    vault — the whole notes vault (every .md note, any folder)

**Task** — structured task records (title, description, summary, tags, project). Semantic search over all tasks.

**Session** — Claude Code session metadata (title, description, plan, linked task context). Semantic search over all sessions.

**Default (omit sources): memory only.** Pass only note_* for notes-only. Pass only "task" for tasks. Pass only "session" for sessions. Pass both for combined.
  "search tasks" → sources: [task]
  "search sessions" → sources: [session]
  "search notes" → sources: [note_vault]
  "search memory" / no qualifier → omit sources
  "search everything" → sources: [memory_daily, ..., note_vault, task, session]

## Path scoping (optional "path" param)

Narrow results to files whose collection-relative path starts with the prefix:
  "search walnut project history" → sources: [memory_skill], path: "walnut/overview/history/"
  "anything about tax in finance skills" → sources: [memory_skill], path: "finance/"
  "daily logs from June 2026" → sources: [memory_daily], path: "2026-06"
  "notes under health/" → sources: [note_vault], path: "health/"

## How to write good queries

Provide 3-5 queries that mix **short keywords** and **longer natural language phrases**.

The search uses keyword matching (BM25, AND logic) + vector similarity (semantic). A single long query like "project deadline status meeting notes" will MISS documents that don't contain every single word. Multiple short queries fix this.

**Rules:**
1. First 1-2 queries: natural language sentences (first = most important, covers core intent — used for reranking)
2. Last 2-3 queries: short keyword phrases (2-3 words) with synonyms — exact keyword match fails if even one word is missing
3. Include what the document might be TITLED — document titles get 4x matching weight (e.g. "travel timeline", "meeting notes", "architecture decision")
4. Think: "what exact words might appear in the target document?" and include those words

**Good:** ["when was the last time we deployed to production", "deploy production", "release history", "deployment log"]
**Bad:** ["deployment history production release timeline last month"]`,
  input_schema: {
    type: 'object',
    properties: {
      queries: {
        type: 'array',
        items: { type: 'string' },
        description: 'Array of 3-5 focused search queries. First = natural language sentence, rest = short keyword phrases. See description for principles.',
        minItems: 1,
        maxItems: 5,
      },
      limit: { type: 'number', description: 'Max results to return. Default: 15' },
      sources: {
        type: 'array',
        items: {
          type: 'string',
          enum: [
            'memory_daily', 'memory_topic', 'memory_project', 'memory_repo', 'memory_compaction', 'memory_global', 'memory_session', 'memory_skill',
            'note_vault',
            'task', 'session',
          ],
        },
        description: 'Which sources to search. Omit = all memory. Pass ONLY note_* for notes-only. Pass ONLY memory_* for specific memory collections. Pass "task" for tasks. Pass "session" for sessions. Pass multiple for combined search.',
      },
      path: {
        type: 'string',
        description: 'Optional collection-relative path prefix filter, e.g. "walnut/overview/history/" with memory_skill, or "2026-06" with memory_daily (time filter). See "Path scoping" in the tool description.',
      },
    },
    required: ['queries'],
  },
  async execute(params) {
    const queries = Array.isArray(params.queries)
      ? (params.queries as string[]).map((query) => query.trim()).filter(Boolean)
      : [];
    if (queries.length === 0) {
      return 'Error: queries is required (non-empty array of strings).';
    }
    const limit = (params.limit as number) ?? 15;
    const sources = params.sources as string[] | undefined;
    const pathPrefix = params.path as string | undefined;
    const wantsTask = sources?.includes('task') === true;
    const wantsSession = sources?.includes('session') === true;

    const references: SearchRow[] = [];
    const semanticQueries: string[] = [];
    if (wantsTask || wantsSession) {
      const [tasks, sessions] = await Promise.all([listTasks(), listSessions()]);
      for (const query of queries) {
        const matches = [
          ...(wantsTask
            ? searchTaskAndSessionReferences(tasks, sessions, query)
            : []),
          ...(wantsSession ? searchSessionReferences(sessions, query) : []),
        ];
        for (const match of matches) {
          const source = match.type === 'task' ? 'task' : 'session';
          const id = match.taskId ?? match.sessionId!;
          references.push({
            filepath: source === 'task' ? `task://${id}` : `session://${id}`,
            title: match.title,
            snippet: match.snippet,
            score: match.score,
            finalScore: match.score,
            source,
            collection: source,
            ...(match.taskId ? { taskId: match.taskId } : {}),
            ...(match.sessionId ? { sessionId: match.sessionId } : {}),
          });
        }
        if (!matches.some((match) => match.score === 1)) {
          semanticQueries.push(query);
        }
      }
    } else {
      semanticQueries.push(...queries);
    }

    // No cross-encoder reranking on this path, ever: the agent loop runs INSIDE
    // the web server process, so a native rerank pass stalls every route for
    // every surface (measured 28.7s for one call, 2949ms of event-loop stall,
    // for a top-1 that was identical without it). The index's own semantic
    // rescore runs in a worker thread under a deadline instead.
    const semanticResults = semanticQueries.length === 0
      ? []
      : await searchIndexSemantic(semanticQueries, sources, limit, pathPrefix);
    const resultKey = (result: SearchRow): string =>
      result.taskId
        ? `task:${result.taskId}`
        : result.sessionId
          ? `session:${result.sessionId}`
          : `${result.source}:${result.filepath}`;
    const deduped = new Map<string, SearchRow>();
    for (const result of [...references, ...semanticResults]) {
      const key = resultKey(result);
      if (!deduped.has(key)) deduped.set(key, result);
    }
    const results = [...deduped.values()].slice(0, limit);
    if (results.length === 0) return 'No results found.';
    return JSON.stringify(results.map(r => ({
      source: r.source,
      title: r.title,
      snippet: r.snippet,
      filepath: r.filepath,
      ...(r.taskId ? { taskId: r.taskId } : {}),
      ...(r.sessionId ? { sessionId: r.sessionId } : {}),
      score: Math.round(r.finalScore * 1000) / 1000,
    })), null, 2);
  },
};
