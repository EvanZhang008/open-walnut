import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { ConnectionJournal, type JournalEvent } from '../../../src/core/feature-nodes/connection-journal.js'

let dir = ''
let file = ''
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'walnut-fn-journal-'))
  file = path.join(dir, 'local', 'feature-nodes', 'connections.jsonl')
})
afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }) })

const lines = () => fs.existsSync(file) ? fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []
const connected = (i: number, nodeId = 'node-a'): JournalEvent => ({ type: 'connected', nodeId, generation: `g:${i}` })

describe('feature node connection journal', () => {
  it('appends asynchronously, keeps the order of record(), and makes its own private dir', async () => {
    const journal = new ConnectionJournal(file)
    for (let i = 0; i < 50; i++) journal.record(connected(i))
    // Nothing is written on the caller's turn: the queue writes later.
    expect(fs.existsSync(file)).toBe(false)
    const flushing = journal.flush()
    journal.record({ type: 'server_stopping', reason: 'deploy', build: 'b1' })
    await flushing
    await journal.flush()
    const got = lines()
    expect(got.map((l) => l.generation ?? l.type)).toEqual([...Array.from({ length: 50 }, (_, i) => `g:${i}`), 'server_stopping'])
    expect(got[0].at).toMatch(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/)
    expect(fs.statSync(path.dirname(file)).mode & 0o777).toBe(0o700)
    expect(fs.statSync(file).mode & 0o777).toBe(0o600)
  })

  it('stays bounded by lines: never past max + slack, and keeps the newest', async () => {
    const journal = new ConnectionJournal(file, { maxLines: 10, slackLines: 5 })
    for (let i = 0; i < 100; i++) {
      journal.record(connected(i))
      if (i % 7 === 0) await journal.flush()
      expect(lines().length).toBeLessThanOrEqual(15)
    }
    await journal.flush()
    const got = lines()
    expect(got.length).toBeLessThanOrEqual(15)
    expect(got.at(-1).generation).toBe('g:99')
    expect(got.map((l) => Number(l.generation.slice(2)))).toEqual([...got.map((l) => Number(l.generation.slice(2)))].sort((a, b) => a - b))
  })

  it('stays bounded by age: a file left by an earlier server loses lines older than the window at the first write', async () => {
    const now = Date.parse('2026-11-04T06:52:00.000Z')
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, [
      JSON.stringify({ at: '2026-10-01T00:00:00.000Z', type: 'connected', nodeId: 'old', generation: 'g:old' }),
      'not json at all',
      JSON.stringify({ at: '2026-11-04T06:00:00.000Z', type: 'connected', nodeId: 'recent', generation: 'g:recent' }),
    ].join('\n') + '\n')
    const journal = new ConnectionJournal(file, { now: () => now, maxAgeMs: 7 * 86_400_000 })
    journal.record(connected(1))
    await journal.flush()
    expect(lines().map((l) => l.generation)).toEqual(['g:recent', 'g:1'])
  })

  it('a file bigger than the tail it reads is rewritten at the first write, so its head goes too', async () => {
    const now = Date.now()
    fs.mkdirSync(path.dirname(file), { recursive: true })
    const filler = JSON.stringify({ at: new Date(now).toISOString(), type: 'connected', nodeId: 'filler', generation: 'g'.repeat(150) })
    // About 2 MB of fresh lines: more than the 1 MB tail, fewer kept than maxLines would allow per byte.
    fs.writeFileSync(file, `${filler}\n`.repeat(Math.ceil((2 * 1024 * 1024) / filler.length)))
    const journal = new ConnectionJournal(file, { maxLines: 100_000 })
    journal.record(connected(1))
    await journal.flush()
    expect(fs.statSync(file).size).toBeLessThanOrEqual(1024 * 1024 + 1024)
    expect(lines().at(-1).generation).toBe('g:1')
  })

  it('never reads back a line older than the age bound, even before a compaction removes it', async () => {
    let t = Date.parse('2026-11-04T06:00:00.000Z')
    const journal = new ConnectionJournal(file, { now: () => t, maxAgeMs: 60_000 })
    journal.record(connected(1))
    await journal.flush()
    t += 120_000
    journal.record(connected(2))
    expect((await journal.read({})).events.map((e) => (e as { generation?: string }).generation)).toEqual(['g:2'])
  })

  it('reads one node plus the server lines, from `since`, the newest `limit` oldest first', async () => {
    let t = Date.parse('2026-11-04T06:50:00.000Z')
    const journal = new ConnectionJournal(file, { now: () => t })
    const at = (ms: number, event: JournalEvent) => { t = Date.parse('2026-11-04T06:50:00.000Z') + ms; journal.record(event) }
    at(0, { type: 'server_started', build: 'b1' })
    at(1000, connected(1))
    at(2000, connected(2, 'node-b'))
    at(140_000, { type: 'server_stopping', reason: 'companion-update', build: 'b1', signal: 'SIGTERM', nextBuild: 'b2' })
    at(140_001, { type: 'disconnected', nodeId: 'node-a', generation: 'g:1', cause: 'server_stopping', closeCode: 1012, connectedForMs: 139_001 })
    at(146_000, { type: 'server_started', build: 'b2' })
    at(147_000, connected(3))
    const a = await journal.read({ nodeId: 'node-a' })
    expect(a.events.map((e) => e.type)).toEqual(['server_started', 'connected', 'server_stopping', 'disconnected', 'server_started', 'connected'])
    expect(a.truncated).toBe(false)
    const since = await journal.read({ nodeId: 'node-a', since: Date.parse('2026-11-04T06:52:20.000Z') })
    expect(since.events.map((e) => e.at)).toEqual([
      '2026-11-04T06:52:20.000Z', '2026-11-04T06:52:20.001Z', '2026-11-04T06:52:26.000Z', '2026-11-04T06:52:27.000Z',
    ])
    const last = await journal.read({ nodeId: 'node-a', limit: 2 })
    expect(last.events.map((e) => e.type)).toEqual(['server_started', 'connected'])
    expect(last.truncated).toBe(true)
    expect((await journal.read({})).events).toHaveLength(7)
  })

  it('records only declared fields, bounded, never an account or token', async () => {
    const journal = new ConnectionJournal(file)
    journal.record({ type: 'connected', nodeId: 'node-a', generation: 'g:1', accountId: 'account-secret', token: 'fn.secret' } as unknown as JournalEvent)
    journal.record({ type: 'disconnected', nodeId: 'node-a', generation: 'g:1', cause: 'closed_by_node', closeCode: 4000,
      closeReason: `bye\n\u0007${'x'.repeat(500)}`, connectedForMs: 12, payload: { secret: 1 } } as unknown as JournalEvent)
    journal.record({ type: 'disconnected', nodeId: 'not a node id!', cause: 'refused', code: 'busy' })
    journal.record({ type: 'disconnected', nodeId: 'node-a', cause: 'made_up' } as unknown as JournalEvent)
    journal.record({ type: 'connected', nodeId: 'node-a' } as unknown as JournalEvent)
    await journal.flush()
    const got = lines()
    expect(got).toHaveLength(3)
    expect(JSON.stringify(got)).not.toMatch(/secret/)
    expect(Object.keys(got[0]).sort()).toEqual(['at', 'generation', 'nodeId', 'type'])
    expect(got[1].closeReason).toHaveLength(120)
    expect(got[1].closeReason).not.toMatch(/[\n\u0007]/)
    expect(got[2]).toMatchObject({ nodeId: null, cause: 'refused', code: 'busy' })
  })

  it('a failed write never throws, loses only its batch, and the next write goes through', async () => {
    const problems: string[] = []
    // The journal dir is a file: every mkdir fails until it is gone.
    fs.mkdirSync(path.dirname(path.dirname(file)), { recursive: true })
    fs.writeFileSync(path.dirname(file), 'in the way')
    const journal = new ConnectionJournal(file, { onProblem: (message) => problems.push(message) })
    journal.record(connected(1))
    await journal.flush()
    expect(problems).toEqual(['feature node journal write failed'])
    fs.rmSync(path.dirname(file))
    journal.record(connected(2))
    await journal.flush()
    expect(lines().map((l) => l.generation)).toEqual(['g:2'])
  })

  it('bounds the queue: past it, events are dropped and said once', async () => {
    const problems: string[] = []
    const journal = new ConnectionJournal(file, { maxQueue: 3, onProblem: (message) => problems.push(message) })
    for (let i = 0; i < 10; i++) journal.record(connected(i))
    // The first went straight to the writer; three waited; the rest were dropped.
    expect(journal.resources).toMatchObject({ queued: 3, dropped: 6 })
    await journal.flush()
    expect(lines().map((l) => l.generation)).toEqual(['g:0', 'g:1', 'g:2', 'g:3'])
    expect(problems).toEqual(['feature node journal queue full: dropping events'])
  })

  it('every line is also handed to the log sink, and a throwing sink changes nothing', async () => {
    const seen: string[] = []
    const journal = new ConnectionJournal(file, { onLine: (entry) => { seen.push(entry.type); throw new Error('sink down') } })
    journal.record({ type: 'server_started', build: 'b1' })
    await journal.flush()
    expect(seen).toEqual(['server_started'])
    expect(lines()).toHaveLength(1)
  })
})
