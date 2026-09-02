/**
 * The id lane: a pasted task/session id is a LOOKUP, not a relevance question.
 *
 * Task ids are `<base36 ms>-<4 hex>` (`mtjpcnzl-d230`); session ids are Claude
 * Code uuids. Both are terrible embedding inputs and carry no prose for FTS to
 * match, so before this lane existed the only id query that worked was a bare,
 * undecorated, complete one (search.ts's `score === 1` reference short-circuit).
 * Everything else fell into the ranking legs, which meant: a PREFIX paid the
 * full hybrid cost — three lanes, an embedder warm — to return a row the
 * reference lane already had; and an id wearing any decoration (backticks from
 * an agent's message, a trailing period from prose, brackets from a log line)
 * matched nothing at all and came back as semantic noise.
 *
 * This lane answers those from the stores alone: no index, no embedder, no
 * ranking. It runs ahead of every scoring leg and, on a hit, IS the answer.
 *
 * It does NOT replace search.ts's reference short-circuit. That one still
 * resolves things this lane deliberately refuses to guess at: exact
 * `external_url` matches, and exact ids in a FOREIGN format (sync-plugin GUIDs
 * and imported ids that are not base36-and-dash).
 */

import type { SessionRecord, Task } from '../types.js';

/**
 * Minimum id-query length. 6, matching the hybrid library's own identifier
 * floor (`IDENT_PREFIX_MIN` in src/lib/hybrid-search/query.ts) so a token is
 * "identifier-shaped" at one length everywhere in search.
 *
 * Why 6 is the right line for task ids specifically: the prefix is a base36
 * millisecond clock, so each character dropped multiplies the creation window
 * it names by 36. A 6-char prefix names a 1,296 ms window — at most a handful
 * of tasks, and we return all of them. At 5 the window is 47 s and at 4 it is
 * 28 min, which is a browse, not a lookup, and a browse belongs in the ranked
 * legs where it can be judged against content.
 */
export const MIN_ID_QUERY_LENGTH = 6;

/**
 * Length at which a purely alphabetic token may be treated as an id.
 *
 * A short id query must not be able to HIJACK an ordinary word search: this
 * lane short-circuits, so a false positive doesn't add a bad row, it deletes
 * every good one. Words made only of [a-f] ("facade", "decade") or of base36
 * letters are real, so 6-7 letter tokens with no digit and no dash stay out.
 * From 8 they are safe by construction: the base36 millisecond clock is
 * exactly 8 characters, so an 8-char pure-alpha query can only match a task id
 * by BEING that task's whole timestamp, and the clock's current prefix ("mt…",
 * "n8…") spells no English word.
 *
 * A digit or a dash anywhere is proof of opacity, so those qualify from 6 —
 * which covers most real ids, since a base36 millisecond usually contains one.
 */
const MIN_ALPHA_ONLY_ID_LENGTH = 8;

/** Longest id we will consider: a uuid is 36 chars. */
const MAX_ID_QUERY_LENGTH = 36;

/** Wrapper pairs an id arrives in: agent markdown, prose, log lines. */
const WRAPPERS: ReadonlyArray<[string, string]> = [
  ['`', '`'], ['"', '"'], ["'", "'"], ['(', ')'], ['[', ']'], ['{', '}'], ['<', '>'],
];

/** Trailing/leading noise that is punctuation, never part of an id. */
const EDGE_NOISE = /^[\s.,;:!?#@|]+|[\s.,;:!?#@|]+$/g;

/**
 * Strip decoration until the text stops shrinking. An id reference in the wild
 * is `` `id` ``, `(id)`, `id:`, `"id".` — combinations included — so one pass is
 * not enough. Shape validation happens AFTER this, on the result, which is what
 * keeps unwrapping from laundering junk into a hit.
 */
export function unwrapIdReference(raw: string): string {
  let text = raw.trim();
  for (let i = 0; i < 6; i++) {
    const before = text;
    text = text.replace(EDGE_NOISE, '');
    for (const [open, close] of WRAPPERS) {
      if (text.length > 2 && text.startsWith(open) && text.endsWith(close)) {
        text = text.slice(1, -1).trim();
      }
    }
    if (text === before) break;
  }
  return text;
}

export interface IdQuery {
  /** Lowercased, decoration-free id text to match against. */
  needle: string;
  /** True when the needle spells a complete task id (`base36-hex`). */
  wholeTaskId: boolean;
  /**
   * True when the needle could be a session id — those are uuids, so hex and
   * dashes only. Gates the session-store read: without it, every long
   * single-word query ('typescript', 'starbutton') would pay for a session
   * list it provably cannot match.
   */
  sessionShaped: boolean;
}

/**
 * Is this whole query an id reference? Returns null for anything that could be
 * prose — the lane only ever fires on a query that is nothing but one opaque
 * token.
 */
export function parseIdQuery(raw: string): IdQuery | null {
  const needle = unwrapIdReference(raw).toLowerCase();
  if (needle.length < MIN_ID_QUERY_LENGTH || needle.length > MAX_ID_QUERY_LENGTH) return null;
  // base36 + dash only, and it must start with an id character (not a dash).
  if (!/^[0-9a-z][0-9a-z-]*[0-9a-z]$/.test(needle)) return null;
  const opaque = /[0-9-]/.test(needle) || needle.length >= MIN_ALPHA_ONLY_ID_LENGTH;
  if (!opaque) return null;
  return {
    needle,
    wholeTaskId: /^[0-9a-z]{6,12}-[0-9a-f]{2,8}$/.test(needle),
    sessionShaped: /^[0-9a-f-]+$/.test(needle),
  };
}

export interface IdMatch {
  /** 'id' for a task's own id, 'session_id' for a session reference. */
  matchField: 'id' | 'session_id';
  /** 1 = the needle IS the id; 0.99 = the needle is a prefix of it. */
  score: 1 | 0.99;
  task?: Task;
  session?: SessionRecord;
  /** The id value that matched — what the snippet shows. */
  value: string;
}

function matchScore(value: string | undefined, needle: string): 1 | 0.99 | 0 {
  if (!value) return 0;
  const lower = value.toLowerCase();
  if (lower === needle) return 1;
  return lower.startsWith(needle) ? 0.99 : 0;
}

/**
 * Resolve an id query against the stores.
 *
 * Ambiguity is answered with ALL matches, never a guess: a prefix that names
 * two tasks created in the same second must show both, because a confident
 * wrong answer is worse than a list. Exact matches, when any exist, suppress
 * the prefix matches — an id that IS a task's id is not ambiguous.
 */
export function matchIdQuery(
  query: IdQuery,
  stores: { tasks?: readonly Task[]; sessions?: readonly SessionRecord[] },
): IdMatch[] {
  const { needle } = query;
  const matches: IdMatch[] = [];

  for (const task of stores.tasks ?? []) {
    const score = matchScore(task.id, needle);
    if (score) matches.push({ matchField: 'id', score, task, value: task.id });
  }

  // Session ids resolve through the session record, whose taskId is the
  // authoritative owner link (task-side session fields go stale on fork/reuse).
  for (const session of stores.sessions ?? []) {
    const score = matchScore(session.claudeSessionId, needle);
    if (score) {
      matches.push({
        matchField: 'session_id', score, session, value: session.claudeSessionId,
      });
    }
  }

  const exact = matches.filter((m) => m.score === 1);
  const kept = exact.length > 0 ? exact : matches;
  // Newest first among equally-scored prefix matches. Task ids sort
  // chronologically as strings (the prefix is a fixed-width base36 clock), so a
  // descending compare on the matched value is a creation-time sort for free.
  return kept.sort((a, b) => b.score - a.score || b.value.localeCompare(a.value));
}
