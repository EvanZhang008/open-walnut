/**
 * The companion's forward on a stream ('bridge-stream-v1', replica plan WP13;
 * the Mac's half is stream-door.ts). While the Mac answers and its daemon says
 * it can, a phone's /api/v1 call goes to the Mac as bytes on a stream through
 * that daemon's bridge, instead of one `server.http` JSON frame: no size cap
 * either way, and the reply streams back as it comes.
 *
 * The request is written on the stream as an ordinary HTTP request (the
 * stream is its socket, as in src/host-server/proxy.ts), with only the headers
 * policy.ts lets cross: the phone's token and every Walnut caller header stay
 * here. The outcome is the same ladder proxy.ts reads for server.http: a stream
 * that never opened was never sent; a call the Mac's door refused ran nothing;
 * a request written with no answer in time may have been applied.
 */

import http from 'node:http'
import type { Duplex } from 'node:stream'
import type { Request, Response } from 'express'
import { forwardRequestHeaders, forwardResponseHeaders } from './policy.js'
import { FORWARD_FAILED_HEADER, FORWARD_REFUSED_HEADER } from './stream-door.js'

export type StreamOutcome =
  /** The Mac's answer was passed on (status, headers, body as it streams). */
  | { kind: 'answered'; status: number }
  /** No stream: nothing reached the Mac. `slow`: the daemon or the Mac did not answer the open in time. */
  | { kind: 'not-sent'; slow: boolean; message: string }
  /** The Mac's door refused it before any route ran. */
  | { kind: 'refused'; status: number }
  /** The request went out and no answer came in time (or the stream broke before one). */
  | { kind: 'unanswered'; message: string }

export interface StreamForwardInput {
  req: Request
  res: Response
  method: string
  /** The JSON body as it arrived, re-serialized (proxy.ts bodyOf), or null. */
  body: Buffer | null
  timeoutMs: number
  open: () => Promise<Duplex>
}

/** Forward one call; resolves once the answer started (or the call is known not answered). */
export function forwardOnStream(input: StreamForwardInput): Promise<StreamOutcome> {
  const { req, res, method, body, timeoutMs } = input
  const started = Date.now()
  return new Promise<StreamOutcome>((resolve) => {
    let settled = false
    const done = (o: StreamOutcome) => { if (!settled) { settled = true; clearTimeout(timer); resolve(o) } }
    let stream: Duplex | null = null
    let up: http.ClientRequest | null = null
    const timer = setTimeout(() => {
      if (!up) {
        done({ kind: 'not-sent', slow: true, message: `no stream to the Mac within ${timeoutMs} ms` })
        stream?.destroy()
        return
      }
      done({ kind: 'unanswered', message: `no answer within ${timeoutMs} ms` })
      up.destroy()
    }, timeoutMs)
    timer.unref?.()

    input.open().then((s) => {
      stream = s
      if (settled) { s.destroy(); return }
      const headers: http.OutgoingHttpHeaders = { ...forwardRequestHeaders(req.headers), host: 'primary' }
      if (body) headers['content-length'] = String(body.byteLength)
      up = http.request({ method, path: req.originalUrl, headers, createConnection: () => s } as http.RequestOptions)
      up.on('response', (answer) => {
        if (settled) { answer.resume(); s.destroy(); return }
        const code = answer.statusCode ?? 502
        if (answer.headers[FORWARD_REFUSED_HEADER] === '1') {
          answer.resume()
          answer.on('end', () => s.destroy())
          done({ kind: 'refused', status: code })
          return
        }
        if (answer.headers[FORWARD_FAILED_HEADER] === '1') {
          // The Mac's door could not reach its own route (its listener closing): the call
          // may have started there, so it is unanswered, as a server.http frame with no reply.
          answer.resume()
          answer.on('end', () => s.destroy())
          done({ kind: 'unanswered', message: 'the Mac could not reach its own route' })
          return
        }
        res.status(code)
        for (const [k, v] of Object.entries(forwardResponseHeaders(answer.headers))) res.setHeader(k, v)
        const len = answer.headers['content-length']
        if (typeof len === 'string' && /^\d+$/.test(len)) res.setHeader('Content-Length', len)
        res.setHeader('X-Walnut-Answered-By', 'primary')
        done({ kind: 'answered', status: code })
        answer.pipe(res)
        answer.on('error', () => res.destroy())
        answer.on('end', () => s.destroy())
      })
      up.on('error', (err) => {
        if (settled) { if (!res.writableFinished) res.destroy(); return }
        done({ kind: 'unanswered', message: err.message })
      })
      // A phone that went away takes its call with it.
      res.on('close', () => { if (!res.writableFinished) up?.destroy() })
      if (body) up.end(body)
      else up.end()
    }, (err: Error) => {
      done({ kind: 'not-sent', slow: /^no answer from the /.test(err.message) || Date.now() - started >= timeoutMs, message: err.message })
    })
  })
}
