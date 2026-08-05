/**
 * Agent tool: memory_notes_search
 * Hybrid search across memory and notes via QMD.
 */
import type { ToolDefinition } from '../tools.js';
import {
  memoryNotesSearch,
  type MemorySearchResult,
} from '../../core/memory-search.js';
import {
  searchSessionReferences,
  searchTaskAndSessionReferences,
} from '../../core/search.js';
import { listTasks } from '../../core/task-manager.js';
import { listSessions } from '../../core/session-tracker.js';

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

    const references: MemorySearchResult[] = [];
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
            filepath: source === 'task'
              ? `qmd://tasks/task-${id}`
              : `qmd://sessions/sess-${id}`,
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

    const semanticResults = semanticQueries.length > 0
      ? await memoryNotesSearch(semanticQueries, sources, limit, pathPrefix)
      : [];
    const resultKey = (result: MemorySearchResult): string =>
      result.taskId
        ? `task:${result.taskId}`
        : result.sessionId
          ? `session:${result.sessionId}`
          : `${result.source}:${result.filepath}`;
    const deduped = new Map<string, MemorySearchResult>();
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
