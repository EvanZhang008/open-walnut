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
import { setCopyWatcher } from '../../../src/core/replication/kind-follower.js'
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

  it('no watcher: a round tells nothing and still stores', async () => {
    const f = memFollower()
    const a: Row = { id: 'task-a', title: 'Leader work' }
    await f.handler.sync({ kind: KIND, entries: [entry(a)], asOf: 1_000 })
    await f.handler.put({ kind: KIND, rows: [a], last: true })
    expect(f.ids()).toEqual(['task-a'])
  })
})
