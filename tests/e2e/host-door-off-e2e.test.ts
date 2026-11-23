/**
 * The real upgrade handler (src/web/ws/handler.ts) and the leader door (src/core/leader-doors.ts) on
 * a real server: with the experiment host_runs_sessions off (its default) `/host-door` never
 * upgrades and nothing answers a hello; turned on, the same server's door opens and answers a
 * hello for a machine it keeps no credential for with unknown_credential (4004); turned off again,
 * it is shut again.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import type { AddressInfo } from 'node:net'
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

/** Dial /host-door with a hello: 'refused' (no upgrade), or the first frame / close code after it. */
async function dial(): Promise<{ upgraded: boolean; code?: number; frame?: unknown }> {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/host-door`)
  const walnutId = await getInstanceId()
  return new Promise((resolve) => {
    let upgraded = false
    ws.on('open', () => {
      upgraded = true
      ws.send(JSON.stringify({ ch: 'door', op: 'hello', v: 2, walnutId, machineId: 'f0'.repeat(16), nonce: 'ab'.repeat(32) }))
    })
    ws.on('message', (m) => { resolve({ upgraded, frame: JSON.parse(String(m)) }); ws.close() })
    ws.on('unexpected-response', () => resolve({ upgraded: false }))
    ws.on('error', () => resolve({ upgraded }))
    ws.on('close', (code) => resolve({ upgraded, code }))
  })
}

async function setExperiment(on: boolean): Promise<void> {
  const r = await fetch(`http://127.0.0.1:${port}/api/config`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ experimental: { host_runs_sessions: on } }) })
  expect(r.status).toBe(200)
}

describe('/host-door on a real server', () => {
  it('with the experiment off, never upgrades', async () => {
    expect(openLeaderDoor('/host-door')).toBeNull()
    expect(await dial()).toEqual({ upgraded: false })
  })

  it('turned on, opens and tells a machine it keeps no credential for 4004; turned off, shuts again', async () => {
    await setExperiment(true)
    await vi.waitFor(() => expect(openLeaderDoor('/host-door')).not.toBeNull(), { timeout: 20_000 })
    expect(await dial()).toEqual({ upgraded: true, code: 4004 })
    await setExperiment(false)
    await vi.waitFor(() => expect(openLeaderDoor('/host-door')).toBeNull(), { timeout: 20_000 })
    expect(await dial()).toEqual({ upgraded: false })
  }, 60_000)
})
