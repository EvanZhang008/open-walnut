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
export const AGENT_SEARCH_PROMPT_V = 'v4';

export const AGENT_SEARCH_MAX_RESULTS = 5;
const EVIDENCE_MAX_CHARS = 200;
const SUMMARY_MAX_CHARS = 300;

const PROMPT_HEADER = `You find WHICH of the user's Walnut tasks matches a search phrase. You are a search tool, not a chat assistant. Reply with JSON only.

## The failure you exist to prevent
A task's own title/note are often WRONG or EMPTY (tasks auto-created for a coding session start as "Session: <folder>" with a blank note); the real intent lives ONLY in the session transcript. Task-lane-only search misses these.`;

const PROMPT_FOOTER = `## Owner rule
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

/**
 * System prompt for the claude -p child (the default engine; slim shell,
 * Bash-only). With `apiBase` (the running server's own 127.0.0.1 address)
 * the child searches via curl against the local HTTP API — tens of ms per
 * search vs spawning a whole `walnut` CLI process per query (~0.5s quiet,
 * ~10s under machine load; a 70s hard query was mostly these spawns).
 * Without apiBase (tests, pre-listen callers) it falls back to the walnut
 * CLI, which rides PATH and needs no URL.
 *
 * slim=1 + tight limits are LOAD-BEARING, not politeness: the CLI persists
 * any Bash output over ~10k chars to a file (`<persisted-output>`) instead
 * of showing it, and verbose rows at limit=15 x 5 variants hit 25KB — the
 * child then burned its whole 80s budget cat/grep/python-ing a file it
 * could never inline (2026-08-29 transcripts). Slim rows (~350 chars) at 4
 * variants x limit=5 stay ~7KB, safely inline.
 */
export function buildCliSystemPrompt(apiBase?: string): string {
  const single = apiBase
    ? `curl -sGm15 "${apiBase}/api/search" --data-urlencode "q=<terms>" -d "types=task,session" -d "limit=8" -d "slim=1"`
    : `walnut tools call search '{"q":"<terms>","types":"task,session","limit":15}'`;
  const batched = apiBase
    ? `for q in 'variant one' 'variant two' '变体三'; do curl -sGm15 "${apiBase}/api/search" --data-urlencode "q=$q" -d "types=task,session" -d "limit=5" -d "slim=1" & done; wait`
    : `for q in 'variant one' 'variant two' '变体三'; do walnut tools call search "{\\"q\\":\\"$q\\",\\"types\\":\\"task,session\\",\\"limit\\":15}" & done; wait`;
  const rowNote = apiBase
    ? `\n   Rows are compact {type,id,title,summary}: a task row's id IS the task_id; a session row's id is ALREADY the owning task's id — copy id exactly.`
    : '';
  return `${PROMPT_HEADER}

## Method — search via Bash. Every extra Bash call costs seconds; fewest calls wins.
  ${single}${rowNote}
0. The user message already contains SEED RESULTS: the raw query was searched for you. If they clearly identify the owning task, answer IMMEDIATELY — run nothing.
1. Otherwise run your query variants in ONE Bash command, concurrently — AT MOST 4 variants (more overflows the tool output and you see NOTHING):
  ${batched}
   Use DIFFERENT vocabulary — the literal strings a transcript would contain (package names, file extensions, commands, API names) plus an English <-> Chinese translation. The seed query counts as already used.
2. At most ONE more such batched command if nothing was convincing.
Stop as soon as you are confident. Never repeat a query.

${PROMPT_FOOTER}`;
}

/** apiBase-less fallback shape (what injected-engine tests pin). */
export const SYSTEM_PROMPT = buildCliSystemPrompt();

/**
 * System prompt for the in-process engine (WALNUT_AGENT_SEARCH_ENGINE=
 * inprocess): the model has ONE native tool, `search`. Latency is dominated
 * by model round-trips, so the method
 * section pushes hard on batching query variants as PARALLEL tool calls in a
 * single round — profiled 2026-08-27: every extra round costs ~2-3s of model
 * time while a search call itself is ~150ms.
 */
export const SYSTEM_PROMPT_TOOL_LOOP = `${PROMPT_HEADER}

## Method — every model round costs the user seconds. Fewest rounds wins.
0. The user message already contains SEED RESULTS: the raw query was searched for you. If they clearly identify the owning task, answer IMMEDIATELY — no tool calls at all.
1. Otherwise: issue SEVERAL search calls AT ONCE (parallel tool calls in one reply): variants with DIFFERENT vocabulary — the literal strings a transcript would contain (package names, file extensions, commands, API names) — plus an English <-> Chinese translation when the query could be phrased in the other language.
2. Only if still nothing convincing: ONE more batched round with new vocabulary. Never repeat a query (the seed query counts as used).
Then answer. Do not deliberate between rounds — a wide batch of searches beats thinking. Keep the answer terse: short evidence quotes, one-line summary.
If a system message says your tool rounds are exhausted, print the JSON answer IMMEDIATELY from what you already saw (best guesses with lower confidence, or {"results":[]}). Never reply with prose about wanting more searches — a reply without the JSON object is a total failure.

${PROMPT_FOOTER}`;

/** Appended to the user prompt by the in-process engine: the raw query's own
 *  search results, pre-fetched server-side so the common case needs ONE model
 *  round instead of two (search round + answer round). */
export function buildSeedResultsBlock(rowsJson: string): string {
  return `\n\nSEED RESULTS — the raw query was already searched for you (search tool, same format):\n${rowsJson}\nIf these identify the owning task, answer now without any tool calls.`;
}

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
