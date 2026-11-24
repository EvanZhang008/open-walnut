/**
 * The order of the old leader's host steps around a handover (handover-host-steps.ts), with fakes for
 * host-follow.ts's steps; and the config they read (leader_switch.machines[].doors and host_key).
 */
import { afterEach, describe, expect, it } from 'vitest'
import { afterHandoverRecord, beforeHandoverRecord, setHandoverHostSteps, undoHostSteps, type HandoverHostSteps, type HostStepsContext } from '../../../../src/core/leader/switch/handover-host-steps.js'
import { parseSwitchSettings } from '../../../../src/core/leader/switch/settings.js'

afterEach(() => setHandoverHostSteps(null))

function fakeSteps(failAt?: string): { calls: string[]; steps: HandoverHostSteps } {
  const calls: string[] = []
  const step = (name: string) => async () => { calls.push(name); return name === failAt ? { ok: false as const, why: 'no daemon' } : { ok: true as const } }
  return {
    calls,
    steps: {
      prepareOldMachineAsHost: step('prepare'), pushNewLeaderDoors: step('push'), configureOldMachineHostService: step('configure'),
      announceSwitchStop: step('announce'), retellNetMembers: step('retell'), dropOwnDaemonDuties: step('drop'), undoHandoverHostSteps: step('undo'),
    },
  }
}

const logs: string[] = []
const ctx = (over: Partial<HostStepsContext> = {}): HostStepsContext => ({
  home: '/a/home', walnutId: 'walnut-1', machineId: 'machine-a', commitWindowMs: 300_000, switchId: 'S1', log: (_l, m) => { logs.push(m) },
  self: { id: 'machine-a', home: '/a/home', standbyDir: '/a/standby', port: 1, hostKey: 'box-a' },
  target: { id: 'machine-b', home: '/b/home', standbyDir: '/b/standby', port: 2, doors: ['wss://machine-b.example.test/door'] },
  ...over,
})

describe('the host steps of a handover', () => {
  it('run in order, the switch stop announced last before the record; after it the members and the daemon duties', async () => {
    const f = fakeSteps()
    setHandoverHostSteps(f.steps)
    expect(await beforeHandoverRecord(ctx())).toEqual({ ok: true })
    await afterHandoverRecord(ctx())
    expect(f.calls).toEqual(['prepare', 'push', 'configure', 'announce', 'retell', 'drop'])
  })

  it('a step that fails takes back the ones before it and refuses the handover; nothing is announced', async () => {
    const f = fakeSteps('configure')
    setHandoverHostSteps(f.steps)
    expect(await beforeHandoverRecord(ctx())).toEqual({ ok: false, why: 'configureOldMachineHostService: no daemon' })
    expect(f.calls).toEqual(['prepare', 'push', 'configure', 'undo'])
  })

  it('none run when not set, or when the config names no doors or host_key (said in the log); a take-back undoes them', async () => {
    expect(await beforeHandoverRecord(ctx())).toEqual({ ok: true })
    const f = fakeSteps()
    setHandoverHostSteps(f.steps)
    logs.length = 0
    expect(await beforeHandoverRecord(ctx({ self: { id: 'machine-a', home: '/a/home', standbyDir: '/a/standby', port: 1 } }))).toEqual({ ok: true })
    expect(f.calls).toEqual([])
    expect(logs.join('\n')).toMatch(/hosts do not follow/)
    await undoHostSteps({ home: '/a/home', walnutId: 'walnut-1', machineId: 'machine-a', log: () => {} })
    expect(f.calls).toEqual(['undo'])
  })

  it('a net host that misses the member lists makes the handover wait and try again, then succeed once it took them', async () => {
    const f = fakeSteps()
    let misses = 2
    f.steps.retellNetMembers = async () => { f.calls.push('retell'); return misses-- > 0 ? { ok: false, why: 'not told: box-h (not connected)' } : { ok: true } }
    setHandoverHostSteps(f.steps)
    expect(await afterHandoverRecord(ctx({ retellWaitMs: 2_000, retellEveryMs: 50 }))).toEqual({ ok: true })
    expect(f.calls).toEqual(['retell', 'retell', 'retell', 'drop'])
  })

  it('a net host that never takes them: the wait runs out, the hosts are named, and this machine\'s daemon keeps its duties', async () => {
    const f = fakeSteps()
    f.steps.retellNetMembers = async () => { f.calls.push('retell'); return { ok: false, why: 'not told: box-h (not connected)' } }
    setHandoverHostSteps(f.steps)
    const t0 = Date.now()
    const r = await afterHandoverRecord(ctx({ retellWaitMs: 400, retellEveryMs: 100 }))
    expect(r).toEqual({ ok: false, why: 'retellNetMembers: not told: box-h (not connected)' })
    expect(Date.now() - t0).toBeLessThan(2_000)
    expect(f.calls.filter((c) => c === 'retell').length).toBeGreaterThan(1)
    expect(f.calls).not.toContain('drop')
  })

  it('the retell is told the new leader (for its network id), and its wait is half the commit window, at most a minute', async () => {
    const f = fakeSteps()
    const seen: string[] = []
    f.steps.retellNetMembers = async ({ target }) => { seen.push(target.id); return { ok: true } }
    setHandoverHostSteps(f.steps)
    await afterHandoverRecord(ctx())
    expect(seen).toEqual(['machine-b'])
  })

  it('the config: doors are wss:// or https:// (ws:// and http:// to loopback), host_key a host name', () => {
    const base = (m: Record<string, unknown>) => parseSwitchSettings({
      witnesses: [{ id: 'w1', dir: '/w/1' }, { id: 'w2', dir: '/w/2' }, { id: 'w3', dir: '/w/3' }],
      machines: [{ id: 'machine-a', home: '/a', standby_dir: '/as', port: 1, ...m }, { id: 'machine-b', home: '/b', standby_dir: '/bs', port: 2 }],
    })
    expect(base({ doors: ['wss://a.example.test/door/', 'ws://127.0.0.1:4000'], host_key: 'box-a' }).settings?.machines[0]).toMatchObject({ doors: ['wss://a.example.test/door', 'ws://127.0.0.1:4000'], hostKey: 'box-a' })
    expect(base({ doors: ['ws://a.example.test'] }).problem).toMatch(/doors must be a list of wss:\/\//)
    expect(base({ doors: ['wss://u:p@a.example.test'] }).problem).toMatch(/doors/)
    expect(base({ host_key: 'a b' }).problem).toMatch(/host_key must be a host name/)
  })
})
