/**
 * Step 3 of a join waits for this machine's network key as long as the daemon may spend
 * downloading walnut-net. 2026-11-03: a PC's first daemon start spent 40 s on that
 * download, the join waited 30 s, and stopped with "the daemon did not answer
 * net.identity"; a second run, with walnut-net already there, joined at once.
 *
 * Real: the join's daemon call over a WebSocket. Stand-in: the daemon (a server that answers
 * `net.identity` late, as one still downloading does).
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AddressInfo } from 'node:net'
import { WebSocketServer } from 'ws'
import { NET_IDENTITY_WAIT_MS, netIdentity } from '../../src/commands/net.js'
import { FETCH_TIMEOUT_MS } from '../../src/providers/net-binary.js'

let server: WebSocketServer | null = null
afterEach(async () => {
  vi.restoreAllMocks()
  await new Promise<void>((r) => (server ? server.close(() => r()) : r()))
  server = null
})

/** A daemon that answers `net.identity` after `ms`. */
async function lateDaemon(ms: number): Promise<number> {
  server = new WebSocketServer({ port: 0, host: '127.0.0.1' })
  server.on('connection', (ws) => ws.on('message', (d) => {
    const m = JSON.parse(d.toString()) as { id: number; cmd: string }
    if (m.cmd === 'net.identity') setTimeout(() => ws.send(JSON.stringify({ id: m.id, ok: true, endpointId: 'a'.repeat(64) })), ms)
  }))
  await new Promise<void>((r) => server!.on('listening', () => r()))
  return (server.address() as AddressInfo).port
}

describe('the join waits for the network key', () => {
  it('longer than one walnut-net download may take', () => {
    // A daemon may spend the whole download limit before it answers: the join outlasts it.
    expect(NET_IDENTITY_WAIT_MS).toBeGreaterThan(FETCH_TIMEOUT_MS)
  })

  it('a late answer still joins, and the wait is said on screen', async () => {
    const out: string[] = []
    vi.spyOn(process.stdout, 'write').mockImplementation((s: string | Uint8Array) => { out.push(String(s)); return true })
    const port = await lateDaemon(400)
    const ident = await netIdentity({ port, slowMs: 50 })
    expect(ident).toMatchObject({ ok: true, endpointId: 'a'.repeat(64) })
    expect(out.join('')).toContain('3/3  Join .............. getting the network part ready (the first time only; it can take a minute)')
  })

  it('a quick answer prints no wait line', async () => {
    const out: string[] = []
    vi.spyOn(process.stdout, 'write').mockImplementation((s: string | Uint8Array) => { out.push(String(s)); return true })
    const port = await lateDaemon(0)
    await netIdentity({ port, slowMs: 2_000 })
    expect(out.join('')).toBe('')
  })
})
