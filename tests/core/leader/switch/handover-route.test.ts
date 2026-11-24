/**
 * POST /api/leader/handover when the network's hosts are not all told after the handover record (the retell wait
 * runs out): the route takes the handover back through the noted switch, so the take-back takes the host steps back
 * once it stands, is tried again every 5 s while it does not, and marks the switch taken back (a handover again under
 * that id is refused). The real route and the real switch state (final-stop.ts); the runtime, the copy link and the
 * host steps are stand-ins that record what they were asked. Also the switch stop: a copy link that cannot be
 * held makes this server not stop at all (the switch waits for its stop again).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import express from 'express'
import http from 'node:http'
import type { AddressInfo } from 'node:net'

const calls: string[] = []
let cancels: Array<{ ok: boolean; why?: string }> = []
let state = 'leading'
const runtime = {
  handover: async (to: string) => { calls.push(`handover ${to}`); state = 'handed-over'; return { ok: true, record: { number: 7 } } },
  cancel: async () => {
    const r = cancels.shift() ?? { ok: true }
    calls.push(`cancel ${r.ok ? 'stood' : 'short'}`)
    if (r.ok) state = 'leading'
    return r
  },
  status: () => ({ state }),
}
let permit: { runtime: typeof runtime; machine: string; trial: boolean } | null = null
const peer = { kind: 'daemon' as const, ready: async () => null, close: () => { calls.push('peer close') }, hold: async () => {}, unhold: () => {} }
const settings = {
  witnesses: [], backWindowHours: 24, commitWindowMs: 120_000, stopWaitMs: 120_000,
  machines: [
    { id: 'machine-a', home: '/a/home', standbyDir: '/a/standby', port: 1, hostKey: 'machine-a' },
    { id: 'machine-b', home: '/b/home', standbyDir: '/b/standby', port: 2, hostKey: 'machine-b' },
  ],
}

vi.mock('../../../../src/core/leader/switch/boot.js', () => ({ currentLeaderPermit: () => permit }))
vi.mock('../../../../src/web/server.js', () => ({
  listeningAddress: () => null, onPlainStop: () => {}, switchStopAvailable: () => true,
  requestSwitchStop: () => { calls.push('switch stop requested'); return true },
}))
vi.mock('../../../../src/core/config-manager.js', () => ({ getConfig: async () => ({ standby: { dir: '/b/standby', host: 'machine-b' }, hosts: { 'machine-b': {} } }) }))
vi.mock('../../../../src/core/hosts/fleet.js', () => ({ getFleetHost: async () => null }))
vi.mock('../../../../src/core/leader/switch/before-handover.js', () => ({ beforeHandover: async () => ({ ok: true }) }))
vi.mock('../../../../src/core/leader/switch/console-credential.js', () => ({ withdrawConsole: async () => { calls.push('console withdrawn'); return { files: [] } } }))
vi.mock('../../../../src/core/leader/switch/witness-transport.js', () => ({ thisWalnutId: async () => 'walnut-1' }))
vi.mock('../../../../src/core/leader/switch/peer.js', () => ({ peerFor: async () => peer }))
vi.mock('../../../../src/core/leader/switch/settings.js', async (orig) => ({ ...(await orig<object>()), readHomeSwitchConfig: () => ({ settings }) }))
vi.mock('../../../../src/core/leader/switch/final-stop.js', async (orig) => ({ ...(await orig<object>()), beginRefusal: () => null }))
vi.mock('../../../../src/core/leader/switch/handover-host-steps.js', () => ({
  beforeHandoverRecord: async () => { calls.push('host steps before'); return { ok: true } },
  afterHandoverRecord: async () => { calls.push('retell'); return { ok: false, why: 'retellNetMembers: not told: box-net-only' } },
  undoHostSteps: async () => { calls.push('host steps undone') },
}))

let server: http.Server | null = null
let base = ''
beforeEach(async () => {
  calls.length = 0
  state = 'leading'
  permit = { runtime, machine: 'machine-a', trial: false }
  ;(await import('../../../../src/core/leader/switch/final-stop.js')).forgetHandedOver()
  const { leaderSwitchRouter } = await import('../../../../src/web/routes/leader-switch.js')
  const app = express()
  app.use(express.json())
  app.use('/api/leader', leaderSwitchRouter)
  server = http.createServer(app)
  await new Promise<void>((r) => server!.listen(0, '127.0.0.1', () => r()))
  base = `http://127.0.0.1:${(server!.address() as AddressInfo).port}`
})
afterEach(async () => {
  ;(await import('../../../../src/core/leader/switch/final-stop.js')).forgetHandedOver()
  await new Promise<void>((r) => (server ? server.close(() => r()) : r()))
})

const handover = (switchId: string) => fetch(`${base}/api/leader/handover`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ to: 'machine-b', switchId }) })
  .then(async (r) => ({ status: r.status, json: await r.json() as { ok: boolean; why?: string } }))
const until = async (what: string, fn: () => boolean, ms: number) => {
  for (const end = Date.now() + ms; Date.now() < end;) { if (fn()) return; await new Promise((r) => setTimeout(r, 100)) }
  throw new Error(`timed out waiting for ${what}: ${calls.join(', ')}`)
}

describe('a handover whose retell of the network did not stand', () => {
  it('is taken back: the host steps are undone once the cancel stands, and the switch id is marked taken back', async () => {
    cancels = [{ ok: true }]
    const r = await handover('20261124T000000-aaaaaa')
    expect(r.status).toBe(409)
    expect(r.json.why).toMatch(/^the handover is taken back: retellNetMembers: not told: box-net-only/)
    expect(calls).toEqual(['host steps before', 'handover machine-b', 'retell', 'cancel stood', 'peer close', 'console withdrawn', 'host steps undone'])
    const { handedOverSwitch, wasTakenBack } = await import('../../../../src/core/leader/switch/final-stop.js')
    expect(handedOverSwitch()).toBeNull()
    expect(wasTakenBack('20261124T000000-aaaaaa')).toBe(true)
    // The same switch again: refused (its target side holds the first handover's number).
    const again = await handover('20261124T000000-aaaaaa')
    expect(again.status).toBe(409)
    expect(again.json.why).toMatch(/took the handover of switch 20261124T000000-aaaaaa back/)
  })

  it('a cancel that does not stand is tried again 5 s later, and the host steps are undone only once one stands', async () => {
    cancels = [{ ok: false, why: 'the cancel record did not reach a majority of the witnesses' }, { ok: true }]
    const r = await handover('20261124T000000-bbbbbb')
    expect(r.status).toBe(409)
    expect(r.json.why).toMatch(/could not be taken back yet, it is tried again every 5 s/)
    expect(calls).not.toContain('host steps undone')
    const { handedOverSwitch, wasTakenBack } = await import('../../../../src/core/leader/switch/final-stop.js')
    expect(handedOverSwitch()?.phase).toBe('waiting')
    await until('the second cancel', () => calls.includes('host steps undone'), 12_000)
    expect(calls.filter((c) => c.startsWith('cancel'))).toEqual(['cancel short', 'cancel stood'])
    expect(handedOverSwitch()).toBeNull()
    expect(wasTakenBack('20261124T000000-bbbbbb')).toBe(true)
  }, 20_000)
})

describe('the switch stop when the copy link cannot be held', () => {
  it('does not stop the server: the stop is abandoned and the switch waits for its stop again', async () => {
    const { noteHandedOver, handedOverSwitch } = await import('../../../../src/core/leader/switch/final-stop.js')
    state = 'handed-over'
    let unheld = 0
    const failing = { ...peer, hold: async () => { calls.push('hold'); throw new Error('the daemon on machine-b does not answer') }, unhold: () => { unheld++ } }
    noteHandedOver({ switchId: '20261124T000000-cccccc', to: 'machine-b', peer: failing as never, commitDeadline: Date.now() + 120_000, stopWaitMs: 120_000, onStopWaitOver: () => {} })
    const r = await fetch(`${base}/api/leader/switch/final-stop`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ switchId: '20261124T000000-cccccc' }) })
    expect(r.status).toBe(202)
    await until('the stop to be given up', () => handedOverSwitch()?.phase === 'waiting', 5_000)
    expect(calls).toEqual(['hold'])
    expect(calls).not.toContain('switch stop requested')
    expect(unheld).toBe(1)
  })
})
