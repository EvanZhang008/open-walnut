/**
 * Agent task search — the pure contract layer: prompt text, tolerant JSON
 * extraction, id validation/enrichment, and ranking. No I/O, no heavy imports;
 * everything here is unit-testable without a model or a server.
 *
 * The failure this feature exists for (2026-08-23): a session-created task had
 * a placeholder title and an empty note — all intent lived only in the session
 * transcript, so task-lane search could never find it. The agent searches the
 * session lane too, and a session hit carries taskId = the OWNING task.
 */

import type { Task } from './types.js';

/** Bump to invalidate cached agent answers when the prompt contract changes. */
export const AGENT_SEARCH_PROMPT_V = 'v1';

export const AGENT_SEARCH_MAX_RESULTS = 5;
const EVIDENCE_MAX_CHARS = 200;
const SUMMARY_MAX_CHARS = 300;

/**
 * System prompt for the claude -p child. The child has the CLI's own tools
 * (Bash), so its search surface is the `walnut` CLI ops registry.
 */
export const SYSTEM_PROMPT = `You find WHICH of the user's Walnut tasks matches a search phrase. You are a search tool, not a chat assistant. Reply with JSON only.

## The failure you exist to prevent
A task's own title/note are often WRONG or EMPTY (tasks auto-created for a coding session start as "Session: <folder>" with a blank note); the real intent lives ONLY in the session transcript. Task-lane-only search misses these.

## Method — search via the walnut CLI (Bash). Budget ~40s, ~6 searches max.
  walnut tools call search '{"q":"<terms>","types":"task,session","limit":15}'
1. Start with the user's own words; then variants with DIFFERENT vocabulary — the literal strings a transcript would contain: package names, file extensions, commands, API names.
2. If nothing convincing, TRANSLATE the query (English <-> Chinese) and search both languages.
3. Optionally confirm a finalist: walnut tools call task_get '{"id":"<task id>"}'.
Stop as soon as you are confident. Never repeat a query.

## Owner rule
- A result with type:"task": its taskId is a candidate answer.
- A result with type:"session": its taskId is the task that OWNS that transcript — return THAT task. A session hit with a placeholder title but a matching snippet is a STRONG hit, not a weak one.
- The same task reached via both lanes is ONE result. Never list a session as a result.
- Prefer recently-active tasks over old loosely-related ones.

## Output — print ONLY this JSON object as your final answer. No prose, no code fence.
{"summary":"<at most 1 sentence, plain text, or omit>",
 "results":[{"task_id":"<EXACT id copied from tool output>",
             "evidence":"<max 200 chars quoted or tightly paraphrased from a snippet you actually saw>",
             "confidence":"high"|"medium"|"low"}]}
At most 3 results, best first. Zero matches -> {"results":[]} — that is a correct answer.
NEVER invent or reconstruct a task_id; an id not present in a tool result is discarded and counts as a wrong answer.
Do NOT output titles, phases, or projects — those are attached from the database.`;

export function buildUserPrompt(query: string): string {
  return `Find the Walnut task matching this search:\n"""${query}"""`;
}

export type AgentConfidence = 'high' | 'medium' | 'low';

export interface RawAgentAnswer {
  summary?: unknown;
  results: Array<{ task_id?: unknown; evidence?: unknown; confidence?: unknown }>;
}

export interface AgentSearchResult {
  taskId: string;
  /** Always from the Task record — never the model's text. */
  title: string;
  phase?: string;
  project?: string;
  evidence: string;
  confidence?: AgentConfidence;
  updatedAt?: string;
}

/**
 * Tolerant extraction: the child is told "JSON only" but cheap models wrap
 * answers in fences or prose. Take the outermost {...} slice and require a
 * `results` array (pattern: parseTriageAnswer in diff-summary.ts).
 */
export function parseAgentAnswer(answer: string): RawAgentAnswer {
  const start = answer.indexOf('{');
  const end = answer.lastIndexOf('}');
  if (start === -1 || end <= start) throw new Error('no JSON object in agent answer');
  const parsed: unknown = JSON.parse(answer.slice(start, end + 1));
  if (typeof parsed !== 'object' || parsed === null || !Array.isArray((parsed as { results?: unknown }).results)) {
    throw new Error('agent answer has no results array');
  }
  const obj = parsed as { summary?: unknown; results: unknown[] };
  return {
    summary: obj.summary,
    results: obj.results.filter((r): r is Record<string, unknown> => typeof r === 'object' && r !== null),
  };
}

function cleanText(value: unknown, maxChars: number): string {
  if (typeof value !== 'string') return '';
  // Strip control chars, collapse whitespace, cap by code point (an emoji
  // split mid-surrogate breaks JSON consumers downstream).
  const flat = value.replace(/\p{C}+/gu, ' ').replace(/\s+/g, ' ').trim();
  return [...flat].slice(0, maxChars).join('');
}

/**
 * Validate the model's task ids against the real task table and enrich from
 * it. Unknown ids are dropped and counted (the model invented them); 8-char
 * prefixes resolve like everywhere else in Walnut; duplicates collapse — this
 * is where task+session dedupe lands when the model lists a task twice.
 */
export function validateAndEnrich(
  raw: RawAgentAnswer,
  tasks: Task[],
): { summary?: string; results: AgentSearchResult[]; droppedIds: number } {
  const byId = new Map<string, Task>();
  for (const task of tasks) {
    byId.set(task.id, task);
    if (task.id.length > 8) byId.set(task.id.slice(0, 8), task);
  }
  const seen = new Set<string>();
  const results: AgentSearchResult[] = [];
  let droppedIds = 0;
  for (const row of raw.results) {
    if (results.length >= AGENT_SEARCH_MAX_RESULTS) break;
    const id = typeof row.task_id === 'string' ? row.task_id.trim() : '';
    const task = byId.get(id) ?? (id.length >= 8 ? byId.get(id.slice(0, 8)) : undefined);
    if (!task) { droppedIds += 1; continue; }
    if (seen.has(task.id)) continue;
    seen.add(task.id);
    const confidence = row.confidence === 'high' || row.confidence === 'medium' || row.confidence === 'low'
      ? row.confidence
      : undefined;
    results.push({
      taskId: task.id,
      title: task.title,
      phase: task.phase,
      ...(task.project ? { project: task.project } : {}),
      evidence: cleanText(row.evidence, EVIDENCE_MAX_CHARS),
      ...(confidence ? { confidence } : {}),
      ...(task.updated_at ? { updatedAt: task.updated_at } : {}),
    });
  }
  const summary = cleanText(raw.summary, SUMMARY_MAX_CHARS);
  return { ...(summary ? { summary } : {}), results, droppedIds };
}

const CONFIDENCE_RANK: Record<string, number> = { high: 0, medium: 1, low: 2 };

/**
 * Stable sort: confidence buckets preserve the agent's own ordering; ONLY the
 * tiebreak inside a bucket is recency — a recently-active task beats an old
 * loosely-related one (acceptance requirement 4).
 */
export function rankAgentResults(results: AgentSearchResult[]): AgentSearchResult[] {
  return [...results].sort((a, b) => {
    const ca = CONFIDENCE_RANK[a.confidence ?? ''] ?? 3;
    const cb = CONFIDENCE_RANK[b.confidence ?? ''] ?? 3;
    if (ca !== cb) return ca - cb;
    return (b.updatedAt ?? '').localeCompare(a.updatedAt ?? '');
  });
}

export function normalizeQueryKey(query: string): string {
  return query.trim().toLowerCase().replace(/\s+/g, ' ');
}
