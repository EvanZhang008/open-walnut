/**
 * The copy watcher of a host replica (src/core/replication/kind-follower.ts
 * setCopyWatcher; docs/plan/walnut-replica-servers-impl.md section 4 "Hold after
 * ack", WP10): the overlay keeps a row marked `awaiting` after the Mac took its
 * record, until a manifest of the Mac stored the key. Over the REAL row-set follower
 * (tests/helpers/replica-kind-harness.ts memFollower).
 *
 * Pinned: a manifest names a watched key at the hash already held: stored; a key it
 * asks for is stored by the put that brings the row; a key the manifest does not name
 * (the Mac holds no such row: a create it took as a duplicate) is stored too, unless
 * the leader keeps it unread; a held key is never stored; nothing is told with no
 * watcher.
 */
import { afterEach, describe, expect, it } from 'vitest'
import { rowSetDigest, setCopyWatcher } from '../../../src/core/replication/kind-follower.js'
import { sha12 } from '../../../src/core/replication/kind.js'
import { memFollower, type Row } from '../../helpers/replica-kind-harness.js'

const KIND = 'acme-rows'
const hashOf = (r: Row) => sha12(JSON.stringify(r))
const entry = (r: Row) => ({ k: r.id, h: hashOf(r) })

afterEach(() => setCopyWatcher(null))

function watcher(keys: string[]) {
  const told: Array<{ kind: string; keys: string[]; asOf: number }> = []
  setCopyWatcher({ watching: (kind) => (kind === KIND ? keys : []), stored: (kind, k, asOf) => { told.push({ kind, keys: [...k].sort(), asOf }) } })
  return told
}

describe('copy watcher: which watched keys a round stored', () => {
  it('a manifest at the held hash, a put that brings the row, a key the manifest no longer names, but never a held or a kept key', async () => {
    const f = memFollower()
    const a: Row = { id: 'task-a', title: 'Leader work' }
    const b: Row = { id: 'task-b', title: 'Worker' }
    // First round: both rows here.
    await f.handler.sync({ kind: KIND, entries: [entry(a), entry(b)], asOf: 1_000 })
    await f.handler.put({ kind: KIND, rows: [a, b], last: true })
    const told = watcher(['task-a', 'task-b', 'made-here-1', 'made-here-2'])
    // A manifest naming task-a at the hash held, task-b at a new hash; made-here-1 kept unread.
    const b2 = { ...b, title: 'Worker, renamed on the Mac' }
    const r = await f.handler.sync({ kind: KIND, entries: [entry(a), entry(b2)], keep: ['made-here-1'], asOf: 2_000 })
    expect(r).toMatchObject({ ok: true, need: ['task-b'] })
    expect(told).toEqual([{ kind: KIND, keys: ['made-here-2', 'task-a'], asOf: 2_000 }])
    // The put brings task-b: stored.
    await f.handler.put({ kind: KIND, rows: [b2], last: true })
    expect(told[1]).toEqual({ kind: KIND, keys: ['task-b'], asOf: 2_000 })
    // A held key is never told, named or not.
    f.held.add('task-a')
    f.held.add('made-here-2')
    await f.handler.sync({ kind: KIND, entries: [entry(a), entry(b2)], asOf: 3_000 })
    expect(told[2]).toEqual({ kind: KIND, keys: ['made-here-1', 'task-b'], asOf: 3_000 })
  })

  it('a delta round tells the watched keys too: an equal digest on a status or on the last put, with its asOf', async () => {
    // kind-delta.ts: a round that only changed rows sends no manifest, so the digest is what proves the copy whole.
    const f = memFollower({ digest: true })
    const a: Row = { id: 'task-a', title: 'Leader work' }
    const b: Row = { id: 'task-b', title: 'Worker' }
    await f.handler.sync({ kind: KIND, entries: [entry(a), entry(b)], asOf: 1_000 })
    await f.handler.put({ kind: KIND, rows: [a, b], last: true })
    const told = watcher(['task-a', 'made-here'])
    const digestOf = (rows: Row[]) => rowSetDigest(rows.map((r) => r.id), Object.fromEntries(rows.map((r) => [r.id, hashOf(r)])), true)
    // Nothing changed (the sweep): the status matches, and every watched key not held here is stored as of it.
    expect(await f.handler.step('status', { kind: KIND, digest: digestOf([a, b]), asOf: 2_000 })).toMatchObject({ ok: true, inSync: true })
    expect(told).toEqual([{ kind: KIND, keys: ['made-here', 'task-a'], asOf: 2_000 }])
    // A delta's last put of a renamed row: the digest matches after it, told with the delta's asOf.
    const a2 = { ...a, title: 'Leader work, renamed' }
    f.held.add('made-here')
    expect(await f.handler.put({ kind: KIND, rows: [a2], last: true, digest: digestOf([a2, b]), asOf: 3_000 })).toMatchObject({ ok: true, stored: 1 })
    expect(told.at(-1)).toEqual({ kind: KIND, keys: ['task-a'], asOf: 3_000 })
    // A digest that does not match tells nothing new.
    const n = told.length
    await f.handler.step('status', { kind: KIND, digest: 'other', asOf: 4_000 })
    expect(told.length).toBe(n)
  })

  it('no watcher: a round tells nothing and still stores', async () => {
    const f = memFollower()
    const a: Row = { id: 'task-a', title: 'Leader work' }
    await f.handler.sync({ kind: KIND, entries: [entry(a)], asOf: 1_000 })
    await f.handler.put({ kind: KIND, rows: [a], last: true })
    expect(f.ids()).toEqual(['task-a'])
  })
})
