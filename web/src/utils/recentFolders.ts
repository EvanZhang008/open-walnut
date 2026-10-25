/**
 * Folder history for the "@" file-mention picker. "@?" reads the union of session
 * working dirs and "@"-browsed folders via GET /api/files/recent-dirs; the server
 * keeps the two stores separate so "@" browsing never pollutes the /session picker.
 */
import { apiGet, apiPost } from '@/api/client';
import { log } from '@/utils/log';
import { fuzzyScore } from '@/utils/fuzzy';

export { tokenize, isSubsequence, fuzzyScore } from '@/utils/fuzzy';

export interface RecentFolder {
  path: string;
  host?: string;
  count?: number;
}

export function recordRecentFolder(path: string, host?: string): void {
  if (!path || path === '/') return;
  const norm = path.replace(/\/+$/, '') || '/';
  apiPost('/api/files/record-dir', { path: norm, host })
    .catch((err) => log.error('recent-folders', 'record failed', { path: norm, error: String(err) }));
}

/**
 * Recent folders on `host` (undefined = local), most-recent first. A remote session
 * must not see local folders: it cannot reference them over its transport.
 */
export async function getRecentFolders(host?: string): Promise<RecentFolder[]> {
  try {
    const res = await apiGet<{ dirs: { cwd: string; host: string | null; count?: number }[] }>('/api/files/recent-dirs');
    const wantHost = host ?? null;
    return res.dirs
      .filter((d) => (d.host ?? null) === wantHost)
      .map((d) => ({ path: d.cwd, host: d.host ?? undefined, count: d.count }));
  } catch {
    return [];
  }
}

export function fuzzyMatchRecents(query: string, recents: RecentFolder[]): RecentFolder[] {
  const q = query.trim();
  const scored = recents.map((r, idx) => ({ r, score: q ? fuzzyScore(q, r.path) : 0, idx }))
    .filter(({ score }) => !q || score > 0);
  // Input order is server recency. An empty query keeps it (the list is "recent
  // folders"); a query ranks equal matches by usage. Nearby folders have no count.
  scored.sort((a, b) =>
    (b.score - a.score) ||
    (q ? (b.r.count ?? 0) - (a.r.count ?? 0) : 0) ||
    (a.idx - b.idx),
  );
  return scored.map((s) => s.r);
}
