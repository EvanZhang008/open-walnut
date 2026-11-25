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
import fs from 'node:fs'
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

// Every home path of the routes in a temp dir (never ~/.open-walnut).
vi.mock('../../../../src/constants.js', async () => (await import('../../../helpers/mock-constants.js')).createMockConstants('walnut-handover-route'))
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
const began = vi.hoisted(() => [] as unknown[])
vi.mock('../../../../src/core/leader/switch/leader-relay-door.js', async (orig) => ({ ...(await orig<object>()), recordBegin: async (o: unknown) => { began.push(o) } }))
// The standby runner's batches the switch stop's last look takes: each answers the next of `looks` (a caught-up one by default).
const caughtUp = { ok: true, manifest: {}, commit: { batch: 9, unchanged: false, written: 1, deleted: 0 }, stats: { totalMs: 1_200, sentBytes: 4096 } }
let looks: unknown[] = []
vi.mock('../../../../src/core/standby/runner.js', () => ({ standbyRunner: () => ({ runOnce: async () => { calls.push('look'); return looks.shift() ?? caughtUp } }) }))
vi.mock('../../../../src/core/leader/switch/handover-host-steps.js', () => ({
  beforeHandoverRecord: async () => { calls.push('host steps before'); return { ok: true } },
  afterHandoverRecord: async () => { calls.push('retell'); return { ok: false, why: 'retellNetMembers: not told: box-net-only' } },
  retellWaitMs: () => 60_000,
  undoHostSteps: async () => { calls.push('host steps undone') },
}))

let server: http.Server | null = null
let base = ''
beforeEach(async () => {
  calls.length = 0
  looks = []
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
    expect(calls).toEqual(['look', 'hold'])
    expect(calls).not.toContain('switch stop requested')
    expect(unheld).toBe(1)
  })
})

describe('the switch stop\'s last look', () => {
  // The commit window is 120 s here: the look's budget is 30 s.
  it('a write after the catch-up the copy link cannot carry in time: the stop is refused, nothing stopped, the handover can be taken back', async () => {
    const { noteHandedOver, handedOverSwitch, beginTakeBack } = await import('../../../../src/core/leader/switch/final-stop.js')
    state = 'handed-over'
    noteHandedOver({ switchId: '20261124T000000-ffffff', to: 'machine-b', peer: peer as never, commitDeadline: Date.now() + 120_000, stopWaitMs: 120_000, onStopWaitOver: () => {} })
    // 1.2 GB written after the catch-up, at 2.5 MB/s: 480 s, then 540 s with what came meanwhile.
    const slow = (ms: number) => ({ ...caughtUp, stats: { totalMs: ms, sentBytes: 1_200_000_000 } })
    looks = [slow(480_000), slow(540_000)]
    const r = await fetch(`${base}/api/leader/switch/final-stop`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ switchId: '20261124T000000-ffffff' }) })
    expect(r.status).toBe(409)
    expect(((await r.json()) as { why: string }).why).toMatch(/^the standby fell behind after its catch-up, so the final batch would not fit in the commit window \(nothing stopped; the handover is being taken back\): .*falls further behind/)
    expect(calls).toEqual(['look', 'look'])
    expect(calls).not.toContain('switch stop requested')
    // Not in a stop: the cancel the source job sends next takes the handover back.
    expect(handedOverSwitch()?.phase).toBe('waiting')
    expect(beginTakeBack().ok).toBe(true)
  })

  it('caught up (a batch within the budget): the stop goes ahead', async () => {
    const { noteHandedOver } = await import('../../../../src/core/leader/switch/final-stop.js')
    state = 'handed-over'
    noteHandedOver({ switchId: '20261124T000000-gggggg', to: 'machine-b', peer: peer as never, commitDeadline: Date.now() + 120_000, stopWaitMs: 120_000, onStopWaitOver: () => {} })
    const r = await fetch(`${base}/api/leader/switch/final-stop`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ switchId: '20261124T000000-gggggg' }) })
    expect(r.status).toBe(202)
    await until('the stop', () => calls.includes('switch stop requested'), 5_000)
    expect(calls[0]).toBe('look')
  })
})

describe('the routes that read the copy link answer within their deadline', () => {
  it('GET /switch/target: a link that does not answer is said so within 10 s, not left hanging', async () => {
    const { noteHandedOver } = await import('../../../../src/core/leader/switch/final-stop.js')
    const silent = { ...peer, readFile: () => new Promise(() => {}) }
    noteHandedOver({ switchId: '20261124T000000-dddddd', to: 'machine-b', peer: silent as never, commitDeadline: Date.now() + 120_000, stopWaitMs: 120_000, onStopWaitOver: () => {} })
    const t0 = Date.now()
    const r = await fetch(`${base}/api/leader/switch/target?switchId=20261124T000000-dddddd`)
    const ms = Date.now() - t0
    expect(r.status).toBe(502)
    expect(((await r.json()) as { why: string }).why).toMatch(/could not be read: the copy link did not answer within 10 s/)
    expect(ms).toBeLessThan(13_000)
  }, 20_000)

  it('POST /switch/check: an old report that cannot be cleared stops the check (no job), and the peer is closed', async () => {
    const started: string[] = []
    Object.assign(peer, {
      writeFile: async () => { throw new Error('fs.write on machine-b: read-only file system') },
      verify: async () => ({ drift: 0 }),
      startTargetJob: async (id: string) => { started.push(id); return { ok: true } },
      readFile: async () => ({ problems: [] }),
    })
    try {
      const r = await fetch(`${base}/api/leader/switch/check`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ to: 'machine-b', switchId: '20261124T000000-eeeeee' }) })
      expect(r.status).toBe(409)
      expect(((await r.json()) as { why: string }).why).toMatch(/the last check report on machine-b could not be cleared: fs.write on machine-b: read-only/)
      expect(started).toEqual([])
      expect(calls).toEqual(['peer close'])
    } finally {
      for (const k of ['writeFile', 'verify', 'startTargetJob', 'readFile']) delete (peer as Record<string, unknown>)[k]
    }
  })
})

describe('the begin a source job asks on loopback', () => {
  const begin = (body: Record<string, unknown>) => fetch(`${base}/api/leader/switch/begin`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
    .then(async (r) => ({ status: r.status, json: await r.json() as { ok: boolean; startedBy?: unknown } }))

  it('a forwarded begin this server lost by a restart is read as its relay door kept it; what a request says counts for nothing', async () => {
    began.length = 0
    const { WALNUT_HOME } = await import('../../../../src/constants.js')
    const { forwardedBeginFile } = await import('../../../../src/core/leader/switch/leader-relay-door.js')
    const { writeDurableJson } = await import('../../../../src/core/leader/switch/records.js')
    const kept = '20261124T000000-bbbbbb'
    writeDurableJson(forwardedBeginFile(WALNUT_HOME, kept), { switchId: kept, to: 'machine-b', by: { machine: 'machine-b', via: 'forwarded' }, hostKey: 'machine-b', at: new Date().toISOString() })
    try {
      // Kept by the door: its job's begin answers who began it, and records nothing again.
      expect((await begin({ to: 'machine-b', switchId: kept })).json).toEqual({ ok: true, startedBy: { machine: 'machine-b', via: 'forwarded' } })
      // No record kept: a body that says it was forwarded is this machine's own command.
      const other = await begin({ to: 'machine-b', switchId: '20261124T000000-cccccc', forwardedBy: 'machine-b', startedBy: { machine: 'machine-b', via: 'forwarded' } })
      expect(other.json).toEqual({ ok: true, startedBy: { machine: 'machine-a', via: 'cli' } })
      expect(began).toEqual([{ switchId: '20261124T000000-cccccc', from: 'machine-a', to: 'machine-b', by: { machine: 'machine-a', via: 'cli' } }])
    } finally { fs.rmSync(forwardedBeginFile(WALNUT_HOME, kept), { force: true }) }
  })
})
