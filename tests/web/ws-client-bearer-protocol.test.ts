/**
 * The SPA's WebSocket never carries the device token in its URL (web/src/api/ws.ts).
 *
 * A browser signed in with a code used to open `/ws?token=<device token>`, and a
 * URL lands in the access log of every tunnel and proxy in front of Walnut. Now
 * the token rides a `walnut.bearer.` subprotocol entry beside `walnut.v1`; on the
 * server's own machine (no token stored) the socket offers no subprotocol at all.
 * A stand-in WebSocket records what the client asked for; nothing else is mocked.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { LEAN_SIGNATURE } from '../../src/lib/ws-lean-protocol'
import { decodeBearerProtocol, WS_APP_PROTOCOL, WS_BEARER_PREFIX } from '../../src/lib/ws-bearer-protocol.js'

const TOKEN = '9a8b7c6d5e4f30211203f4e5d6c7b8a9'

let opened: Array<{ url: string; protocols: unknown; argc: number }>
let stored: Record<string, string>

beforeEach(() => {
  vi.resetModules()
  opened = []
  stored = {}
  const Fake = function (this: unknown, ...args: unknown[]) {
    opened.push({ url: String(args[0]), protocols: args[1], argc: args.length })
    return { readyState: 0, send: () => {}, close: () => {}, onopen: null, onclose: null, onerror: null, onmessage: null }
  } as unknown as typeof WebSocket
  ;(Fake as unknown as { OPEN: number }).OPEN = 1
  vi.stubGlobal('WebSocket', Fake)
  vi.stubGlobal('window', { location: { protocol: 'https:', host: 'walnut.example.net' } })
  vi.stubGlobal('localStorage', {
    getItem: (k: string) => stored[k] ?? null,
    setItem: (k: string, v: string) => { stored[k] = v },
    removeItem: (k: string) => { delete stored[k] },
  })
})

afterEach(() => {
  vi.unstubAllGlobals()
})

async function connect() {
  const { wsClient } = await import('@/api/ws')
  wsClient.connect()
  return opened[0]!
}

describe('the SPA\'s /ws handshake', () => {
  it('a browser signed in with a code: a /ws URL with no credential, the token in the bearer subprotocol', async () => {
    stored['walnut.deviceToken'] = TOKEN
    const { url, protocols } = await connect()
    // Only the lean-frames version rides the query (web/src/api/ws-lean.ts), never a credential.
    expect(url).toBe(`wss://walnut.example.net/ws?lean=${LEAN_SIGNATURE}`)
    expect(url).not.toContain('token')
    expect(url).not.toContain(TOKEN)
    const offered = protocols as string[]
    expect(offered[0]).toBe(WS_APP_PROTOCOL)
    expect(offered).toHaveLength(2)
    expect(offered[1]!.startsWith(WS_BEARER_PREFIX)).toBe(true)
    // Encoded, so the raw token is not readable in the header either.
    expect(offered[1]).not.toContain(TOKEN)
    expect(decodeBearerProtocol(offered[1]!)).toBe(TOKEN)
  })

  it('a Demo socket carries this page generation, not a newer tab storage value', async () => {
    vi.stubGlobal('window', { location: { protocol: 'http:', host: '127.0.0.1:3458', hostname: '127.0.0.1', port: '3458' } })
    vi.stubGlobal('sessionStorage', { getItem: () => 'first', clear: () => {}, setItem: () => {} })
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({ generation: 'first' })))
    stored['walnut.demo.generation'] = 'first'
    const { initDemoGeneration } = await import('@/utils/demo-generation')
    await initDemoGeneration()
    stored['walnut.demo.generation'] = 'second'
    const { url } = await connect()
    expect(url).toBe(`ws://127.0.0.1:3458/ws?demo-generation=first&lean=${LEAN_SIGNATURE}`)
  })

  it('a reset detected on socket close reloads before retrying its refused old generation', async () => {
    const reload = vi.fn()
    vi.stubGlobal('window', { location: { protocol: 'http:', host: '127.0.0.1:3458', hostname: '127.0.0.1', port: '3458', reload } })
    vi.stubGlobal('sessionStorage', { getItem: () => 'first', clear: () => {}, setItem: () => {} })
    const request = vi.fn(async () => Response.json({ generation: 'first' }))
    vi.stubGlobal('fetch', request)
    stored['walnut.demo.generation'] = 'first'
    const { initDemoGeneration } = await import('@/utils/demo-generation')
    await initDemoGeneration()
    const { wsClient } = await import('@/api/ws')
    wsClient.connect()
    request.mockResolvedValue(Response.json({ generation: 'second' }))
    const socket = (wsClient as unknown as { ws: { onclose: (event: { code: number; reason: string }) => void } }).ws
    socket.onclose({ code: 1006, reason: '' })
    await vi.waitFor(() => expect(reload).toHaveBeenCalledTimes(1))
    expect(opened).toHaveLength(1)
    wsClient.disconnect()
  })

  it('on the server\'s own machine (no token stored): a /ws with no credential and no subprotocol', async () => {
    const { url, argc } = await connect()
    // Only the lean-frames version rides the query (web/src/api/ws-lean.ts), never a credential.
    expect(url).toBe(`wss://walnut.example.net/ws?lean=${LEAN_SIGNATURE}`)
    expect(argc).toBe(1)
  })
})
