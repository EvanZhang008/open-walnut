/** A page's error line into the real-use recorder (web/routes/browser-logs.ts), as its kind only. */
import { pageErrorKind } from './normalize.js'
import { answeredTemplates, recordPageError } from './record.js'
import { placeOfPagePath } from './page-uses.js'

/** `url` is the page's path the line came from: its own errors count on that page too (page-uses.ts). */
export function recordPageLine(message: string, args: string | undefined, count: number | undefined, url?: string): void {
  try {
    const k = pageErrorKind(message, args, answeredTemplates)
    if (!k) return
    // A line the page folded (`count`) is that many errors, at most 50 from one batch.
    const n = Math.min(Math.max(1, Number(count) || 1), 50)
    const place = placeOfPagePath(url)
    for (let i = 0; i < n; i++) recordPageError(k, Date.now(), place)
  } catch { /* recording never fails the log route */ }
}
