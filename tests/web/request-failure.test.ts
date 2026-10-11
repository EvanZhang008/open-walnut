/**
 * A request the browser gave up on reads as the deadline it had, in plain
 * words (web/src/utils/request-failure.ts). A gate review saw a cloud removal
 * say "Couldn't remove: signal timed out" in Chromium and "Couldn't remove:
 * Fetch is aborted" in WebKit: the browser's own text for its own deadline.
 */
import { describe, expect, it } from 'vitest'
import { asDeadlineError, browserGaveUp, deadlineFired, gaveUpSentence, requestFailureText } from '../../web/src/utils/request-failure.js'

/** What each engine throws when AbortSignal.timeout fires (and WebKit for an abort). */
const chromiumTimeout = Object.assign(new Error('signal timed out'), { name: 'TimeoutError' })
const webkitAbort = Object.assign(new Error('Fetch is aborted'), { name: 'AbortError' })

describe('requestFailureText', () => {
  it("a browser's deadline is said as the deadline, in either engine's words", () => {
    expect(browserGaveUp(chromiumTimeout)).toBe(true)
    expect(browserGaveUp(webkitAbort)).toBe(true)
    expect(requestFailureText(chromiumTimeout, 45_000)).toBe('Walnut did not answer in 45s.')
    expect(requestFailureText(webkitAbort, 15_000)).toBe('Walnut did not answer in 15s.')
    expect(gaveUpSentence(1_500)).toBe('Walnut did not answer in 2s.')
  })

  it("the server's own sentence is kept as it is", () => {
    const server = new Error('Could not reach the cloud companion (timed out after 15s).')
    expect(browserGaveUp(server)).toBe(false)
    expect(requestFailureText(server, 45_000)).toBe('Could not reach the cloud companion (timed out after 15s).')
    expect(requestFailureText('plain words', 15_000)).toBe('plain words')
    expect(requestFailureText(null, 15_000)).toBe('Unknown error')
  })
})

describe('asDeadlineError', () => {
  const fired = (): AbortSignal => {
    const c = new AbortController()
    c.abort(new DOMException('signal timed out', 'TimeoutError'))
    return c.signal
  }

  it("WebKit's AbortError for a deadline that fired becomes the TimeoutError Chromium throws", () => {
    expect(deadlineFired(fired())).toBe(true)
    const err = asDeadlineError(webkitAbort, fired())
    expect((err as Error).name).toBe('TimeoutError')
    // AbortSignal.any keeps the reason of the signal that fired first.
    const either = AbortSignal.any([new AbortController().signal, fired()])
    expect((asDeadlineError(webkitAbort, either) as Error).name).toBe('TimeoutError')
  })

  it("a caller's own cancel, a signal that never fired, and any other error are left as they are", () => {
    const cancel = new AbortController()
    cancel.abort()
    expect(deadlineFired(cancel.signal)).toBe(false)
    expect(asDeadlineError(webkitAbort, cancel.signal)).toBe(webkitAbort)
    expect(asDeadlineError(webkitAbort, AbortSignal.any([cancel.signal, AbortSignal.timeout(60_000)]))).toBe(webkitAbort)
    expect(asDeadlineError(webkitAbort, new AbortController().signal)).toBe(webkitAbort)
    expect(asDeadlineError(webkitAbort, undefined)).toBe(webkitAbort)
    const network = new TypeError('Load failed')
    expect(asDeadlineError(network, fired())).toBe(network)
    expect(asDeadlineError(chromiumTimeout, fired())).toBe(chromiumTimeout)
  })
})
