/**
 * The real upgrade handler (src/web/ws/handler.ts) and the leader door (src/core/leader-doors.ts) on
 * a real server: with the experiment host_runs_sessions off (its default) `/host-door` never
 * upgrades and nothing answers a hello; turned on, the same server's door opens and answers a
 * hello for a machine it keeps no credential for with unknown_credential (4004); turned off again,
 * it is shut again.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import net, { type AddressInfo } from 'node:net'
import crypto from 'node:crypto'
import { WebSocket } from 'ws'
import { createMockConstants } from '../helpers/mock-constants.js'

vi.mock('../../src/constants.js', () => createMockConstants('walnut-host-door-off'))

import { startServer, stopServer } from '../../src/web/server.js'
import { getInstanceId } from '../../src/core/device-auth.js'
import { openLeaderDoor } from '../../src/core/leader-doors.js'

let port = 0

beforeAll(async () => {
  const server = await startServer({ port: 0, dev: true })
  port = (server.address() as AddressInfo).port
}, 60_000)
afterAll(async () => { await stopServer() }, 30_000)

/** Ask for the /host-door upgrade by hand: did the server answer 101? (A shut door destroys the socket.) */
async function upgrades(): Promise<boolean> {
  const sock = net.connect(port, '127.0.0.1')
  sock.on('error', () => {})
  let got = ''
  sock.on('data', (b: Buffer) => { got += b.toString('latin1') })
  await new Promise<void>((r) => sock.on('connect', () => r()))
  sock.write(`GET /host-door HTTP/1.1\r\nHost: 127.0.0.1\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: ${crypto.randomBytes(16).toString('base64')}\r\nSec-WebSocket-Version: 13\r\n\r\n`)
  await vi.waitFor(() => expect(got.includes('\r\n\r\n') || sock.destroyed).toBe(true), { timeout: 10_000 })
  sock.destroy()
  return got.startsWith('HTTP/1.1 101')
}

/** A hello on an opened door: the close code it got. */
async function helloCode(): Promise<number> {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/host-door`)
  ws.on('error', () => {})
  const walnutId = await getInstanceId()
  await new Promise<void>((r) => ws.on('open', () => r()))
  ws.send(JSON.stringify({ ch: 'door', op: 'hello', v: 2, walnutId, machineId: 'f0'.repeat(16), nonce: 'ab'.repeat(32) }))
  return new Promise((r) => ws.on('close', (code) => r(code)))
}

async function setExperiment(on: boolean): Promise<void> {
  const r = await fetch(`http://127.0.0.1:${port}/api/config`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ experimental: { host_runs_sessions: on } }) })
  expect(r.status).toBe(200)
}

describe('/host-door on a real server', () => {
  it('with the experiment off, never upgrades', async () => {
    expect(openLeaderDoor('/host-door')).toBeNull()
    expect(await upgrades()).toBe(false)
  })

  it('turned on, opens and tells a machine it keeps no credential for 4004; turned off, shuts again', async () => {
    await setExperiment(true)
    await vi.waitFor(() => expect(openLeaderDoor('/host-door')).not.toBeNull(), { timeout: 20_000 })
    expect(await upgrades()).toBe(true)
    expect(await helloCode()).toBe(4004)
    await setExperiment(false)
    await vi.waitFor(() => expect(openLeaderDoor('/host-door')).toBeNull(), { timeout: 20_000 })
    expect(await upgrades()).toBe(false)
  }, 60_000)
})
