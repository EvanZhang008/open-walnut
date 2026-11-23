/**
 * With the experiment `switchable_leader` off, a host's service answers every witness path with
 * the 404 it always gave, and loads nothing of the permit or the switch to do it. (Its own file:
 * a module loaded by an earlier test would hide the proof.)
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { startWitnessMachine, loopbackCall, type WitnessMachine } from '../../../helpers/witness-machines.js'
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
let m: WitnessMachine

const post = (p: string, body: unknown) => new Promise<{ status: number; body: unknown } | null>((resolve) => {
  loopbackCall({ m1: m })({ id: 'x', host: 'm1' }, p, body as never, resolve)
})

beforeEach(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'witness-off-'))
  m = await startWitnessMachine({ host: 'm1', root, walnutId: WALNUT, enabled: false })
})
afterEach(async () => {
  await m.close()
  fs.rmSync(root, { recursive: true, force: true })
})

describe('a host service with the experiment off', () => {
  it('answers 404 not_found like a path it never had, loads nothing, writes nothing; on, it loads the route', async () => {
    const read = await post(WITNESS_REQUEST_PATH, { v: 1, walnutId: WALNUT, witness: 'w1', request: { type: 'read' } })
    const setup = await post(WITNESS_SETUP_PATH, { v: 1, walnutId: WALNUT, witness: 'w1', list: ['w1', 'w2', 'w3'] })
    const never = await post('/host-api/never-had-this', {})
    expect(never).toEqual({ status: 404, body: { ok: false, error: 'not_found' } })
    expect(read).toEqual(never)
    expect(setup).toEqual(never)
    expect(loaded).toEqual([])
    expect(fs.readdirSync(root)).toEqual([])
    // Flag on: the same call is served, and now the route is loaded.
    m.enabled = true
    const on = await post(WITNESS_REQUEST_PATH, { v: 1, walnutId: WALNUT, witness: 'w1', request: { type: 'read' } })
    expect(on?.status).toBe(404) // enabled but never set up: still no witness
    expect((on!.body as { error: string }).error).toBe('not_a_witness')
    expect(loaded).toContain('witness-route')
  })
})
