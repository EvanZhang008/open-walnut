/** Fetch file content for the FileViewer overlay. */
import { fileDocKey, publishDocSaved } from '@/stores/file-save-signal';
import { asDeadlineError } from '@/utils/request-failure';
import { apiPost } from './client';

export interface FileContentResponse {
  content: string | null;
  size: number;
  truncated: boolean;
  binary: boolean;
  error?: string;
  extension: string;
  /** The remote read is still arriving (a slow link that answers) and goes on:
   *  asking again joins it. `from` is the host's label. Comes with `error`. */
  loading?: { from: string };
  /** `host_reconnecting` with `error`: the file's host is not answering now. The
   *  view asks again on its own until it is back. */
  code?: string;
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
  opts: { ifNoneMatch?: string; track?: 'baseline' | 'agent'; signal?: AbortSignal } = {},
): Promise<ConditionalFileContent> {
  const params = new URLSearchParams({ path: filePath });
  if (host) params.set('host', host);
  if (opts.track) params.set('track', opts.track);

  let res: Response;
  try {
    res = await fetch(`/api/file-content?${params}`, {
      cache: 'no-store',
      signal: opts.signal,
      ...(opts.ifNoneMatch ? { headers: { 'If-None-Match': `"${opts.ifNoneMatch}"` } } : {}),
    });
  } catch (err) {
    throw asDeadlineError(err, opts.signal);
  }
  if (res.status === 304) return { notModified: true };
  if (!res.ok) throw new Error(`Failed to fetch file content: ${res.status}`);
  return { notModified: false, payload: await res.json() };
}

/** A save rejected because the file changed on disk under the editor. */
/**
 * Why the server refused. Three different situations that must not be treated
 * alike:
 *   - `stale-lock`: someone really did change the file. Merge and retry.
 *   - `unverified-base`: THIS bundle could not prove where its token came from.
 *     Nothing changed on disk, so merging is pointless (and would report a
 *     collision that never happened) — the tab needs newer code.
 *   - `unlocked-machine-write`: a client bug sent an automatic write with no lock
 *     at all. Should be impossible; never merge it.
 */
export type FileSaveConflictReason = 'stale-lock' | 'unverified-base' | 'unlocked-machine-write';

export class FileSaveConflictError extends Error {
  constructor(
    public currentHash: string,
    /** Absent from a server too old to send it; treat that as `stale-lock`. */
    public reason: FileSaveConflictReason = 'stale-lock',
  ) {
    super('This file changed on disk since you opened it.');
    this.name = 'FileSaveConflictError';
  }
}

/** A save the server answered with a non-2xx status other than 409. Carries the
 *  status so a caller can tell a gateway that lost the server (502/503/504) from
 *  a refusal (4xx), which is the difference between "try again shortly" and
 *  "tell the user". */
export class FileSaveHttpError extends Error {
  /** `code` is the server's (`host_reconnecting`: the file's host is not answering, Walnut is). */
  constructor(message: string, public status: number, public code?: string) {
    super(message);
    this.name = 'FileSaveHttpError';
  }
}

/**
 * A save whose request never reached the server (server down, connection
 * refused, DNS, offline). Thrown ONLY from around the `fetch` call itself: every
 * browser signals this failure with a `TypeError`, but so does a programming
 * error anywhere in a caller's try block, and treating "my bookkeeping threw
 * after the PUT landed" as "the server is unreachable" would re-send a write
 * that already succeeded (live mode) or tell the user to press Save again for
 * a file that is saved. Wrapping at the one place the fetch happens is what
 * keeps the two apart. The browser's wording ("Failed to fetch" in Chromium,
 * "Load failed" in WebKit, "NetworkError when attempting to fetch resource." in
 * Firefox) rides along as the message for the log, never for the user.
 */
export class FileSaveUnreachableError extends Error {
  constructor(cause: unknown) {
    super(cause instanceof Error ? cause.message : String(cause));
    this.name = 'FileSaveUnreachableError';
  }
}

/** The request never reached the server (see FileSaveUnreachableError). An
 *  aborted request is not one of these: that is a DOMException the caller asked
 *  for, and it passes through the wrapper untouched. */
export function isNetworkFetchError(err: unknown): boolean {
  return err instanceof FileSaveUnreachableError;
}

/** `fetch` that turns a failed connection into FileSaveUnreachableError and
 *  leaves everything else (an abort, a programming error) as it was. */
async function fetchOrUnreachable(input: string, init: RequestInit): Promise<Response> {
  try {
    return await fetch(input, init);
  } catch (caught) {
    if (caught instanceof TypeError) throw new FileSaveUnreachableError(caught);
    // Our own deadline (SAVE_TIMEOUT_MS): the server is there but did not answer.
    // WebKit says AbortError for it, which reached the user as "Fetch is aborted".
    const err = asDeadlineError(caught, init.signal);
    if (err instanceof DOMException && err.name === 'TimeoutError') throw new FileSaveHttpError(SAVE_TIMED_OUT_MESSAGE, 504);
    throw err;
  }
}

/** What the explicit Save button shows when its request never reached Walnut.
 *  Named here because it replaces the browser's own wording, which the 2026-09-24
 *  incident put in front of a user verbatim ("Failed to fetch"). */
export const SAVE_UNREACHABLE_MESSAGE =
  "Can't reach Walnut right now. Your text is still in the editor: check that Walnut is running, then press Save again.";

/**
 * How long a save waits for its answer. The server bounds a remote save's checks
 * like every read (60s stream cap, then the link's idle bound) and the write
 * itself by the daemon's 30s command timeout, so a save on a slow link that
 * answers is never cut by this; a save nobody answers no longer waits forever.
 */
export const SAVE_TIMEOUT_MS = 120_000;
/** What a save that outlived SAVE_TIMEOUT_MS says (a 504: Live Edit retries it). */
export const SAVE_TIMED_OUT_MESSAGE =
  'The save got no answer in time. Your text is still in the editor: press Save again. If the first save landed, you are asked before anything is overwritten.';
/** How long a create, rename, copy or delete waits (the server answers "still working" by 20s). */
export const FILE_OP_TIMEOUT_MS = 45_000;

/**
 * Save an edited file. `expectedHash` is the contentHash from the read that
 * seeded the editor — the server rejects the write with 409 if the bytes on disk
 * no longer hash to it (an agent, another tab, or a git checkout got there
 * first), so an edit can never silently clobber someone else's change.
 *
 * Throws FileSaveConflictError on 409, FileSaveHttpError on any other non-2xx,
 * FileSaveUnreachableError when the request never reached the server. All three
 * are surfaced in the editor's toolbar rather than swallowed.
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
    /**
     * Mount id of the view doing the writing. Every successful save is announced
     * on the browser-local doc-saved signal so any OTHER view of this same file
     * converges in the same tick (see stores/file-save-signal.ts); `origin` is
     * what lets the writer ignore the echo of its own save. Omitted = the signal
     * still fires, under an anonymous origin.
     */
    origin?: string;
    /**
     * Set ONLY when `expectedHash` was computed from the bytes this write is
     * replacing (see utils/content-hash.ts), rather than quoted from a ref the
     * editor happened to be holding. The server REFUSES an automatic write without
     * it, which is what makes the guard independent of any particular bundle being
     * loaded in any particular tab: an old build cannot send this, so an old build
     * cannot auto-write. Five stale-copy write-backs are why.
     */
    baseFrom?: 'content';
  } = {},
): Promise<{ size: number; contentHash: string }> {
  const res = await fetchOrUnreachable('/api/file-content', {
    method: 'PUT',
    signal: AbortSignal.timeout(SAVE_TIMEOUT_MS),
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      path: filePath,
      content,
      ...(opts.host ? { host: opts.host } : {}),
      ...(opts.expectedHash ? { expectedHash: opts.expectedHash } : {}),
      ...(opts.writer ? { writer: opts.writer } : {}),
      // Attribution: which view fired it. Accepted here since the beginning but
      // never actually sent, so every write log line said `origin: undefined`.
      ...(opts.origin ? { origin: opts.origin } : {}),
      ...(opts.baseFrom ? { baseFrom: opts.baseFrom } : {}),
    }),
  });
  const body = await res.json().catch(() => ({} as Record<string, unknown>));
  if (res.status === 409 && typeof body?.currentHash === 'string') {
    const reason = typeof body?.reason === 'string' ? body.reason as FileSaveConflictReason : undefined;
    throw new FileSaveConflictError(body.currentHash, reason);
  }
  if (!res.ok) {
    throw new FileSaveHttpError(
      typeof body?.error === 'string' ? body.error : `Save failed: ${res.status}`,
      res.status,
      typeof body?.code === 'string' ? body.code : undefined,
    );
  }
  const result = { size: body.size as number, contentHash: body.contentHash as string };
  // Announce it HERE, the one choke point every writer of a file goes through
  // (explicit Save, Live Edit's auto-write, its merge re-write). Carrying the
  // content means a clean sibling view adopts these exact bytes without a read.
  publishDocSaved({
    key: fileDocKey(opts.host, filePath),
    contentHash: result.contentHash,
    content,
    size: result.size,
    origin: opts.origin ?? 'anonymous',
  });
  return result;
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
  let res: Response;
  const deadline = AbortSignal.timeout(FILE_OP_TIMEOUT_MS);
  try {
    res = await fetch(`/api/files/${op}`, {
      method: 'POST',
      signal: deadline,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  } catch (caught) {
    // WebKit says AbortError for the deadline (it reached the user as "Fetch is aborted").
    const err = asDeadlineError(caught, deadline);
    if (err instanceof DOMException && err.name === 'TimeoutError') {
      // The work may still be running where the file lives: say so, as a 202 would.
      throw new FileOpPending('No answer yet. The tree will refresh if it finishes.');
    }
    throw err;
  }
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
    let code: string | undefined;
    try {
      const body = await res.json();
      if (body?.error) msg = body.error;
      if (typeof body?.code === 'string') code = body.code;
    } catch { /* non-JSON error body */ }
    throw new DirListError(msg, res.status, code);
  }
  return res.json();
}

/** A listing the server could not make. `code` is the server's (`host_reconnecting`, ...). */
export class DirListError extends Error {
  constructor(message: string, public status: number, public code?: string) {
    super(message);
    this.name = 'DirListError';
  }
}

/** The server's code for a host that is not answering now (Walnut is): ask again in a few seconds. */
export const HOST_RECONNECTING_CODE = 'host_reconnecting';

/** The host is not answering yet (503 host_reconnecting): asking again in a few seconds may list it. */
export function isHostReconnectingListing(err: unknown): boolean {
  return err instanceof DirListError && err.code === HOST_RECONNECTING_CODE;
}

/** One listing in a batch: either the directory, or why it could not be read (`code` as for one listing). */
export type BatchDirListing = (DirListResponse & { error?: undefined; code?: undefined }) | { path: string; error: string; code?: string };

/** List MANY directories in one request (the tree restore).
 *
 *  A browser runs 6 connections per origin. Restoring an expanded tree one
 *  `fetch` per directory therefore stalls everything else in the app for as long
 *  as the slowest listing takes — on a remote session that is an SSH round trip
 *  each, ~1.4s cold. This is the same work in one connection.
 *
 *  Partial by contract: the server answers within its own deadline and reports
 *  `timedOut`, because the tree has already painted from cache and every listing
 *  here is a correction. Callers apply what came back and leave the rest alone. */
export async function fetchDirListMany(
  paths: string[],
  host?: string,
  showHidden = false,
  opts: { signal?: AbortSignal; background?: boolean } = {},
): Promise<{ listings: BatchDirListing[]; truncated: boolean; timedOut: boolean }> {
  if (!paths.length) return { listings: [], truncated: false, timedOut: false };
  return apiPost('/api/files/list-many', { paths, host, showHidden }, {
    signal: opts.signal,
    timeoutMs: 20_000,
    background: true,
    ...(opts.background ? { priority: 'low' as const } : {}),
  });
}

/** Which of these files still exist on the host (`POST /api/files/exists`). A path the server
 *  could not answer for is absent from the map: not known gone. */
export async function fetchPathsExist(paths: readonly string[], host?: string): Promise<Record<string, boolean>> {
  const body = await apiPost<{ exists?: Record<string, boolean> }>('/api/files/exists', { paths, ...(host ? { host } : {}) }, { background: true, priority: 'low', timeoutMs: 10_000 });
  return body?.exists ?? {};
}
