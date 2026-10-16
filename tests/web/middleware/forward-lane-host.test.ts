/**
 * The host a request came through, from its socket alone (src/lib/forward-lane-ports.ts,
 * src/web/middleware/op-id.ts forwardHostOf): a replica's stream that the daemon
 * connection splices into a loopback connection here (daemon-connection.ts
 * plugFollowerStream) is that connection's hostKey; a direct loopback client is this
 * server's own (LOCAL_HOST), whatever headers it sends; the registration ends when the
 * lane's socket closes.
 */
import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest'
import express from 'express'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { Duplex, PassThrough } from 'node:stream'
import { createMockConstants } from '../../helpers/mock-constants.js'

vi.mock('../../../src/constants.js', () => createMockConstants('walnut-forward-lane-host'))
const door = vi.hoisted(() => ({ port: 0 }))
vi.mock('../../../src/web/expose-runtime.js', () => ({ getExposeRuntime: () => ({ openPort: () => door.port }) }))

import { DaemonConnection } from '../../../src/providers/daemon-connection.js'
import { forwardHostOf } from '../../../src/web/middleware/op-id.js'
import { LOCAL_HOST } from '../../../src/core/offline-merge/ledger.js'
import { _forwardPortsForTesting } from '../../../src/lib/forward-lane-ports.js'

let server: http.Server

beforeAll(async () => {
  const app = express()
  app.all('/who', (req, res) => { res.json({ host: forwardHostOf(req) }) })
  server = http.createServer(app)
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()))
  door.port = (server.address() as AddressInfo).port
})

afterAll(async () => {
  server.closeAllConnections()
  await new Promise<void>((r) => server.close(() => r()))
})

/** One HTTP request written into a lane stream, as a replica's would arrive; the raw answer. */
async function throughLane(conn: DaemonConnection, headers: Record<string, string> = {}): Promise<string> {
  const toServer = new PassThrough()
  const fromServer = new PassThrough()
  const lane = Duplex.from({ readable: toServer, writable: fromServer })
  lane.on('error', () => undefined)
  let raw = ''
  fromServer.on('data', (c: Buffer) => { raw += c.toString('utf8') })
  await (conn as unknown as { plugFollowerStream(s: Duplex): Promise<void> }).plugFollowerStream(lane)
  const extra = Object.entries(headers).map(([k, v]) => `${k}: ${v}\r\n`).join('')
  toServer.write(`GET /who HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n${extra}\r\n`)
  const deadline = Date.now() + 5000
  while (!raw.includes('"host"') && Date.now() < deadline) await new Promise((r) => setTimeout(r, 10))
  lane.destroy()
  return raw
}

const hostIn = (raw: string): string => JSON.parse(raw.slice(raw.indexOf('{'))).host

describe('forward lane host tagging', () => {
  it('a request through plugFollowerStream is the connection\'s hostKey', async () => {
    const conn = new DaemonConnection('marina-box', { hostname: 'marina-box' } as never)
    expect(hostIn(await throughLane(conn))).toBe('marina-box')
    // Each connection names its own host.
    const other = new DaemonConnection('acme-box', { hostname: 'acme-box' } as never)
    expect(hostIn(await throughLane(other))).toBe('acme-box')
  })

  it('a direct loopback request stays LOCAL_HOST, and no header can set the host', async () => {
    const res = await fetch(`http://127.0.0.1:${door.port}/who`, {
      method: 'POST',
      headers: { 'x-walnut-forward-host': 'marina-box', 'x-walnut-host': 'marina-box', 'x-forwarded-for': '10.0.0.9', 'x-walnut-op-id': 'op-0123456789abcdef' },
    })
    expect((await res.json()).host).toBe(LOCAL_HOST)
  })

  it('the lane\'s port is forgotten once its socket closes', async () => {
    const conn = new DaemonConnection('marina-box', { hostname: 'marina-box' } as never)
    await throughLane(conn)
    const deadline = Date.now() + 5000
    while ([..._forwardPortsForTesting().values()].includes('marina-box') && Date.now() < deadline) await new Promise((r) => setTimeout(r, 10))
    expect([..._forwardPortsForTesting().values()]).not.toContain('marina-box')
  })
})
