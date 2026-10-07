/**
 * The Mac's half of the companion's forward (policy.ts): run one /api/v1 call
 * the companion carried here (`server.http` over the bridge) against this
 * server's own routes, as the paired client it came from.
 *
 * The call is a loopback request to this server, labelled with the caller's
 * class (`x-walnut-origin: remote-http`), exactly as the plugin HTTP relay and
 * the op executor label theirs. So every route applies the rule it applies to a
 * paired phone, and none of the "this Mac only" ones open: they read the label
 * (src/web/middleware/request-origin.ts). No credential crosses: the phone's
 * token stays on the companion, and the label is how this server knows the call
 * is not its own.
 */

import { getSelfApiRoot } from '../../lib/self-api-root.js'
import { ORIGIN_HEADER, REMOTE_HTTP_ORIGIN, lowerOrigin } from '../../lib/caller-origin.js'
import {
  FORWARD_METHODS, FORWARD_TARGET_TIMEOUT_MS, MAX_FORWARD_REQUEST_BYTES, MAX_FORWARD_RESPONSE_BYTES,
  companionAnswers, forwardRequestHeaders, forwardResponseHeaders, parseForwardUrl,
} from './policy.js'

/**
 * `refused`: nothing ran here (a bad or unforwardable call); the companion may
 * answer it itself. `failed`: the call went to the route and no answer came
 * back, so a write may have been applied.
 */
export class ForwardError extends Error {
  constructor(message: string, readonly status: number, readonly code: 'forward_refused' | 'forward_failed') {
    super(message)
    this.name = 'ForwardError'
  }
}

export interface ForwardReply {
  status: number
  headers: Record<string, string>
  size: number
  /** The body, base64. Absent when `tooLarge`. */
  data?: string
  /** The reply was larger than the bridge carries: nothing of it came back. */
  tooLarge?: true
}

const refuse = (message: string, status = 400): ForwardError => new ForwardError(message, status, 'forward_refused')

function decodeBody(data: unknown, size: unknown): Buffer {
  if (data === undefined || data === null || data === '') return Buffer.alloc(0)
  if (typeof data !== 'string' || typeof size !== 'number' || !Number.isSafeInteger(size) || size < 0) {
    throw refuse('Invalid forwarded body')
  }
  if (size > MAX_FORWARD_REQUEST_BYTES || data.length > Math.ceil(MAX_FORWARD_REQUEST_BYTES / 3) * 4 + 4) {
    throw refuse('Forwarded body is too large', 413)
  }
  const body = Buffer.from(data, 'base64')
  if (body.byteLength !== size || body.toString('base64').replace(/=+$/, '') !== data.replace(/=+$/, '')) {
    throw refuse('Invalid forwarded body encoding')
  }
  return body
}

/** Read at most `limit` bytes; null when the body is longer. */
async function readUpTo(response: Response, limit: number): Promise<Buffer | null> {
  if (!response.body) return Buffer.alloc(0)
  const reader = response.body.getReader()
  const chunks: Buffer[] = []
  let total = 0
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      total += value.byteLength
      if (total > limit) {
        await reader.cancel().catch(() => {})
        return null
      }
      chunks.push(Buffer.from(value))
    }
  } finally {
    reader.releaseLock()
  }
  return Buffer.concat(chunks, total)
}

/**
 * Run one forwarded call. `relayOrigin` is who the relay acts for (the cloud
 * bridge: remote-http); the call never acts above a client off this Mac.
 */
export async function runForwardedCall(params: Record<string, unknown>, relayOrigin?: string): Promise<ForwardReply> {
  const method = typeof params.method === 'string' ? params.method.toUpperCase() : ''
  if (!FORWARD_METHODS.has(method)) throw refuse('Unsupported method', 405)
  const url = parseForwardUrl(params.url)
  if (!url) throw refuse('Invalid forwarded path')
  const kept = companionAnswers(method, url.rel)
  if (kept) throw refuse(`The companion answers ${url.pathname} itself (${kept})`)
  const body = decodeBody(params.data, params.size)
  if ((method === 'GET' || method === 'HEAD') && body.byteLength > 0) throw refuse(`${method} cannot have a body`)
  const root = getSelfApiRoot()
  if (!root) throw refuse('This server is not listening yet', 503)

  const headers = { ...forwardRequestHeaders(params.headers), [ORIGIN_HEADER]: lowerOrigin(REMOTE_HTTP_ORIGIN, relayOrigin) }
  const timeoutMs = typeof params.timeoutMs === 'number' && params.timeoutMs > 0
    ? Math.min(params.timeoutMs, FORWARD_TARGET_TIMEOUT_MS) : FORWARD_TARGET_TIMEOUT_MS
  let response: Response
  try {
    response = await fetch(new URL(`${url.pathname}${url.search}`, root), {
      method,
      headers,
      ...(body.byteLength > 0 ? { body: body as unknown as BodyInit } : {}),
      redirect: 'manual',
      signal: AbortSignal.timeout(timeoutMs),
    })
  } catch (err) {
    const timedOut = err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError')
    throw new ForwardError(timedOut ? 'The route did not answer in time' : `The route could not be reached: ${err instanceof Error ? err.message : String(err)}`, timedOut ? 504 : 502, 'forward_failed')
  }
  let content: Buffer | null
  try {
    content = await readUpTo(response, MAX_FORWARD_RESPONSE_BYTES)
  } catch (err) {
    throw new ForwardError(`The reply broke off: ${err instanceof Error ? err.message : String(err)}`, 502, 'forward_failed')
  }
  const replyHeaders = forwardResponseHeaders(Object.fromEntries(response.headers.entries()))
  if (content === null) return { status: response.status, headers: replyHeaders, size: MAX_FORWARD_RESPONSE_BYTES + 1, tooLarge: true }
  return { status: response.status, headers: replyHeaders, size: content.byteLength, data: content.toString('base64') }
}
