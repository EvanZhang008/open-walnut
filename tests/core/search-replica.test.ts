/**
 * The companion's copy of the primary's search index: the primary's rounds
 * (core/replication/search-replica.ts) against the REAL companion side
 * (search-replica-store.ts → the hybrid-search copy writer → its own
 * cache/search-replica.sqlite), joined by an in-process transport that carries
 * only what JSON carries. The primary's index is a real index on a temp file
 * with the text fixture embedder, so its docs have real vectors to copy.
 *
 * Pinned: every doc with its vectors arrives (file kinds at the companion's
 * own paths, anything outside the data home left out); once both sides match,
 * a round is one status step and a change is one small delta; memory decides
 * Auto, On is the user's call, Off closes the copy; a restart keeps it; the
 * search path uses it only while it is ready; a manifest that would empty it
 * is refused; an older companion rests the lane.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { createMockConstants } from '../helpers/mock-constants.js'

vi.mock('../../src/constants.js', () => createMockConstants('walnut-search-replica', { CLOUD_MODE: true }))

import { WALNUT_HOME, TASKS_DIR } from '../../src/constants.js'
import { createSearchIndex, type SearchIndex } from '../../src/lib/hybrid-search/index.js'
import * as wiring from '../../src/core/search/wiring.js'
import * as store from '../../src/core/replication/search-replica-store.js'
import {
  syncSearchReplica, noteSearchDocChange, followerSearchStatuses, _resetSearchReplicaForTesting, type SearchReplicaDeps,
} from '../../src/core/replication/search-replica.js'
import type { ReplicaTarget } from '../../src/core/replication/replica-targets.js'
import { companionSearchDecision, wireDocOf, AUTO_MIN_TOTAL_MB } from '../../src/core/replication/search-replica-wire.js'
import { DigestMap } from '../../src/core/replication/search-digest.js'
import { replicaKey, refOfReplicaKey } from '../../src/core/search/replica-refs.js'
import { companionSearchReady } from '../../src/core/search/companion-ready.js'
import { drainBackfill, paragraphs, vecRows } from '../lib/text-embed-index.js'
import type { CompanionSearchMode } from '../../src/core/replication/search-replica-wire.js'

const MAC_HOME = '/Users/someone/.open-walnut'
const TEXT_WORKER = new URL('../lib/fixtures/text-embed-worker.cjs', import.meta.url).pathname

let dir = ''
let src: SearchIndex
let mode: CompanionSearchMode = 'auto'
let totalMb = 8_000
let macAway = false
let companionModel: string | null = 'fake/model'
let calls: Array<{ op: string; n: number; partial?: boolean }> = []
let olderCompanion = false

let companionAvailable = true
const companion: ReplicaTarget = {
  id: 'companion',
  kind: 'companion',
  label: 'Cloud companion',
  available: async () => companionAvailable,
  post: async (payload) => {
    // The wire: the companion sees what JSON carries, never the primary's objects.
    const body = JSON.parse(JSON.stringify(payload)) as Record<string, unknown>
    const n = Array.isArray(body.docs) ? body.docs.length : Array.isArray(body.entries) ? body.entries.length : 0
    calls.push({ op: String(body.op), n, ...(body.partial ? { partial: true } : {}) })
    if (olderCompanion) return { ok: false, outcome: 'failed', status: 400, error: body.op === 'status' ? 'unknown_op' : 'unknown_kind' }
    const r = body.op === 'status' ? await store.searchReplicaStatus(body)
      : body.op === 'sync' ? await store.searchReplicaSync(body)
        : await store.searchReplicaPut(body)
    return r.ok ? { ok: true, reply: r } : { ok: false, outcome: 'failed', status: r.status, error: r.error }
  },
}
let targets: ReplicaTarget[] = [companion]

const deps: SearchReplicaDeps = {
  index: () => src,
  model: () => 'fake/model',
  home: MAC_HOME,
  mode: async () => mode,
  targets: () => targets,
  pause: async () => {},
}

/** One round; the companion's result (the only follower unless a test adds one). */
const round = async () => {
  const all = await syncSearchReplica(deps)
  const { target: _t, ...r } = all.find((x) => x.target === 'companion')!
  return r
}
const companionStatus = () => followerSearchStatuses().find((s) => s.id === 'companion')

function openSource(): SearchIndex {
  return createSearchIndex({
    dbPath: path.join(dir, 'mac-search.sqlite'),
    kinds: wiring.SEARCH_V2_KIND_WEIGHTS,
    embedder: { modelId: 'fake/text:{}', dims: 4, workerPath: TEXT_WORKER },
    onDocChange: noteSearchDocChange,
  })
}

const LANTERN = paragraphs('lantern', 3)

function seed(): void {
  src.upsert({ kind: 'task', ref: 't-1', title: 'Rotate the cedar gateway certificate', summary: 'Before Friday', updatedAt: 1_000, identifiers: ['t-1', 'CR-AB12'] })
  src.upsert({ kind: 'session', ref: 's-1', title: 'Debug the retry window', note: 'worker budget passage', updatedAt: 2_000 })
  src.upsert({ kind: 'note', ref: `${MAC_HOME}/notes/garden/lantern.md`, title: 'Lantern notes', note: LANTERN, updatedAt: 3_000 })
  src.upsert({ kind: 'memory', ref: `${MAC_HOME}/memory/MEMORY.md`, title: 'Memory', note: 'The marina tool renews certificates.', updatedAt: 4_000 })
  // Outside the data home: no place for it on the companion.
  src.upsert({ kind: 'note', ref: '/Volumes/elsewhere/loose.md', title: 'Loose note', note: 'cedar', updatedAt: 5_000 })
}

const copy = () => wiring.getSearchV2Index()
const copyDoc = (kind: string, ref: string) => copy().db.prepare('SELECT id, title, hash FROM doc WHERE kind = ? AND ref = ?').get(kind, ref) as { id: number; title: string; hash: string } | undefined
const srcId = (kind: string, ref: string) => (src.db.prepare('SELECT id FROM doc WHERE kind = ? AND ref = ?').get(kind, ref) as { id: number }).id
const ops = () => calls.map((c) => c.op)

async function resetCompanion(): Promise<void> {
  await wiring.closeSearchV2Index()
  store._resetSearchReplicaStoreForTesting({ totalMb: () => totalMb, macAway: async () => macAway, model: () => companionModel })
}

beforeEach(async () => {
  await fsp.rm(WALNUT_HOME, { recursive: true, force: true })
  await fsp.mkdir(TASKS_DIR, { recursive: true })
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wn-search-replica-'))
  mode = 'auto'
  totalMb = 8_000
  macAway = false
  companionModel = 'fake/model'
  olderCompanion = false
  companionAvailable = true
  targets = [companion]
  calls = []
  _resetSearchReplicaForTesting()
  await resetCompanion()
  src = openSource()
  seed()
  await drainBackfill(src)
})

afterEach(async () => {
  await src.stopEmbedder().catch(() => {})
  try { src.close() } catch { /* closed */ }
  await wiring.closeSearchV2Index()
  fs.rmSync(dir, { recursive: true, force: true })
  await fsp.rm(WALNUT_HOME, { recursive: true, force: true }).catch(() => {})
})

describe('the companion copy of the search index', () => {
  it('the first round copies every doc with its vectors, file kinds at the companion\'s paths; the next is one status step', async () => {
    const r = await round()
    expect(r).toMatchObject({ action: 'synced', need: 4, sent: 4, inSync: true })
    expect(ops()).toEqual(['status', 'sync', 'put'])

    const note = copyDoc('note', path.join(WALNUT_HOME, 'notes', 'garden', 'lantern.md'))
    expect(note?.title).toBe('Lantern notes')
    expect(vecRows(copy(), note!.id)).toEqual(vecRows(src, srcId('note', `${MAC_HOME}/notes/garden/lantern.md`)))
    expect(vecRows(copy(), note!.id).length).toBeGreaterThan(1)
    expect(copyDoc('task', 't-1')?.title).toBe('Rotate the cedar gateway certificate')
    expect(copyDoc('memory', path.join(WALNUT_HOME, 'memory', 'MEMORY.md'))).toBeDefined()
    expect(copy().db.prepare(`SELECT COUNT(*) AS n FROM doc WHERE ref LIKE '%loose.md'`).get()).toEqual({ n: 0 })
    expect(companionSearchReady()).toBe(true)
    expect(companionStatus()).toMatchObject({ state: 'ready', mode: 'auto', reason: 'auto', docs: 4 })

    calls = []
    expect(await round()).toEqual({ action: 'in-sync' })
    expect(ops()).toEqual(['status'])
  })

  it('a change on the Mac is one small delta: the changed doc goes, a removed doc leaves', async () => {
    await round()
    calls = []
    src.upsert({ kind: 'task', ref: 't-1', title: 'Rotate the cedar certificate, now with a new name', updatedAt: 6_000, identifiers: ['t-1'] })
    src.remove('session', 's-1')
    const r = await round()
    expect(r).toMatchObject({ action: 'synced', need: 1, sent: 1, removed: 1, inSync: true })
    expect(calls).toEqual([
      { op: 'status', n: 0 },
      { op: 'sync', n: 1, partial: true },
      { op: 'put', n: 1 },
    ])
    expect(copyDoc('task', 't-1')?.title).toBe('Rotate the cedar certificate, now with a new name')
    expect(copyDoc('session', 's-1')).toBeUndefined()
    // Vectors the Mac has not computed yet do not arrive as stale ones.
    expect(vecRows(copy(), copyDoc('task', 't-1')!.id)).toEqual([])
    await drainBackfill(src)
    await round()
    expect(vecRows(copy(), copyDoc('task', 't-1')!.id)).toEqual(vecRows(src, srcId('task', 't-1')))
  })

  it('the search path uses the copy only while it is ready: memory lane included, at the companion\'s paths', async () => {
    const { search } = await import('../../src/core/search.js')
    expect(await search('lantern', { types: ['memory'] })).toEqual([]) // no copy: no memory lane on a replica
    await round()
    const hits = await search('lantern', { types: ['memory'] })
    expect(hits[0]).toMatchObject({ type: 'memory', path: path.join(WALNUT_HOME, 'notes', 'garden', 'lantern.md'), matchField: 'note' })
    const tasks = await search('cedar gateway', { types: ['task'] })
    expect(tasks[0]).toMatchObject({ type: 'task', taskId: 't-1', matchField: 'task' })

    mode = 'off'
    expect(await round()).toEqual({ action: 'off' })
    expect(companionSearchReady()).toBe(false)
    expect(await search('lantern', { types: ['memory'] })).toEqual([])
  })

  it('a session hit from the copy names its task through the task copy (this box holds no record of it)', async () => {
    await round()
    const tm = await import('../../src/core/task-manager.js')
    const now = new Date().toISOString()
    await tm.applyTaskReplica({ rows: [{
      id: 'own-1', title: 'Fix the retry window', status: 'todo', phase: 'TODO', priority: 'none', project: 'Acme', source: 'local',
      session_ids: ['s-1'], description: '', summary: '', note: '', created_at: now, updated_at: now,
    } as never] })
    const { search } = await import('../../src/core/search.js')
    const hits = await search('worker budget passage', { types: ['session'] })
    expect(hits[0]).toMatchObject({ type: 'session', sessionId: 's-1', taskId: 'own-1' })
  })

  it('Auto without the memory copies nothing and says why; On copies anyway and says it is forced', async () => {
    totalMb = AUTO_MIN_TOTAL_MB - 1_700
    expect(await round()).toEqual({ action: 'off' })
    expect(ops()).toEqual(['status'])
    expect(wiring.searchV2IndexOpen()).toBe(false)
    expect(companionStatus()).toMatchObject({ state: 'memory', totalMb: AUTO_MIN_TOTAL_MB - 1_700, autoMinMb: AUTO_MIN_TOTAL_MB })

    mode = 'on'
    expect(await round()).toMatchObject({ action: 'synced', inSync: true })
    expect(companionStatus()).toMatchObject({ state: 'ready', reason: 'forced' })
    expect(companionSearchReady()).toBe(true)
  })

  it('Off closes the copy; back on, the copy it kept matches at once (nothing sent again)', async () => {
    await round()
    mode = 'off'
    await round()
    expect(wiring.searchV2IndexOpen()).toBe(false)
    expect(companionStatus()?.state).toBe('off')
    mode = 'auto'
    calls = []
    expect(await round()).toEqual({ action: 'in-sync' })
    expect(ops()).toEqual(['status'])
    expect(companionSearchReady()).toBe(true)
  })

  it('a companion restart opens its copy at boot, before any round, and the first round finds it level', async () => {
    await round()
    await resetCompanion()
    expect(companionSearchReady()).toBe(false)
    const started = store.startSearchReplicaStore({ totalMb: () => totalMb, macAway: async () => true, model: () => companionModel })
    try {
      await vi.waitFor(() => expect(companionSearchReady()).toBe(true), { timeout: 5_000 })
      const { search } = await import('../../src/core/search.js')
      expect((await search('cedar gateway', { types: ['task'] }))[0]?.taskId).toBe('t-1')
      _resetSearchReplicaForTesting() // the Mac restarted too: it knows nothing of the last match
      calls = []
      expect(await round()).toEqual({ action: 'in-sync' })
      expect(ops()).toEqual(['status'])
    } finally {
      await started.stop()
    }
  })

  it('a task written here while the Mac is away goes into the copy; the Mac\'s own version replaces it later', async () => {
    await round()
    macAway = true
    const started = store.startSearchReplicaStore({ totalMb: () => totalMb, macAway: async () => macAway, model: () => companionModel })
    try {
      const tm = await import('../../src/core/task-manager.js')
      const { bus, EventNames } = await import('../../src/core/event-bus.js')
      const { task } = await tm.addTask({ title: 'Buy lantern oil for the porch', project: 'Home' })
      // As the task route announces it.
      bus.emit(EventNames.TASK_CREATED, { task }, ['web-ui'], { source: 'api' })
      await vi.waitFor(() => expect(copyDoc('task', task.id)?.title).toBe('Buy lantern oil for the porch'), { timeout: 8_000, interval: 250 })
      // Written here, not sent by the Mac: no stamp, so the copy no longer matches the Mac's.
      expect(copy().replica.tagsOf([copyDoc('task', task.id)!.id])).toEqual([])
      // The Mac is back with the write relayed: its row wins and the copy is level again.
      macAway = false
      src.upsert({ kind: 'task', ref: task.id, title: 'Buy lantern oil for the porch', meta: 'Project: Home\n\nv1', updatedAt: 7_000, identifiers: [task.id] })
      const r = await round()
      expect(r).toMatchObject({ action: 'synced', inSync: true })
      expect(copyDoc('task', task.id)?.hash).toBe((src.db.prepare('SELECT hash FROM doc WHERE ref = ?').get(task.id) as { hash: string }).hash)
    } finally {
      await started.stop()
    }
  })

  it('while the Mac answers, a write here stays out of the copy (the Mac\'s round brings it)', async () => {
    await round()
    const started = store.startSearchReplicaStore({ totalMb: () => totalMb, macAway: async () => false, model: () => companionModel })
    try {
      const tm = await import('../../src/core/task-manager.js')
      const { bus, EventNames } = await import('../../src/core/event-bus.js')
      const { task } = await tm.addTask({ title: 'Call the plumber', project: 'Home' })
      bus.emit(EventNames.TASK_CREATED, { task }, ['web-ui'], { source: 'api' })
      await new Promise((r) => setTimeout(r, 3_000))
      expect(copyDoc('task', task.id)).toBeUndefined()
      calls = []
      expect(await round()).toEqual({ action: 'in-sync' })
    } finally {
      await started.stop()
    }
  })

  it('Settings reads the last round from the index status payload', async () => {
    const { buildSearchIndexStatusPayload } = await import('../../src/web/routes/search-index.js')
    expect((await buildSearchIndexStatusPayload()).followers).toEqual([])
    await round()
    expect((await buildSearchIndexStatusPayload()).followers).toMatchObject([
      { id: 'companion', kind: 'companion', label: 'Cloud companion', state: 'ready', mode: 'auto', docs: 4 },
    ])
  })

  it('a manifest that would remove most of the copy is refused, and the copy keeps answering', async () => {
    for (let i = 0; i < 210; i++) src.upsert({ kind: 'task', ref: `bulk-${i}`, title: `Bulk task ${i}`, updatedAt: 10_000 + i })
    await round()
    expect(copy().stats().docs).toBe(214)
    await src.rebuildAll([]) // a damaged Mac index, emptied at boot
    const r = await round()
    expect(r).toEqual({ action: 'failed', error: 'manifest_removes_most_docs' })
    expect(copy().stats().docs).toBe(214)
    expect(companionSearchReady()).toBe(true)
  })

  it('an older companion rests the lane instead of failing every round', async () => {
    olderCompanion = true
    expect(await round()).toEqual({ action: 'unsupported' })
    expect(companionStatus()?.state).toBe('unsupported')
    calls = []
    expect(await round()).toEqual({ action: 'unsupported' })
    expect(calls).toEqual([])
  })

  it('every follower gets its own round: an older host server rests, the companion still fills, a removed one leaves Settings', async () => {
    const hostCalls: string[] = []
    const host: ReplicaTarget = {
      id: 'host:devbox', kind: 'host', label: 'devbox',
      available: async () => true,
      post: async (payload) => { hostCalls.push(String(payload.op)); return { ok: false, outcome: 'failed', status: 400, error: 'unknown_op' } },
    }
    targets = [host, companion]
    const all = await syncSearchReplica(deps)
    expect(all.map((r) => [r.target, r.action])).toEqual([['host:devbox', 'unsupported'], ['companion', 'synced']])
    expect(followerSearchStatuses().map((s) => [s.id, s.state, s.label])).toEqual([
      ['host:devbox', 'unsupported', 'devbox'], ['companion', 'ready', 'Cloud companion'],
    ])
    // The next round asks the resting host nothing and finds the companion level.
    hostCalls.length = 0
    calls = []
    expect((await syncSearchReplica(deps)).map((r) => r.action)).toEqual(['unsupported', 'in-sync'])
    expect(hostCalls).toEqual([])
    expect(ops()).toEqual(['status'])
    targets = [companion]
    await syncSearchReplica(deps)
    expect(followerSearchStatuses().map((s) => s.id)).toEqual(['companion'])
  })

  it('a follower that fails mid-round does not stop the next one', async () => {
    const broken: ReplicaTarget = {
      id: 'host:flaky', kind: 'host', label: 'flaky',
      available: async () => true,
      post: async () => { throw new Error('socket hang up') },
    }
    targets = [broken, companion]
    const all = await syncSearchReplica(deps)
    expect(all[0]).toMatchObject({ target: 'host:flaky', action: 'failed', error: 'socket hang up' })
    expect(all[1]).toMatchObject({ target: 'companion', action: 'synced', inSync: true })
  })

  it('another model on the companion keeps the copy off; no companion means no step at all', async () => {
    companionModel = 'other/model'
    await resetCompanion()
    expect(await round()).toEqual({ action: 'off' })
    expect(companionStatus()?.state).toBe('model')
    calls = []
    companionAvailable = false
    expect(await round()).toEqual({ action: 'unavailable' })
    expect(calls).toEqual([])
    expect(companionStatus()?.state).toBe('unavailable')
  })
})

describe('the pieces', () => {
  it('replica keys: ids as they are, files by their place under the data home', () => {
    expect(replicaKey('task', 't-1', MAC_HOME)).toBe('task:t-1')
    expect(replicaKey('note', `${MAC_HOME}/notes/a b/c.md`, MAC_HOME)).toBe('note:~/notes/a b/c.md')
    expect(replicaKey('note', '/elsewhere/c.md', MAC_HOME)).toBeNull()
    expect(refOfReplicaKey('note:~/notes/a b/c.md', '/var/home')).toEqual({ kind: 'note', ref: '/var/home/notes/a b/c.md' })
    expect(refOfReplicaKey('session:abc-1', '/var/home')).toEqual({ kind: 'session', ref: 'abc-1' })
    for (const bad of ['note:~/../etc/passwd.md', 'note:/etc/passwd', 'note:~/a//b.md', 'nokind', ':x']) {
      expect(refOfReplicaKey(bad, '/var/home')).toBeNull()
    }
  })

  it('the digest does not depend on order and follows every change', () => {
    const a = new DigestMap()
    const b = new DigestMap()
    a.set(1, 'task:x', 'v1'); a.set(2, 'task:y', 'v2')
    b.set(9, 'task:y', 'v2'); b.set(8, 'task:x', 'v1')
    expect(a.digest).toBe(b.digest)
    a.set(1, 'task:x', 'v3')
    expect(a.digest).not.toBe(b.digest)
    a.set(1, 'task:x', 'v1')
    expect(a.digest).toBe(b.digest)
    a.delete(2)
    expect(a.size).toBe(1)
    expect(a.valueOfKey('task:y')).toBeUndefined()
  })

  it('Auto asks for the headroom, On is the user\'s call, Off is off', () => {
    expect(companionSearchDecision('auto', 8_000)).toEqual({ enabled: true, reason: 'auto' })
    expect(companionSearchDecision('auto', 4_000)).toEqual({ enabled: false, reason: 'memory' })
    expect(companionSearchDecision('on', 4_000)).toEqual({ enabled: true, reason: 'forced' })
    expect(companionSearchDecision('on', 8_000)).toEqual({ enabled: true, reason: 'on' })
    expect(companionSearchDecision('off', 64_000)).toEqual({ enabled: false, reason: 'off' })
  })

  it('a malformed doc on the wire is dropped', () => {
    const good = { k: 'task:t', h: 'a'.repeat(16) + 'v', title: 't', summary: '', note: '', meta: '', updatedAt: 1, hash: 'b'.repeat(40), idents: [], vectors: [{ s: 0, b: 'AAAA' }] }
    expect(wireDocOf(good)).not.toBeNull()
    for (const bad of [{ ...good, h: 'xyz' }, { ...good, hash: 'short' }, { ...good, vectors: [{ s: -1, b: '' }] }, { ...good, idents: [1] }, { ...good, updatedAt: 'now' }]) {
      expect(wireDocOf(bad)).toBeNull()
    }
  })
})
