/**
 * The log lines of an index a database got after its open (src/lib/sqlite-late-index.ts): one when
 * it is built, one when the build stopped (the next open tries again).
 */
import path from 'node:path'
import type { LateIndexReport } from '../lib/sqlite-late-index.js'
import { log } from '../logging/index.js'

export function lateIndexReport(file: string): LateIndexReport {
  return (built, error) => {
    const fields = { file: path.basename(file), built }
    if (error) log.obs.warn('sqlite: an index built after the open stopped; the next open tries again', { ...fields, error })
    else log.obs.info('sqlite: indexes built after the open', fields)
  }
}
