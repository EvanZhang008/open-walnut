/** A page's error line into the real-use recorder (web/routes/browser-logs.ts), as its kind only. */
import { pageErrorKind } from './normalize.js'
import { answeredTemplates, recordPageError } from './record.js'

export function recordPageLine(message: string, args: string | undefined, count: number | undefined): void {
  try {
    const k = pageErrorKind(message, args, answeredTemplates)
    if (!k) return
    // A line the page folded (`count`) is that many errors, at most 50 from one batch.
    const n = Math.min(Math.max(1, Number(count) || 1), 50)
    for (let i = 0; i < n; i++) recordPageError(k)
  } catch { /* recording never fails the log route */ }
}
