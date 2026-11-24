/**
 * The wiring of service-set-move-memory.test.ts: a connect's first trigger push asks the link's
 * service set part first (ServiceSetLink.beforeTriggerPush), so the set's daemon gets the triggers'
 * memory a move cut by a leader restart still owes before any trigger is armed there, and a push
 * it refuses (a kept copy that cannot be read) sends no trigger at all.
 *
 * What's real: DaemonConnection.pushTriggersNow and its compile. What's faked: the wire
 * (sendAdmitted), the gate's answer.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DaemonConnection } from '../../src/providers/daemon-connection.js'
import { ServiceSetLink } from '../../src/providers/service-set-move-link.js'
import { setTriggerPayloadProvider } from '../../src/core/routines/trigger-bridge.js'

type Internals = {
  _connected: boolean
  sendAdmitted: (cmd: string, params: Record<string, unknown>) => Promise<Record<string, unknown>>
}

describe('a connect\'s first trigger push waits for what a cut move owes the set', () => {
  beforeEach(() => {
    setTriggerPayloadProvider(async () => ({ payload: { version: 1, triggers: [{ id: 'mail', name: 'mail', everyMs: 300_000, check: { run: 'true' } }] }, hash: 'set:mail' }))
  })
  afterEach(() => {
    setTriggerPayloadProvider(null)
    vi.restoreAllMocks()
  })

  function conn(gate: () => Promise<boolean>) {
    vi.spyOn(DaemonConnection.prototype, 'linkKind', 'get').mockReturnValue('net')
    const c = new DaemonConnection('devbox', null)
    const x = c as unknown as Internals
    x._connected = true
    vi.spyOn(c, 'hasCapability').mockImplementation((cap: string) => cap === 'triggers-v1')
    const wire: string[] = []
    vi.spyOn(x, 'sendAdmitted').mockImplementation(async (cmd) => { wire.push(cmd); return { ok: true, applied: true } })
    const asked: unknown[] = []
    vi.spyOn(ServiceSetLink.prototype, 'beforeTriggerPush').mockImplementation(async (live) => { wire.push('gate'); asked.push(live); return gate() })
    return { c, wire, asked }
  }

  it('the gate answers before the set goes out, once per connect, with the triggers the push carries', async () => {
    const { c, wire, asked } = conn(async () => true)
    await c.pushTriggersNow()
    expect(wire).toEqual(['gate', 'triggers.configure'])
    expect(asked).toEqual([['mail']])
    expect(c.triggersPushed).toBe(true)
    // A second push on the same connect (a trigger changed) is a change: the gate is not asked again.
    setTriggerPayloadProvider(async () => ({ payload: { version: 1, triggers: [{ id: 'mail', name: 'mail', everyMs: 60_000, check: { run: 'true' } }] }, hash: 'set:mail:2' }))
    await c.pushTriggersNow()
    expect(wire.filter((w) => w === 'gate')).toHaveLength(1)
    expect(wire.length).toBeGreaterThan(2)
  })

  it('a gate that throws is no yes: nothing is pushed', async () => {
    const { c, wire } = conn(async () => { throw new Error('the move store could not be read') })
    await c.pushTriggersNow()
    expect(wire).toEqual(['gate'])
    expect(c.triggersPushed).toBe(false)
    c.disconnect()
  })

  it('a push the gate refuses sends no trigger, and the next push asks it again', async () => {
    let open = false
    const { c, wire } = conn(async () => open)
    await c.pushTriggersNow()
    expect(wire).toEqual(['gate'])
    expect(c.triggersPushed).toBe(false)
    open = true
    await c.pushTriggersNow()
    expect(wire).toEqual(['gate', 'gate', 'triggers.configure'])
    expect(c.triggersPushed).toBe(true)
  })
})
