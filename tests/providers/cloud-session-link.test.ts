import http from 'node:http'
import { WebSocket, WebSocketServer } from 'ws'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { CloudSessionLink } from '../../src/providers/cloud-session-link.js'

const h = vi.hoisted(() => ({ endpoint: vi.fn(), recover: vi.fn() }))
vi.mock('../../src/core/cloud-ingest.js', () => ({ cloudSessionEndpoint: h.endpoint, recoverCloudSessionCredential: h.recover }))

let server: http.Server | undefined
let wss: WebSocketServer | undefined
let link: CloudSessionLink | undefined
const seen: string[] = []

async function fixture(attached: Record<string, unknown> = { ok: true, alive: true, pid: 123, currentOffset: 100 }): Promise<WebSocket[]> {
  const sockets: WebSocket[] = []
  server = http.createServer()
  wss = new WebSocketServer({ server })
  wss.on('connection', (socket, request) => {
    seen.push(request.url ?? '')
    expect(request.headers.authorization).toBe('Bearer machine-test-token')
    sockets.push(socket)
    socket.send(JSON.stringify({ ev: 'jsonl', sid: 'session-a', line: '{"type":"result"}', v: 120 }))
    socket.send(JSON.stringify({ ev: 'jsonl', sid: 'other-session', line: 'unrelated', v: 900 }))
    socket.send(JSON.stringify({ ev: 'attached', ...attached }))
  })
  await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve))
  const port = (server.address() as { port: number }).port
  h.endpoint.mockResolvedValue({ url: `http://127.0.0.1:${port}/bridge`, token: 'machine-test-token' })
  return sockets
}

afterEach(async () => {
  link?.close()
  for (const socket of wss?.clients ?? []) socket.terminate()
  if (wss) await new Promise<void>((resolve) => wss!.close(() => resolve()))
  if (server) await new Promise<void>((resolve) => server!.close(() => resolve()))
  link = undefined; wss = undefined; server = undefined; seen.length = 0
  vi.useRealTimers()
  h.endpoint.mockReset(); h.recover.mockReset()
})

describe('the read-only cloud session link', () => {
  it('preserves the daemon catch-up before attachment and filters other sessions', async () => {
    await fixture()
    const events: unknown[] = []
    link = new CloudSessionLink('dev.box', 'session-a', () => 80, (event) => events.push(event))
    const reply = await link.connect()
    expect(reply).toMatchObject({ alive: true, pid: 123, currentOffset: 100 })
    expect(link.connected).toBe(true)
    expect(events).toEqual([
      { ev: 'jsonl', sid: 'session-a', line: '{"type":"result"}', v: 120 },
      { ev: 'attached', ok: true, alive: true, pid: 123, currentOffset: 100 },
    ])
    expect(seen[0]).toBe('/bridge/session-stream?host=dev.box&sessionId=session-a&fromOffset=80')
    expect(await link.connect()).toEqual(reply)
    expect(seen).toHaveLength(1)
  })

  it('does not manufacture liveness from a second call to an attached dead session', async () => {
    await fixture({ ok: true, alive: false, state: 'dead', pid: null })
    link = new CloudSessionLink('devbox', 'session-a', () => 80, () => {})
    expect(await link.connect()).toMatchObject({ alive: false, state: 'dead' })
    expect(await link.connect()).toMatchObject({ alive: false, state: 'dead' })
  })

  it('a closed owner cannot revive a late endpoint lookup', async () => {
    let resolve!: (value: unknown) => void
    h.endpoint.mockImplementation(() => new Promise((r) => { resolve = r }))
    link = new CloudSessionLink('devbox', 'session-a', () => 80, () => { throw new Error('closed owner received an event') })
    const opening = link.connect()
    const rejected = expect(opening).rejects.toMatchObject({ name: 'SendHeldError' })
    await vi.waitFor(() => expect(h.endpoint).toHaveBeenCalled())
    link.close()
    resolve({ url: 'http://127.0.0.1:9/bridge', token: 'unused' })
    await rejected
    expect(link.connected).toBe(false)
  })

  it('retries a missing endpoint without requiring another user send', async () => {
    await fixture()
    const endpoint = await h.endpoint()
    h.endpoint.mockResolvedValueOnce(null).mockResolvedValue(endpoint)
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    link = new CloudSessionLink('devbox', 'session-a', () => 80, () => {})
    await expect(link.connect()).rejects.toMatchObject({ name: 'SendHeldError' })
    await vi.advanceTimersByTimeAsync(5_000)
    await vi.waitFor(() => expect(link!.connected).toBe(true))
    expect(seen).toHaveLength(1)
  })

  it('limits stale-credential handshakes and reads the recovered token after waiting', async () => {
    const links: CloudSessionLink[] = []
    const headers: string[] = []
    server = http.createServer()
    wss = new WebSocketServer({ noServer: true })
    server.on('upgrade', (request, socket, head) => {
      const authorization = request.headers.authorization ?? ''
      headers.push(authorization)
      if (authorization === 'Bearer stale-link-token') {
        socket.end('HTTP/1.1 401 Unauthorized\r\nContent-Length: 0\r\nConnection: close\r\n\r\n')
        return
      }
      wss!.handleUpgrade(request, socket, head, (ws) => {
        ws.send(JSON.stringify({ ev: 'attached', ok: true, alive: true, currentOffset: 0 }))
      })
    })
    await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve))
    const url = `http://127.0.0.1:${(server.address() as { port: number }).port}/bridge`
    let token = 'stale-link-token'
    let recovery: Promise<void> | undefined
    h.recover.mockImplementation(() => recovery ??= new Promise<void>((resolve) => {
      setTimeout(() => { token = 'recovered-link-token'; resolve() }, 50)
    }))
    h.endpoint.mockImplementation(async () => { await recovery; return { url, token } })
    try {
      for (let i = 0; i < 12; i++) links.push(new CloudSessionLink('devbox', `session-${i}`, () => 0, () => {}))
      const outcomes = await Promise.allSettled(links.map((item) => item.connect()))
      const stale = headers.filter((value) => value === 'Bearer stale-link-token').length
      expect(stale).toBeGreaterThan(0)
      expect(stale).toBeLessThanOrEqual(2)
      expect(outcomes.filter((outcome) => outcome.status === 'fulfilled')).toHaveLength(12 - stale)
      expect(headers.filter((value) => value === 'Bearer recovered-link-token')).toHaveLength(12 - stale)
    } finally { links.forEach((item) => item.close()) }
  })

  it('holds a refused token without repeating authentication failures while recovery has no replacement', async () => {
    server = http.createServer()
    const refusals = vi.fn()
    server.on('upgrade', (_request, socket) => {
      refusals()
      socket.end('HTTP/1.1 401 Unauthorized\r\nContent-Length: 0\r\nConnection: close\r\n\r\n')
    })
    await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve))
    h.endpoint.mockResolvedValue({ url: `http://127.0.0.1:${(server.address() as { port: number }).port}/bridge`, token: 'refused-link-token' })
    h.recover.mockResolvedValue(undefined)
    link = new CloudSessionLink('devbox', 'session-a', () => 0, () => {})
    await expect(link.connect()).rejects.toMatchObject({ name: 'SendHeldError' })
    for (let i = 0; i < 12; i++) await expect(link.connect()).rejects.toMatchObject({ name: 'SendHeldError' })
    expect(refusals).toHaveBeenCalledTimes(1)
  })

  it('reconnects from the current owner cursor without sending any daemon command', async () => {
    const sockets = await fixture()
    let offset = 80
    link = new CloudSessionLink('devbox', 'session-a', () => offset, (event) => {
      if (event.ev === 'jsonl' && typeof event.v === 'number') offset = event.v
    })
    await link.connect()
    const data = vi.fn()
    sockets[0].on('message', data)
    sockets[0].close()
    await vi.waitFor(() => expect(link!.connected).toBe(false))
    await link.connect()
    expect(seen).toHaveLength(2)
    expect(seen[1]).toContain('fromOffset=120')
    expect(data).not.toHaveBeenCalled()
  })
})
