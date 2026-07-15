/**
 * Shared fuzzy-matching primitives — extracted from recentFolders.ts so the
 * "@" file-mention picker and the /session path selector share ONE scorer
 * instead of growing parallel implementations.
 *
 * recentFolders.ts re-exports these; import from either place.
 */

/** Split a string into lowercase alphanumeric tokens (path separators and any
 *  punctuation count as boundaries). "MyLongPackageName" stays one token;
 *  "a/b-c_d" → ["a","b","c","d"]. (No /i flag needed — input is lowercased first.) */
export function tokenize(s: string): string[] {
  return s.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
}

/** Contiguous-subsequence test: does `q` appear in order within `p`? (cheap) */
export function isSubsequence(q: string, p: string): boolean {
  let qi = 0;
  for (let i = 0; i < p.length && qi < q.length; i++) if (p[i] === q[qi]) qi++;
  return qi === q.length;
}

/**
 * Token-aware relevance score (0 = no signal, higher = better). Unlike a strict
 * subsequence match, this never hard-excludes a path — so pasting one long path
 * surfaces its SIBLINGS (shared tokens) ranked by how much they overlap.
 *
 * Signals are CUMULATIVE (summed, not exclusive bands) — a path can earn several
 * at once, which is intentional: "matches as a substring AND in the folder name"
 * should outrank "matches as a substring only". Weights, strongest first:
 *   +10  whole query is a substring of the full path        (exact-ish)
 *   +6   whole query is a substring of the last segment     (folder-name hit)
 *   +4   per query token that exactly equals a path token   (segment hit)
 *   +2   per query token that is a substring of some token  (partial)
 *   +2   per query token that hits the last segment         (folder-name bonus)
 *   +1   whole query is a subsequence of the path           (loose fuzzy fallback)
 * These weights are calibrated as ONE scale with the cwd/host boosts in
 * recentFolders.ts (UNDER_CWD_BOOST ≈ a substring hit; SAME_HOST_BOOST ≈ one
 * token hit) — change them together, and note the boosts only re-rank, they
 * never resurrect a 0-score.
 */
export function fuzzyScore(query: string, path: string): number {
  const q = query.trim().toLowerCase();
  if (!q) return 0;
  const p = path.toLowerCase();
  const lastSeg = p.slice(p.lastIndexOf('/') + 1);

  let score = 0;
  if (p.includes(q)) score += 10;
  if (lastSeg.includes(q)) score += 6;

  const qTokens = tokenize(query);
  const pTokens = new Set(tokenize(path));
  const lastTokens = new Set(tokenize(lastSeg));
  for (const qt of qTokens) {
    if (pTokens.has(qt)) score += 4;            // exact segment/token hit
    else if ([...pTokens].some((pt) => pt.includes(qt))) score += 2; // partial token
    if (lastTokens.has(qt)) score += 2;         // bonus: in the folder name
  }

  if (score === 0 && isSubsequence(q, p)) score += 1; // loose fuzzy fallback
  return score;
}

/** Match-quality band for ranking: how well does `needle` match `hay`?
 *  Bands (best → worst): prefix > substring > subsequence > none.
 *  Comparison is case-insensitive. Empty needle counts as 'prefix' (matches everything). */
export type MatchQuality = 'prefix' | 'substring' | 'subsequence' | 'none';

const QUALITY_RANK: Record<MatchQuality, number> = { prefix: 3, substring: 2, subsequence: 1, none: 0 };

export function matchQuality(needle: string, hay: string): MatchQuality {
  const n = needle.toLowerCase();
  const h = hay.toLowerCase();
  if (n.length === 0) return 'prefix';
  if (h.startsWith(n)) return 'prefix';
  if (h.includes(n)) return 'substring';
  if (isSubsequence(n, h)) return 'subsequence';
  return 'none';
}

/** Numeric rank for a MatchQuality (higher = better) — for use in comparators. */
export function qualityRank(q: MatchQuality): number {
  return QUALITY_RANK[q];
}
