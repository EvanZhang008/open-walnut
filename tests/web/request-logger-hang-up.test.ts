/**
 * A client that gave up waiting is how real use sees a route that held it (2026-11-24): a page's
 * 15 s deadline aborts its fetch, and the request logger used to record that hang-up as a wait of
 * 0 ms, so a route that held its page until the page gave up read as fast while the page's timeout
 * rang the watches of tasks that changed neither. Through the real middleware: a hang-up past the
 * slow line is the route's slow read; a short one, and a stream's end, are not.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Request, Response } from 'express'
import { EventEmitter } from 'node:events'
import { requestLogger, _resetRouteHealthForTest } from '../../src/web/middleware/request-logger.js'
import { addObserveTap, resetMetrics } from '../../src/core/observability/metrics.js'
import { _resetUsageRecorderForTesting } from '../../src/core/usage-watch/record.js'
import { log } from '../../src/logging/index.js'

const T = Date.parse('2026-11-24T09:02:13Z')

function request(opts: { url: string; contentType?: string; headersSent?: boolean; method?: string }) {
  const res = new EventEmitter() as unknown as Response & EventEmitter
  Object.assign(res, { statusCode: 200, headersSent: opts.headersSent ?? false, setHeader: () => res, getHeader: (n: string) => (n === 'content-type' ? opts.contentType : undefined) })
  const path = opts.url.split('?')[0]!
  const req = { method: opts.method ?? 'GET', originalUrl: opts.url, path, baseUrl: '/api', route: { path: path.slice(4) }, query: {}, headers: {} } as unknown as Request
  requestLogger(req, res, () => {})
  return { close: () => res.emit('close') }
}

let slow: string[] = []
let off: () => void = () => {}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(T)
  resetMetrics()
  _resetUsageRecorderForTesting(true)
  vi.spyOn(log.web, 'info').mockImplementation(() => undefined as never)
  slow = []
  off = addObserveTap((name, _v, labels) => { if (name === 'usage.http.slow') slow.push(labels?.route ?? '') })
})

afterEach(() => {
  off()
  _resetUsageRecorderForTesting(false)
  _resetRouteHealthForTest()
  resetMetrics()
  vi.restoreAllMocks()
  vi.useRealTimers()
})

describe('a client that gave up waiting', () => {
  it('past the slow line, is its route\'s slow read', () => {
    const r = request({ url: '/api/notes-list' })
    vi.setSystemTime(T + 15_010)
    r.close()
    expect(slow).toEqual(['GET /api/notes-list'])
  })

  it('a short hang-up, a long poll, a stream\'s end, a write and an answer already under way are not', () => {
    const short = request({ url: '/api/notes-list' })
    const poll = request({ url: '/api/hosts-exec?wait_ms=60000' })
    const stream = request({ url: '/api/feed', contentType: 'text/event-stream' })
    // A long poll by POST that the wait pattern does not name (the browser bridge's poll).
    const write = request({ url: '/api/browser-poll', method: 'POST' })
    // A video's Range read the player left while seeking: its 206 was already on its way.
    const video = request({ url: '/api/file-content', headersSent: true })
    vi.setSystemTime(T + 900)
    short.close()
    vi.setSystemTime(T + 60_000)
    for (const r of [poll, stream, write, video]) r.close()
    expect(slow).toEqual([])
  })
})
