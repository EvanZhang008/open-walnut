/**
 * The device token of a browser's WebSocket, carried as a subprotocol entry.
 *
 * A browser cannot set a header on a WebSocket, and a token in the URL
 * (`/ws?token=`) lands in the access log of every tunnel and proxy in front of
 * Walnut. So the SPA offers two subprotocols, the pattern Kubernetes uses:
 *
 *   new WebSocket(url, ['walnut.v1', 'walnut.bearer.' + base64url(token)])
 *
 * The server reads the token from the bearer entry and answers `walnut.v1`
 * (selectWsProtocol): a browser that offered subprotocols fails the handshake
 * when the answer names none, and the bearer entry is never echoed back.
 * base64url without padding, because `=` is not a token character and a
 * subprotocol name must be one (RFC 6455, section 4.1).
 *
 * Pure and isomorphic: the SPA (web/src/api/ws.ts) and the server
 * (src/web/ws/upgrade-credential.ts) both import it.
 */

/** The application protocol the SPA offers on /ws and the server answers. */
export const WS_APP_PROTOCOL = 'walnut.v1'
/** The prefix of the subprotocol entry that carries the device token. */
export const WS_BEARER_PREFIX = 'walnut.bearer.'

const BASE64URL = /^[A-Za-z0-9_-]+$/

function toBase64Url(bytes: Uint8Array): string {
  let bin = ''
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]!)
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

/** The bearer entry for a token: the prefix, then the token's UTF-8 bytes in unpadded base64url. */
export function encodeBearerProtocol(token: string): string {
  return WS_BEARER_PREFIX + toBase64Url(new TextEncoder().encode(token))
}

/** What the SPA offers for a device token: the app protocol first, then the bearer entry. */
export function wsProtocolsFor(token: string): string[] {
  return [WS_APP_PROTOCOL, encodeBearerProtocol(token)]
}

/**
 * The token in a bearer entry, or null when the entry is not the canonical
 * unpadded base64url of non-empty UTF-8 text (a stray character, padding, a
 * last character with spare bits set, bytes that are not UTF-8).
 */
export function decodeBearerProtocol(entry: string): string | null {
  if (!entry.startsWith(WS_BEARER_PREFIX)) return null
  const body = entry.slice(WS_BEARER_PREFIX.length)
  if (!body || body.length % 4 === 1 || !BASE64URL.test(body)) return null
  let bin: string
  try {
    bin = atob(body.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (body.length % 4)) % 4))
  } catch {
    return null
  }
  const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0))
  // Spare bits in the last character decode to the same bytes: only one spelling counts.
  if (toBase64Url(bytes) !== body) return null
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes) || null
  } catch {
    return null
  }
}

/** The subprotocols a Sec-WebSocket-Protocol header offers (a repeated header arrives joined, or as an array). */
export function offeredProtocols(header: string | string[] | undefined): string[] {
  if (header === undefined) return []
  return (Array.isArray(header) ? header.join(',') : header).split(',').map((p) => p.trim()).filter(Boolean)
}

export type BearerOffer = { kind: 'none' } | { kind: 'token'; token: string } | { kind: 'malformed' }

/** The token the offered subprotocols carry. An entry that does not decode, or two entries, is malformed. */
export function bearerFromProtocols(protocols: Iterable<string>): BearerOffer {
  const entries = [...protocols].filter((p) => p.startsWith(WS_BEARER_PREFIX))
  if (entries.length === 0) return { kind: 'none' }
  if (entries.length > 1) return { kind: 'malformed' }
  const token = decodeBearerProtocol(entries[0]!)
  return token === null ? { kind: 'malformed' } : { kind: 'token', token }
}

/** The subprotocol the server answers: `walnut.v1` when the client offered it, else none. Never a bearer entry. */
export function selectWsProtocol(protocols: Iterable<string>): string | false {
  for (const p of protocols) if (p === WS_APP_PROTOCOL) return p
  return false
}
