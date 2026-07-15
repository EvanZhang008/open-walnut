/**
 * Recently-opened folder history for the "@" file-mention picker.
 *
 * Server-persisted (shared across browsers/devices, survives restart). "@?" reads
 * the UNION of two stores via GET /api/files/recent-dirs:
 *   - session working dirs (frequent-directories) — what /session also uses
 *   - folders browsed in "@" (mention-directories) — recorded via POST /record-dir
 * The two are kept SEPARATE server-side so "@" browsing never pollutes the /session
 * path picker (which reads frequent-dirs only). This file only ever touches the
 * union read + the mention-dir write — never the session store directly.
 */
import { apiGet, apiPost } from '@/api/client';
import { log } from '@/utils/log';

export interface RecentFolder {
  path: string;
  host?: string;
}

/** Record an "@"-picker folder visit into the mention-dirs store (fire-and-forget).
 *  Root ("/") is skipped as noise; the `|| '/'` is just defensive normalization. */
export function recordRecentFolder(path: string, host?: string): void {
  if (!path || path === '/') return;
  const norm = path.replace(/\/+$/, '') || '/';
  apiPost('/api/files/record-dir', { path: norm, host })
    .catch((err) => log.error('recent-folders', 'record failed', { path: norm, error: String(err) }));
}

/**
 * ALL recent folders (session ∪ "@"-browsed) across every host, most-recent first.
 * "@?" is a GLOBAL search — it returns folders on every host, not just the current
 * one; the current-path/same-host boost is applied at ranking time (see
 * fuzzyMatchRecents) so those still float to the top.
 *
 * Scoped to `host` (undefined = local): folders live on a specific machine, so a
 * remote session must NOT surface local folders (you can't reference them over
 * that session's transport). "Global" here means across all PATHS on this host —
 * not limited to the current cwd subtree — NOT across hosts.
 */
export async function getRecentFolders(host?: string): Promise<RecentFolder[]> {
  try {
    const res = await apiGet<{ dirs: { cwd: string; host: string | null }[] }>('/api/files/recent-dirs');
    const wantHost = host ?? null;
    return res.dirs
      .filter((d) => (d.host ?? null) === wantHost)
      .map((d) => ({ path: d.cwd, host: d.host ?? undefined }));
  } catch {
    return [];
  }
}

// Fuzzy primitives moved to @/utils/fuzzy (shared with the /session path
// selector). Re-exported here so existing imports keep working.
import { fuzzyScore } from '@/utils/fuzzy';
export { tokenize, isSubsequence, fuzzyScore } from '@/utils/fuzzy';

/** Context for ranking — folders under the current cwd get a tiebreaker bump.
 *  (host is already hard-filtered upstream in getRecentFolders, so it's not a
 *  ranking input here — every candidate is already on the right host.) */
export interface RecentContext {
  cwd?: string;
}

/**
 * Fuzzy-match recents against a query, best fuzzy score first.
 *
 * "under the current cwd" is a SECONDARY sort key, NOT added into the fuzzy score
 * — otherwise a weakly-matching folder under cwd could leapfrog a far stronger
 * match elsewhere. So ranking is: (1) fuzzy relevance, then (2) under-cwd first,
 * then (3) input order (which the server pre-sorted by recency). With an empty
 * query all fuzzy scores are 0, so it degrades to under-cwd-then-recency.
 * Folders with zero fuzzy signal (and a non-empty query) are dropped.
 */
export function fuzzyMatchRecents(
  query: string,
  recents: RecentFolder[],
  ctx: RecentContext = {},
): RecentFolder[] {
  const q = query.trim();
  const cwd = ctx.cwd ? ctx.cwd.replace(/\/+$/, '') : '';
  const underCwd = (r: RecentFolder): boolean =>
    !!cwd && (r.path === cwd || r.path.startsWith(cwd + '/'));

  const scored: { r: RecentFolder; score: number; cwd: boolean; idx: number }[] = [];
  recents.forEach((r, idx) => {
    const base = q ? fuzzyScore(q, r.path) : 0;
    if (q && base === 0) return; // non-empty query with zero signal → drop
    scored.push({ r, score: base, cwd: underCwd(r), idx });
  });
  scored.sort((a, b) =>
    (b.score - a.score) ||              // 1. fuzzy relevance
    (Number(b.cwd) - Number(a.cwd)) ||  // 2. under current cwd
    (a.idx - b.idx),                    // 3. server recency order
  );
  return scored.map((s) => s.r);
}
