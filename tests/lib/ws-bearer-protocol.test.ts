/**
 * The device token as a WebSocket subprotocol entry (src/lib/ws-bearer-protocol.ts)
 * and the order a server reads an upgrade's credential in
 * (src/web/ws/upgrade-credential.ts): the bearer entry, then Authorization, then
 * the legacy `?token=`. The server's answer names `walnut.v1` and never the
 * bearer entry.
 */
import { describe, expect, it } from 'vitest'
import {
  WS_APP_PROTOCOL, WS_BEARER_PREFIX, bearerFromProtocols, decodeBearerProtocol, encodeBearerProtocol,
  offeredProtocols, selectWsProtocol, wsProtocolsFor,
} from '../../src/lib/ws-bearer-protocol.js'
import { upgradeCredential } from '../../src/web/ws/upgrade-credential.js'

const HEX_TOKEN = '0f1e2d3c4b5a69788796a5b4c3d2e1f0'
// An API key from config.yaml may be any text: ASCII punctuation and non-ASCII (escaped here).
const ODD_TOKEN = 'key/with+slash=and \u00e9\u4e2d\u{1F511}'

/** A subprotocol name is an RFC 7230 token: no `=`, `/`, `+`, space, or anything above ASCII. */
const RFC_TOKEN = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/

function req(headers: Record<string, string | string[]>) {
  return { headers }
}
const url = (q = '') => new URL(`http://box.example/ws${q}`)

describe('the bearer entry', () => {
  it('round-trips a hex device token and any text, and is a valid subprotocol name', () => {
    for (const token of [HEX_TOKEN, ODD_TOKEN, 'a', 'ab', 'abc']) {
      const entry = encodeBearerProtocol(token)
      expect(entry.startsWith(WS_BEARER_PREFIX)).toBe(true)
      expect(entry, token).toMatch(RFC_TOKEN)
      expect(entry).not.toContain('=')
      expect(decodeBearerProtocol(entry)).toBe(token)
    }
  })

  it('is spelled the way a browser spells it (btoa of the UTF-8 bytes, base64url, no padding)', () => {
    expect(encodeBearerProtocol(HEX_TOKEN)).toBe(WS_BEARER_PREFIX + Buffer.from(HEX_TOKEN).toString('base64url'))
    expect(encodeBearerProtocol(ODD_TOKEN)).toBe(WS_BEARER_PREFIX + Buffer.from(ODD_TOKEN, 'utf-8').toString('base64url'))
  })

  it('the SPA offers walnut.v1 first, then the bearer entry', () => {
    expect(wsProtocolsFor(HEX_TOKEN)).toEqual([WS_APP_PROTOCOL, encodeBearerProtocol(HEX_TOKEN)])
  })

  it('refuses bad base64: a stray character, padding, a lone last character, spare bits, not UTF-8, empty', () => {
    const good = encodeBearerProtocol(HEX_TOKEN).slice(WS_BEARER_PREFIX.length)
    const bad = [
      '',
      good + '=',
      good.slice(0, 4) + '.' + good.slice(5),
      good.slice(0, 4) + '+' + good.slice(5),
      'QUJDR', // length 5: 4k+1 characters never decode
      'QR', // "A" is QQ; R sets spare bits, so it is not the canonical spelling
      Buffer.from([0xff, 0xfe, 0xfd]).toString('base64url'), // not UTF-8
    ]
    for (const body of bad) expect(decodeBearerProtocol(WS_BEARER_PREFIX + body), body).toBeNull()
    expect(decodeBearerProtocol('walnut.v1')).toBeNull()
  })

  it('reads one entry out of the offered list; none is none; two entries or an unreadable one is malformed', () => {
    const entry = encodeBearerProtocol(HEX_TOKEN)
    expect(bearerFromProtocols([WS_APP_PROTOCOL, entry])).toEqual({ kind: 'token', token: HEX_TOKEN })
    expect(bearerFromProtocols([WS_APP_PROTOCOL])).toEqual({ kind: 'none' })
    expect(bearerFromProtocols([])).toEqual({ kind: 'none' })
    expect(bearerFromProtocols([entry, encodeBearerProtocol('other-token')])).toEqual({ kind: 'malformed' })
    expect(bearerFromProtocols([WS_APP_PROTOCOL, `${WS_BEARER_PREFIX}QR`])).toEqual({ kind: 'malformed' })
  })

  it('splits a Sec-WebSocket-Protocol header, joined or repeated', () => {
    expect(offeredProtocols(undefined)).toEqual([])
    expect(offeredProtocols('walnut.v1, walnut.bearer.YWJj')).toEqual(['walnut.v1', 'walnut.bearer.YWJj'])
    expect(offeredProtocols(['walnut.v1', 'walnut.bearer.YWJj'])).toEqual(['walnut.v1', 'walnut.bearer.YWJj'])
  })
})

describe('the server\'s answer', () => {
  it('names walnut.v1 when offered, wherever it stands, and nothing otherwise', () => {
    const entry = encodeBearerProtocol(HEX_TOKEN)
    expect(selectWsProtocol(new Set([WS_APP_PROTOCOL, entry]))).toBe(WS_APP_PROTOCOL)
    expect(selectWsProtocol(new Set([entry, WS_APP_PROTOCOL]))).toBe(WS_APP_PROTOCOL)
    expect(selectWsProtocol(new Set(['chat']))).toBe(false)
  })

  it('never echoes the bearer entry, also when it is all the client offered', () => {
    const entry = encodeBearerProtocol(HEX_TOKEN)
    expect(selectWsProtocol(new Set([entry]))).toBe(false)
    expect(selectWsProtocol(new Set([entry, 'other']))).toBe(false)
  })
})

describe('the credential of an upgrade', () => {
  const entry = encodeBearerProtocol(HEX_TOKEN)

  it('a good bearer entry wins over Authorization and ?token=', () => {
    expect(upgradeCredential(req({ 'sec-websocket-protocol': `walnut.v1, ${entry}`, authorization: 'Bearer from-header' }), url('?token=from-query')))
      .toEqual({ kind: 'token', token: HEX_TOKEN, via: 'subprotocol' })
  })

  it('a bad bearer entry is malformed and never falls through to the header or the query', () => {
    const header = `walnut.v1, ${WS_BEARER_PREFIX}QR`
    expect(upgradeCredential(req({ 'sec-websocket-protocol': header, authorization: `Bearer ${HEX_TOKEN}` }), url(`?token=${HEX_TOKEN}`)))
      .toEqual({ kind: 'malformed', raw: header })
  })

  it('without a bearer entry: Authorization, then the legacy ?token= (still accepted)', () => {
    expect(upgradeCredential(req({ 'sec-websocket-protocol': 'walnut.v1', authorization: 'Bearer from-header' }), url('?token=from-query')))
      .toEqual({ kind: 'token', token: 'from-header', via: 'header' })
    expect(upgradeCredential(req({}), url(`?token=${encodeURIComponent(ODD_TOKEN)}`)))
      .toEqual({ kind: 'token', token: ODD_TOKEN, via: 'query' })
  })

  it('nothing presented is none: no header, an empty Bearer, an empty ?token=', () => {
    expect(upgradeCredential(req({}), url())).toEqual({ kind: 'none' })
    expect(upgradeCredential(req({ authorization: 'Bearer ' }), url('?token='))).toEqual({ kind: 'none' })
    expect(upgradeCredential(req({ 'sec-websocket-protocol': 'walnut.v1' }), url())).toEqual({ kind: 'none' })
  })
})
