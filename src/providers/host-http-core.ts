/**
 * The host side of `host_http` (src/core/hosts/host-http.ts): one HTTP request
 * made FROM this host for a task on another host, so the task reaches a web
 * service only this machine can (a dev server on its localhost, a service on its
 * own network) without a tunnel or an open port (the user, 2026-10-31: "a web
 * service ... we can call it directly").
 *
 * The server decides WHETHER a task may (the user's grant for the task and
 * host); this file only makes the request, bounded: http and https only, a
 * deadline (30 s by default, 5 min at most), redirects followed, and at most
 * 256 KB of the body read (text as text, anything else as base64). A
 * Set-Cookie header's value never comes back.
 *
 * Bundled into the binary daemon and shipped inside the host-reach-core.cjs
 * sidecar for the source twin; 'host-http-v1' is advertised only where it loads.
 */
export const HTTP_DEFAULT_MS = 30_000
export const HTTP_MAX_MS = 5 * 60_000
export const BODY_MAX_BYTES = 256 * 1024
const REQUEST_BODY_MAX = 4 * 1024 * 1024
const METHODS = new Set(['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'])

export type HttpError = { ok: false; code: 'bad_request' | 'request_failed' | 'timeout'; error: string }

export interface HttpRequest {
  url?: unknown
  method?: unknown
  headers?: unknown
  body?: unknown
  bodyBase64?: unknown
  timeoutMs?: unknown
  maxBytes?: unknown
}

export interface HttpReply {
  ok: true
  status: number
  statusText: string
  url: string
  headers: Record<string, string>
  contentType: string
  /** The body as text, when it is text; else `bodyBase64`. */
  body?: string
  bodyBase64?: string
  bodyBytes: number
  truncated: boolean
  ms: number
}

function bad(error: string, code: HttpError['code'] = 'bad_request'): HttpError {
  return { ok: false, code, error }
}

/** Text a person or an agent reads as written: JSON, XML, HTML, forms, scripts. */
export function isTextType(type: string): boolean {
  const t = type.toLowerCase()
  return t.startsWith('text/') || /\b(json|xml|javascript|ecmascript|x-www-form-urlencoded|yaml|toml|csv|graphql|svg)\b/.test(t) || t === ''
}

export function createHostHttp(deps: { fetch?: typeof fetch; now?: () => number } = {}) {
  const now = deps.now ?? Date.now

  async function request(req: HttpRequest): Promise<HttpReply | HttpError> {
    let url: URL
    try { url = new URL(String(req.url ?? '')) } catch { return bad('url must be an absolute http:// or https:// address') }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return bad('url must use http:// or https://')
    const method = typeof req.method === 'string' && req.method ? req.method.toUpperCase() : 'GET'
    if (!METHODS.has(method)) return bad(`method must be one of ${[...METHODS].join(', ')}`)
    const headers: Record<string, string> = {}
    if (req.headers !== undefined) {
      if (!req.headers || typeof req.headers !== 'object' || Array.isArray(req.headers)) return bad('headers must be an object of strings')
      for (const [k, v] of Object.entries(req.headers as Record<string, unknown>)) {
        if (typeof v !== 'string' || /[\r\n]/.test(k + v)) return bad(`header ${k} must be a one-line string`)
        headers[k] = v
      }
    }
    if (req.body !== undefined && req.bodyBase64 !== undefined) return bad('give body or bodyBase64, not both')
    let body: Buffer | undefined
    if (typeof req.body === 'string') body = Buffer.from(req.body, 'utf8')
    else if (typeof req.bodyBase64 === 'string') body = Buffer.from(req.bodyBase64, 'base64')
    else if (req.body !== undefined || req.bodyBase64 !== undefined) return bad('body must be a string (bodyBase64 for bytes)')
    if (body && body.length > REQUEST_BODY_MAX) return bad(`the request body is over ${REQUEST_BODY_MAX} bytes`)
    if (body && (method === 'GET' || method === 'HEAD')) return bad(`a ${method} request has no body`)
    const timeoutMs = Math.min(typeof req.timeoutMs === 'number' && req.timeoutMs > 0 ? req.timeoutMs : HTTP_DEFAULT_MS, HTTP_MAX_MS)
    const maxBytes = Math.min(typeof req.maxBytes === 'number' && req.maxBytes > 0 ? req.maxBytes : BODY_MAX_BYTES, BODY_MAX_BYTES)

    const f = deps.fetch ?? globalThis.fetch
    const t0 = now()
    const ctl = new AbortController()
    const timer = setTimeout(() => ctl.abort(), timeoutMs)
    timer.unref?.()
    try {
      const res = await f(url.toString(), { method, headers, ...(body ? { body: new Uint8Array(body) } : {}), redirect: 'follow', signal: ctl.signal })
      const out: Record<string, string> = {}
      res.headers.forEach((v, k) => { out[k] = k.toLowerCase() === 'set-cookie' ? '[hidden by Walnut]' : v })
      const chunks: Buffer[] = []
      let got = 0
      let truncated = false
      if (res.body && method !== 'HEAD') {
        const reader = res.body.getReader()
        for (;;) {
          const { done, value } = await reader.read()
          if (done) break
          const buf = Buffer.from(value)
          if (got + buf.length > maxBytes) {
            chunks.push(buf.subarray(0, maxBytes - got))
            got = maxBytes
            truncated = true
            void reader.cancel().catch(() => {})
            break
          }
          chunks.push(buf)
          got += buf.length
        }
      }
      const bytes = Buffer.concat(chunks)
      const contentType = res.headers.get('content-type') ?? ''
      const asText = isTextType(contentType)
      return {
        ok: true, status: res.status, statusText: res.statusText, url: res.url || url.toString(), headers: out, contentType,
        ...(asText ? { body: bytes.toString('utf8') } : { bodyBase64: bytes.toString('base64') }),
        bodyBytes: bytes.length, truncated, ms: now() - t0,
      }
    } catch (err) {
      if (ctl.signal.aborted) return bad(`no answer from ${url.origin} within ${timeoutMs} ms`, 'timeout')
      const cause = (err as { cause?: { code?: unknown; message?: unknown } }).cause
      const why = cause && (cause.code || cause.message) ? `${String(cause.code ?? '')} ${String(cause.message ?? '')}`.trim() : (err as Error).message
      return bad(`the request to ${url.origin} failed on this host: ${why}`, 'request_failed')
    } finally {
      clearTimeout(timer)
    }
  }

  return { request }
}

export type HostHttp = ReturnType<typeof createHostHttp>
