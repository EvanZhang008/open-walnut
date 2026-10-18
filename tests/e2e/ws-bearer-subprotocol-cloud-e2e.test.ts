/**
 * The cloud companion's /ws takes the device token from the SPA's subprotocol
 * (src/lib/ws-bearer-protocol.ts), through the real startServer in CLOUD_MODE.
 *
 * On the companion every browser comes through the box's reverse proxy, which
 * forwards Sec-WebSocket-Protocol as it came, so the server sees a loopback
 * socket and the browser's X-Forwarded-For. The `?token=` the daemons' bridge
 * client and older clients send stays accepted; a daemon's machine token still
 * never opens the browser RPC surface.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs/promises'
import type { Server as HttpServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { WebSocket } from 'ws'
import { createMockConstants } from '../helpers/mock-constants.js'

vi.mock('../../src/constants.js', () => createMockConstants('walnut-ws-bearer-cloud-e2e', { CLOUD_MODE: true }))

import { WALNUT_HOME } from '../../src/constants.js'
import { startServer, stopServer } from '../../src/web/server.js'
import { createDevice, _resetDeviceAuthForTesting } from '../../src/core/device-auth.js'
import { _resetAuthRateLimitForTesting } from '../../src/web/middleware/auth-rate-limit.js'
import { encodeBearerProtocol, wsProtocolsFor, WS_APP_PROTOCOL, WS_BEARER_PREFIX } from '../../src/lib/ws-bearer-protocol.js'

let server: HttpServer
let port = 0
let deviceToken = ''
let machineToken = ''

function open(protocols: string[] | undefined, path = '/ws'): Promise<{ status: number; protocol?: string }> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}${path}`, protocols, {
      origin: 'https://companion.example.net', headers: { 'X-Forwarded-For': '198.51.100.23' },
    })
    ws.once('open', () => { resolve({ status: 101, protocol: ws.protocol }); ws.close() })
    ws.once('unexpected-response', (_req, res) => { res.resume(); resolve({ status: res.statusCode ?? 0 }); ws.terminate() })
    ws.once('error', (err) => { if (ws.readyState !== WebSocket.OPEN) reject(err) })
  })
}

beforeAll(async () => {
  await fs.rm(WALNUT_HOME, { recursive: true, force: true })
  await fs.mkdir(WALNUT_HOME, { recursive: true })
  _resetDeviceAuthForTesting()
  server = await startServer({ port: 0, dev: true })
  port = (server.address() as AddressInfo).port
  deviceToken = (await createDevice('companion-browser')).token
  machineToken = (await createDevice('companion-daemon', { kind: 'machine' })).token
}, 120_000)

afterAll(async () => {
  await stopServer()
  await fs.rm(WALNUT_HOME, { recursive: true, force: true }).catch(() => {})
})

beforeEach(() => _resetAuthRateLimitForTesting())

describe('the companion\'s /ws and the bearer subprotocol', () => {
  it('the SPA\'s subprotocols get in, and the answer names walnut.v1, also with the bearer entry first', async () => {
    expect(await open(wsProtocolsFor(deviceToken))).toEqual({ status: 101, protocol: WS_APP_PROTOCOL })
    expect(await open([encodeBearerProtocol(deviceToken), WS_APP_PROTOCOL])).toEqual({ status: 101, protocol: WS_APP_PROTOCOL })
  })

  it('no credential, a wrong token, an unreadable entry, and a machine token are 401', async () => {
    expect((await open([WS_APP_PROTOCOL])).status).toBe(401)
    expect((await open(wsProtocolsFor('not-a-paired-token'))).status).toBe(401)
    expect((await open([WS_APP_PROTOCOL, `${WS_BEARER_PREFIX}QR`])).status).toBe(401)
    expect((await open(wsProtocolsFor(machineToken))).status).toBe(401)
  })

  it('the legacy ?token= still opens it', async () => {
    expect(await open(undefined, `/ws?token=${encodeURIComponent(deviceToken)}`)).toEqual({ status: 101, protocol: '' })
  })
})
