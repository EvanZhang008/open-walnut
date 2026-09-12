/**
 * Where a link inside a previewed HTML file should go.
 *
 * The Files panel renders an HTML file in an iframe at
 * `/api/file-raw/<host>/<abs path>`. Left alone, a click inside it navigates the
 * FRAME: to another file (fine to look at, but the panel's tree, ‹ › history and
 * viewer know nothing about it, so there is no way back), to a root-absolute
 * filesystem path the site cannot serve, or to another website squeezed into
 * the preview pane. These helpers decide, per link, whether the panel should
 * open the target as a file of its own, hand an external site to a new tab, or
 * leave the browser to it (in-page anchors, downloads, other schemes).
 */

const RAW_ROUTE_RE = /^\/api(?:\/v1)?\/file-raw\/([^/]+)\/(.*)$/
const RAW_QUERY_ROUTE_RE = /^\/api(?:\/v1)?\/file-content$/

export interface PreviewFileTarget {
  /** Host alias; undefined for the local machine. */
  host?: string
  /** Absolute path (or `~/…`, remote only), as the file API expects it. */
  path: string
}

function decodeSegment(seg: string): string | null {
  try { return decodeURIComponent(seg) } catch { return null }
}

export function sameHost(a: string | undefined, b: string | undefined): boolean {
  return (a || 'local') === (b || 'local')
}

/**
 * The file a same-origin URL denotes, or null when it is not a file URL.
 *
 * Three shapes qualify: the file-raw route (what a relative reference resolves
 * to, and what the server redirects a root-absolute one onto); the query-shaped
 * `/api/file-content?path=…&raw=1` a cloud replica serves the same document
 * from; and a root-absolute path (`/tmp/report/video.webm`), which inside a
 * previewed document means the file at that path on the document's own host.
 * Anything else under `/api/` is an API call, not a file. A trailing slash names
 * a directory, which the panel has no viewer for.
 *
 * `href` may be a full URL or a path (with or without a query string).
 */
export function previewFileTarget(href: string, documentHost?: string): PreviewFileTarget | null {
  let url: URL
  try { url = new URL(href, 'http://walnut.invalid') } catch { return null }
  const pathname = url.pathname
  if (pathname.endsWith('/')) return null
  const m = RAW_ROUTE_RE.exec(pathname)
  if (m) {
    const hostSeg = decodeSegment(m[1]!)
    if (hostSeg == null) return null
    const rest = m[2]!.split('/').map(decodeSegment)
    if (rest.some((s) => s == null)) return null
    const joined = rest.join('/')
    if (!joined) return null
    return { host: hostSeg === 'local' ? undefined : hostSeg, path: joined.startsWith('~') ? joined : `/${joined.replace(/^\/+/, '')}` }
  }
  if (RAW_QUERY_ROUTE_RE.test(pathname)) {
    const path = url.searchParams.get('path')
    if (url.searchParams.get('raw') !== '1' || !path) return null
    return { host: url.searchParams.get('host') || undefined, path }
  }
  if (pathname === '/api' || pathname.startsWith('/api/')) return null
  if (!pathname.startsWith('/')) return null
  const segs = pathname.split('/').map(decodeSegment)
  if (segs.some((s) => s == null)) return null
  return { host: documentHost, path: segs.join('/') }
}

/**
 * What a same-origin URL means relative to the file being previewed: the file
 * itself, another file on the same host (which the panel can open), or neither
 * (a directory, an API URL, a file on another host).
 */
export function classifyPreviewNavigation(
  href: string,
  current: PreviewFileTarget,
): 'same-file' | { kind: 'file'; path: string } | null {
  const target = previewFileTarget(href, current.host)
  if (!target || !sameHost(target.host, current.host)) return null
  if (target.path === current.path) return 'same-file'
  return { kind: 'file', path: target.path }
}

export type PreviewLinkVerdict =
  /** Let the browser handle it: same document (anchor / self link), non-http scheme, not a file. */
  | { kind: 'passthrough' }
  /** Another website: open it outside the preview pane. */
  | { kind: 'external'; url: string }
  /** Another file on the same host: open it in the panel's own viewer. */
  | { kind: 'file'; path: string }

/**
 * Classify a clicked link. `href` is the anchor's resolved URL (`a.href`),
 * `documentHref` the frame document's current URL, `current` the file being
 * previewed. A target on a different host than the document is left to the
 * browser: the panel is bound to one host.
 */
export function classifyPreviewLink(
  href: string,
  documentHref: string,
  current: PreviewFileTarget,
): PreviewLinkVerdict {
  let url: URL
  let doc: URL
  try {
    doc = new URL(documentHref)
    url = new URL(href, doc)
  } catch {
    return { kind: 'passthrough' }
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return { kind: 'passthrough' }
  if (url.origin !== doc.origin) return { kind: 'external', url: url.href }
  const nav = classifyPreviewNavigation(url.href, current)
  if (!nav || nav === 'same-file') return { kind: 'passthrough' }
  return nav
}
