import { describe, expect, it } from 'vitest'
import { SocketTraffic } from '../../src/web/ws/traffic.js'

describe('bounded per-socket traffic samples', () => {
  it('counts actual encoded bytes and the paired whole-frame baseline, then drains', () => {
    const traffic = new SocketTraffic(1000)
    traffic.record(Buffer.byteLength(String.fromCodePoint(0x4e2d)), 1000, 'session:background-tasks')
    traffic.record(20, 500, 'task:updated')
    traffic.record(10)
    expect(traffic.sample(60999)).toBeNull()
    expect(traffic.sample(61000)).toEqual({ elapsedMs: 60000, frames: 3, bytes: 33, plainBytes: 1510,
      bytesPerMinute: 33, plainBytesPerMinute: 1510, comparison: true,
      backgroundBytes: 3, taskBytes: 20, responseBytes: 10, otherBytes: 0 })
    expect(traffic.compare).toBe(false)
    expect(traffic.sample(121000)).toBeNull()
  })

  it('classifies every negotiated task event using the protocol registry', async () => {
    const { LEAN_TASK_EVENTS } = await import('../../src/lib/ws-lean-protocol.js')
    const traffic = new SocketTraffic(0)
    for (const name of LEAN_TASK_EVENTS) traffic.record(10, 10, name)
    expect(traffic.sample(60000)).toMatchObject({ taskBytes: LEAN_TASK_EVENTS.length * 10, otherBytes: 0 })
  })

  it('labels an old Mac app socket from its existing logs without trusting content', () => {
    const traffic = new SocketTraffic(0)
    traffic.identify({ entries: [{ client: 'mac-app', tab: 'abc123', message: 'not retained' }] })
    traffic.identify({ entries: [{ client: 'forged', tab: 'bad/token' }] })
    traffic.record(60)
    expect(traffic.sample(60000)).toMatchObject({ client: 'mac-app', tab: 'abc123', bytesPerMinute: 60 })
  })

  it('isolates sockets and normalizes a short disconnect sample without logging twice', () => {
    const a = new SocketTraffic(0)
    const b = new SocketTraffic(0)
    a.record(30)
    expect(a.sample(30000, true)).toMatchObject({ bytes: 30, bytesPerMinute: 60 })
    expect(a.sample(30001, true)).toBeNull()
    expect(b.sample(60000)).toBeNull()
  })
})
