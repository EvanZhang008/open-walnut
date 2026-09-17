/**
 * The ✦ AI search's own two message shapes — pure, dependency-free, and shared
 * by the server pipeline and the browser (see the `@open-walnut/search-transcript`
 * alias in web/vite.config.ts).
 *
 * The search runs in a REAL Claude Code session (task-search-agent.ts) and that
 * session is adoptable: "Open as session" hands the finished conversation to the
 * user (sessions/adopt-search-session.ts). So the two messages Walnut itself
 * caused now land in a chat panel, where they read as machine noise — a user
 * bubble holding the whole seeded prompt (a ~2.5KB row dump) and an assistant
 * bubble holding the raw answer object.
 *
 * This module is the ONE place that knows those shapes. The prompt's sentinels
 * are BUILT from these constants (task-search-agent-contract.ts) and PARSED back
 * from them here, so the wording and its reader cannot drift. Rendering them as
 * a card is Walnut recognizing its OWN text; the transcript is harness-owned
 * data and is never rewritten (precedent: session-outbound.ts, which cards a
 * session_send out of the SENDING session's own tool call).
 *
 * Both parsers are STRICT — anything not fully understood returns null, because
 * the fallback (render the text exactly as it renders today) is always safe,
 * while a half-understood card would hide words the model really wrote. Verified
 * against a real transcript (2026-09-16): the prompt message is exactly
 * head + `"""query"""` + the seed block, and the answer message is exactly the
 * JSON object — while the model's mid-run narration is ordinary prose that must
 * keep rendering as prose.
 */

/** First line of the search prompt. Walnut writes it; nothing else does. */
export const SEARCH_PROMPT_HEAD = 'Find the Walnut task matching this search:';
/** Opening words of the appended seed block (em dash included, as written). */
export const SEED_BLOCK_HEAD = 'SEED RESULTS — the raw query was already searched for you';
/** The query is wrapped in triple quotes, so a query may contain quotes. */
const FENCE = '"""';

/** Max results a search answer may carry. Both surfaces render at most this. */
export const AGENT_SEARCH_MAX_RESULTS = 5;

/** A results list longer than this is not an answer — it is some other JSON. */
const MAX_PARSEABLE_ROWS = 50;

/** Answers are ~2KB; this bounds the candidate walk in extractResultsObject. */
const MAX_JSON_CANDIDATES = 50;

/**
 * Flatten model text for display: strip control characters, collapse runs of
 * whitespace, cap by CODE POINT (a cap by UTF-16 unit can split an emoji
 * mid-surrogate and break every consumer downstream).
 */
export function cleanSearchText(value: unknown, maxChars: number): string {
  if (typeof value !== 'string') return '';
  const flat = value.replace(/\p{C}+/gu, ' ').replace(/\s+/g, ' ').trim();
  return [...flat].slice(0, maxChars).join('');
}

export interface SearchResultsObject {
  summary?: unknown;
  results: Record<string, unknown>[];
}

/**
 * Pull the answer object out of a model reply.
 *
 * Tolerant on purpose: the child is told "JSON only" but models wrap answers in
 * fences or prose — and sometimes QUOTE tool-output rows (their own `{…}` JSON)
 * before the real answer, so a naive first-`{`-to-last-`}` slice is garbage
 * (shipped a 502 unparseable, 2026-08-30). Walk the `{` candidates left to right
 * against the LAST `}` until one parses AND carries a `results` array; a quoted
 * row mid-prose fails the parse (trailing prose) and is skipped.
 */
export function extractResultsObject(answer: string): SearchResultsObject | null {
  const end = answer.lastIndexOf('}');
  if (end === -1) return null;
  let start = answer.indexOf('{');
  for (let i = 0; start !== -1 && start < end && i < MAX_JSON_CANDIDATES; i++, start = answer.indexOf('{', start + 1)) {
    let parsed: unknown;
    try { parsed = JSON.parse(answer.slice(start, end + 1)); } catch { continue; }
    if (typeof parsed !== 'object' || parsed === null || !Array.isArray((parsed as { results?: unknown }).results)) {
      continue;
    }
    const obj = parsed as { summary?: unknown; results: unknown[] };
    return {
      summary: obj.summary,
      results: obj.results.filter((r): r is Record<string, unknown> => typeof r === 'object' && r !== null),
    };
  }
  return null;
}

export interface SearchPromptMessage {
  /** What the human typed in the search box. */
  query: string;
  /** The appended seed block, verbatim, when the prompt carried one. */
  seed?: string;
  /** How many rows the seed block listed, when that could be counted. */
  seedRows?: number;
  /** The whole prompt with newlines normalized — what a disclosure discloses. */
  raw: string;
}

/** Rows in a seed block are one JSON array on one line. Count them, best effort. */
function countSeedRows(seed: string): number | undefined {
  for (const line of seed.split('\n')) {
    if (!line.startsWith('[')) continue;
    try {
      const parsed = JSON.parse(line) as unknown;
      if (Array.isArray(parsed)) return parsed.length;
    } catch { /* the count is decoration */ }
    return undefined;
  }
  return undefined;
}

/**
 * Recognize the search prompt Walnut sent, and split it into the human's query
 * and the machine block appended to it.
 *
 * Strict in three ways, each one a way a loose version loses content:
 *  · the head line must OPEN the message, so a message that merely quotes it
 *    (a person asking about this feature) is never eaten;
 *  · the quoted region must be exactly `"""…"""` — any other text between the
 *    head and the seed block means this is not the prompt we built;
 *  · the closing fence is looked for BEFORE the seed sentinel, so a query
 *    containing `"""` cannot swallow the block, and an absent sentinel simply
 *    means "no seed" (the seed fetch is allowed to fail).
 */
export function parseSearchPromptMessage(text: string): SearchPromptMessage | null {
  if (!text || !text.includes(SEARCH_PROMPT_HEAD)) return null;
  const raw = text.replace(/\r\n/g, '\n');
  const body = raw.replace(/^\s+/, '');
  if (!body.startsWith(`${SEARCH_PROMPT_HEAD}\n`)) return null;
  const rest = body.slice(SEARCH_PROMPT_HEAD.length + 1);

  const sentinelAt = rest.indexOf(`\n\n${SEED_BLOCK_HEAD}`);
  const quoted = (sentinelAt === -1 ? rest : rest.slice(0, sentinelAt)).replace(/\s+$/, '');
  if (!quoted.startsWith(FENCE) || !quoted.endsWith(FENCE) || quoted.length < FENCE.length * 2) return null;
  const query = quoted.slice(FENCE.length, quoted.length - FENCE.length);
  if (!query.trim()) return null;

  const seed = sentinelAt === -1 ? undefined : rest.slice(sentinelAt + 2);
  const seedRows = seed ? countSeedRows(seed) : undefined;
  return {
    query,
    ...(seed ? { seed } : {}),
    ...(seedRows !== undefined ? { seedRows } : {}),
    raw,
  };
}

export type SearchAnswerConfidence = 'high' | 'medium' | 'low';

export interface SearchAnswerRow {
  taskId: string;
  /** The model's one-phrase justification, flattened and clipped. */
  evidence?: string;
  confidence?: SearchAnswerConfidence;
}

export interface SearchAnswerMessage {
  summary?: string;
  rows: SearchAnswerRow[];
  /** Rows beyond the render cap, so a card can say "+N more" instead of lying. */
  extraRows: number;
}

/** Chars kept of the model's per-row evidence / of its summary. Shared with the
 *  live pipeline's enrichment (task-search-agent-contract) so the SAME answer is
 *  clipped identically whether it is read from the API or from the transcript. */
export const EVIDENCE_MAX_CHARS = 200;
export const SUMMARY_MAX_CHARS = 300;

/** One optional ``` fence around the whole reply — models add it unasked. */
const FENCED = /^```[a-z]*\n([\s\S]*)\n```$/;

/**
 * Recognize a message that is NOTHING BUT the search answer object.
 *
 * Deliberately stricter than extractResultsObject: that one serves the live
 * pipeline, where a best-effort answer beats a 502. Here a message with prose
 * around the JSON is a message with words in it, and words must render as
 * words — so anything but the bare object (optionally fenced) returns null and
 * keeps today's rendering. A row without a usable `task_id` rejects the WHOLE
 * message for the same reason: dropping it would silently hide a result.
 */
export function parseSearchAnswerMessage(text: string): SearchAnswerMessage | null {
  if (!text) return null;
  const trimmed = text.trim();
  if (!trimmed) return null;
  const inner = (FENCED.exec(trimmed)?.[1] ?? trimmed).trim();
  if (!inner.startsWith('{') || !inner.endsWith('}')) return null;
  const parsed = extractResultsObject(inner);
  if (!parsed) return null;
  if (parsed.results.length > MAX_PARSEABLE_ROWS) return null;

  const rows: SearchAnswerRow[] = [];
  const seen = new Set<string>();
  for (const row of parsed.results) {
    const taskId = typeof row.task_id === 'string' ? row.task_id.trim() : '';
    if (!taskId) return null;
    // One task, one row — the prompt says so ("The same task reached via both
    // lanes is ONE result") and the live card enforces it while enriching, so a
    // transcript listing a task twice must not render it twice either. Only
    // literal repeats can be caught here; an id and a PREFIX of it are the same
    // task, and that pair collapses once the ids resolve (SearchAnswerCard).
    if (seen.has(taskId)) continue;
    seen.add(taskId);
    const confidence = row.confidence === 'high' || row.confidence === 'medium' || row.confidence === 'low'
      ? row.confidence
      : undefined;
    const evidence = cleanSearchText(row.evidence, EVIDENCE_MAX_CHARS);
    rows.push({
      taskId,
      ...(evidence ? { evidence } : {}),
      ...(confidence ? { confidence } : {}),
    });
  }
  const summary = cleanSearchText(parsed.summary, SUMMARY_MAX_CHARS);
  return {
    ...(summary ? { summary } : {}),
    rows: rows.slice(0, AGENT_SEARCH_MAX_RESULTS),
    extraRows: Math.max(0, rows.length - AGENT_SEARCH_MAX_RESULTS),
  };
}
