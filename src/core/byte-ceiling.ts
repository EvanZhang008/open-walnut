/**
 * The whole-file read's byte ceiling (DaemonFileReader.maxReadBytes) as one
 * error shape every caller recognises the same way.
 *
 * A refusal on size is not a failure: each caller that reads a transcript whole
 * has a designed answer for it (a bounded tail window, a host-local probe), so it
 * is logged by that caller at info, and the reader's own fail-fast refusal stays
 * at debug. Kept apart from daemon-file-reader.ts so the many tests that mock
 * the reader keep this real.
 */

const MARK = 'byte ceiling'

export function byteCeilingError(limit: number, path: string, size: number | undefined): Error {
  return new Error(
    `file read exceeded the ${limit}-${MARK} (path=${path}, size=${size}); ` +
    'read a bounded window instead (see readSessionHistoryTail)',
  )
}

export function isByteCeilingError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : typeof err === 'string' ? err : ''
  return msg.includes(MARK)
}
