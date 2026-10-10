/**
 * Answer a request Node's HTTP parser refused with JSON, not an empty body.
 *
 * Such a request never reaches Express, so Node used to answer it on its own with a
 * bare `400 Bad Request` and no body. The usual one here is a raw (not
 * percent-encoded) non-ASCII character in the URL, `curl ".../api/tasks?q=<CJK>"`:
 * the caller (most often an agent) read the empty body as a broken server
 * (2026-10-09). Now it gets the reason and the fix. Every other parse error keeps
 * the status Node itself would send.
 */

import type { Server as HttpServer } from 'node:http'
import type { Duplex } from 'node:stream'

/** What Node sends for these codes when no listener is attached (lib/_http_server.js). */
const STATUS_FOR_CODE: Readonly<Record<string, number>> = {
  HPE_HEADER_OVERFLOW: 431,
  HPE_CHUNK_EXTENSIONS_OVERFLOW: 413,
  ERR_HTTP_REQUEST_TIMEOUT: 408,
}

const REASON: Readonly<Record<number, string>> = {
  400: 'Bad Request', 408: 'Request Timeout', 413: 'Payload Too Large', 431: 'Request Header Fields Too Large',
}

const URL_CODES = new Set(['HPE_INVALID_URL', 'HPE_INVALID_PATH'])

export function clientErrorBody(code: string | undefined): { status: number; body: Record<string, string> } {
  const status = (code && STATUS_FOR_CODE[code]) || 400
  if (code && URL_CODES.has(code)) {
    return {
      status,
      body: {
        error: 'invalid_url',
        message: 'The request URL has characters that must be percent-encoded (non-ASCII text, spaces). '
          + 'Encode each query value (encodeURIComponent, or curl -G --data-urlencode "q=...").',
      },
    }
  }
  return { status, body: { error: 'bad_request', message: `The HTTP request could not be parsed (${code ?? 'unknown'}).` } }
}

export function attachClientErrorAnswer(server: HttpServer): void {
  server.on('clientError', (err: NodeJS.ErrnoException, socket: Duplex) => {
    // A reset peer is gone; a response already started on this socket cannot be replaced.
    const inFlight = (socket as Duplex & { _httpMessage?: { headersSent?: boolean } })._httpMessage
    if (err.code === 'ECONNRESET' || !socket.writable || inFlight?.headersSent) {
      socket.destroy()
      return
    }
    const { status, body } = clientErrorBody(err.code)
    const json = JSON.stringify(body)
    socket.end(
      `HTTP/1.1 ${status} ${REASON[status] ?? 'Bad Request'}\r\n`
      + 'Content-Type: application/json; charset=utf-8\r\n'
      + `Content-Length: ${Buffer.byteLength(json)}\r\n`
      + 'Connection: close\r\n\r\n'
      + json,
    )
  })
}
