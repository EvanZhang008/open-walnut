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
    vi.spyOn(ServiceSetLink.prototype, 'beforeTriggerPush').mockImplementation(async () => { wire.push('gate'); return gate() })
    return { c, wire }
  }

  it('the gate answers before the set goes out, once per connect', async () => {
    const { c, wire } = conn(async () => true)
    await c.pushTriggersNow()
    expect(wire).toEqual(['gate', 'triggers.configure'])
    expect(c.triggersPushed).toBe(true)
  })

  it('a push the gate refuses sends no trigger', async () => {
    const { c, wire } = conn(async () => false)
    await c.pushTriggersNow()
    expect(wire).toEqual(['gate'])
    expect(c.triggersPushed).toBe(false)
  })
})
