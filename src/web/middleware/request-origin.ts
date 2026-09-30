/**
 * The caller class of one HTTP request (src/lib/caller-origin.ts), for routes
 * that serve private data or run ops on the caller's behalf.
 *
 *   socket off this machine (local-trust.ts)   -> `remote-http`, whatever it sends
 *   this machine, no x-walnut-origin           -> `__local__`
 *   this machine, x-walnut-origin: __local__   -> `__local__`
 *   this machine, the header repeated          -> `unknown` (see below)
 *   this machine, an empty header              -> `unknown`
 *   this machine, any other value              -> that value (a host, garbage)
 *
 * A header sent more than once reaches a route joined with ", " (Node's rule
 * for a custom header), or as an array from code that builds headers itself.
 * Either way it is `unknown`, the lowest class, and never one of its parts: no
 * origin contains a comma (caller-origin.ts hostOrigin), so a comma means the
 * header was repeated.
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
  // Sent more than once (joined with ", ", or an array): `unknown`, never a part of it.
  if (typeof raw !== 'string' || raw.includes(',')) return UNKNOWN_ORIGIN
  const value = raw.trim()
  if (value === LOCAL_ORIGIN) return LOCAL_ORIGIN
  return value ? value.slice(0, 200) : UNKNOWN_ORIGIN
}

/** A loopback self-call made for someone off this Mac (the header says so). */
export function isOnBehalfOfRemote(req: RequestLike): boolean {
  const raw = req.headers[ORIGIN_HEADER]
  return raw !== undefined && requestOrigin(req) !== LOCAL_ORIGIN
}
