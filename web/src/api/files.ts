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
  opts: {
    /** Retained for callers that document their intent; every read is uncached. */
    noCache?: boolean;
    /**
     * Record what this read found as a version in the file's history. Only the
     * EDITOR passes this (the mention popup, diff view and pop-out are lookups,
     * not sessions of work). `baseline` = the bytes as found when the file was
     * opened; `agent` = bytes another writer put there while it was open.
     */
    track?: 'baseline' | 'agent';
  } = {},
): Promise<FileContentResponse> {
  const params = new URLSearchParams({ path: filePath });
  if (host) params.set('host', host);
  if (opts.track) params.set('track', opts.track);

  // `no-store` UNCONDITIONALLY, not just for an explicit Refresh. This route now
  // answers with `ETag` + `Cache-Control: no-cache`, which overrides the blanket
  // `no-store` the /api middleware sets — so the browser's own HTTP cache may
  // store and revalidate it, and a revalidation this function does not know about
  // can surface as a 304 that `res.json()` reads as an empty body. That is the
  // failure the server disables Express ETags for (see server.ts). Callers that
  // WANT the conditional exchange use fetchFileContentConditional, which handles
  // 304 explicitly.
  const res = await fetch(`/api/file-content?${params}`, { cache: 'no-store' });
  if (!res.ok) throw new Error(`Failed to fetch file content: ${res.status}`);
  return res.json();
}

/** The answer to a conditional open: either "you already have it" or the bytes. */
export interface ConditionalFileContent {
  /**
   * The server confirmed (304) that the `ifNoneMatch` bytes the caller already
   * holds are the bytes on disk. Nothing crossed the wire — for a remote file,
   * nothing crossed the tunnel either.
   */
  notModified: boolean;
  /** The fresh payload. Absent exactly when `notModified` is true. */
  payload?: FileContentResponse;
}

/**
 * Open a file, telling the server which bytes we already have.
 *
 * This is the editor's read path (`fetchFileContent` stays for the lookups: the
 * mention popup, the diff view, the pop-out). Passing `ifNoneMatch` — the
 * `contentHash` of a cached copy — lets the server answer 304 instead of
 * re-shipping an unchanged file, which is the whole cost of re-opening something
 * over an SSH tunnel. The pane paints its cached copy first and this call is what
 * confirms or replaces it (see cache/filecontent-idb.ts).
 *
 * `cache: 'no-store'` on purpose: we supply the validator ourselves and want the
 * raw 304, not the browser silently completing it from its own HTTP cache.
 */
export async function fetchFileContentConditional(
  filePath: string,
  host?: string,
  opts: { ifNoneMatch?: string; track?: 'baseline' | 'agent' } = {},
): Promise<ConditionalFileContent> {
  const params = new URLSearchParams({ path: filePath });
  if (host) params.set('host', host);
  if (opts.track) params.set('track', opts.track);

  const res = await fetch(`/api/file-content?${params}`, {
    cache: 'no-store',
    ...(opts.ifNoneMatch ? { headers: { 'If-None-Match': `"${opts.ifNoneMatch}"` } } : {}),
  });
  if (res.status === 304) return { notModified: true };
  if (!res.ok) throw new Error(`Failed to fetch file content: ${res.status}`);
  return { notModified: false, payload: await res.json() };
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
  opts: {
    host?: string;
    expectedHash?: string;
    /**
     * Who is writing, for the file's history timeline. `user` = an explicit Save
     * (its own entry). `live` = a Live Edit auto-write, which the server FOLDS into
     * the previous live entry when it is recent, so a typing burst is one version,
     * not one per keystroke pause. `merge` = the result of auto-merging another
     * writer's bytes with the user's. Omitted = `user`.
     */
    writer?: 'user' | 'live' | 'merge';
  } = {},
): Promise<{ size: number; contentHash: string }> {
  const res = await fetch('/api/file-content', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      path: filePath,
      content,
      ...(opts.host ? { host: opts.host } : {}),
      ...(opts.expectedHash ? { expectedHash: opts.expectedHash } : {}),
      ...(opts.writer ? { writer: opts.writer } : {}),
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
 *
 * `reload` (the pane's reloadToken) is folded into the query string: an iframe/
 * img/video src that stays byte-identical is never re-navigated by the browser,
 * so without it the Refresh button was a no-op for every raw-rendered kind.
 */
export function rawFileContentUrl(filePath: string, host?: string, reload?: number): string {
  // PATH-shaped, not query-shaped, on purpose: a document's relative URLs resolve
  // against its URL's PATH and the query string is dropped. From
  // `/api/file-content?path=…&raw=1` an HTML preview's `<img src="diagram.png">`
  // became `/api/diagram.png` — every relative image in every previewed HTML
  // file was broken. From `/api/file-raw/local/…/proj/index.html` it resolves to
  // a sibling under the same route, which serves it. One encoded segment per
  // path component so `#`, `?` and spaces in a filename survive the trip.
  const segments = filePath.split('/').filter((s, i) => i === 0 ? s.length > 0 : true);
  const encodedPath = segments.map(encodeURIComponent).join('/');
  const url = `/api/file-raw/${encodeURIComponent(host || 'local')}/${encodedPath}`;
  return reload ? `${url}?r=${reload}` : url;
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

/** One match from the reference search (cmd+click on an identifier). */
export interface ReferenceMatch {
  file: string;
  line: number;
  text: string;
  kind: 'def' | 'ref';
}

export interface ReferencesResponse {
  symbol: string;
  root: string;
  matches: ReferenceMatch[];
  truncated: boolean;
  tool: 'git-grep' | 'grep' | 'none';
  error?: string;
}

/**
 * Repo-wide reference search for an identifier. One RPC: the host (daemon for
 * remote sessions) runs a batched `git grep -w` from the file's repo root and
 * returns classified matches — definitions sorted first.
 */
export async function fetchReferences(
  filePath: string,
  symbol: string,
  host?: string,
): Promise<ReferencesResponse> {
  const params = new URLSearchParams({ path: filePath, symbol });
  if (host) params.set('host', host);
  const res = await fetch(`/api/files/references?${params}`);
  const body = await res.json().catch(() => ({} as Record<string, unknown>));
  if (!res.ok) {
    throw new Error(typeof body?.error === 'string' ? body.error : `Reference search failed: ${res.status}`);
  }
  return body as ReferencesResponse;
}

/**
 * A file mutation the server refused. `code` is the machine-readable reason
 * (`invalid` | `forbidden` | `not_found` | `exists` | `is_directory` |
 * `no_space` | `unsupported` | `daemon_needs_upgrade` | `remote`, or `'unknown'`
 * when the body carried none), and `message` is the server's own prose — shown
 * to the user VERBATIM, because for `daemon_needs_upgrade` the message is the
 * actual instruction.
 */
export class FileOpError extends Error {
  constructor(message: string, public code: string, public status: number) {
    super(message);
    this.name = 'FileOpError';
  }
}

/**
 * A mutation that is STILL RUNNING when the server's deadline passed (a recursive
 * delete of a huge tree, a copy over a slow tunnel). Not a failure: the work
 * continues on the host, and the tree will show the result when it lands. This is
 * distinct from FileOpError on purpose — the old behaviour turned a remote
 * timeout into "Could not complete", while the daemon went on and deleted the
 * folder anyway, so the user was told it failed and the folder was gone.
 */
export class FileOpPending extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'FileOpPending';
  }
}

async function fileOp(
  op: 'mkdir' | 'create' | 'rename' | 'duplicate' | 'delete',
  body: Record<string, unknown>,
): Promise<{ path?: string }> {
  const res = await fetch(`/api/files/${op}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const parsed = await res.json().catch(() => ({} as Record<string, unknown>));
  if (res.status === 202) {
    throw new FileOpPending(
      typeof parsed?.message === 'string' ? parsed.message : 'Still working on it…',
    );
  }
  if (!res.ok) {
    throw new FileOpError(
      typeof parsed?.error === 'string' ? parsed.error : `${op} failed: ${res.status}`,
      typeof parsed?.code === 'string' ? parsed.code : 'unknown',
      res.status,
    );
  }
  return parsed as { path?: string };
}

/** Create an empty file. Fails with code `exists` when something is already there. */
export async function createFile(filePath: string, host?: string): Promise<string> {
  const body = await fileOp('create', { path: filePath, ...(host ? { host } : {}) });
  return body.path ?? filePath;
}

/** Create a directory (parents are the server's business, not the caller's). */
export async function createFolder(dirPath: string, host?: string): Promise<string> {
  const body = await fileOp('mkdir', { path: dirPath, ...(host ? { host } : {}) });
  return body.path ?? dirPath;
}

/** Move/rename a file or directory to `newPath`. */
export async function renamePath(filePath: string, newPath: string, host?: string): Promise<string> {
  const body = await fileOp('rename', { path: filePath, newPath, ...(host ? { host } : {}) });
  return body.path ?? newPath;
}

/** Copy a file or directory to `newPath` (recursive for directories, server-side). */
export async function duplicatePath(filePath: string, newPath: string, host?: string): Promise<string> {
  const body = await fileOp('duplicate', { path: filePath, newPath, ...(host ? { host } : {}) });
  return body.path ?? newPath;
}

/** Delete a file, or a directory when `recursive` is set. Permanent — confirm first. */
export async function deletePath(
  filePath: string,
  host?: string,
  opts: { recursive?: boolean } = {},
): Promise<void> {
  await fileOp('delete', {
    path: filePath,
    ...(host ? { host } : {}),
    ...(opts.recursive ? { recursive: true } : {}),
  });
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
  /** Position the reference itself carried (`a.ts:42`, `a.ts#L10-L20`). Present
   *  even when the file wasn't found — the reference still asked for it. */
  line?: number;
  column?: number;
  endLine?: number;
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
