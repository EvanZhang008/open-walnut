/**
 * What a host's copies never hold (core/replication/host-private.ts): a task Walnut keeps local
 * and its rows. The filter itself (which tasks, which rows, the manifest a host takes), a copy
 * round against the real row-set follower (a row already copied is removed at the next round,
 * the companion keeps it), the search docs, and the host's own refusal of a call about such a
 * task (replica/kept-local-calls.ts keptLocalRefusal).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createMockConstants } from '../../helpers/mock-constants.js'

vi.mock('../../../src/constants.js', () => createMockConstants('walnut-host-private', { CLOUD_MODE: false }))

import {
  hostManifest, hostPrivacyOf, keptFromHosts, keptVaultFolders, nothingKept, onHostPrivacyChange, refKept, searchKeyKeptFromHosts, taskFree, type HostPrivacy,
} from '../../../src/core/replication/host-private.js'
import path from 'node:path'
import { WALNUT_HOME } from '../../../src/constants.js'
import { buildKindManifest } from '../../../src/core/replication/kind-leader.js'
import { sha12 } from '../../../src/core/replication/kind.js'
import { NOTHING_HELD, createRowSetFollower, serialChain, type RowSetState } from '../../../src/core/replication/kind-follower.js'
import { syncCopyKinds, type CopyKind, type CopyTarget } from '../../../src/core/replication/kinds/copy-kind.js'
import { _resetReplicaStatusForTesting } from '../../../src/core/replication/replica-status.js'
import { _resetServerRoleForTesting } from '../../../src/core/server-role.js'
import { keptLocalRefusal } from '../../../src/replica/kept-local-calls.js'
import { namesKeptLocal } from '../../../src/core/replication/kinds/local-tasks.js'

const HOLD = { target: 'acme', state: 'chosen', at: '2026-11-21T00:00:00.000Z' }

interface Row { id: string; task: string; v: number }

const privacy = (kept: string[], sessions: Array<[string, string]> = []): HostPrivacy =>
  hostPrivacyOf([...kept.map((id) => ({ id, sync_hold: HOLD })), { id: 'open' }], sessions.map(([sid, taskId]) => ({ claudeSessionId: sid, taskId })))

describe('which tasks a host never holds', () => {
  it('every task with a hold, whatever its state; never one without', () => {
    for (const state of ['checking', 'private', 'unjudged', 'chosen']) expect(keptFromHosts({ sync_hold: { ...HOLD, state } })).toBe(true)
    expect(keptFromHosts({})).toBe(false)
    expect(keptFromHosts({ sync_hold: undefined })).toBe(false)
  })

  it('their sessions, the ones a newer session detached included; a signature that moves with either set', () => {
    const p = hostPrivacyOf(
      [{ id: 'kept', sync_hold: HOLD }, { id: 'open' }],
      [{ claudeSessionId: 's-1', taskId: 'kept' }, { claudeSessionId: 's-2', taskId: 'open', legacyTaskId: 'kept' }, { claudeSessionId: 's-3', taskId: 'open' }],
    )
    expect([...p.tasks]).toEqual(['kept'])
    expect([...p.sessions].sort()).toEqual(['s-1', 's-2'])
    expect(p.sig).not.toBe('')
    expect(privacy(['kept'], [['s-1', 'kept']]).sig).not.toBe(privacy(['kept']).sig)
    expect(hostPrivacyOf([{ id: 'open' }], [{ claudeSessionId: 's', taskId: 'open' }]).sig).toBe('')
  })

  it('a subtask is kept with a kept parent at any depth, its sessions too; ids resolved the shared way; a loop ends the walk', () => {
    const p = hostPrivacyOf(
      [
        { id: 'lead-0001', sync_hold: HOLD }, { id: 'child-01', parent_task_id: 'lead-0001' }, { id: 'grand-01', parent_task_id: 'child-01' },
        // A legacy prefix ref names its parent; one that names the child itself never does.
        { id: 'legacy-1', parent_task_id: 'lead-00' }, { id: 'lead-0001x', parent_task_id: 'lead-0001x' },
        { id: 'loop-a', parent_task_id: 'loop-b' }, { id: 'loop-b', parent_task_id: 'loop-a' }, { id: 'open', parent_task_id: 'gone' },
      ],
      [{ claudeSessionId: 's-grand', taskId: 'grand-01' }, { claudeSessionId: 's-open', taskId: 'open' }],
    )
    expect([...p.tasks].sort()).toEqual(['child-01', 'grand-01', 'lead-0001', 'legacy-1'])
    expect([...p.sessions]).toEqual(['s-grand'])
    expect(hostPrivacyOf([{ id: 'loop-a', parent_task_id: 'loop-b' }, { id: 'loop-b', parent_task_id: 'loop-a' }], []).tasks.size).toBe(0)
  })

  it('a change of the kept set is told within seconds of the task change that made it, and only then', async () => {
    let kept: string[] = []
    const fired: number[] = []
    const stop = onHostPrivacyChange(() => fired.push(Date.now()), async () => privacy(kept))
    try {
      const { bus } = await import('../../../src/core/event-bus.js')
      await new Promise((r) => setTimeout(r, 50))
      bus.emit('task:updated', { task: { id: 'open' } }, ['web-ui'])
      await new Promise((r) => setTimeout(r, 2_400))
      expect(fired, 'nothing kept changed').toEqual([])
      kept = ['kept']
      bus.emit('task:updated', { task: { id: 'kept' } }, ['web-ui'])
      await vi.waitFor(() => expect(fired.length).toBe(1), { timeout: 5_000 })
    } finally {
      stop()
    }
  }, 15_000)

  it('a ref names a kept task, a kept session, or a row of another kind left out this round', () => {
    const p = privacy(['kept'], [['s-1', 'kept']])
    p.derived.set('inbox', new Set(['lt-a-1234']))
    expect(['task:kept', 'session:s-1', 'inbox:lt-a-1234'].map((r) => refKept(r, p))).toEqual([true, true, true])
    expect(['task:open', 'session:s-2', 'inbox:lt-b-1234', 'boards:kept', 'kept', 'task:'].map((r) => refKept(r, p))).toEqual([false, false, false, false, false, false])
  })
})

const rowKind = (over: Partial<CopyKind<Row>> = {}): CopyKind<Row> => ({
  kind: 'sessions', schemaVersion: 1, key: (r) => r.id, hash: (r) => sha12(JSON.stringify(r)), ordered: false, digest: false,
  owners: (r) => [`task:${r.task}`], rows: async () => [], watch: () => () => {}, ...over,
})

describe('the manifest a host takes', () => {
  const rows: Row[] = [{ id: 'a', task: 'open', v: 1 }, { id: 'b', task: 'kept', v: 1 }, { id: 'c', task: 'open', v: 2 }]

  it('nothing kept, or a kind of no one\'s rows: the very manifest every target takes', async () => {
    const kind = rowKind()
    const m = await buildKindManifest(kind, rows)
    expect(await hostManifest(kind, m, nothingKept())).toBe(m)
    expect(await hostManifest(rowKind({ owners: taskFree('test rows of no one') }), m, privacy(['kept']))).toBe(m)
    expect(await hostManifest(kind, m, privacy(['other']))).toBe(m)
  })

  it('without the kept task\'s rows, its hash its own; the same object for every host of the round', async () => {
    const kind = rowKind()
    const m = await buildKindManifest(kind, rows)
    const p = privacy(['kept'])
    const h = await hostManifest(kind, m, p)
    expect(h.entries.map((e) => e.k)).toEqual(['a', 'c'])
    expect([...h.byKey.keys()]).toEqual(['a', 'c'])
    expect(h.hash).not.toBe(m.hash)
    expect(h.hash).toBe((await buildKindManifest(kind, rows.filter((r) => r.task !== 'kept'))).hash)
    expect(await hostManifest(kind, m, p)).toBe(h)
    expect([...p.derived.get('sessions')!]).toEqual(['b'])
    // The leader's own manifest is untouched (the companion takes it).
    expect(m.entries.map((e) => e.k)).toEqual(['a', 'b', 'c'])
  })

  it('a key the leader could not read of a kept task is not kept for the host either', async () => {
    const kind = rowKind()
    const m = { ...(await buildKindManifest(kind, rows.slice(0, 1))), keep: ['kept', 'unread'] }
    const h = await hostManifest(kind, m, privacy(['kept']))
    expect(h.keep).toEqual(['unread'])
    expect(h.hash).not.toBe(m.hash)
  })

  it('a kind derived from another leaves out the rows of the rows it left out, read when no round of it ran first', async () => {
    const letters = rowKind({ kind: 'inbox', rows: async () => [{ id: 'lt-a', task: 'kept', v: 1 }, { id: 'lt-b', task: 'open', v: 1 }] })
    const bodies = rowKind({ kind: 'inbox-bodies', derivedFrom: 'inbox', owners: (r) => [`inbox:${r.task}`] })
    const m = await buildKindManifest(bodies, [{ id: 'lt-a.html', task: 'lt-a', v: 1 }, { id: 'lt-b.md', task: 'lt-b', v: 1 }])
    const resolve = vi.fn(async (name: string) => (name === 'inbox' ? letters : undefined))
    const p = privacy(['kept'])
    expect((await hostManifest(bodies, m, p, resolve)).entries.map((e) => e.k)).toEqual(['lt-b.md'])
    expect(resolve).toHaveBeenCalledOnce()
    // Once the letters' round ran, their answer is used as it is.
    const p2 = privacy(['kept'])
    await hostManifest(letters, await buildKindManifest(letters, await letters.rows()), p2, resolve)
    expect((await hostManifest(bodies, m, p2, resolve)).entries.map((e) => e.k)).toEqual(['lt-b.md'])
    expect(resolve).toHaveBeenCalledOnce()
  })
})

describe('a host\'s search copy', () => {
  it('leaves out a kept task\'s doc, its sessions\' docs and the files under its own folder', () => {
    const p = privacy(['kept'], [['s-1', 'kept']])
    expect(['task:kept', 'session:s-1', 'memory:~/artifacts/nodes/kept/MEMORY.md'].map((k) => searchKeyKeptFromHosts(k, p))).toEqual([true, true, true])
    expect(['task:open', 'session:s-2', 'note:~/notes/kept-notes.md', 'memory:~/artifacts/nodes/open/MEMORY.md'].map((k) => searchKeyKeptFromHosts(k, p))).toEqual([false, false, false, false])
    expect(searchKeyKeptFromHosts('task:kept', nothingKept())).toBe(false)
  })
})

describe('a host\'s notes copy (the daemon\'s file copy, host-replica.ts)', () => {
  it('leaves out a kept task\'s own folder where the vault holds it, never a project\'s shared one', async () => {
    const { artifactsDir, setArtifactsByProject } = await import('../../../src/core/artifacts/paths.js')
    const read = vi.fn(async () => privacy(['kept-a', 'kept-b']))
    expect(await keptVaultFolders(artifactsDir(), read)).toEqual(['nodes/kept-a', 'nodes/kept-b'])
    expect(await keptVaultFolders(WALNUT_HOME, read)).toEqual(['artifacts/nodes/kept-a', 'artifacts/nodes/kept-b'])
    expect(await keptVaultFolders(artifactsDir(), async () => nothingKept())).toEqual([])
    expect(read).toHaveBeenCalledTimes(2)
    // A vault that does not hold the task folders reads nothing.
    expect(await keptVaultFolders(path.join(WALNUT_HOME, 'notes'), read)).toEqual([])
    setArtifactsByProject(true)
    try { expect(await keptVaultFolders(artifactsDir(), read)).toEqual([]) } finally { setArtifactsByProject(false) }
    expect(read).toHaveBeenCalledTimes(2)
  })
})

describe('a copy round: what each target holds', () => {
  function memFollower(kind: string) {
    const store = new Map<string, Row>()
    const state: RowSetState = { asOf: 0, at: 0, order: [], hashes: {} }
    const f = createRowSetFollower<Row>({
      kind, schemaVersion: 1, label: kind, log: { info: () => {}, warn: () => {} }, removalFloor: 50, ordered: false,
      serial: serialChain(), load: async () => state, save: async () => {}, isRow: (v): v is Row => typeof (v as Row)?.id === 'string',
      key: (r) => r.id, localKeys: async () => [...store.keys()],
      apply: async ({ rows, removeIds }) => { for (const id of removeIds ?? []) store.delete(id); for (const r of rows ?? []) store.set(r.id, r); return { skipped: [] } },
      held: async () => NOTHING_HELD, changed: () => {},
    })
    return { store, f }
  }
  function target(id: string, kind: 'host' | 'companion', f: ReturnType<typeof memFollower>['f']): CopyTarget {
    return {
      id, kind, label: id, available: async () => true, program: () => 'replica',
      post: async (payload) => {
        const body = JSON.parse(JSON.stringify(payload)) as Record<string, unknown>
        const r = await f.step(body.op as 'sync', body)
        return r.ok ? { ok: true, reply: r } : { ok: false, outcome: 'failed', status: r.status, error: r.error }
      },
    }
  }

  beforeEach(() => {
    _resetServerRoleForTesting()
    _resetReplicaStatusForTesting()
  })

  it('a kept task\'s rows never reach a host; one already copied goes at the next round; the companion keeps every row', async () => {
    let leader: Row[] = [{ id: 'a', task: 'open', v: 1 }, { id: 'b', task: 'secret', v: 1 }, { id: 'c', task: 'later', v: 1 }]
    let kept = ['secret']
    const kind = rowKind({ rows: async () => leader })
    const host = memFollower('sessions')
    const companion = memFollower('sessions')
    const deps = { targets: () => [target('host:devbox', 'host', host.f), target('companion', 'companion', companion.f)], privacy: async () => privacy(kept) }
    await syncCopyKinds([kind], deps)
    expect([...host.store.keys()].sort()).toEqual(['a', 'c'])
    expect([...companion.store.keys()].sort()).toEqual(['a', 'b', 'c'])
    // `later` is made local: its row leaves the host's copy; the companion's stays.
    kept = ['secret', 'later']
    const r = await syncCopyKinds([kind], deps)
    expect(r.find((x) => x.target === 'host:devbox')).toMatchObject({ action: 'synced', removed: 1 })
    expect([...host.store.keys()]).toEqual(['a'])
    expect([...companion.store.keys()].sort()).toEqual(['a', 'b', 'c'])
    // Nothing changed: no step for the host.
    expect((await syncCopyKinds([kind], deps)).map((x) => x.action)).toEqual(['unchanged', 'unchanged'])
    // Its hold released (synced again): it comes back.
    kept = ['secret']
    leader = [...leader]
    await syncCopyKinds([kind], deps)
    expect([...host.store.keys()].sort()).toEqual(['a', 'c'])
  })

  it('a host whose privacy cannot be worked out takes nothing that round, never the whole manifest', async () => {
    const kind = rowKind({ rows: async () => [{ id: 'b', task: 'secret', v: 1 }] })
    const host = memFollower('sessions')
    const r = await syncCopyKinds([kind], { targets: () => [target('host:devbox', 'host', host.f)], privacy: async () => { throw new Error('store unreadable') } })
    expect(r).toEqual([{ target: 'host:devbox', kind: 'sessions', action: 'failed', error: 'store unreadable' }])
    expect(host.store.size).toBe(0)
  })
})

describe('the host\'s own answer to a call about a kept task', () => {
  const here = { tasks: new Set(['kept-task-0001']), sessions: new Set(['kept-session-0001']) }
  const relayed = (over: Record<string, unknown> = {}) => ({ relayId: 7, capability: 'tools.call', callerSid: 'open-session', payload: { name: 'task_get', args: { id: 'kept-task-0001' } }, ...over })

  it('a call naming it, by id, short id or path segment, at any depth, or by one of its sessions: needs_leader task_kept_local, final', () => {
    const want = { relayId: 7, errorCode: 'needs_leader', detail: { why: 'task_kept_local', final: true } }
    expect(keptLocalRefusal(relayed(), here)).toMatchObject(want)
    expect(keptLocalRefusal(relayed({ payload: { name: 'task_get', args: { id: 'kept-t' } } }), here)).toMatchObject(want)
    expect(keptLocalRefusal(relayed({ payload: { name: 'task_update_bulk', args: { updates: [{ id: 'kept-task-0001' }] } } }), here)).toMatchObject(want)
    expect(keptLocalRefusal(relayed({ payload: { name: 'task_history', args: { id: 'kept-session-0001' } } }), here)).toMatchObject(want)
    expect(keptLocalRefusal(relayed({ payload: { name: 'api', args: { method: 'GET', path: '/api/v1/tasks/kept-task-0001' } } }), here)).toMatchObject(want)
    // A kept session's own call naming its task explicitly is about it too.
    expect(keptLocalRefusal(relayed({ callerSid: 'kept-session-0001', payload: { name: 'board_get', args: { task: 'kept-task-0001' } } }), here)).toMatchObject(want)
  })

  it('a call of its own session that falls back on its own task: refused, final', () => {
    const own = (name: string, args: Record<string, unknown> = {}) => keptLocalRefusal(relayed({ callerSid: 'kept-session-0001', payload: { name, args } }), here)
    for (const name of ['agent_memory_read', 'brief_read', 'board_post', 'thread_list', 'open_items', 'task_dir', 'task_create']) {
      expect(own(name, name === 'task_create' ? { title: 'a subtask', project: 'Elsewhere' } : {}), name).toMatchObject({ errorCode: 'needs_leader', detail: { why: 'task_kept_local', final: true } })
    }
    expect(String(own('agent_memory_read')!.error)).toMatch(/this session's task is kept local/)
  })

  it('a message to it runs: the host holds it for the Mac (away-sends.ts), whoever sends it', () => {
    expect(keptLocalRefusal(relayed({ payload: { name: 'task_send', args: { to: 'kept-task-0001', text: 'hi' } } }), here)).toBeNull()
    expect(keptLocalRefusal(relayed({ payload: { name: 'session_send', args: { to: 'kept-session-0001', text: 'x' } } }), here)).toBeNull()
    expect(keptLocalRefusal(relayed({ callerSid: 'kept-session-0001', payload: { name: 'task_send', args: { to: 'open-task', text: 'kept-task-0001' } } }), here)).toBeNull()
  })

  it('any other call of its own session runs: a search, a skill, a status, a trigger, a task it names that is not kept', () => {
    const own = (name: string, args: Record<string, unknown> = {}) => keptLocalRefusal(relayed({ callerSid: 'kept-session-0001', payload: { name, args } }), here)
    expect(own('search', { q: 'appraisal' })).toBeNull()
    expect(own('skill_read', { name: 'walnut' })).toBeNull()
    expect(own('walnut_status')).toBeNull()
    expect(own('trigger_list')).toBeNull()
    expect(own('human_inbox_send', { subject: 'Done', type: 'report', text: 'ok' })).toBeNull()
    expect(own('board_get', { task: 'open-task' })).toBeNull()
    expect(own('agent_memory_read', { task: 'open-task' })).toBeNull()
  })

  it('anything else runs: another task, a short or spaced string, the tool list, an empty list', () => {
    expect(keptLocalRefusal(relayed({ payload: { name: 'task_get', args: { id: 'open-task' } } }), here)).toBeNull()
    expect(keptLocalRefusal(relayed({ payload: { name: 'task_send', args: { to: 'open-task', text: 'kept-task-0001 is mentioned in words' } } }), here)).toBeNull()
    expect(keptLocalRefusal(relayed({ payload: { name: 'task_list', args: { q: 'kept' } } }), here)).toBeNull()
    expect(keptLocalRefusal(relayed({ capability: 'tools.list', callerSid: 'kept-session-0001', payload: {} }), here)).toBeNull()
    expect(keptLocalRefusal(relayed(), { tasks: new Set(), sessions: new Set() })).toBeNull()
    expect(namesKeptLocal('/api/v1/tasks/open-task', here)).toBe(false)
    expect(namesKeptLocal('kept', here)).toBe(false)
  })

  it('a same-host send while the Mac answers: not final, so the daemon relays it to the Mac, as before', () => {
    for (const r of [
      keptLocalRefusal(relayed({ payload: { name: 'task_send', args: { to: 'kept-task-0001', text: 'hi' } } }), here, true),
      keptLocalRefusal(relayed({ callerSid: 'kept-session-0001', payload: { name: 'task_send', args: { to: 'open-task', text: 'hi' } } }), here, true),
    ]) {
      expect(r).toMatchObject({ errorCode: 'needs_leader', detail: { why: 'task_kept_local' } })
      expect((r!.detail as Record<string, unknown>).final).toBeUndefined()
    }
    expect(keptLocalRefusal(relayed({ payload: { name: 'task_send', args: { to: 'open-task', text: 'hi' } } }), here, true)).toBeNull()
  })
})
