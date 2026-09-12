/**
 * Root-absolute URLs inside a previewed HTML file are FILESYSTEM paths.
 *
 * The Files panel previews an HTML file at `/api/file-raw/<host>/<abs path>`, so
 * its RELATIVE references (`img/diagram.png`) resolve to siblings under that
 * route and are served. A ROOT-absolute reference (`href="/tmp/report/video.webm"`,
 * the shape every generated report uses for a file it produced) resolves to the
 * site root instead: `/tmp/report/video.webm` on the Walnut origin. Nothing
 * lives there, so the click landed on Express's bare `Cannot GET /tmp/…`, and a
 * `.html` target was worse — the SPA fallback answered it, and the whole Walnut
 * console loaded INSIDE the preview frame.
 *
 * The Referer says where such a request came from. A request whose referer is a
 * previewed document, for a path no static root claimed, is that document
 * reaching for a file; it is redirected onto the same route under the same host
 * segment. Every kind of reference goes through here (anchor, img, video,
 * script, stylesheet, CSS url()), and the document itself needs no rewriting.
 * Mounted AFTER the static roots and before the SPA fallback: a real site asset
 * (`/favicon.ico` for a preview opened in its own tab) still wins.
 *
 * Nothing here is a new capability: the target is a URL the client can already
 * request directly, and the file-raw route applies its own sandbox to it. The
 * referer is still required to be same-host, so a page on another site cannot
 * steer requests onto the route by dressing up its own URL.
 *
 * Relies on the browser sending a same-origin Referer, which is the default
 * policy. A document that opts out (`<meta name="referrer" content="no-referrer">`)
 * keeps its clicks covered by the client (FileContentView intercepts them) but
 * loses this fix for its images and stylesheets; do not add a `Referrer-Policy:
 * no-referrer` header to the file-raw responses.
 */

import type { Request, Response, NextFunction } from 'express'

const RAW_DOCUMENT_RE = /^(\/api(?:\/v1)?\/file-raw)\/([^/]+)\//
const RAW_QUERY_DOCUMENT_RE = /^(\/api(?:\/v1)?\/file-content)$/

/**
 * The URL a not-found request should be redirected to, or null when the request
 * did not come from a previewed document (leave it to the SPA fallback / 404).
 *
 * `requestUrl` is the request's original URL (path + query, still percent-
 * encoded): the path-shaped target keeps it verbatim because the file-raw route
 * decodes per segment, exactly as it does for a relative reference. `requestHost`
 * is the host the request was addressed to; a referer from any other host is
 * ignored.
 */
export function fileRawRedirectTarget(
  referer: string | undefined,
  requestUrl: string,
  requestHost?: string,
): string | null {
  // Every asset and SPA route carries a referer too: reject those on a substring
  // scan before paying for a URL parse.
  if (!referer || !referer.includes('/file-')) return null
  if (!requestUrl.startsWith('/') || requestUrl.startsWith('//')) return null
  const reqPath = requestUrl.split('?')[0]!
  if (reqPath === '/' || reqPath === '/api' || reqPath.startsWith('/api/')) return null

  let ref: URL
  try { ref = new URL(referer) } catch { return null }
  if (requestHost && ref.host.toLowerCase() !== requestHost.toLowerCase()) return null

  const m = RAW_DOCUMENT_RE.exec(ref.pathname)
  if (m) return `${m[1]}/${m[2]}${requestUrl}`

  // A cloud replica serves the same preview from the query-shaped route (the
  // path-shaped one redirects there), so its documents carry this referer.
  const q = RAW_QUERY_DOCUMENT_RE.exec(ref.pathname)
  if (q && ref.searchParams.get('raw') === '1' && ref.searchParams.get('path')) {
    let decoded: string
    try { decoded = decodeURIComponent(reqPath) } catch { return null }
    const params = new URLSearchParams({ path: decoded, raw: '1' })
    const host = ref.searchParams.get('host')
    if (host) params.set('host', host)
    return `${q[1]}?${params}`
  }
  return null
}

/** The host a request was addressed to, as the browser sees it (proxy-aware). */
function requestHost(req: Request): string | undefined {
  const forwarded = req.headers['x-forwarded-host']
  const first = (Array.isArray(forwarded) ? forwarded[0] : forwarded)?.split(',')[0]?.trim()
  return first || req.headers.host
}

/** Express middleware form. Mount after the static roots, ahead of the SPA fallback. */
export function fileRawRefererRedirect(req: Request, res: Response, next: NextFunction): void {
  if (req.method !== 'GET' && req.method !== 'HEAD') { next(); return }
  const target = fileRawRedirectTarget(req.headers.referer, req.originalUrl, requestHost(req))
  if (!target) { next(); return }
  res.redirect(302, target)
}
