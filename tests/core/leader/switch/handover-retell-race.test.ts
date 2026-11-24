/**
 * POST /api/leader/handover while its retell of the network is in flight: a take-back that lands then (a cancel by
 * hand, a short stop wait) must leave this machine leading WITH its daemon duties. The real route, the real switch
 * state (final-stop.ts) and the real order of the host steps (handover-host-steps.ts); the runtime, the copy link and
 * the host-follow steps themselves are stand-ins that record what they were asked. The retell holds until the test
 * lets it go, so the take-back lands inside it.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import express from 'express'
import http from 'node:http'
import type { AddressInfo } from 'node:net'

const calls: string[] = []
let state = 'leading'
const runtime = {
  handover: async (to: string) => { calls.push(`handover ${to}`); state = 'handed-over'; return { ok: true, record: { number: 7 } } },
  cancel: async () => { calls.push('cancel stood'); state = 'leading'; return { ok: true } },
  status: () => ({ state }),
}
let permit: { runtime: typeof runtime; machine: string; trial: boolean } | null = null
const peer = {
  kind: 'daemon' as const, host: 'machine-b', ready: async () => null, close: () => { calls.push('peer close') }, hold: async () => {}, unhold: () => {},
  writeFile: async () => { calls.push('ticket') }, startTargetJob: async () => { calls.push('target job'); return { ok: true } },
}
const settings = {
  witnesses: [], backWindowHours: 24, commitWindowMs: 120_000, stopWaitMs: 120_000,
  machines: [
    { id: 'machine-a', home: '/a/home', standbyDir: '/a/standby', port: 1, hostKey: 'machine-a' },
    { id: 'machine-b', home: '/b/home', standbyDir: '/b/standby', port: 2, hostKey: 'machine-b', doors: ['wss://machine-b.example.test/host-door'] },
  ],
}

vi.mock('../../../../src/core/leader/switch/boot.js', () => ({ currentLeaderPermit: () => permit }))
vi.mock('../../../../src/web/server.js', () => ({
  listeningAddress: () => null, onPlainStop: () => {}, switchStopAvailable: () => true,
  requestSwitchStop: () => { calls.push('switch stop requested'); return true },
}))
vi.mock('../../../../src/core/config-manager.js', () => ({ getConfig: async () => ({ standby: { dir: '/b/standby', host: 'machine-b' }, hosts: { 'machine-b': {} } }) }))
vi.mock('../../../../src/core/hosts/fleet.js', () => ({ getFleetHost: async () => null }))
vi.mock('../../../../src/core/home-move.js', () => ({ homeOnHosts: async () => null }))
vi.mock('../../../../src/core/leader/switch/before-handover.js', () => ({ beforeHandover: async () => ({ ok: true }) }))
vi.mock('../../../../src/core/leader/switch/console-credential.js', () => ({ withdrawConsole: async () => ({ files: [] }) }))
vi.mock('../../../../src/core/leader/switch/witness-transport.js', () => ({ thisWalnutId: async () => 'walnut-1' }))
vi.mock('../../../../src/core/leader/switch/peer.js', () => ({ peerFor: async () => peer }))
vi.mock('../../../../src/core/leader/switch/settings.js', async (orig) => ({ ...(await orig<object>()), readHomeSwitchConfig: () => ({ settings }) }))
vi.mock('../../../../src/core/leader/switch/final-stop.js', async (orig) => ({ ...(await orig<object>()), beginRefusal: () => null }))

/** The retell: held until `letRetellGo`, then it answers ok (every net host took the lists). */
let letRetellGo: () => void = () => {}
function holdRetell(): void {
  const held = new Promise<void>((r) => { letRetellGo = r })
  steps.retellNetMembers = async () => { calls.push('retell begins'); await held; calls.push('retell ends'); return { ok: true } }
}
const step = (name: string) => async () => { calls.push(name); return { ok: true as const } }
const steps = {
  prepareOldMachineAsHost: step('prepare'), pushNewLeaderDoors: step('push'), configureOldMachineHostService: step('configure'),
  announceSwitchStop: step('announce'), retellNetMembers: step('retell'), dropOwnDaemonDuties: step('drop duties'), undoHandoverHostSteps: step('undo host steps'),
}

let server: http.Server | null = null
let base = ''
beforeEach(async () => {
  calls.length = 0
  state = 'leading'
  settings.stopWaitMs = 120_000
  permit = { runtime, machine: 'machine-a', trial: false }
  ;(await import('../../../../src/core/leader/switch/final-stop.js')).forgetHandedOver()
  ;(await import('../../../../src/core/leader/switch/handover-host-steps.js')).setHandoverHostSteps(steps)
  const { leaderSwitchRouter } = await import('../../../../src/web/routes/leader-switch.js')
  const app = express()
  app.use(express.json())
  app.use('/api/leader', leaderSwitchRouter)
  server = http.createServer(app)
  await new Promise<void>((r) => server!.listen(0, '127.0.0.1', () => r()))
  base = `http://127.0.0.1:${(server!.address() as AddressInfo).port}`
})
afterEach(async () => {
  letRetellGo()
  ;(await import('../../../../src/core/leader/switch/final-stop.js')).forgetHandedOver()
  ;(await import('../../../../src/core/leader/switch/handover-host-steps.js')).setHandoverHostSteps(null)
  await new Promise<void>((r) => (server ? server.close(() => r()) : r()))
})

const post = (path: string, body: unknown = {}) => fetch(`${base}/api/leader${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
  .then(async (r) => ({ status: r.status, json: await r.json() as { ok: boolean; why?: string } }))
const until = async (what: string, fn: () => boolean, ms: number) => {
  for (const end = Date.now() + ms; Date.now() < end;) { if (fn()) return; await new Promise((r) => setTimeout(r, 20)) }
  throw new Error(`timed out waiting for ${what}: ${calls.join(', ')}`)
}

describe('a take-back that lands while the handover\'s retell is in flight', () => {
  it('a cancel by hand: the duties are never dropped, and the undo runs only after the retell ended', async () => {
    holdRetell()
    const handing = post('/handover', { to: 'machine-b', switchId: '20261124T000000-ffffff' })
    await until('the retell to begin', () => calls.includes('retell begins'), 5_000)
    const cancelling = post('/cancel')
    // The cancel stood at once; its undo waits for the retell in flight.
    await until('the cancel', () => calls.includes('cancel stood'), 5_000)
    await new Promise((r) => setTimeout(r, 200))
    expect(calls).not.toContain('undo host steps')
    letRetellGo()
    const [h, c] = await Promise.all([handing, cancelling])
    expect(c.json.ok).toBe(true)
    expect(h.status).toBe(409)
    expect(h.json.why).toMatch(/taken back while the hosts were told/)
    expect(calls).not.toContain('drop duties')
    expect(calls.indexOf('undo host steps')).toBeGreaterThan(calls.indexOf('retell ends'))
    expect(calls).not.toContain('target job')
    const { wasTakenBack } = await import('../../../../src/core/leader/switch/final-stop.js')
    expect(wasTakenBack('20261124T000000-ffffff')).toBe(true)
  })

  it('a short stop wait (stop_wait_s at its 10 s floor, here 300 ms) does not run out during the retell: it counts from the retell\'s end', async () => {
    settings.stopWaitMs = 300
    holdRetell()
    const handing = post('/handover', { to: 'machine-b', switchId: '20261124T000000-gggggg' })
    await until('the retell to begin', () => calls.includes('retell begins'), 5_000)
    // Past the stop wait alone: nothing was taken back.
    await new Promise((r) => setTimeout(r, 800))
    expect(calls).not.toContain('cancel stood')
    letRetellGo()
    const h = await handing
    expect(h.status).toBe(200)
    expect(calls.filter((x) => ['retell ends', 'drop duties', 'ticket', 'target job'].includes(x))).toEqual(['retell ends', 'drop duties', 'ticket', 'target job'])
    expect(calls).not.toContain('undo host steps')
  })
})
