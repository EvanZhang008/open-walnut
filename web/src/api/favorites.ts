import { apiGet, apiPost, apiDelete } from './client';

export interface Favorites {
  projects: string[];
  /** Vault-relative note paths (WITH .md), e.g. "PARA/foo.md". */
  notes: string[];
}

export async function fetchFavorites(): Promise<Favorites> {
  return apiGet<Favorites>('/api/favorites');
}

// Project favorites are matched case-INSENSITIVELY server-side (project identity
// is NOCASE) and stored under the registry's canonical spelling. Both mutations
// answer with the full post-write list, so callers should adopt it verbatim
// instead of patching their local copy with the requested spelling.
export async function addFavoriteProject(name: string): Promise<string[]> {
  const res = await apiPost<{ projects: string[] }>(`/api/favorites/projects/${encodeURIComponent(name)}`);
  return res.projects ?? [];
}

export async function removeFavoriteProject(name: string): Promise<string[]> {
  const res = await apiDelete<{ projects: string[] }>(`/api/favorites/projects/${encodeURIComponent(name)}`);
  return res.projects ?? [];
}

// Note paths contain slashes + .md, so add goes in the request BODY (the BE reads
// req.body.path). Remove uses the query string, since the shared apiDelete client
// helper sends no body — the BE accepts ?path= as the documented fallback. Paths
// are stored/compared verbatim WITH .md (exact-string match, no normalization).
export async function addFavoriteNote(path: string): Promise<void> {
  await apiPost('/api/favorites/notes', { path });
}

export async function removeFavoriteNote(path: string): Promise<void> {
  await apiDelete(`/api/favorites/notes?path=${encodeURIComponent(path)}`);
}
