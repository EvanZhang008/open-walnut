/**
 * The server's loop thread moves to QoS user-initiated on macOS where the deploy
 * raised the process (src/lib/loop-thread-qos.ts). On 2026-11-19 a session row
 * INSERT that needs 1.5 ms of CPU waited 300 to 650 ms for a CPU at the default
 * band, 41 times in 11 h.
 */
import { describe, expect, it } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { QOS_CLASS_USER_INITIATED, raiseLoopThreadQos, type QosCalls } from '../../src/lib/loop-thread-qos.js'

function fakeCalls(rc = 0) {
  const set: Array<[number, number]> = []
  let qos = 0x15 // QOS_CLASS_DEFAULT
  const calls: QosCalls = {
    set: (c, p) => { set.push([c, p]); if (rc === 0) qos = c; return rc },
    current: () => qos,
  }
  return { set, calls: async () => calls }
}

describe('raiseLoopThreadQos', () => {
  it('raises the calling thread to user-initiated on macOS when the deploy raised the process', async () => {
    const f = fakeCalls()
    const got = await raiseLoopThreadQos({ raisedByDeploy: true, platform: 'darwin', env: {}, calls: f.calls })
    expect(f.set).toEqual([[QOS_CLASS_USER_INITIATED, 0]])
    expect(got).toEqual({ applied: true, before: '0x15', after: '0x19' })
  })

  it('leaves a server the deploy did not raise as launched, unless WALNUT_LOOP_QOS=1', async () => {
    const f = fakeCalls()
    expect(await raiseLoopThreadQos({ raisedByDeploy: false, platform: 'darwin', env: {}, calls: f.calls })).toMatchObject({ applied: false, reason: 'not-requested' })
    expect(f.set).toEqual([])
    expect((await raiseLoopThreadQos({ raisedByDeploy: false, platform: 'darwin', env: { WALNUT_LOOP_QOS: '1' }, calls: f.calls })).applied).toBe(true)
  })

  it('does nothing off macOS or with WALNUT_LOOP_QOS=0', async () => {
    const f = fakeCalls()
    expect(await raiseLoopThreadQos({ raisedByDeploy: true, platform: 'linux', env: {}, calls: f.calls })).toMatchObject({ reason: 'not-darwin' })
    expect(await raiseLoopThreadQos({ raisedByDeploy: true, platform: 'darwin', env: { WALNUT_LOOP_QOS: '0' }, calls: f.calls })).toMatchObject({ reason: 'turned-off' })
    expect(f.set).toEqual([])
  })

  it('reports a refusal or a missing bun:ffi and never throws', async () => {
    const refused = await raiseLoopThreadQos({ raisedByDeploy: true, platform: 'darwin', env: {}, calls: fakeCalls(1).calls })
    expect(refused).toMatchObject({ applied: false, reason: 'refused', after: '0x15' })
    const missing = await raiseLoopThreadQos({ raisedByDeploy: true, platform: 'darwin', env: {}, calls: async () => { throw new Error('no ffi') } })
    expect(missing).toMatchObject({ applied: false, reason: 'unavailable', error: 'no ffi' })
  })

  // The guard on the wiring: the server raises its loop thread with the deploy's
  // own answer, before the event-loop monitor starts measuring it.
  it('is called at server boot with the clamp request, before the event-loop monitor starts', () => {
    const src = fs.readFileSync(path.join(__dirname, '../../src/web/server.ts'), 'utf8')
    expect(src).toMatch(/const raisedByDeploy = takeQosClampRequest\(\)/)
    const raise = src.indexOf('raiseLoopThreadQos({ raisedByDeploy })')
    const monitor = src.indexOf('startEventLoopMonitor()')
    expect(raise).toBeGreaterThan(0)
    expect(raise).toBeLessThan(monitor)
  })
})
