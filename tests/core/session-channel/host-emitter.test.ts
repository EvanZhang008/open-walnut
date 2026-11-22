/**
 * The host's emitter (src/core/session-channel/host-emitter.ts): bus events and row writes of the
 * sessions this host owns become channel records, in order; flow goes to the channel only; the
 * leader's and the commands' events are never kept; a session that is not this host's never
 * reaches the log; row patches carry only what changed; `live` is written at most once per window
 * and only when it changed.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { EventBus } from '../../../src/core/event-bus.js'
import { FactLog, type FactRecord } from '../../../src/core/session-channel/fact-log.js'
import { createHostEmitter, rowPatch, sessionIdOf, type HostEmitter } from '../../../src/core/session-channel/host-emitter.js'
import type { LiveState } from '../../../src/core/session-channel/host-api.js'
import type { SessionRecord } from '../../../src/core/types.js'

const HOST = 'marina-box'
const OWN = '11111111-1111-4111-8111-111111111111'
const FOREIGN = '22222222-2222-4222-8222-222222222222'
const LATE = '33333333-3333-4333-8333-333333333333'

let dir = ''
let log: FactLog
let bus: EventBus
let emitter: HostEmitter
let rowFn: ((row: SessionRecord) => void) | null = null
let flows: Array<[string, string]> = []
let live = new Map<string, LiveState>()
let offset = 0

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
function row(sid: string, over: Partial<SessionRecord> = {}): SessionRecord {
  return {
    claudeSessionId: sid, taskId: 'task-marina-1', project: 'Marina', process_status: 'running', mode: 'default',
    startedAt: '2026-11-22T00:00:00.000Z', lastActiveAt: '2026-11-22T00:00:00.000Z', last_status_change: '2026-11-22T00:00:00.000Z',
    messageCount: 1, host: HOST, judge: 'host', streamEpoch: 'ep1', ...over,
  } as SessionRecord
}
/** Where the log stood once the emitter started (its start writes each own row whole first). */
let startHead = 0
async function records(from = startHead): Promise<FactRecord[]> {
  await log.flush()
  return log.read(from)
}

async function make(opts: { own?: SessionRecord[]; pendingMs?: number; liveMs?: number } = {}): Promise<void> {
  emitter = createHostEmitter({
    log, channel: { flow: (sid: string, name: string) => { flows.push([sid, name]) } } as never, hostKey: HOST,
    ownRows: async () => opts.own ?? [],
    liveOf: (sid) => live.get(sid) ?? null,
    offsetOf: () => offset,
    bus, rowListener: (fn) => { rowFn = fn },
    liveMs: opts.liveMs ?? 30, pendingMs: opts.pendingMs ?? 200,
  })
  await emitter.start()
  await log.flush()
  startHead = log.head
}

beforeEach(async () => {
  dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'host-emitter-'))
  log = await FactLog.open({ dir, walnutId: 'w1', flushMs: 1, durable: false })
  bus = new EventBus()
  flows = []
  live = new Map()
  offset = 0
  rowFn = null
  startHead = 0
})
afterEach(async () => {
  emitter?.stop()
  await log.close()
  await fsp.rm(dir, { recursive: true, force: true })
})

describe('sessionIdOf and rowPatch', () => {
  it('reads the id an event names, a transfer by its actual id', () => {
    expect(sessionIdOf('session:result', { sessionId: 'a' })).toBe('a')
    expect(sessionIdOf('session:started', { claudeSessionId: 'b' })).toBe('b')
    expect(sessionIdOf('transfer:fork-init', { actualId: 'c', preassignedId: 'x' })).toBe('c')
    expect(sessionIdOf('session:result', null)).toBeNull()
  })

  it('names what changed, null for what was cleared, and never a leader field', () => {
    const p = rowPatch(row(OWN, { messageCount: 1, errorMessage: 'x', title: 'a' }), row(OWN, { messageCount: 2, title: 'b' }))
    expect(p).toEqual({ messageCount: 2, errorMessage: null })
  })
})

describe('the emitter', () => {
  it('keeps the facts of its own session in order with their line, sends flow, and keeps nothing of the rest', async () => {
    await make({ own: [row(OWN)] })
    offset = 42
    bus.emit('session:tool-use', { sessionId: OWN, name: 'Bash' }, ['x'])
    bus.emit('session:text-delta', { sessionId: OWN, delta: 'hi' }, ['x'])
    bus.emit('session:status-changed', { sessionId: OWN }, ['x'])
    bus.emit('session:send', { sessionId: OWN, message: 'm' }, ['x'])
    bus.emit('session:result', { sessionId: OWN, result: 'done' }, ['x'])
    bus.emit('session:result', { sessionId: OWN, result: 'echo' }, ['x'], { source: 'host-channel' })
    const recs = await records()
    expect(recs.map((r) => r.name)).toEqual(['session:tool-use', 'session:result'])
    expect(recs[0]!.line).toEqual({ epoch: 'ep1', v: 42 })
    // The start's whole row of the session took its first place in the sequence.
    expect(recs.map((r) => r.sseq)).toEqual([2, 3])
    // Each keeps the destinations its emit named, for the leader to say it to the same subscribers.
    expect(recs.map((r) => r.to)).toEqual([['x'], ['x']])
    expect(flows).toEqual([[OWN, 'session:text-delta']])
  })

  it('ignores a session that is not this host\'s: its events, its flow and its row writes', async () => {
    await make({ own: [row(OWN)], pendingMs: 50 })
    rowFn!(row(FOREIGN, { judge: undefined }))
    rowFn!(row(FOREIGN, { host: 'another-box' }))
    bus.emit('session:result', { sessionId: FOREIGN, result: 'x' }, ['x'])
    bus.emit('session:text-delta', { sessionId: FOREIGN, delta: 'x' }, ['x'])
    await sleep(120)
    expect(await records()).toEqual([])
    expect(flows).toEqual([])
  })

  it('writes the first row it sees as born, then only patches, and nothing for a write that changed no host field', async () => {
    await make()
    rowFn!(row(OWN))
    rowFn!(row(OWN, { messageCount: 2, process_status: 'idle' }))
    rowFn!(row(OWN, { messageCount: 2, process_status: 'idle', title: 'Renamed by the leader' }))
    rowFn!(row(OWN, { messageCount: 2, process_status: 'idle', title: 'Renamed by the leader', errorMessage: undefined }))
    const recs = await records()
    expect(recs.map((r) => r.name)).toEqual(['row', 'row'])
    expect(recs[0]!.data).toMatchObject({ born: true, patch: { claudeSessionId: OWN, judge: 'host', host: HOST } })
    expect(recs[1]!.data).toEqual({ patch: { messageCount: 2, process_status: 'idle' } })
  })

  it('a row this host already had at start is patched, never born again', async () => {
    await make({ own: [row(OWN)] })
    rowFn!(row(OWN, { messageCount: 5 }))
    const recs = await records()
    expect(recs.map((r) => r.data)).toEqual([{ patch: { messageCount: 5 } }])
  })

  it('its start writes each own row whole once (a resync, never a start), so a write before it reaches the leader', async () => {
    await make({ own: [row(OWN, { messageCount: 9 }), row(FOREIGN, { host: 'another-box' })] })
    const recs = await records(0)
    expect(recs.map((r) => [r.sid, r.name])).toEqual([[OWN, 'row']])
    expect(recs[0]!.data).toMatchObject({ resync: true, patch: { claudeSessionId: OWN, messageCount: 9 } })
    expect((recs[0]!.data as { born?: unknown }).born).toBeUndefined()
    // The leader asks again for a row it could not apply: the same whole row, own rows only.
    await emitter.resync([OWN, FOREIGN])
    expect((await records()).map((r) => [r.sid, r.name, (r.data as { resync?: unknown }).resync])).toEqual([[OWN, 'row', true]])
  })

  it('a patch the log did not take rides the next one', async () => {
    await make({ own: [row(OWN)] })
    const append = log.append.bind(log)
    let fail = true
    log.append = ((...a: Parameters<typeof log.append>) => { if (fail) { fail = false; throw new Error('disk full') } return append(...a) }) as typeof log.append
    rowFn!(row(OWN, { process_status: 'stopped' }))
    rowFn!(row(OWN, { process_status: 'stopped', messageCount: 3 }))
    expect((await records()).map((r) => r.data)).toEqual([{ patch: { process_status: 'stopped', messageCount: 3 } }])
  })

  it('holds the events that beat their row, and keeps them after the born row in order', async () => {
    await make()
    bus.emit('session:started', { sessionId: LATE }, ['x'])
    bus.emit('session:tool-use', { sessionId: LATE, name: 'Read' }, ['x'])
    rowFn!(row(LATE))
    bus.emit('session:result', { sessionId: LATE, result: 'r' }, ['x'])
    const recs = await records()
    expect(recs.map((r) => r.name)).toEqual(['row', 'session:started', 'session:tool-use', 'session:result'])
    expect(recs.map((r) => r.sseq)).toEqual([1, 2, 3, 4])
  })

  it('drops held events whose row never becomes this host\'s', async () => {
    await make({ pendingMs: 40 })
    bus.emit('session:started', { sessionId: LATE }, ['x'])
    await sleep(90)
    rowFn!(row(LATE))
    const recs = await records()
    expect(recs.map((r) => r.name)).toEqual(['row'])
  })

  it('writes live at most once per window, only when it changed, and not for the restless fields alone', async () => {
    await make({ own: [row(OWN)], liveMs: 30 })
    live.set(OWN, { turnGen: 1, processStatus: 'running', consumedOffset: 10 })
    for (let i = 0; i < 20; i++) bus.emit('session:tool-use', { sessionId: OWN, name: 'Bash' }, ['x'])
    await sleep(80)
    bus.emit('session:status-changed', { sessionId: OWN }, ['x'])
    await sleep(80)
    live.set(OWN, { turnGen: 1, processStatus: 'running', consumedOffset: 99 })
    bus.emit('session:status-changed', { sessionId: OWN }, ['x'])
    await sleep(80)
    live.set(OWN, { turnGen: 2, processStatus: 'idle', consumedOffset: 120 })
    bus.emit('session:status-changed', { sessionId: OWN }, ['x'])
    // The last change is written within its window; an extra write before it never matches.
    await vi.waitFor(async () => {
      const lives = (await records()).filter((r) => r.name === 'live').map((r) => (r.data as { state: LiveState }).state)
      expect(lives).toEqual([
        { turnGen: 1, processStatus: 'running', consumedOffset: 10 },
        { turnGen: 2, processStatus: 'idle', consumedOffset: 120 },
      ])
    })
  })

  it('a rename continues the session\'s sequence under the new id; a drop forgets it', async () => {
    await make({ own: [row(OWN)] })
    bus.emit('session:result', { sessionId: OWN, result: 'a' }, ['x'])
    emitter.noteRename(OWN, LATE)
    bus.emit('session:result', { sessionId: LATE, result: 'b' }, ['x'])
    bus.emit('session:result', { sessionId: OWN, result: 'gone' }, ['x'])
    emitter.noteDrop([LATE])
    bus.emit('session:result', { sessionId: LATE, result: 'after drop' }, ['x'])
    await sleep(250)
    const recs = await records()
    expect(recs.map((r) => [r.sid, r.name, r.sseq])).toEqual([
      [OWN, 'session:result', 2], [LATE, 'rename', 3], [LATE, 'session:result', 4], [LATE, 'drop', 5],
    ])
    expect(emitter.ownSessionOfTask('task-marina-1')).toBeNull()
  })

  it('a drop the leader asked for is answered with a drop record, also for a session this host no longer has', async () => {
    await make({ own: [row(OWN)] })
    emitter.noteDrop(['sid-never-here'])
    emitter.noteDrop([OWN, 'sid-never-here'], { answer: true })
    // A drop is appended at once: records() flushes it.
    expect((await records()).map((r) => [r.sid, r.name])).toEqual([[OWN, 'drop'], ['sid-never-here', 'drop']])
    expect(emitter.owns(OWN)).toBe(false)
  })
})
