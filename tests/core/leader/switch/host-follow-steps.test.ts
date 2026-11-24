/**
 * What the handover's host steps choose for their hooks (host-follow-steps.ts): the host service's
 * loopback port (picked as the host-server manager picks one, kept across a handover asked again) and
 * the new leader's network id; and that a retell which missed a host, or does not let the new leader
 * in, is not ok and names it.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'

const tmp: string[] = []
afterEach(() => { vi.restoreAllMocks(); vi.resetModules(); for (const d of tmp.splice(0)) fs.rmSync(d, { recursive: true, force: true }) })
const home = () => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'host-follow-steps-')); tmp.push(d); return d }

describe('the host service port', () => {
  it('is a free loopback port in the host-server range, skipping one in use', async () => {
    const { hostServicePort } = await import('../../../../src/core/leader/switch/host-follow-steps.js')
    const busy = net.createServer()
    await new Promise<void>((r) => busy.listen(0, '127.0.0.1', () => r()))
    const taken = (busy.address() as net.AddressInfo).port
    // A port of the range free now (a fixed one can be the local end of some connection on this box).
    let open = 41_234
    while (!(await new Promise<boolean>((r) => { const s = net.createServer(); s.once('error', () => r(false)); s.listen(open, '127.0.0.1', () => s.close(() => r(true))) }))) open++
    const picks = [taken, open]
    try {
      expect(await hostServicePort(home(), { random: () => picks.shift()! })).toBe(open)
    } finally {
      busy.close()
    }
    const p = await hostServicePort(home())
    expect(p).toBeGreaterThanOrEqual(41_000)
    expect(p).toBeLessThan(50_000)
  })

  it('a handover asked again keeps the port its record names; a record of another switch is not reused', async () => {
    const { hostServicePort } = await import('../../../../src/core/leader/switch/host-follow-steps.js')
    const { hostServiceRecordFile } = await import('../../../../src/core/leader/switch/host-follow.js')
    const h = home()
    fs.mkdirSync(path.dirname(hostServiceRecordFile(h)), { recursive: true })
    fs.writeFileSync(hostServiceRecordFile(h), JSON.stringify({ v: 1, home: h, port: 43_210, switchId: 'S1' }))
    // The same switch: its service may hold the port already, so it is not checked for free.
    expect(await hostServicePort(h, { switchId: 'S1', random: () => { throw new Error('no pick') }, free: async () => false })).toBe(43_210)
    // Another switch, or none named: a fresh free port.
    const picks = [43_210, 44_444]
    expect(await hostServicePort(h, { switchId: 'S2', random: () => picks.shift()!, free: async (p) => p !== 43_210 })).toBe(44_444)
    expect(await hostServicePort(h, { random: () => 45_000, free: async () => true })).toBe(45_000)
  })

  it('no free port among the candidates: says so', async () => {
    const { hostServicePort } = await import('../../../../src/core/leader/switch/host-follow-steps.js')
    await expect(hostServicePort(home(), { free: async () => false })).rejects.toThrow(/no free loopback port/)
  })
})

describe('the retell', () => {
  const target = { id: 'machine-b', home: '/b', standbyDir: '/bs', port: 2, hostKey: 'box-b' }
  it('names the hosts it missed, and a new leader the network does not let in', async () => {
    vi.doMock('../../../../src/core/leader/switch/host-follow.js', () => ({
      retellNetMembers: async () => ({ ok: true, told: ['box-c'], missed: [{ host: 'box-h', why: 'not connected' }], newLeaderLetIn: false }),
    }))
    vi.doMock('../../../../src/core/config-manager.js', () => ({ getConfig: async () => ({ hosts: {} }) }))
    const { hostFollowSteps } = await import('../../../../src/core/leader/switch/host-follow-steps.js')
    const r = await hostFollowSteps.retellNetMembers({ target })
    expect(r.ok).toBe(false)
    expect(!r.ok && r.why).toMatch(/box-h \(not connected\)/)
    expect(!r.ok && r.why).toMatch(/does not let machine-b in/)
  })

  it('is ok when every host took the lists and the new leader is let in; the network id comes from hosts', async () => {
    const asked: unknown[] = []
    vi.doMock('../../../../src/core/leader/switch/host-follow.js', () => ({
      retellNetMembers: async (o: unknown) => { asked.push(o); return { ok: true, told: ['box-h'], missed: [], newLeaderLetIn: true } },
    }))
    vi.doMock('../../../../src/core/config-manager.js', () => ({ getConfig: async () => ({ hosts: { 'box-b': { transport: 'net', endpoint: 'ABCD1234' } } }) }))
    const { hostFollowSteps } = await import('../../../../src/core/leader/switch/host-follow-steps.js')
    expect(await hostFollowSteps.retellNetMembers({ target })).toEqual({ ok: true })
    expect(asked).toEqual([{ endpoints: { 'machine-b': 'abcd1234' } }])
  })
})
