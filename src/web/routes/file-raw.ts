/**
 * PATH-SHAPED raw file URL — the fix for relative references inside a previewed
 * HTML file.
 *
 *   GET /api/file-raw/<host>/<absolute path...>[?download=1][&r=N]
 *   e.g. /api/file-raw/local/Users/me/proj/index.html
 *        /api/file-raw/devbox/~/proj/index.html
 *
 * Why a second URL shape for bytes the query-shaped `?raw=1` route already
 * serves: a document's relative URLs resolve against its own URL's PATH, and the
 * query string is discarded. Loaded from `/api/file-content?path=…&raw=1`, an
 * HTML file's `<img src="diagram.png">` resolved to `/api/diagram.png` — every
 * relative image, stylesheet and link in every previewed HTML file was broken,
 * and `<base href>` cannot repair it because there is no path to base on. Served
 * from `/api/file-raw/local/Users/me/proj/index.html`, that same `diagram.png`
 * resolves to `/api/file-raw/local/Users/me/proj/diagram.png`, which this route
 * also serves. `../shared/x.css` resolves the same way; the browser normalises
 * the dots before the request reaches us.
 *
 * `<host>` is `local` for this machine or a host alias; the rest of the path is
 * the file's absolute (or `~`-relative, remote only) path with each segment
 * percent-encoded. Nothing here is a new capability: the handler is the SAME
 * `serveRawFileContent` the query-shaped route uses, so the sandbox
 * (`assertPathAllowed`, secret denylist, remote via the daemon) is identical.
 */

import { Router, type Request, type Response, type NextFunction } from 'express'
import { CLOUD_MODE } from '../../constants.js'

export const fileRawRouter = Router()

/** `local` → this machine (no host); anything else is a host alias. */
export function hostFromSegment(seg: string): string | undefined {
  return seg === 'local' || seg === '' ? undefined : seg
}

/**
 * Rebuild the file path from the wildcard remainder. Express has already
 * percent-decoded each segment. A `~` first segment stays `~/…` (remote home-
 * relative, expanded by the daemon); anything else is made absolute.
 */
export function pathFromRemainder(rest: string): string {
  if (rest.startsWith('~')) return rest
  return '/' + rest.replace(/^\/+/, '')
}

// Express 5: a named splat, not a bare `*`.
fileRawRouter.get('/:host/*rest', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const hostSeg = String(req.params.host ?? '')
    // Express 5 hands a splat back as an ARRAY of decoded segments.
    const restParam = (req.params as Record<string, unknown>).rest
    const rest = Array.isArray(restParam) ? restParam.join('/') : String(restParam ?? '')
    const host = hostFromSegment(hostSeg)
    const filePath = pathFromRemainder(rest)
    const download = req.query.download === '1' || req.query.download === 'true'

    if (CLOUD_MODE) {
      // The replica relays reads through the narrow bridge command; that path
      // is query-shaped and owned by file-content-bridge. Rather than duplicate
      // it, point the client at the shape the replica does serve.
      const params = new URLSearchParams({ path: filePath, raw: '1' })
      if (host) params.set('host', host)
      if (download) params.set('download', '1')
      res.redirect(302, `/api/file-content?${params}`)
      return
    }

    const { serveRawFileContent, FileContentError } = await import('./file-content.js')
    try {
      await serveRawFileContent(req, res, filePath, host, download)
    } catch (err) {
      if (err instanceof FileContentError) {
        res.status(err.statusCode).type('text/plain').send(err.message)
        return
      }
      throw err
    }
  } catch (err) {
    next(err)
  }
})
