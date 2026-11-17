/**
 * A provider call under a deadline (src/lib/with-deadline.ts): past it, the call's signal aborts and
 * the answer is a rejection with the message `timeout`, so a provider that ignores the signal still
 * never holds a read or a route.
 */

import { withDeadline } from '../../lib/with-deadline.js'

export const DEADLINE_MESSAGE = 'timeout'

export function abortableDeadline<T>(ms: number, run: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const ctl = new AbortController()
  return withDeadline((async () => run(ctl.signal))(), ms, () => {
    ctl.abort()
    throw new Error(DEADLINE_MESSAGE)
  })
}
