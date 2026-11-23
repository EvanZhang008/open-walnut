/**
 * With the experiment `switchable_leader` off, a host's service answers every witness path with
 * the 404 it always gave, and loads nothing of the permit or the switch to do it. (Its own file:
 * a module loaded by an earlier test would hide the proof.)
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { duplexPair } from 'node:stream'
import { createLeaderDoor, type LeaderDoor } from '../../../../src/replica/leader-door.js'
import { requestOver } from '../../../../src/core/host-server/request-over.js'
import type { DeviceCopy } from '../../../../src/host-server/device-copy.js'
import { WITNESS_REQUEST_PATH, WITNESS_SETUP_PATH } from '../../../../src/core/leader/switch/witness-wire.js'

const loaded: string[] = []
vi.mock('../../../../src/core/leader/switch/witness-route.js', async (importActual) => {
  loaded.push('witness-route')
  return await importActual()
})
vi.mock('../../../../src/core/leader/switch/machine-id.js', async (importActual) => {
  loaded.push('machine-id')
  return await importActual()
})
vi.mock('../../../../src/core/leader/switch/local-witnesses.js', async (importActual) => {
  loaded.push('local-witnesses')
  return await importActual()
})

const WALNUT = 'walnut-test-1'
let root = ''
let door: LeaderDoor
let enabled = false
let configThrows = false

/** One request to the door over an in-memory stream pair (no port: the quick tier opens none). */
const post = async (p: string, body: unknown): Promise<{ status: number; body: unknown }> => {
  const [client, server] = duplexPair()
  door.accept(server)
  const res = await requestOver(client, 'POST', p, Buffer.from(JSON.stringify(body)), 5_000)
  const out = { status: res.status, body: await res.json().catch(() => null) as unknown }
  client.destroy()
  return out
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'witness-off-'))
  enabled = false
  configThrows = false
  door = createLeaderDoor({
    devices: { put: async () => ({}) } as unknown as DeviceCopy,
    witness: { enabled: async () => { if (configThrows) throw new Error('config unreadable'); return enabled }, walnutId: () => WALNUT, root: () => root },
  })
})
afterEach(async () => {
  await door.close()
  fs.rmSync(root, { recursive: true, force: true })
})

describe('a host service with the experiment off', () => {
  it('answers 404 not_found like a path it never had, loads nothing, writes nothing; on, it loads the route', async () => {
    const read = await post(WITNESS_REQUEST_PATH, { v: 1, walnutId: WALNUT, witness: 'w1', request: { type: 'read' } })
    const setup = await post(WITNESS_SETUP_PATH, { v: 1, walnutId: WALNUT, witness: 'w1', list: ['w1', 'w2', 'w3'], evidence: [] })
    const never = await post('/host-api/never-had-this', {})
    expect(never).toEqual({ status: 404, body: { ok: false, error: 'not_found' } })
    expect(read).toEqual(never)
    expect(setup).toEqual(never)
    expect(loaded).toEqual([])
    expect(fs.readdirSync(root)).toEqual([])
    // Flag on: the same call reaches the route, which is loaded now. Never set up, it answers with the very bytes
    // of a path the service never had.
    enabled = true
    const on = await post(WITNESS_REQUEST_PATH, { v: 1, walnutId: WALNUT, witness: 'w1', request: { type: 'read' } })
    expect(on).toEqual(never)
    expect(loaded).toContain('witness-route')
  })

  it('a config that cannot be read counts as off: 404, never a 500', async () => {
    configThrows = true
    const r = await post(WITNESS_REQUEST_PATH, { v: 1, walnutId: WALNUT, witness: 'w1', request: { type: 'read' } })
    expect(r).toEqual({ status: 404, body: { ok: false, error: 'not_found' } })
  })
})
