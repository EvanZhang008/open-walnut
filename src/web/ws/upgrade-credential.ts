/**
 * The credential a WebSocket upgrade presents, in the order the server reads it:
 *
 *   1. a `walnut.bearer.` subprotocol entry: the SPA (src/lib/ws-bearer-protocol.ts),
 *      so the device token never rides the URL into a proxy's access log
 *   2. `Authorization: Bearer`: a client that can set headers
 *   3. `?token=`: legacy, still accepted for an older SPA bundle open in a
 *      window and for the daemons' bridge client
 *
 * A bearer entry that does not decode is a wrong credential, never a reason to
 * read the next source: the client said which credential it meant.
 */

import type { IncomingHttpHeaders } from 'node:http'
import { bearerFromProtocols, offeredProtocols } from '../../lib/ws-bearer-protocol.js'

export type UpgradeCredential =
  | { kind: 'none' }
  /** `raw` is the header as sent, only to tell one retried bad entry from many (auth-rate-limit.ts). */
  | { kind: 'malformed'; raw: string }
  | { kind: 'token'; token: string; via: 'subprotocol' | 'header' | 'query' }

export function upgradeCredential(request: { headers: IncomingHttpHeaders }, url: URL): UpgradeCredential {
  const protocolHeader = request.headers['sec-websocket-protocol']
  const offer = bearerFromProtocols(offeredProtocols(protocolHeader))
  if (offer.kind === 'token') return { kind: 'token', token: offer.token, via: 'subprotocol' }
  if (offer.kind === 'malformed') return { kind: 'malformed', raw: String(protocolHeader) }
  const header = request.headers.authorization
  if (header?.startsWith('Bearer ') && header.length > 7) return { kind: 'token', token: header.slice(7), via: 'header' }
  const query = url.searchParams.get('token')
  if (query) return { kind: 'token', token: query, via: 'query' }
  return { kind: 'none' }
}
