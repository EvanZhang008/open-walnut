/**
 * Keep a pane's EMBEDDED images current without disturbing the pane.
 *
 * A markdown file open in the Files panel shows `![](images/diagram.png)` as an
 * <img> proxied through `/api/local-image?path=…`. When the agent regenerates
 * that PNG the file on disk changes but nothing in the pane does: the .md bytes
 * are the same, so no re-read happens, and even a repaint would emit the same
 * URL — which the browser (WebKit above all) serves from its per-document memory
 * cache without a request. The user saw the old drawing until they reloaded the
 * whole app.
 *
 * The answer is NOT to remount the editor (that yanks the caret to line 1 and
 * throws away scroll position for a picture change), and not to make the user
 * press Refresh. It is a quiet check: ask the server for each image's current
 * ETag with a conditional request (304 unless the bytes changed — the route
 * sends `Cache-Control: no-cache` + a strong ETag for exactly this), and when
 * an ETag moved, swap that ONE <img>'s src to a versioned URL. The browser keeps
 * showing the old pixels until the new ones decode, so it reads as the picture
 * updating, not as the page reloading. Pure DOM: ProseMirror ignores attribute
 * mutations on leaf nodes, and the saved markdown never held the URL anyway
 * (see ResolvedImage's header).
 *
 * DOM-agnostic on purpose (an ImgLike, an injectable fetch) so the decision is
 * unit-testable without a browser.
 */

export const IMAGE_PROXY_MARK = '/api/local-image?';

/** The subset of HTMLImageElement this module touches. */
export interface ImgLike {
  src: string;
  dataset: { lightboxSrc?: string };
}

export interface RevalidateResult {
  /** Base urls (version stripped) whose bytes changed and whose <img> was swapped. */
  changed: string[];
  /** Base urls seen for the first time this pass (ETag recorded, nothing swapped). */
  recorded: string[];
}

/** Is this src one of ours? Absolute (`http://host/api/local-image?…`) or path-only. */
export function isProxiedImageSrc(src: string): boolean {
  return typeof src === 'string' && src.includes(IMAGE_PROXY_MARK);
}

/** The url without its `r` version parameter — the identity of the picture. */
export function stripImageVersion(src: string): string {
  const q = src.indexOf('?');
  if (q < 0) return src;
  const params = new URLSearchParams(src.slice(q + 1));
  params.delete('r');
  const rest = params.toString();
  return rest ? `${src.slice(0, q)}?${rest}` : src.slice(0, q);
}

/** The same picture under a new url the memory cache cannot answer. */
export function withImageVersion(src: string, version: string | number): string {
  const base = stripImageVersion(src);
  return `${base}${base.includes('?') ? '&' : '?'}r=${encodeURIComponent(String(version))}`;
}

type FetchLike = (url: string, init: { cache: 'no-cache'; credentials: 'same-origin' }) =>
  Promise<{ ok: boolean; headers: { get(name: string): string | null }; body?: { cancel(): Promise<void> } | null }>;

/**
 * One pass over the pane's proxied images.
 *
 * `etags` is the caller's memory across passes (per pane): the first time a
 * picture is seen its ETag is only recorded — there is nothing to compare with,
 * and swapping on sight would re-download every image on every mount. From the
 * second pass on, a moved ETag means the bytes changed and the <img> is pointed
 * at `…&r=<version>`.
 *
 * Failures are per image and silent: a host that is down keeps its old picture,
 * which is the same thing the user would have seen anyway.
 */
export async function revalidateImages(
  imgs: Iterable<ImgLike>,
  etags: Map<string, string>,
  version: string | number,
  fetchImpl: FetchLike,
): Promise<RevalidateResult> {
  const changed: string[] = [];
  const recorded: string[] = [];
  // One fetch per DISTINCT picture: the same diagram embedded twice is checked once.
  const byBase = new Map<string, ImgLike[]>();
  for (const img of imgs) {
    if (!isProxiedImageSrc(img.src)) continue;
    const base = stripImageVersion(img.src);
    const list = byBase.get(base);
    if (list) list.push(img); else byBase.set(base, [img]);
  }

  await Promise.all([...byBase.entries()].map(async ([base, list]) => {
    let etag: string | null;
    try {
      // `no-cache` = the browser MUST revalidate with the server (If-None-Match
      // from its HTTP cache), then hands back the fresh headers either way. The
      // body is the cached one on a 304 and is not needed here.
      const res = await fetchImpl(list[0].src, { cache: 'no-cache', credentials: 'same-origin' });
      if (!res.ok) return;
      etag = res.headers.get('etag');
      void res.body?.cancel().catch(() => { /* already consumed / not a stream */ });
    } catch {
      return;
    }
    if (!etag) return;
    const prev = etags.get(base);
    etags.set(base, etag);
    if (prev === undefined) { recorded.push(base); return; }
    if (prev === etag) return;
    const next = withImageVersion(base, version);
    for (const img of list) {
      img.src = next;
      if (img.dataset.lightboxSrc != null) img.dataset.lightboxSrc = next;
    }
    changed.push(base);
  }));

  return { changed, recorded };
}

/**
 * Tools whose result cannot have changed a file. Anything not listed (Write,
 * Edit, Bash, MCP tools, …) counts as "might have", because a diagram is as
 * often produced by a script as by a Write.
 */
export const READ_ONLY_TOOLS = new Set([
  'Read', 'Grep', 'Glob', 'LS', 'WebFetch', 'WebSearch', 'TodoWrite', 'TodoRead',
  'AskUserQuestion', 'ListAgents', 'ToolSearch', 'TaskOutput', 'CronList',
]);
