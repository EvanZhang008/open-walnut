/** Fetch file content for the FileViewer overlay. */

export interface FileContentResponse {
  content: string | null;
  size: number;
  truncated: boolean;
  binary: boolean;
  error?: string;
  extension: string;
  /** Hash of the served bytes — the editor's optimistic-lock token on save.
   *  ABSENT for a truncated read, which is what makes the editor read-only there
   *  (saving the first 512 KB back would delete the file's tail). */
  contentHash?: string;
}

export async function fetchFileContent(
  filePath: string,
  host?: string,
  opts: { noCache?: boolean } = {},
): Promise<FileContentResponse> {
  const params = new URLSearchParams({ path: filePath });
  if (host) params.set('host', host);

  // An explicit Refresh must reach disk — a cached 200 would silently serve the
  // pre-edit bytes and make the button look broken.
  const res = await fetch(`/api/file-content?${params}`, opts.noCache ? { cache: 'no-store' } : undefined);
  if (!res.ok) throw new Error(`Failed to fetch file content: ${res.status}`);
  return res.json();
}

/** A save rejected because the file changed on disk under the editor. */
export class FileSaveConflictError extends Error {
  constructor(public currentHash: string) {
    super('This file changed on disk since you opened it.');
    this.name = 'FileSaveConflictError';
  }
}

/**
 * Save an edited file. `expectedHash` is the contentHash from the read that
 * seeded the editor — the server rejects the write with 409 if the bytes on disk
 * no longer hash to it (an agent, another tab, or a git checkout got there
 * first), so an edit can never silently clobber someone else's change.
 *
 * Throws FileSaveConflictError on 409, plain Error otherwise (both surfaced in
 * the editor's toolbar rather than swallowed).
 */
export async function saveFileContent(
  filePath: string,
  content: string,
  opts: { host?: string; expectedHash?: string } = {},
): Promise<{ size: number; contentHash: string }> {
  const res = await fetch('/api/file-content', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      path: filePath,
      content,
      ...(opts.host ? { host: opts.host } : {}),
      ...(opts.expectedHash ? { expectedHash: opts.expectedHash } : {}),
    }),
  });
  const body = await res.json().catch(() => ({} as Record<string, unknown>));
  if (res.status === 409 && typeof body?.currentHash === 'string') {
    throw new FileSaveConflictError(body.currentHash);
  }
  if (!res.ok) throw new Error(typeof body?.error === 'string' ? body.error : `Save failed: ${res.status}`);
  return { size: body.size as number, contentHash: body.contentHash as string };
}

/**
 * URL that serves a file's raw bytes with a real Content-Type. Used as an
 * iframe `src` so HTML previews get their own document URL — in-page anchors,
 * relative links and scripts then resolve against the file, not the Walnut SPA.
 */
export function rawFileContentUrl(filePath: string, host?: string): string {
  const params = new URLSearchParams({ path: filePath, raw: '1' });
  if (host) params.set('host', host);
  return `/api/file-content?${params}`;
}

/**
 * URL that downloads a file's raw bytes (Content-Disposition: attachment).
 * Works for any file type — the fallback when inline preview can't render it.
 */
export function downloadFileUrl(filePath: string, host?: string): string {
  const params = new URLSearchParams({ path: filePath, raw: '1', download: '1' });
  if (host) params.set('host', host);
  return `/api/file-content?${params}`;
}

/**
 * Hand a LOCAL file/folder to the macOS desktop — reveal it in Finder, or launch
 * it in its default app. Rejects (throws) in cloud mode, off macOS, and for
 * remote (`host`) paths; callers surface that as a disabled/one-off error.
 */
export async function revealLocalFile(
  filePath: string,
  mode: 'finder' | 'app',
  host?: string,
): Promise<string> {
  const res = await fetch('/api/files/reveal', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ path: filePath, mode, host }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body?.error || `reveal failed: ${res.status}`);
  return body.fullPath as string;
}

/** A single directory entry for the file explorer tree. */
export interface DirEntry {
  name: string;
  type: 'dir' | 'file';
  size?: number;
}

export interface DirListResponse {
  path: string;
  entries: DirEntry[];
  /** Set when the requested path was a file: the listing is its parent dir and
   *  this is the file's basename, so the UI can select/preview it (VS Code style). */
  selectedFile?: string;
  /** Set when `path` is NOT what was asked for: the request pointed at something
   *  that doesn't exist, so this is the nearest usable directory. Show the listing
   *  plus "couldn't find <requestedPath>" — never a raw errno. */
  requestedPath?: string;
  /** Which resolver layer produced `path` ('transcript' | 'git' | 'find' | …). */
  resolvedVia?: string;
}

export interface ResolvePathResponse {
  path: string;
  resolved: boolean;
  /** Which layer found it — useful in logs when a resolution looks surprising. */
  via?: string;
  /** true = `path` is a nearest-existing-ancestor stand-in, not the target. */
  degraded?: boolean;
  /** Other plausible matches, shallowest first. */
  alternatives?: string[];
}

/**
 * Resolve a path a transcript mentioned into a real path on the session's host.
 *
 * The host runs a layered search: paths the session already opened (from its
 * transcript), the ancestor walk, the git index (submodules included, any depth),
 * then a pruned find. Passing `sessionId` unlocks the transcript layer, which is
 * both the cheapest and the most accurate — always pass it when known.
 */
export async function resolvePath(
  rel: string,
  cwd: string,
  host?: string,
  sessionId?: string,
): Promise<ResolvePathResponse> {
  const params = new URLSearchParams({ rel, cwd });
  if (host) params.set('host', host);
  if (sessionId) params.set('sessionId', sessionId);
  const res = await fetch(`/api/files/resolve-path?${params}`);
  if (!res.ok) {
    // Best-effort fallback: naive join so the click still does something.
    return { path: `${cwd.replace(/\/$/, '')}/${rel.replace(/^\.\//, '')}`, resolved: false };
  }
  return res.json();
}

/** List one level of a directory (lazy-loaded tree). Supports local + remote (host).
 *
 *  `cwd`/`sessionId` are optional and only enable SELF-HEALING: when the path
 *  can't be listed, the backend resolves it against the session's context and
 *  lists what it found, so a stale or shortened path shows files instead of
 *  `ENOENT: scandir`. Always pass them from a session's file explorer. */
export async function fetchDirList(
  dirPath: string,
  host?: string,
  showHidden = false,
  opts: { noCache?: boolean; cwd?: string; sessionId?: string } = {},
): Promise<DirListResponse> {
  const params = new URLSearchParams({ path: dirPath });
  if (host) params.set('host', host);
  if (showHidden) params.set('showHidden', '1');
  if (opts.cwd) params.set('cwd', opts.cwd);
  if (opts.sessionId) params.set('sessionId', opts.sessionId);

  const res = await fetch(`/api/files/list?${params}`, opts.noCache ? { cache: 'no-store' } : undefined);
  if (!res.ok) {
    let msg = `Failed to list directory: ${res.status}`;
    try {
      const body = await res.json();
      if (body?.error) msg = body.error;
    } catch { /* non-JSON error body */ }
    throw new Error(msg);
  }
  return res.json();
}
