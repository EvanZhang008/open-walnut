/**
 * Session mention ("@<session> message") — pure logic.
 *
 * Mirrors Claude Code's direct-member-message convention: a message whose FIRST
 * character is "@" followed by a name and a space is a direct message to that
 * peer, not to the current session (Claude Code parses `^@([\w-]+)\s+(.+)$` in
 * its input box; verified against the 2.1.240 binary). Walnut inserts the
 * 8-char session id prefix as the name — the server's
 * resolveSessionByIdOrPrefix resolves it back (409 on ambiguity, so a routed
 * send can never silently reach the wrong session).
 *
 * The "@" popup is ONE unified palette with two groups — Sessions and Files —
 * and the query decides which group leads (routeMention). Session rows are
 * filtered here, in memory, with a VS-Code-style subsequence matcher: zero
 * debounce, zero network per keystroke, and the matched characters are
 * returned so the UI can highlight WHY a row matched.
 */

export interface SessionMentionCandidate {
  /** Full session id (routing key). */
  id: string;
  title: string;
  host: string;
  status: string;
  lastActiveAt: string;
}

/** Where an active "@query" should route. */
export type MentionRoute =
  | { kind: 'recents' }
  | { kind: 'palette'; order: 'sessions-first' | 'files-first' };

/**
 * Routing rule for an active "@" at `atIndex` with `query` typed after it:
 *  - "@?…"           → the recent-folders popup (unchanged legacy mode);
 *  - path-shaped     → unified palette, FILES group first ("/" or "~" means the
 *    user is clearly typing a path — descend into it, don't fight them);
 *  - mid-text "@"    → unified palette, files first (referencing something
 *    inside a sentence is almost always a file);
 *  - line-start "@"  → unified palette, SESSIONS first (the whole message is
 *    about to be routed somewhere — Claude Code's `@name message`).
 */
export function routeMention(atIndex: number, query: string): MentionRoute {
  if (query.startsWith('?')) return { kind: 'recents' };
  if (query.includes('/') || query.startsWith('~')) return { kind: 'palette', order: 'files-first' };
  if (atIndex === 0) return { kind: 'palette', order: 'sessions-first' };
  return { kind: 'palette', order: 'files-first' };
}

/** Greedy subsequence match of `q` in `h` starting at `from`, or null. */
function greedyFrom(q: string, h: string, from: number): number[] | null {
  const positions: number[] = [];
  for (let i = 0; i < q.length; i++) {
    const idx = h.indexOf(q[i], from);
    if (idx === -1) return null;
    positions.push(idx);
    from = idx + 1;
  }
  return positions;
}

function scorePositions(qLen: number, hay: string, positions: number[]): number {
  let score = 0;
  const span = positions[positions.length - 1] - positions[0] + 1;
  score -= (span - qLen) * 2; // gaps between matched chars
  score -= positions[0] * 0.5; // earlier start is better
  for (let k = 0; k < positions.length; k++) {
    const p = positions[k];
    if (p === 0 || /[\s\-_./:]/.test(hay[p - 1])) score += 3; // word boundary
    if (k > 0 && p === positions[k - 1] + 1) score += 1; // consecutive run
  }
  return score;
}

/**
 * Case-insensitive subsequence match (VS Code style). Returns the matched
 * character positions (for highlighting) and a score — higher is better:
 * word-boundary and consecutive hits score up, gaps and late starts score
 * down.
 *
 * A single greedy pass has a known trap: "target" against "Walnut mention e2e
 * target" grabs the "t" in "Walnut" and shreds the tight word match at the
 * end. So the greedy match is retried from EVERY occurrence of the query's
 * first character (bounded) and the best-scoring alignment wins.
 */
export function fuzzyMatch(
  query: string,
  hay: string,
): { positions: number[]; score: number } | null {
  if (!query) return { positions: [], score: 0 };
  const q = query.toLowerCase();
  const h = hay.toLowerCase();
  let best: { positions: number[]; score: number } | null = null;
  let start = h.indexOf(q[0]);
  let tries = 0;
  while (start !== -1 && tries < 24) {
    const positions = greedyFrom(q, h, start);
    if (!positions) break; // no full match from here → none from any later start
    const score = scorePositions(q.length, hay, positions);
    if (!best || score > best.score) best = { positions, score };
    start = h.indexOf(q[0], start + 1);
    tries++;
  }
  return best;
}

/** A session row ready to render: which field matched and where. */
export interface RankedSessionMention {
  session: SessionMentionCandidate;
  /** null on an empty query (nothing to highlight). */
  matchField: 'title' | 'id' | 'host' | null;
  positions: number[];
}

/** Active sessions outrank idle ones when scores tie / query is empty. */
function statusWeight(status: string): number {
  return status === 'running' ? 0 : 1;
}

/**
 * Filter + rank the in-memory session list against the typed query.
 * Empty query → most useful first: running sessions, then recency.
 * Non-empty → best fuzzy score wins (title preferred over id over host on
 * ties); the matched field's positions come back for highlighting.
 */
export function rankSessionMentions(
  query: string,
  candidates: SessionMentionCandidate[],
  opts: { excludeId?: string; limit?: number } = {},
): RankedSessionMention[] {
  const limit = opts.limit ?? 8;
  const pool = opts.excludeId ? candidates.filter((c) => c.id !== opts.excludeId) : candidates;

  if (!query) {
    return [...pool]
      .sort(
        (a, b) =>
          statusWeight(a.status) - statusWeight(b.status) ||
          b.lastActiveAt.localeCompare(a.lastActiveAt),
      )
      .slice(0, limit)
      .map((session) => ({ session, matchField: null, positions: [] }));
  }

  const hits: Array<RankedSessionMention & { score: number }> = [];
  for (const session of pool) {
    // Try each searchable field; keep the best (field priority breaks ties).
    const fields: Array<['title' | 'id' | 'host', string, number]> = [
      ['title', session.title, 2],
      ['id', session.id.slice(0, 8), 1],
      ['host', session.host === '__local__' ? 'local' : session.host, 0],
    ];
    let best: (RankedSessionMention & { score: number }) | null = null;
    for (const [field, text, bias] of fields) {
      const m = fuzzyMatch(query, text);
      if (!m) continue;
      const scored = { session, matchField: field, positions: m.positions, score: m.score * 4 + bias };
      if (!best || scored.score > best.score) best = scored;
    }
    if (best) hits.push(best);
  }
  return hits
    .sort(
      (a, b) =>
        b.score - a.score ||
        statusWeight(a.session.status) - statusWeight(b.session.status) ||
        b.session.lastActiveAt.localeCompare(a.session.lastActiveAt),
    )
    .slice(0, limit)
    .map(({ session, matchField, positions }) => ({ session, matchField, positions }));
}

/**
 * Parse a leading session directive: `@<ref> <body>`. Returns null when the
 * text can't be one (no leading @, no space, or a ref that can't be an id
 * prefix). A non-null result still needs server-side prefix resolution.
 */
export function parseSessionDirective(text: string): { ref: string; body: string } | null {
  const m = text.match(/^@([\w-]{4,})\s+([\s\S]+)$/);
  if (!m) return null;
  const body = m[2].trim();
  if (!body) return null;
  return { ref: m[1], body };
}

/** The token inserted into the composer for a picked session. */
export function formatSessionRef(id: string): string {
  return `@${id.slice(0, 8)} `;
}

/**
 * Resolve a directive ref against the in-memory index the same way the server
 * does (unique id-prefix): used for the pre-send "will send to …" hint strip.
 * Ambiguous or unknown → null (the server stays the routing authority).
 */
export function resolveRefInIndex(
  ref: string,
  candidates: SessionMentionCandidate[],
): SessionMentionCandidate | null {
  const matches = candidates.filter((c) => c.id.startsWith(ref));
  return matches.length === 1 ? matches[0] : null;
}
