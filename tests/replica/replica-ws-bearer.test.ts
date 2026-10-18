/**
 * A host replica's own /ws (away mode, docs/plan/walnut-replica-servers-impl.md
 * D11) reads the device token from the SPA's `walnut.bearer.` subprotocol entry
 * (src/lib/ws-bearer-protocol.ts) and checks it against the device copy, the
 * same rule as its /api (src/replica/auth.ts). Every port of a replica is a
 * tunnel port, so loopback earns nothing here.
 *
 * The real handler (attachWss) on a real HTTP server, a real device copy in a
 * temp data dir, real `ws` clients.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { createServer, type Server as HttpServer } from 'node:http'
import { WebSocket } from 'ws'
import { createMockConstants } from '../helpers/mock-constants.js'
import { sha256 } from '../helpers/replica-host-env.js'

vi.mock('../../src/constants.js', () => createMockConstants('walnut-replica-ws-bearer'))

import { attachWss, closeWss } from '../../src/web/ws/handler.js'
import { _resetReplicaAuthForTesting, replicaDeviceCopy } from '../../src/replica/auth.js'
import { _resetServerRoleForTesting, isHostReplica } from '../../src/core/server-role.js'
import { _resetLoopbackTrustForTesting, refuseLoopbackTrust } from '../../src/web/middleware/local-trust.js'
import { _resetAuthRateLimitForTesting } from '../../src/web/middleware/auth-rate-limit.js'
import { encodeBearerProtocol, wsProtocolsFor, WS_APP_PROTOCOL, WS_BEARER_PREFIX } from '../../src/lib/ws-bearer-protocol.js'

const PHONE_TOKEN = 'marina-phone-token-' + 'b'.repeat(24)
const savedRole = { role: process.env.WALNUT_ROLE, placement: process.env.WALNUT_PLACEMENT }

let server: HttpServer
let port = 0

function open(protocols: string[] | undefined, path = '/ws'): Promise<{ status: number; protocol?: string }> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}${path}`, protocols)
    ws.once('open', () => { resolve({ status: 101, protocol: ws.protocol }); ws.close() })
    ws.once('unexpected-response', (_req, res) => { res.resume(); resolve({ status: res.statusCode ?? 0 }); ws.terminate() })
    ws.once('error', (err) => { if (ws.readyState !== WebSocket.OPEN) reject(err) })
  })
}

beforeAll(async () => {
  process.env.WALNUT_ROLE = 'replica'
  process.env.WALNUT_PLACEMENT = 'host'
  _resetServerRoleForTesting()
  refuseLoopbackTrust()
  server = createServer()
  attachWss(server)
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()))
  port = (server.address() as { port: number }).port
})

afterAll(async () => {
  closeWss()
  await new Promise<void>((r) => server.close(() => r()))
  for (const [k, v] of [['WALNUT_ROLE', savedRole.role], ['WALNUT_PLACEMENT', savedRole.placement]] as const) {
    if (v === undefined) delete process.env[k]
    else process.env[k] = v
  }
  _resetServerRoleForTesting()
  _resetLoopbackTrustForTesting()
})

beforeEach(() => {
  _resetAuthRateLimitForTesting()
  _resetReplicaAuthForTesting()
  expect(replicaDeviceCopy().put({ devices: [{ name: 'marina-phone', tokenHash: sha256(PHONE_TOKEN) }] })).toMatchObject({ ok: true })
})

describe('a host replica\'s own /ws and the bearer subprotocol', () => {
  it('is a host replica that trusts no loopback caller', async () => {
    expect(isHostReplica()).toBe(true)
    expect((await open(undefined)).status).toBe(401)
  })

  it('a phone in the device copy gets in with the SPA\'s subprotocols; the answer names walnut.v1, never the bearer entry', async () => {
    expect(await open(wsProtocolsFor(PHONE_TOKEN))).toEqual({ status: 101, protocol: WS_APP_PROTOCOL })
    expect(await open([encodeBearerProtocol(PHONE_TOKEN), WS_APP_PROTOCOL])).toEqual({ status: 101, protocol: WS_APP_PROTOCOL })
  })

  it('a token not in the copy and an unreadable entry are 401, and count into the replica\'s one bucket', async () => {
    expect((await open(wsProtocolsFor('not-in-the-copy'))).status).toBe(401)
    for (let i = 0; i < 9; i++) expect((await open([WS_APP_PROTOCOL, `${WS_BEARER_PREFIX}bad.${i}`])).status).toBe(401)
    expect((await open(wsProtocolsFor('another-guess'))).status).toBe(429)
    // The phone's good token always passes, whoever failed before it.
    expect((await open(wsProtocolsFor(PHONE_TOKEN))).status).toBe(101)
  })

  it('the legacy ?token= still opens it', async () => {
    expect(await open(undefined, `/ws?token=${PHONE_TOKEN}`)).toEqual({ status: 101, protocol: '' })
  })
})
