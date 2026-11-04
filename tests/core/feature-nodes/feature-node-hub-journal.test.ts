import { afterEach, describe, expect, it } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { FeatureNodeHub } from '../../../src/web/ws/feature-node-hub.js'
import { ConnectionJournal, type ConnectionLog, type JournalEvent } from '../../../src/core/feature-nodes/connection-journal.js'
import type { Authority } from '../../../src/core/feature-nodes/contracts.js'
import { FakeClock, FakeTransport, authority, capability, deferred, flush } from './fakes.js'

class Recorder implements ConnectionLog {
  readonly events: JournalEvent[] = []
  flushes = 0
  gate?: Promise<void>
  record(event: JournalEvent): void { this.events.push(event) }
  flush(): Promise<void> { this.flushes++; return this.gate ?? Promise.resolve() }
}

const hubs: FeatureNodeHub[] = []
afterEach(() => { for (const hub of hubs.splice(0)) void hub.close() })

function setup(verify?: () => Promise<Authority | undefined>) {
  const clock = new FakeClock()
  const journal = new Recorder()
  const hub = new FeatureNodeHub(clock, journal)
  hubs.push(hub)
  const attach = (nodeId = 'node-a', transport = new FakeTransport()) => {
    const attached = hub.attach({ authority: authority(nodeId), verify: verify ?? (async () => authority(nodeId)) }, transport)
    return { attached, transport, generation: attached.success ? attached.payload.generation : undefined }
  }
  return { clock, journal, hub, attach }
}

describe('feature node hub: the connection journal', () => {
  it('a node that closes with a code reads connected, then disconnected closed_by_node with that code', () => {
    const f = setup()
    const { transport, generation } = f.attach()
    f.clock.advance(4200)
    transport.remoteClose(4000, 'node going away')
    expect(f.journal.events).toEqual([
      { type: 'connected', nodeId: 'node-a', generation },
      { type: 'disconnected', nodeId: 'node-a', generation, cause: 'closed_by_node', closeCode: 4000, closeReason: 'node going away', connectedForMs: 4200 },
    ])
    // A close frame without a status (1005) is still the node's close.
    const again = f.attach()
    again.transport.remoteClose(1005, '')
    expect(f.journal.events.at(-1)).toMatchObject({ cause: 'closed_by_node', closeCode: 1005 })
  })

  it('no close frame (1006, or a transport that gives no code) is abnormal; a transport error is its own cause', () => {
    const f = setup()
    f.attach('node-a').transport.remoteClose(1006, '')
    f.attach('node-b').transport.remoteClose()
    f.attach('node-c').transport.fail()
    expect(f.journal.events.filter((e) => e.type === 'disconnected')).toEqual([
      expect.objectContaining({ nodeId: 'node-a', cause: 'abnormal', closeCode: 1006 }),
      expect.objectContaining({ nodeId: 'node-b', cause: 'abnormal' }),
      expect.objectContaining({ nodeId: 'node-c', cause: 'transport_error' }),
    ])
    expect(f.journal.events.find((e) => e.type === 'disconnected' && e.nodeId === 'node-b')).not.toHaveProperty('closeCode')
    expect(f.hub.size).toBe(0)
  })

  it('the same node attaching again: the old one is replaced (and just ended), then the new one connects', () => {
    const f = setup()
    const first = f.attach()
    const second = f.attach()
    expect(f.journal.events).toEqual([
      { type: 'connected', nodeId: 'node-a', generation: first.generation },
      expect.objectContaining({ type: 'disconnected', nodeId: 'node-a', generation: first.generation, cause: 'replaced' }),
      { type: 'connected', nodeId: 'node-a', generation: second.generation },
    ])
    expect(first.transport.closedWith).toEqual([[undefined, undefined]])
    expect(f.hub.connection('node-a')).toMatchObject({ generation: second.generation })
  })

  it('a refused attach says why: offline, busy, denied', async () => {
    const f = setup()
    const closedTransport = new FakeTransport()
    closedTransport.status = 'closed'
    expect(f.attach('node-x', closedTransport).attached).toMatchObject({ success: false, code: 'offline' })
    for (let i = 0; i < 32; i++) f.attach(`node-${i}`)
    expect(f.attach('node-33').attached).toMatchObject({ success: false, code: 'busy' })
    const forged = { ...authority('node-forged'), permissionVersion: -1 }
    expect(f.hub.attach({ authority: forged, verify: async () => forged }, new FakeTransport())).toMatchObject({ success: false, code: 'denied' })
    await f.hub.close({ reason: 'SIGTERM' })
    expect(f.attach('node-late').attached).toMatchObject({ success: false, code: 'offline' })
    const refusals = f.journal.events.filter((e) => e.type === 'disconnected' && e.cause === 'refused')
    expect(refusals).toEqual([
      { type: 'disconnected', nodeId: 'node-x', cause: 'refused', code: 'offline' },
      { type: 'disconnected', nodeId: 'node-33', cause: 'refused', code: 'busy' },
      { type: 'disconnected', nodeId: 'node-forged', cause: 'refused', code: 'denied' },
      { type: 'disconnected', nodeId: 'node-late', cause: 'refused', code: 'offline' },
    ])
  })

  it('closing at server stop: server_stopping first, every node closed with 1012, resolved only once the journal has it', async () => {
    const f = setup()
    const a = f.attach('node-a')
    const b = f.attach('node-b')
    const gate = deferred<void>()
    f.journal.gate = gate.promise
    let resolved = false
    const closing = f.hub.close({ reason: 'deploy', build: 'b1', signal: 'SIGTERM', nextBuild: 'b2' }).then(() => { resolved = true })
    // Closed on the call itself, before anything resolves.
    expect(a.transport.closedWith).toEqual([[1012, 'server stopping: deploy']])
    expect(b.transport.closedWith).toEqual([[1012, 'server stopping: deploy']])
    expect(f.journal.events.slice(2).map((e) => e.type === 'disconnected' ? `${e.nodeId}:${e.cause}` : e.type))
      .toEqual(['server_stopping', 'node-a:server_stopping', 'node-b:server_stopping'])
    expect(f.journal.events[2]).toEqual({ type: 'server_stopping', reason: 'deploy', build: 'b1', signal: 'SIGTERM', nextBuild: 'b2' })
    await flush()
    expect(resolved).toBe(false)
    gate.resolve()
    await closing
    expect(resolved).toBe(true)
    // A second close records nothing more.
    await f.hub.close({ reason: 'SIGTERM' })
    expect(f.journal.events.filter((e) => e.type === 'server_stopping')).toHaveLength(1)
  })

  it('a malformed frame is a protocol error, closed 1008; a failed credential check is revoked', async () => {
    let current: Authority | undefined = authority()
    const f = setup(async () => current)
    const bad = f.attach()
    bad.transport.deliverRaw('not a frame')
    bad.transport.deliverRaw(Buffer.from('binary'))
    expect(f.journal.events.at(-1)).toMatchObject({ type: 'disconnected', cause: 'protocol_error' })
    expect(bad.transport.closedWith).toEqual([[1008, 'invalid feature frame']])
    const next = f.attach()
    next.transport.deliver({ protocolVersion: 1, type: 'manifest', capabilities: [capability] })
    current = undefined
    expect(await f.hub.check('node-a', next.generation!)).toBe(false)
    await flush()
    expect(f.journal.events.at(-1)).toMatchObject({ type: 'disconnected', generation: next.generation, cause: 'revoked' })
  })

  it('a non-string frame (what the ws adapter hands over for a binary frame) is refused, even valid JSON', () => {
    const f = setup()
    const { transport } = f.attach()
    transport.deliverRaw(Buffer.from('{"protocolVersion":1,"type":"manifest","capabilities":[]}'))
    expect(transport.closedWith).toEqual([[1008, 'invalid feature frame']])
    expect(f.journal.events.at(-1)).toMatchObject({ cause: 'protocol_error', closeCode: 1008 })
  })

  it('a credential check that times out or throws is credential_check_failed, not revoked', async () => {
    const held = deferred<Authority | undefined>()
    const f = setup(() => held.promise)
    const slow = f.attach()
    const checking = f.hub.check('node-a', slow.generation!)
    await flush()
    f.clock.advance(1000)
    expect(await checking).toBe(false)
    expect(f.journal.events.at(-1)).toMatchObject({ type: 'disconnected', generation: slow.generation, cause: 'credential_check_failed' })
    held.resolve(authority())
    await flush()
    expect(f.journal.events.filter((e) => e.type === 'disconnected')).toHaveLength(1)
    const g = setup(() => Promise.reject(new Error('store unreadable')))
    const broken = g.attach()
    expect(await g.hub.check('node-a', broken.generation!)).toBe(false)
    expect(g.journal.events.at(-1)).toMatchObject({ cause: 'credential_check_failed' })
  })

  it('disconnect() from the runtime ends only that generation, once', () => {
    const f = setup()
    const first = f.attach()
    f.hub.disconnect('node-a', 'some-other-generation', 'credential_check_failed')
    expect(f.hub.size).toBe(1)
    f.hub.disconnect('node-a', first.generation!, 'credential_check_failed')
    f.hub.disconnect('node-a', first.generation!, 'credential_check_failed')
    expect(f.journal.events.filter((e) => e.type === 'disconnected')).toEqual([
      expect.objectContaining({ generation: first.generation, cause: 'credential_check_failed' }),
    ])
    expect(first.transport.closedWith).toEqual([[undefined, undefined]])
  })

  it('a hub without a journal works as before, and a throwing journal never stops a connection', () => {
    const plain = new FeatureNodeHub(new FakeClock())
    hubs.push(plain)
    expect(plain.attach({ authority: authority(), verify: async () => authority() }, new FakeTransport())).toMatchObject({ success: true })
    const broken = new FeatureNodeHub(new FakeClock(), { record: () => { throw new Error('disk gone') } })
    hubs.push(broken)
    const transport = new FakeTransport()
    expect(broken.attach({ authority: authority(), verify: async () => authority() }, transport)).toMatchObject({ success: true })
    transport.remoteClose(4000, 'bye')
    expect(broken.size).toBe(0)
  })

  it('journals identifiers only, through a real journal file, in order', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'walnut-fn-hub-journal-'))
    try {
      const file = path.join(dir, 'connections.jsonl')
      const journal = new ConnectionJournal(file)
      const clock = new FakeClock()
      const hub = new FeatureNodeHub(clock, journal)
      const transport = new FakeTransport()
      const attached = hub.attach({ authority: authority(), verify: async () => authority() }, transport)
      expect(attached.success).toBe(true)
      hub.attach({ authority: authority(), verify: async () => authority() }, new FakeTransport())
      await hub.close({ reason: 'companion-update', build: 'b1' })
      const text = fs.readFileSync(file, 'utf8')
      expect(text).not.toContain('account-a')
      expect(text).not.toContain('catalog')
      expect(text.trim().split('\n').map((l) => JSON.parse(l)).map((e) => `${e.type}:${e.cause ?? ''}`))
        .toEqual(['connected:', 'disconnected:replaced', 'connected:', 'server_stopping:', 'disconnected:server_stopping'])
    } finally { fs.rmSync(dir, { recursive: true, force: true }) }
  })
})
