/**
 * Remote witnesses are read by a running leader server, never by a command-line process: the server's
 * runtime reads them over its own links (GET /api/leader/witnesses), and the switch preflight and
 * `walnut leader status` ask it. With none running the reader says so. A world of three remote witnesses
 * on loopback doors, a real runtime and the real route.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import express from 'express'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import type { AddressInfo } from 'node:net'
import { blankEvidence, startWitnessMachine, loopbackCall, type WitnessMachine } from '../../../helpers/witness-machines.js'
import { DEFAULT_PERMIT_PARAMS } from '../../../../src/core/leader/permit/types.js'
import { startPermitRuntime, type PermitRuntime } from '../../../../src/core/leader/switch/runtime.js'
import { setOutwardDoorChecker } from '../../../../src/core/leader/switch/doors.js'
import { setUpRemoteWitness } from '../../../../src/core/leader/switch/witness-transport.js'
import { NoLeaderServerToRead, makeWitnessReader } from '../../../../src/core/leader/switch/witness-reader.js'
import type { LeaderSwitchSettings, RemoteWitnessPlace } from '../../../../src/core/leader/switch/settings.js'

let current: { runtime: PermitRuntime; machine: string; trial: boolean } | null = null
vi.mock('../../../../src/core/leader/switch/boot.js', () => ({ currentLeaderPermit: () => current }))

const WALNUT = 'walnut-test-1'
const LIST = ['w1', 'w2', 'w3']
const PLACES: RemoteWitnessPlace[] = LIST.map((id, i) => ({ id, host: `m${i + 1}` }))

let root = ''
let machines: WitnessMachine[] = []
let settings: LeaderSwitchSettings
let runtime: PermitRuntime | null = null
let server: http.Server | null = null
let base = ''

beforeEach(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'witness-reader-'))
  machines = await Promise.all(PLACES.map((p) => startWitnessMachine({ host: p.host, root: path.join(root, p.host), walnutId: WALNUT })))
  const call = loopbackCall(Object.fromEntries(machines.map((m) => [m.host, m])))
  for (const p of PLACES) await setUpRemoteWitness(p, LIST, WALNUT, blankEvidence(LIST, p.id), call)
  settings = {
    witnesses: PLACES,
    machines: ['machine-a', 'machine-b'].map((id, i) => ({ id, home: path.join(root, id, 'home'), standbyDir: path.join(root, id, 'standby'), port: 4900 + i })),
    backWindowHours: 24,
    // The default parameters: a witness machine serves with them (the settings never change them), and refuses a record of another validity.
    params: { ...DEFAULT_PERMIT_PARAMS },
  }
  fs.mkdirSync(settings.machines[0]!.home, { recursive: true })
  runtime = await startPermitRuntime({ home: settings.machines[0]!.home, holderId: 'machine-a', settings, trial: false, net: { remote: call, walnutId: WALNUT } })
  current = { runtime, machine: 'machine-a', trial: false }
  const { leaderSwitchRouter } = await import('../../../../src/web/routes/leader-switch.js')
  const app = express()
  app.use('/api/leader', leaderSwitchRouter)
  server = http.createServer(app)
  await new Promise<void>((r) => server!.listen(0, '127.0.0.1', () => r()))
  base = `http://127.0.0.1:${(server!.address() as AddressInfo).port}`
})
afterEach(async () => {
  await runtime?.stop()
  setOutwardDoorChecker(null)
  current = null
  await new Promise<void>((r) => (server ? server.close(() => r()) : r()))
  server?.closeAllConnections?.()
  await Promise.all(machines.map((m) => m.close()))
  fs.rmSync(root, { recursive: true, force: true })
})

const api = (method: string, urlPath: string) => fetch(`${base}${urlPath}`, { method }).then(async (r) => ({ status: r.status, json: await r.json().catch(() => null) as unknown }))

describe('reading remote witnesses through the running leader server', () => {
  it('the server leads on three remote witnesses and its route returns the record a majority holds', async () => {
    expect(runtime!.decision, JSON.stringify(runtime!.status())).toMatchObject({ kind: 'lead' })
    const r = await api('GET', '/api/leader/witnesses')
    expect(r.status).toBe(200)
    expect(r.json).toMatchObject({ ok: true, agreed: true, answered: 3, of: 3, standing: { holder: 'machine-a', by: 'machine-a' } })
  })

  it('the reader returns it, and the preflight rule (a majority answered, the old leader named) holds with one witness down', async () => {
    machines[2]!.setUp(false)
    const read = makeWitnessReader('machine-a-switch-reader', settings, () => [{ api }])
    const got = await read()
    expect(got.answered).toBe(2)
    expect(got.standing).toMatchObject({ holder: 'machine-a' })
  })

  it('with no server to ask it says so plainly, and does not read the witnesses itself', async () => {
    const read = makeWitnessReader('machine-a-switch-reader', settings, () => [])
    await expect(read()).rejects.toBeInstanceOf(NoLeaderServerToRead)
    await expect(read()).rejects.toThrow(/only a running leader server can read them: none is running here/)
    // A server that is down answers no differently.
    const dead = makeWitnessReader('x', settings, () => [{ api: () => Promise.reject(new Error('ECONNREFUSED')) }])
    await expect(dead()).rejects.toBeInstanceOf(NoLeaderServerToRead)
  })

  it('a trial start or no permit runtime answers 409: it cannot read remote witnesses', async () => {
    current = { ...current!, trial: true }
    expect((await api('GET', '/api/leader/witnesses')).status).toBe(409)
    current = null
    expect((await api('GET', '/api/leader/witnesses')).status).toBe(409)
  })

  it('all-local witnesses are read in this process, with no server at all', async () => {
    const local = { ...settings, witnesses: [{ id: 'w1', dir: path.join(root, 'nope') }, { id: 'w2', dir: path.join(root, 'nope2') }, { id: 'w3', dir: path.join(root, 'nope3') }] }
    const got = await makeWitnessReader('x', local, () => [])()
    expect(got.answered).toBe(0)
  })
})
