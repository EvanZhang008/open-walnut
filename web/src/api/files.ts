/** Fetch file content for the FileViewer overlay. */

export interface FileContentResponse {
  content: string | null;
  size: number;
  truncated: boolean;
  binary: boolean;
  error?: string;
  extension: string;
}

export async function fetchFileContent(
  filePath: string,
  host?: string,
): Promise<FileContentResponse> {
  const params = new URLSearchParams({ path: filePath });
  if (host) params.set('host', host);

  const res = await fetch(`/api/file-content?${params}`);
  if (!res.ok) throw new Error(`Failed to fetch file content: ${res.status}`);
  return res.json();
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
}

/**
 * Resolve a relative (possibly extensionless, package-relative) path against a
 * session cwd. Backend tries cwd, then walks up parent dirs to the repo root,
 * returning the first base where the path exists. Falls back to cwd/rel.
 */
export async function resolvePath(
  rel: string,
  cwd: string,
  host?: string,
): Promise<{ path: string; resolved: boolean }> {
  const params = new URLSearchParams({ rel, cwd });
  if (host) params.set('host', host);
  const res = await fetch(`/api/files/resolve-path?${params}`);
  if (!res.ok) {
    // Best-effort fallback: naive join so the click still does something.
    return { path: `${cwd.replace(/\/$/, '')}/${rel.replace(/^\.\//, '')}`, resolved: false };
  }
  return res.json();
}

/** List one level of a directory (lazy-loaded tree). Supports local + remote (host). */
export async function fetchDirList(
  dirPath: string,
  host?: string,
  showHidden = false,
): Promise<DirListResponse> {
  const params = new URLSearchParams({ path: dirPath });
  if (host) params.set('host', host);
  if (showHidden) params.set('showHidden', '1');

  const res = await fetch(`/api/files/list?${params}`);
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
