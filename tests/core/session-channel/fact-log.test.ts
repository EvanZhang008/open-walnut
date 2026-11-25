/**
 * The host's fact log (src/core/session-channel/fact-log.ts): order and durability, recovery
 * after a crash, the inline cap, compaction, and the size it keeps for 10 busy sessions while the
 * leader is away for 24 hours.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { FACT_FLUSH_MS, FACT_INLINE_CAP, FactLog, compactRecords, cutRowFields, type FactRecord } from '../../../src/core/session-channel/fact-log.js'

let dir = ''
beforeEach(async () => { dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'fact-log-')) })
afterEach(async () => { await fsp.rm(dir, { recursive: true, force: true }) })

const open = (over: Partial<Parameters<typeof FactLog.open>[0]> = {}) => FactLog.open({ dir, walnutId: 'w1', flushMs: 1, ...over })

describe('appending', () => {
  it('numbers records in call order, per log and per session, and tells listeners only once durable', async () => {
    const log = await open()
    const heard: FactRecord[] = []
    log.onDurable((r) => heard.push(...r))
    const a = log.append('s1', 'session:user-line', { text: 'hi' })
    const b = log.append('s2', 'session:user-line', { text: 'yo' })
    const c = log.append('s1', 'session:result', { result: 'ok' })
    expect([a.seq, b.seq, c.seq]).toEqual([1, 2, 3])
    expect([a.sseq, b.sseq, c.sseq]).toEqual([1, 1, 2])
    expect(heard).toEqual([])
    expect(log.head).toBe(0)
    await log.flush()
    expect(heard.map((r) => r.seq)).toEqual([1, 2, 3])
    expect(log.head).toBe(3)
    expect((await log.read(1)).map((r) => r.seq)).toEqual([2, 3])
    await log.close()
  })

  it('reopens where it was: the same log id, seq and sseq go on', async () => {
    let log = await open()
    log.append('s1', 'session:user-line', {})
    log.append('s1', 'session:result', {})
    await log.close()
    const id = log.logId
    log = await open()
    expect(log.logId).toBe(id)
    expect(log.head).toBe(2)
    const n = log.append('s1', 'session:user-line', {})
    expect([n.seq, n.sseq]).toEqual([3, 3])
    await log.close()
  })

  it('a torn last line from a crash is cut at open, and the next record starts a line of its own', async () => {
    let log = await open()
    log.append('s1', 'session:user-line', { text: 'one' })
    await log.close()
    const file = path.join(dir, 'facts-w1.ndjson')
    await fsp.appendFile(file, '{"v":2,"seq":2,"kind":"session-fa')
    log = await open()
    expect(log.head).toBe(1)
    log.append('s1', 'session:result', {})
    await log.flush()
    expect((await log.read(0)).map((r) => [r.seq, r.name])).toEqual([[1, 'session:user-line'], [2, 'session:result']])
    expect(fs.readFileSync(file, 'utf8').trim().split('\n').every((l) => JSON.parse(l))).toBeTruthy()
    await log.close()
  })

  it('a record kept twice (a batch written again after its sync failed) is read once', async () => {
    let log = await open()
    log.append('s1', 'session:user-line', { text: 'one' })
    log.append('s1', 'session:result', {})
    await log.close()
    const file = path.join(dir, 'facts-w1.ndjson')
    const lines = fs.readFileSync(file, 'utf8').trim().split('\n')
    await fsp.appendFile(file, lines.map((l) => l + '\n').join(''))
    log = await open()
    expect((await log.read(0)).map((r) => r.seq)).toEqual([1, 2])
    expect(log.head).toBe(2)
    await log.close()
  })

  it('a rename continues the old id\'s sseq', async () => {
    const log = await open()
    log.append('old-id', 'session:user-line', {})
    log.append('old-id', 'session:result', {})
    expect(log.append('new-id', 'rename', { from: 'old-id' }, { continueFrom: 'old-id' }).sseq).toBe(3)
    await log.close()
  })

  it('a long string is cut on disk and named with its line; the live record is whole', async () => {
    const log = await open({ inlineCap: 100 })
    const heard: FactRecord[] = []
    log.onDurable((r) => heard.push(...r))
    const big = 'x'.repeat(5000)
    log.append('s1', 'session:tool-result', { content: [{ text: big }], toolUseId: 't1' }, { line: { epoch: 'e1', v: 9000 } })
    await log.flush()
    expect((heard[0].data as { content: { text: string }[] }).content[0].text).toBe(big)
    const [disk] = await log.read(0)
    expect((disk.data as { content: { text: string }[] }).content[0].text.length).toBe(100)
    expect(disk.refs).toEqual({ 'content.0.text': { epoch: 'e1', v: 9000, bytes: 5000 } })
    await log.close()
  })

  it('names nothing outside its own files: an id that would leave the directory is refused', async () => {
    await expect(FactLog.open({ dir, walnutId: '../evil' })).rejects.toThrow(/bad walnut id/)
    const log = await open()
    expect(() => log.append('../s', 'session:result', {})).toThrow(/bad session id/)
    await log.close()
  })
  it('by default gathers the appends of 50 ms into one write: a busy host costs its leader one transaction per window, not per tool call', async () => {
    expect(FACT_FLUSH_MS).toBe(50)
    const log = await FactLog.open({ dir, walnutId: 'w1', durable: false })
    const batches: number[][] = []
    log.onDurable((r) => batches.push(r.map((x) => x.seq)))
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    try {
      log.append('s1', 'session:tool-use', { i: 1 })
      // Async: a window that closed takes its batch in the microtasks after its timer.
      await vi.advanceTimersByTimeAsync(40)
      log.append('s1', 'session:tool-result', { i: 1 })
      await vi.advanceTimersByTimeAsync(20)
    } finally {
      vi.useRealTimers()
    }
    await log.flush()
    expect(batches).toEqual([[1, 2]])
    await log.close()
  })
})

const rec = (seq: number, sid: string, name: string, data: unknown = {}, v?: number): FactRecord =>
  ({ v: 2, seq, opId: `o${seq}`, rev: 1, at: seq, kind: 'session-fact', sid, sseq: seq, name, data, ...(v ? { line: { v } } : {}) })

describe('a row record is never cut (2026-11-24: a spawn prompt replayed cut at 16 KB)', () => {
  it('keeps every field of a row whole on disk, however long', async () => {
    const log = await open({ inlineCap: 100 })
    const prompt = 'p'.repeat(5000)
    log.append('s1', 'row', { patch: { appliedAppendSystemPrompt: prompt } })
    await log.flush()
    const [disk] = await log.read(0)
    expect((disk.data as { patch: { appliedAppendSystemPrompt: string } }).patch.appliedAppendSystemPrompt).toBe(prompt)
    expect(disk.refs).toBeUndefined()
    await log.close()
  })

  it('names the fields an older log cut, by its refs or, merged by its compaction, by their cut length', () => {
    const cutByRefs = { name: 'row', data: { patch: { appliedAppendSystemPrompt: 'x'.repeat(10), title: 't' } }, refs: { 'patch.appliedAppendSystemPrompt': { bytes: 99 } } }
    expect(cutRowFields(cutByRefs)).toEqual(['appliedAppendSystemPrompt'])
    expect(cutRowFields({ name: 'row', data: { patch: { appliedAppendSystemPrompt: 'y'.repeat(FACT_INLINE_CAP), model: 'm' } } })).toEqual(['appliedAppendSystemPrompt'])
    expect(cutRowFields({ name: 'session:tool-result', data: {}, refs: { 'content.0.text': { bytes: 5 } } })).toEqual([])
  })

  it('compaction carries what an older log cut onto the merged row, until a later patch sets the field again', () => {
    const cut: FactRecord = { ...rec(1, 's1', 'row', { patch: { appliedAppendSystemPrompt: 'cut', placeNoted: 'a' } }), refs: { 'patch.appliedAppendSystemPrompt': { bytes: 99 }, 'patch.placeNoted': { bytes: 99 } } }
    const out = compactRecords([cut, rec(2, 's1', 'row', { patch: { placeNoted: 'whole' } }), rec(3, 's1', 'session:result', {}, 5)])
    const row = out.find((r) => r.name === 'row')!
    expect(Object.keys(row.refs ?? {})).toEqual(['patch.appliedAppendSystemPrompt'])
    expect(cutRowFields(row)).toEqual(['appliedAppendSystemPrompt'])
  })
})

describe('compaction', () => {
  it('a finished turn keeps its result, one summary for its tool facts and one merged row patch; a running turn stays whole', () => {
    const out = compactRecords([
      rec(1, 's1', 'session:user-line', {}, 10),
      rec(2, 's1', 'row', { patch: { process_status: 'running' } }),
      rec(3, 's1', 'session:tool-use', { name: 'Bash' }, 20),
      rec(4, 's2', 'session:tool-use', { name: 'Read' }, 5),
      rec(5, 's1', 'session:tool-result', {}, 30),
      rec(6, 's1', 'session:tool-use', { name: 'Bash' }, 40),
      rec(7, 's1', 'row', { patch: { messageCount: 3 } }),
      rec(8, 's1', 'session:result', { result: 'done' }, 50),
      rec(9, 's1', 'session:tool-use', { name: 'Edit' }, 60),
    ])
    expect(out.map((r) => [r.seq, r.sid, r.name])).toEqual([
      [1, 's1', 'turn-summary'], [4, 's2', 'session:tool-use'], [7, 's1', 'row'], [8, 's1', 'session:result'], [9, 's1', 'session:tool-use'],
    ])
    expect(out[0].data).toMatchObject({ facts: 4, toolUses: 2, tools: { Bash: 2 }, vFrom: 10, vTo: 40 })
    expect(out[2].data).toEqual({ patch: { process_status: 'running', messageCount: 3 } })
  })

  it('only the newest live state of each session stays', () => {
    const out = compactRecords([
      rec(1, 's1', 'live', { state: { turnGen: 1 } }), rec(2, 's2', 'live', { state: { turnGen: 1 } }),
      rec(3, 's1', 'live', { state: { turnGen: 2 } }), rec(4, 's1', 'session:tool-use', {}),
    ])
    expect(out.map((r) => [r.seq, r.sid, r.name])).toEqual([[2, 's2', 'live'], [3, 's1', 'live'], [4, 's1', 'session:tool-use']])
  })

  it('a session the leader deleted keeps only its drop record; other sessions stay as they were', () => {
    const out = compactRecords([
      rec(1, 's1', 'row', { born: true, patch: {} }), rec(2, 's1', 'session:tool-use', {}), rec(3, 's2', 'session:tool-use', {}),
      rec(4, 's1', 'live', { state: {} }), rec(5, 's1', 'drop', { sid: 's1' }), rec(6, 's2', 'session:result', {}),
    ])
    expect(out.map((r) => [r.seq, r.sid, r.name])).toEqual([[3, 's2', 'session:tool-use'], [5, 's1', 'drop'], [6, 's2', 'session:result']])
  })

  it('acked records go at compaction, and a reader below the floor learns it', async () => {
    const log = await open()
    for (let i = 0; i < 10; i++) log.append('s1', i % 2 ? 'session:result' : 'session:user-line', { i })
    await log.flush()
    await log.ack(6)
    await log.compact()
    expect(log.floor).toBe(7)
    expect((await log.read(0)).map((r) => r.seq)).toEqual([7, 8, 9, 10])
    await log.close()
  })
})

describe('snapshot facts while the leader is away (2026-11-25: 1,242 ledger snapshots of 74 KB in one running turn, 102 MB unread)', () => {
  it('a running turn keeps only the newest snapshot of each kind per session; its other facts stay', () => {
    const out = compactRecords([
      rec(1, 's1', 'session:background-tasks', { tasks: [1] }), rec(2, 's1', 'session:tool-use', {}),
      rec(3, 's2', 'session:background-tasks', { tasks: [9] }), rec(4, 's1', 'session:background-tasks', { tasks: [1, 2] }),
      rec(5, 's1', 'session:team-info', { members: [] }), rec(6, 's1', 'session:turn-speed', { speed: 1 }),
      rec(7, 's1', 'session:turn-speed', { speed: 2 }), rec(8, 's1', 'session:model-catalog', { models: [] }),
      rec(9, 's1', 'session:model-catalog', { models: [1] }), rec(10, 's1', 'session:team-info', { members: [1] }),
    ])
    expect(out.map((r) => [r.seq, r.sid, r.name])).toEqual([
      [2, 's1', 'session:tool-use'], [3, 's2', 'session:background-tasks'], [4, 's1', 'session:background-tasks'],
      [7, 's1', 'session:turn-speed'], [9, 's1', 'session:model-catalog'], [10, 's1', 'session:team-info'],
    ])
  })

  it('a finished turn still folds its snapshots into its summary, and a later snapshot never takes the summary away', () => {
    const out = compactRecords([
      rec(1, 's1', 'session:background-tasks', { tasks: [1] }), rec(2, 's1', 'session:tool-use', { name: 'Bash' }),
      rec(3, 's1', 'session:result', {}), rec(4, 's1', 'session:background-tasks', { tasks: [1, 2] }),
    ])
    expect(out.map((r) => [r.seq, r.name])).toEqual([[1, 'turn-summary'], [3, 'session:result'], [4, 'session:background-tasks']])
    expect((out[0].data as { facts: number }).facts).toBe(2)
  })

  it('a long turn with a busy ledger stays small on disk, and the file is not rewritten at every flush', async () => {
    const said: string[] = []
    const log = await open({ durable: false, compactBytes: 1024 * 1024, log: (_l, msg) => { said.push(msg) } })
    const ledger = Array.from({ length: 180 }, (_, i) => ({ taskId: `b${i}`, status: 'completed', description: 'Build and run all rehearsals on HEAD', startedAt: i, endedAt: i + 1 }))
    for (let i = 0; i < 1200; i++) {
      log.append('s1', 'session:background-tasks', { sessionId: 's1', inFlight: 1, tasks: ledger.slice(0, 1 + (i % 180)) })
      if (i % 3 === 0) log.append('s1', 'session:tool-use', { name: 'Bash' })
      if (i % 20 === 19) await log.flush()
    }
    await log.flush()
    const size = (await fsp.stat(path.join(dir, 'facts-w1.ndjson'))).size
    expect(size).toBeLessThan(2 * 1024 * 1024)
    await log.compact()
    const kept = await log.read(0)
    expect(kept.filter((r) => r.name === 'session:background-tasks')).toHaveLength(1)
    expect(kept.filter((r) => r.name === 'session:tool-use')).toHaveLength(400)
    // Each compaction at least halves what it was given, or the next waits until the file doubles.
    expect(said.filter((m) => m === 'fact log: compacted').length).toBeLessThan(40)
    await log.close()
  })

  it('a leader catching up, acking a little at a time, does not make every ack rewrite the unread rest', async () => {
    const said: string[] = []
    const log = await open({ durable: false, compactBytes: 64 * 1024, log: (_l, msg) => { said.push(msg) } })
    const body = 'x'.repeat(1000)
    for (let i = 0; i < 400; i++) log.append('s1', 'session:tool-use', { name: 'Bash', input: body })
    await log.flush()
    const before = said.filter((m) => m === 'fact log: compacted').length
    for (let upTo = 10; upTo <= 400; upTo += 10) await log.ack(upTo)
    // 40 acks: a compaction only when half of what is left is confirmed, a handful, never one per ack.
    const n = said.filter((m) => m === 'fact log: compacted').length - before
    expect(n).toBeGreaterThan(0)
    expect(n).toBeLessThanOrEqual(8)
    expect(log.floor).toBeGreaterThan(200)
    await log.close()
  })

  it('what compaction cannot drop is not read and rewritten again until the file doubles', async () => {
    const said: string[] = []
    const log = await open({ durable: false, compactBytes: 64 * 1024, log: (_l, msg) => { said.push(msg) } })
    const body = 'x'.repeat(1000)
    for (let i = 0; i < 400; i++) {
      log.append('s1', 'session:tool-use', { name: 'Bash', input: body })
      await log.flush()
    }
    // 400 flushes past the size of 64 KB: a handful of compactions (64, 128, 256 KB), never one per flush.
    const n = said.filter((m) => m === 'fact log: compacted').length
    expect(n).toBeGreaterThan(0)
    expect(n).toBeLessThanOrEqual(4)
    expect((await log.read(0))).toHaveLength(400)
    await log.close()
  })
})

describe('size while the leader is away', () => {
  it('10 busy sessions for 24 hours with nothing confirmed stay under 64 MB', async () => {
    const log = await open({ durable: false, flushMs: 1000, compactBytes: 8 * 1024 * 1024 })
    const result = 'r'.repeat(800)
    const toolOut = 'o'.repeat(2000)
    const bigOut = 'B'.repeat(60_000)
    let t = 0
    // A busy session: a turn every 2 minutes, 24 hours: 720 turns, each with a prompt, 15 tool
    // calls and their results (every fifth result 60 KB), 3 usage updates, 2 system events,
    // 4 row patches and its result.
    for (let turn = 0; turn < 720; turn++) {
      for (let s = 0; s < 10; s++) {
        const sid = `sess-${s}`
        log.append(sid, 'session:user-line', { text: 'please continue with the next step of the plan' }, { at: ++t })
        for (let k = 0; k < 15; k++) {
          log.append(sid, 'session:tool-use', { name: 'Bash', input: { command: 'bun run test tests/core/x.test.ts' } }, { at: ++t, line: { v: t } })
          log.append(sid, 'session:tool-result', { toolUseId: `t${k}`, content: k % 5 === 0 ? bigOut : toolOut }, { at: ++t, line: { v: t } })
          if (k % 5 === 0) log.append(sid, 'session:usage-update', { input: 1000 + k, output: 200 }, { at: ++t })
          if (k % 4 === 0) log.append(sid, 'row', { patch: { activity: `step ${k}`, messageCount: turn } }, { at: ++t })
        }
        log.append(sid, 'session:system-event', { subtype: 'status' }, { at: ++t })
        log.append(sid, 'session:system-event', { subtype: 'status' }, { at: ++t })
        log.append(sid, 'session:result', { result, usage: { input: 9000, output: 900 } }, { at: ++t })
      }
      if (turn % 10 === 9) await log.flush()
    }
    await log.flush()
    await log.compact()
    const size = (await fsp.stat(path.join(dir, 'facts-w1.ndjson'))).size
    expect(size).toBeLessThan(64 * 1024 * 1024)
    // Every turn's result is still there, once.
    const kept = await log.read(0)
    expect(kept.filter((r) => r.name === 'session:result').length).toBe(7200)
    console.log(`fact log after 24h x 10 busy sessions: ${(size / 1024 / 1024).toFixed(1)} MB, ${kept.length} records`)
    await log.close()
  }, 300_000)
})
