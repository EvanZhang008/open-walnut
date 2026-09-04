/**
 * "@" mention — routing + the fuzzy matcher shared by every palette group.
 *
 * The "@" popup is ONE unified palette: Walnut entities (Tasks / Sessions /
 * Projects, each pick INSERTS A REFERENCE pill) plus Files (Claude Code's own
 * `@path` convention). routeMention decides which half leads from the shape of
 * the query alone: a path-shaped query means the user is typing a path, so
 * Files lead and directory navigation keeps working; anything else leads with
 * the entities. Ranking itself lives in mention-entities.ts.
 */

export interface SessionMentionCandidate {
  /** Full session id. */
  id: string;
  title: string;
  host: string;
  status: string;
  lastActiveAt: string;
  /** Owning task id, '' when the session has none. Additive — absent on servers
   *  older than the session-envelope card, so every reader must tolerate that. */
  taskId?: string;
}

/**
 * Resolve a short session id against the in-memory index the same way the
 * server does (unique id-prefix): used by the provenance card to turn a peer's
 * short id into a clickable chip. Ambiguous or unknown → null.
 */
export function resolveRefInIndex(
  ref: string,
  candidates: SessionMentionCandidate[],
): SessionMentionCandidate | null {
  const matches = candidates.filter((c) => c.id.startsWith(ref));
  return matches.length === 1 ? matches[0] : null;
}

/** Where an active "@query" should route. */
export type MentionRoute =
  | { kind: 'recents' }
  | { kind: 'palette'; order: 'entities-first' | 'files-first' };

/**
 * Routing rule for the text typed after an "@":
 *  - "@?…"        → the recent-folders popup (unchanged legacy mode);
 *  - path-shaped  → unified palette, FILES first ("/" or "~" means the user is
 *    clearly typing a path — descend into it, don't fight them);
 *  - otherwise    → unified palette, ENTITIES first (tasks / sessions /
 *    projects are what a bare "@" is most often reaching for; Files stay
 *    visible right below).
 * Position in the message deliberately does not matter: a reference is a
 * reference wherever it sits.
 */
export function routeMention(query: string): MentionRoute {
  if (query.startsWith('?')) return { kind: 'recents' };
  if (query.includes('/') || query.startsWith('~')) return { kind: 'palette', order: 'files-first' };
  return { kind: 'palette', order: 'entities-first' };
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
