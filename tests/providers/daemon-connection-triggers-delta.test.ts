/**
 * A change to the armed trigger set on a connection whose last push the daemon took sends only
 * the defs that moved and the ids gone (triggers-delta-v1), and the daemon ends up with exactly
 * the set the server compiled. 2026-11-20: a change of one of 109 triggers sent all of them
 * (about 118 KB) up newdev's SSH link, which a relay on that path ends every few MB carried up.
 *
 * Real layer: real DaemonConnections over real WebSockets to MockDaemon, which makes the set from
 * a delta with the same core function both daemon twins use (their side:
 * tests/integration/offline-triggers-twins.test.ts).
 */
import { describe, it, expect, afterEach, beforeEach } from 'vitest'
import { MockDaemon } from '../helpers/mock-daemon.js'
import { DaemonConnection } from '../../src/providers/daemon-connection.js'
import { setTriggerPayloadProvider } from '../../src/core/routines/trigger-bridge.js'
import { triggerPushHash } from '../../src/providers/trigger-check-core.js'

const TARGET = { hostname: '127.0.0.1', user: undefined, port: undefined }

/** A def as the server compiles it; `note` stands in for a session routine's long prompt. */
const def = (n: number, rev = 0) => ({
  id: `mtrigdl${String(n).padStart(2, '0')}-0001`, name: `Watch ${n}`, everyMs: 300_000,
  check: { run: `sh check-${n}.sh --rev ${rev}`, timeoutSeconds: 30 }, note: `${'x'.repeat(3000)}-${rev}`,
})
const compiled = (defs: ReturnType<typeof def>[]) => {
  const triggers = [...defs].sort((a, b) => (a.id < b.id ? -1 : 1))
  return { payload: { version: 1 as const, triggers }, hash: triggerPushHash(triggers) }
}

async function waitFor(cond: () => boolean, ms = 10_000): Promise<void> {
  const until = Date.now() + ms
  while (!cond()) {
    if (Date.now() > until) throw new Error('timed out')
    await new Promise((r) => setTimeout(r, 25))
  }
}

describe('DaemonConnection trigger push sends only what changed', () => {
  let daemon: MockDaemon
  let current = compiled([])
  const conns: DaemonConnection[] = []

  beforeEach(async () => {
    current = compiled(Array.from({ length: 40 }, (_, i) => def(i)))
    setTriggerPayloadProvider(async () => current)
    daemon = new MockDaemon()
    daemon.enableTriggers()
  })

  afterEach(async () => {
    for (const c of conns.splice(0)) { try { c.disconnect() } catch { /* best effort */ } }
    setTriggerPayloadProvider(null)
    await daemon.stop()
  })

  const pushes = () => daemon.getCommandHistory().filter((c) => c.cmd === 'triggers.configure')
  const kinds = () => pushes().map((c) => c.payload.probe === true ? 'probe' : c.payload.delta ? 'delta' : 'set')
  const bytes = (c: { payload: Record<string, unknown> }) => JSON.stringify(c.payload).length
  const held = () => daemon.triggerSets[daemon.triggerSets.length - 1]

  async function connect(host: string): Promise<DaemonConnection> {
    const conn = new DaemonConnection(host, TARGET)
    conns.push(conn)
    await conn.connectDirect(`ws://127.0.0.1:${daemon.port}`)
    await conn.pushTriggersNow()
    await waitFor(() => conn.triggersPushed)
    return conn
  }

  it('a change, an addition and a removal go as a delta, again and again, and the daemon holds exactly the compiled set', async () => {
    await daemon.start()
    const conn = await connect('trig-delta')
    expect(kinds()).toEqual(['probe', 'set'])
    const full = bytes(pushes()[1])
    const defs = Array.from({ length: 40 }, (_, i) => def(i))
    for (let round = 1; round <= 3; round++) {
      defs[round] = def(round, round) // changed
      defs.push(def(40 + round)) // new
      defs.splice(defs.findIndex((d) => d.id === def(10 + round).id), 1) // gone
      current = compiled(defs)
      await conn.pushTriggersNow()
      const last = pushes()[pushes().length - 1]
      expect(last.payload.delta).toMatchObject({ drop: [def(10 + round).id] })
      expect((last.payload.delta as { put: { id: string }[] }).put.map((d) => d.id).sort()).toEqual([def(round).id, def(40 + round).id].sort())
      expect(last.payload.pushHash).toBe(current.hash)
      expect(bytes(last)).toBeLessThan(full / 10)
      expect(held()).toEqual(current.payload.triggers)
    }
    expect(kinds()).toEqual(['probe', 'set', 'delta', 'delta', 'delta'])
    // The same set again sends nothing.
    await conn.pushTriggersNow()
    expect(pushes()).toHaveLength(5)
  })

  it('a daemon that no longer holds the base answers held: false, and the whole set follows in the same push', async () => {
    await daemon.start()
    const conn = await connect('trig-delta-moved')
    // Another link of this daemon pushed another set meanwhile.
    daemon.replaceHeldTriggers('other-set', [def(99)])
    const defs = Array.from({ length: 40 }, (_, i) => def(i))
    defs[0] = def(0, 1)
    current = compiled(defs)
    await conn.pushTriggersNow()
    expect(kinds()).toEqual(['probe', 'set', 'delta', 'set'])
    expect(pushes()[3].payload.pushHash).toBe(current.hash)
    expect(held()).toEqual(current.payload.triggers)
    // And the next change is a delta from that set.
    defs[1] = def(1, 1)
    current = compiled(defs)
    await conn.pushTriggersNow()
    expect(kinds()).toEqual(['probe', 'set', 'delta', 'set', 'delta'])
    expect(held()).toEqual(current.payload.triggers)
  })

  it('a change of every def goes as the whole set, and a reconnect only asks', async () => {
    await daemon.start()
    const conn = await connect('trig-delta-all')
    current = compiled(Array.from({ length: 40 }, (_, i) => def(i, 7)))
    await conn.pushTriggersNow()
    expect(kinds()).toEqual(['probe', 'set', 'set'])
    conn.disconnect()
    await connect('trig-delta-all')
    expect(kinds()).toEqual(['probe', 'set', 'set', 'probe'])
    expect(held()).toEqual(current.payload.triggers)
  })

  it('a daemon without triggers-delta-v1 gets the whole set on every change', async () => {
    daemon.omitCapabilities(['triggers-delta-v1'])
    await daemon.start()
    const conn = await connect('trig-delta-old')
    const defs = Array.from({ length: 40 }, (_, i) => def(i))
    defs[0] = def(0, 1)
    current = compiled(defs)
    await conn.pushTriggersNow()
    expect(kinds()).toEqual(['probe', 'set', 'set'])
    expect(held()).toEqual(current.payload.triggers)
  })
  it('a delta onto a set the daemon holds already is taken as held, and a delta it cannot read is followed by the whole set', async () => {
    await daemon.start()
    const conn = await connect('trig-delta-held')
    const defs = Array.from({ length: 40 }, (_, i) => def(i))
    defs[0] = def(0, 1)
    current = compiled(defs)
    // Another link of this daemon pushed this very set already.
    daemon.replaceHeldTriggers(current.hash, current.payload.triggers)
    await conn.pushTriggersNow()
    expect(kinds()).toEqual(['probe', 'set', 'delta'])
    daemon.failTriggerDeltas()
    defs[1] = def(1, 1)
    current = compiled(defs)
    await conn.pushTriggersNow()
    expect(kinds()).toEqual(['probe', 'set', 'delta', 'delta', 'set'])
    expect(held()).toEqual(current.payload.triggers)
  })

  it('a reconnect while a push is in flight still gets its own first push', async () => {
    await daemon.start()
    const conn = await connect('trig-delta-inflight')
    let release!: () => void
    const gate = new Promise<void>((r) => { release = r })
    const defs = Array.from({ length: 40 }, (_, i) => def(i))
    defs[0] = def(0, 1)
    const next = compiled(defs)
    setTriggerPayloadProvider(async () => { await gate; return next })
    const inFlight = conn.pushTriggersNow()
    await new Promise((r) => setTimeout(r, 100))
    // The link drops and comes back while the compile waits.
    conn.disconnect()
    await conn.connectDirect(`ws://127.0.0.1:${daemon.port}`)
    release()
    await inFlight
    await waitFor(() => conn.triggersPushed)
    // The new connection's own push: a probe first (it found nothing held under that name), then the set.
    expect(kinds().slice(2)).toEqual(['probe', 'set'])
    expect(held()).toEqual(next.payload.triggers)
  })
})
