/**
 * The caller class of one HTTP request (src/lib/caller-origin.ts), for routes
 * that serve private data or run ops on the caller's behalf.
 *
 *   socket off this machine (local-trust.ts)   -> `remote-http`, whatever it sends
 *   this machine, no x-walnut-origin           -> `__local__`
 *   this machine, x-walnut-origin: __local__   -> `__local__`
 *   this machine, any other value              -> that value (a host, garbage),
 *                                                 or `unknown` when empty or repeated
 *
 * So the header can only LOWER trust: a client off this machine cannot claim to
 * be local with it, and a self-call made for a remote caller cannot shed it.
 */

import type { IncomingHttpHeaders } from 'node:http'
import { classifyLocalRequest } from './local-trust.js'
import { LOCAL_ORIGIN, ORIGIN_HEADER, REMOTE_HTTP_ORIGIN, UNKNOWN_ORIGIN } from '../../lib/caller-origin.js'

interface RequestLike {
  socket?: { remoteAddress?: string; localPort?: number }
  headers: IncomingHttpHeaders
}

export function requestOrigin(req: RequestLike): string {
  if (!classifyLocalRequest(req).trusted) return REMOTE_HTTP_ORIGIN
  const raw = req.headers[ORIGIN_HEADER]
  if (raw === undefined) return LOCAL_ORIGIN
  // Node joins a repeated custom header with ", ", which can never equal the local value.
  const value = typeof raw === 'string' ? raw.trim() : ''
  if (value === LOCAL_ORIGIN) return LOCAL_ORIGIN
  return value ? value.slice(0, 200) : UNKNOWN_ORIGIN
}

/** A loopback self-call made for someone off this Mac (the header says so). */
export function isOnBehalfOfRemote(req: RequestLike): boolean {
  const raw = req.headers[ORIGIN_HEADER]
  return raw !== undefined && requestOrigin(req) !== LOCAL_ORIGIN
}
