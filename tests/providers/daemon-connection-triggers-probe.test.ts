/**
 * DaemonConnection's trigger push asks the daemon first (triggers-probe-v1): a reconnect, or a
 * new server, sends no set the daemon still holds under that name, and the clock settle still
 * gets the daemon's answer (2026-11-13: every connection sent the set again, 90 to 350 KB on
 * the session link). A daemon without the capability gets the set as before, unnamed.
 *
 * Real layer: real DaemonConnections over real WebSockets to MockDaemon, which answers the
 * probe as both daemon twins do (their side: tests/integration/offline-triggers-twins.test.ts).
 */
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest'
import { MockDaemon } from '../helpers/mock-daemon.js'
import { DaemonConnection } from '../../src/providers/daemon-connection.js'
import { setTriggerPayloadProvider } from '../../src/core/routines/trigger-bridge.js'

const TARGET = { hostname: '127.0.0.1', user: undefined, port: undefined }
const SET = { version: 1 as const, triggers: [{ id: 'mtrigprb-0001', name: 'Watch', everyMs: 300_000, check: { run: 'true' }, note: 'x'.repeat(50_000) }] }

async function waitFor(cond: () => boolean, ms = 10_000): Promise<void> {
  const until = Date.now() + ms
  while (!cond()) {
    if (Date.now() > until) throw new Error('timed out')
    await new Promise((r) => setTimeout(r, 25))
  }
}

describe('DaemonConnection trigger push with a probe first', () => {
  let daemon: MockDaemon
  const conns: DaemonConnection[] = []
  const applied = vi.fn(async (_reply: Record<string, unknown>) => {})

  beforeEach(async () => {
    applied.mockClear()
    setTriggerPayloadProvider(async () => ({ payload: SET, hash: 'set-h1', applied }))
    daemon = new MockDaemon()
    daemon.enableTriggers()
  })

  afterEach(async () => {
    for (const c of conns.splice(0)) { try { c.disconnect() } catch { /* best effort */ } }
    setTriggerPayloadProvider(null)
    await daemon.stop()
  })

  const pushes = () => daemon.getCommandHistory().filter((c) => c.cmd === 'triggers.configure')

  async function connect(host: string): Promise<DaemonConnection> {
    const conn = new DaemonConnection(host, TARGET)
    conns.push(conn)
    await conn.connectDirect(`ws://127.0.0.1:${daemon.port}`)
    await conn.pushTriggersNow()
    return conn
  }

  it('the first connection sends the set named; the next one only asks, and the settle gets the held answer', async () => {
    await daemon.start()
    const first = await connect('trig-probe')
    await waitFor(() => first.triggersPushed)
    expect(pushes().map((c) => c.payload.probe === true ? 'probe' : 'set')).toEqual(['probe', 'set'])
    expect(pushes()[1].payload.pushHash).toBe('set-h1')
    expect(applied).toHaveBeenCalledTimes(1)
    first.disconnect()

    const second = await connect('trig-probe')
    await waitFor(() => second.triggersPushed)
    expect(pushes().map((c) => c.payload.probe === true ? 'probe' : 'set')).toEqual(['probe', 'set', 'probe'])
    expect(applied).toHaveBeenCalledTimes(2)
    expect(applied.mock.calls[1][0]).toMatchObject({ ok: true, held: true, applied: true })
    // On the same connection, a push of the same set sends nothing at all.
    await second.pushTriggersNow()
    expect(pushes()).toHaveLength(3)
  })

  it('a daemon without triggers-probe-v1 gets the set as before, with no name, on every connection', async () => {
    daemon.omitCapabilities(['triggers-probe-v1'])
    await daemon.start()
    for (let i = 0; i < 2; i++) {
      const c = await connect('trig-probe-old')
      await waitFor(() => c.triggersPushed)
      c.disconnect()
    }
    expect(pushes().map((c) => c.payload.probe === true ? 'probe' : 'set')).toEqual(['set', 'set'])
    expect(pushes().every((c) => c.payload.pushHash === undefined)).toBe(true)
  })
})
