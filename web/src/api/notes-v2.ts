import { apiGet, apiPut, apiPost, apiDelete } from './client';

export interface NoteTreeNode {
  name: string;
  path: string;
  type: 'file' | 'folder';
  /**
   * For files: 'note' = markdown (open in editor), 'attachment' = image/pdf
   * (preview via attachmentUrl, never markdown-load). Absent on folders and on
   * older payloads (treat absent file as 'note').
   */
  kind?: 'note' | 'attachment';
  children?: NoteTreeNode[];
}

/**
 * URL for a vault attachment (image/pdf) — the single notes-owned endpoint that
 * streams the file with the right content-type (incl. pdf). Used by the tree
 * preview and ![[embed]] rendering. `path` is vault-relative.
 */
export function attachmentUrl(path: string): string {
  return `/api/notes-v2/attachment?${new URLSearchParams({ path })}`;
}

/**
 * Upload a pasted image INTO THE VAULT (an `_attachment/` folder beside the
 * note). Returns the vault-relative path — the `![[...]]` embed target — so the
 * markdown on disk stays Obsidian-portable (vs. the chat-only /api/images store).
 */
export async function uploadNoteAttachment(
  notePath: string,
  data: string,
  mediaType: string,
): Promise<{ path: string; name: string }> {
  return apiPost<{ ok: boolean; path: string; name: string }>('/api/notes-v2/attachment', {
    notePath,
    data,
    mediaType,
  });
}

export interface NoteListItem {
  path: string;
  name: string;
  /** Stable note id (frontmatter). Empty string before the index has stamped it. */
  id?: string;
  /** Display title (first H1, then basename). Falls back to `name` when absent. */
  title?: string;
}

/** ● exact / ○ semantic / ◐ both — the hybrid-search match label (§1.2). */
export type MatchType = 'exact' | 'semantic' | 'both';
/** Link edge resolution state (§1.2). */
export type LinkStatus = 'resolved' | 'unresolved' | 'ambiguous';

export interface SearchResult {
  path: string;
  /**
   * Basename (no .md). Optional: the hybrid `/search` payload (§1.2 #8) carries
   * `title`, NOT `name` — only the legacy back-compat rows ever set it. Consumers
   * read `title || name`.
   */
  name?: string;
  snippet: string;
  /** Stable note id (dedupe key); may be absent on the legacy/back-compat shape. */
  id?: string;
  /** Display title. */
  title?: string;
  /** Which leg(s) matched — drives the ●/◐/○ glyph + word badge. */
  matchType?: MatchType;
  /** Unified rank score (exact/both never below purely-semantic). */
  score?: number;
  stringScore?: number;
  semanticScore?: number;
  matchedTags?: string[];
}

export interface BacklinkResult {
  path: string;
  name: string;
  snippet: string;
  id?: string;
  title?: string;
  /** 'resolved' | 'ambiguous' — ambiguous edges are shown, not hidden. */
  status?: LinkStatus;
  /** When status==='ambiguous': candidate target ids/paths the link could mean. */
  candidates?: string[];
}

/** Forward link of a note (GET /links). */
export interface ForwardLink {
  dstId: string | null;
  dstName: string;
  status: LinkStatus;
  title?: string;
  path?: string;
}

/** Index health/observability (GET /index/status). */
export interface IndexStatus {
  docCount: number;
  lastRebuild: string | null;
  schemaVersion: number;
  embedState: 'idle' | 'embedding' | 'unavailable';
  embedProgress?: { done: number; total: number };
  dbSizeBytes: number;
  rebuilding?: boolean;
  degraded?: 'semantic-unavailable';
}

export async function fetchNotesTree(): Promise<NoteTreeNode[]> {
  const res = await apiGet<{ tree: NoteTreeNode[] }>('/api/notes-v2');
  return res.tree;
}

export async function fetchNoteContent(notePath: string): Promise<{ content: string; updatedAt: string; contentHash: string }> {
  return apiGet<{ content: string; updatedAt: string; contentHash: string }>(`/api/notes-v2/content/${notePath}`);
}

export async function saveNoteContent(notePath: string, content: string, expectedHash?: string): Promise<{ updatedAt: string; contentHash: string; id?: string }> {
  // `id` is the stamped-at-create-time frontmatter id; returned so the FE can refresh
  // its expected hash without a spurious 409 (§2 identity contract).
  return apiPut<{ ok: boolean; updatedAt: string; contentHash: string; id?: string }>(`/api/notes-v2/content/${notePath}`, { content, expectedHash });
}

export async function deleteNote(notePath: string): Promise<void> {
  await apiDelete(`/api/notes-v2/content/${notePath}`);
}

export async function moveNote(from: string, to: string): Promise<void> {
  await apiPost('/api/notes-v2/move', { from, to });
}

export async function createFolder(folderPath: string): Promise<void> {
  await apiPost('/api/notes-v2/folder', { path: folderPath });
}

/** Back-compat string search (mode defaults to hybrid server-side); returns rows only. */
export async function searchNotes(query: string): Promise<SearchResult[]> {
  const res = await apiGet<{ results: SearchResult[] }>('/api/notes-v2/search', { q: query });
  return res.results;
}

/**
 * Hybrid search (§1.2 #8): string + semantic in one deduped, labeled list. Returns
 * the full payload incl. `degraded` so the UI can show a "semantic unavailable" hint.
 */
export async function searchNotesHybrid(
  query: string,
  opts: { mode?: 'hybrid' | 'string' | 'semantic'; limit?: number; signal?: AbortSignal } = {},
): Promise<{ results: SearchResult[]; degraded?: 'semantic-unavailable' }> {
  const params: Record<string, string> = { q: query };
  if (opts.mode) params.mode = opts.mode;
  if (opts.limit) params.limit = String(opts.limit);
  return apiGet<{ results: SearchResult[]; degraded?: 'semantic-unavailable' }>(
    '/api/notes-v2/search',
    params,
    { signal: opts.signal },
  );
}

export async function fetchBacklinks(notePath: string): Promise<BacklinkResult[]> {
  const res = await apiGet<{ backlinks: BacklinkResult[] }>(`/api/notes-v2/backlinks/${notePath}`);
  return res.backlinks;
}

/** Forward links of a note (optional, for relations/debug). */
export async function fetchForwardLinks(notePath: string): Promise<ForwardLink[]> {
  const res = await apiGet<{ links: ForwardLink[] }>(`/api/notes-v2/links/${notePath}`);
  return res.links ?? [];
}

export async function fetchNotesList(): Promise<NoteListItem[]> {
  const res = await apiGet<{ notes: NoteListItem[] }>('/api/notes-v2/list');
  return res.notes;
}

/** A vault tag with its usage count (frequency-ranked, desc) — §1.2 #11. */
export interface TagCount {
  tag: string;
  count: number;
}

/**
 * Fetch all vault tags, frequency-ranked, for the `#tag` autocomplete.
 * Degrades gracefully to `[]` if the index/endpoint is not yet available so
 * manual typing still works (the autocomplete shows only the "Create" row).
 */
export async function fetchTags(): Promise<TagCount[]> {
  const res = await apiGet<{ tags: TagCount[] }>('/api/notes-v2/tags');
  return res.tags ?? [];
}

/** A note carrying a given tag (newest first) — §1.2 #12. */
export interface TagNoteItem {
  id: string;
  title: string;
  path: string;
  snippet: string;
  modified: string;
}

/** Notes carrying a tag, newest first (P1 browse; endpoint already shipped). */
export async function fetchTagNotes(tag: string): Promise<TagNoteItem[]> {
  const res = await apiGet<{ notes: TagNoteItem[] }>(`/api/notes-v2/tags/${encodeURIComponent(tag)}/notes`);
  return res.notes ?? [];
}

/** Targeted tag rewrite across carrying notes (§1.2 #13). */
export async function renameTag(from: string, to: string): Promise<{ ok: boolean; updated: number }> {
  return apiPost<{ ok: boolean; updated: number }>('/api/notes-v2/tags/rename', { from, to });
}

/** Index health/observability (§1.2 #14). */
export async function fetchIndexStatus(): Promise<IndexStatus> {
  return apiGet<IndexStatus>('/api/notes-v2/index/status');
}

/** Drop + rebuild the structural sidecar (admin/Settings) — §1.2 #15. */
export async function rebuildIndex(): Promise<{ ok: boolean; rebuilding: boolean }> {
  return apiPost<{ ok: boolean; rebuilding: boolean }>('/api/notes-v2/index/rebuild');
}
