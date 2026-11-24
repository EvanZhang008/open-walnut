/**
 * The copy kinds' scheduler (core/replication/kinds/copy-kind.ts
 * startCopyKindsSync), on a fake clock: a kind's store write brings a round of
 * that kind alone after the 3 s debounce, a target joining one of every kind,
 * held rows one more after 35 s, the sweep every 5 minutes asks by digest, a
 * follower starts nothing, the companion is never sent these kinds, and stop
 * clears every timer; a scheduler that stops leaves another its "round soon",
 * and a confirm whose step was lost goes again within seconds. The follower here is the real row-set follower over an
 * in-memory store (kind-follower.ts createRowSetFollower), so the steps are
 * answered as a replica answers them.
 */
import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from 'vitest'
import { createMockConstants } from '../../../helpers/mock-constants.js'

vi.mock('../../../../src/constants.js', () => createMockConstants('walnut-copy-scheduler', { CLOUD_MODE: false }))

import { _resetServerRoleForTesting } from '../../../../src/core/server-role.js'
import { COPY_DEBOUNCE_MS, COPY_FIRST_ROUND_MS, COPY_SWEEP_MS, confirmCopyKindRemoval, copyChoiceChanged, copyKindNow, startCopyKindsSync, type CopyKind, type CopyTarget } from '../../../../src/core/replication/kinds/copy-kind.js'
import { NOTHING_HELD, createRowSetFollower, serialChain, type HeldSource, type RowSetState } from '../../../../src/core/replication/kind-follower.js'
import { HELD_RETRY_MS, confirmRetryMs, sha12 } from '../../../../src/core/replication/kind.js'
import { _resetReplicaStatusForTesting, peekKindState } from '../../../../src/core/replication/replica-status.js'
import { _resetReplicaTargetsForTesting, registerReplicaTarget } from '../../../../src/core/replication/replica-targets.js'

interface Row { id: string; v: number }

function memFollower(kind: string, held: () => HeldSource = () => NOTHING_HELD) {
  const store = new Map<string, Row>()
  const state: RowSetState = { asOf: 0, at: 0, order: [], hashes: {} }
  const f = createRowSetFollower<Row>({
    kind, schemaVersion: 1, label: kind, log: { info: () => {}, warn: () => {} }, removalFloor: 50, ordered: false, digest: true,
    serial: serialChain(), load: async () => state, save: async () => {}, isRow: (v): v is Row => typeof (v as Row)?.id === 'string',
    key: (r) => r.id, localKeys: async () => [...store.keys()],
    apply: async ({ rows, removeIds }) => { for (const id of removeIds ?? []) store.delete(id); for (const r of rows ?? []) store.set(r.id, r); return { skipped: [] } },
    held: async () => held(), changed: () => {},
    purge: async () => { const removed = store.size; store.clear(); state.hashes = {}; return { removed } },
  })
  return { store, f }
}

let steps: string[] = []
let rowsRead: string[] = []
const leader: Record<string, Row[]> = { alpha: [], beta: [] }
const watchers: Record<string, () => void> = {}
let heldIds = new Set<string>()
let followers = makeFollowers()
function makeFollowers() {
  return { alpha: memFollower('alpha', () => ({ has: (k) => heldIds.has(k), orderWriteRecent: () => false })), beta: memFollower('beta', () => ({ has: (k) => heldIds.has(k), orderWriteRecent: () => false })) }
}

function kindOf(name: 'alpha' | 'beta'): CopyKind<Row> {
  return {
    kind: name, schemaVersion: 1, key: (r) => r.id, hash: (r) => sha12(JSON.stringify(r)), ordered: false, digest: true,
    choice: name === 'alpha' ? 'sessions' : 'boards',
    rows: async () => { rowsRead.push(name); return leader[name] },
    watch: (soon) => { watchers[name] = soon; return () => { delete watchers[name] } },
  }
}

/** A target; a host runs the replica program unless `program` says otherwise (null: the view names none). */
function target(id: string, kind: 'host' | 'companion', program: string | null = 'replica', choice?: () => Record<string, boolean>): CopyTarget {
  return {
    id, kind, label: id, available: async () => true,
    program: () => program ?? undefined,
    ...(choice ? { copies: async () => choice() } : {}),
    post: async (payload) => {
      const body = JSON.parse(JSON.stringify(payload)) as Record<string, unknown>
      steps.push(`${id} ${String(body.op)}:${String(body.kind)}`)
      const f = followers[body.kind as 'alpha' | 'beta'].f
      const r = await f.step(body.op as 'sync', body)
      if (!r.ok && r.status === 404) return { ok: false, outcome: 'unsupported', status: 404, error: r.error }
      return r.ok ? { ok: true, reply: r } : { ok: false, outcome: 'failed', status: r.status, error: r.error }
    },
  }
}

async function tick(ms: number): Promise<void> {
  await vi.advanceTimersByTimeAsync(ms)
}

beforeEach(() => {
  vi.useFakeTimers()
  _resetServerRoleForTesting()
  _resetReplicaStatusForTesting()
  _resetReplicaTargetsForTesting()
  steps = []
  rowsRead = []
  heldIds = new Set()
  leader.alpha = [{ id: 'a1', v: 1 }, { id: 'a2', v: 1 }]
  leader.beta = [{ id: 'b1', v: 1 }]
  followers = makeFollowers()
})

afterEach(() => {
  vi.useRealTimers()
  delete process.env.WALNUT_HOST_SERVER
  _resetServerRoleForTesting()
})

describe('startCopyKindsSync', () => {
  const kinds = [kindOf('alpha'), kindOf('beta')]

  it('a follower starts nothing: no watch, no timer', async () => {
    process.env.WALNUT_HOST_SERVER = '1'
    _resetServerRoleForTesting()
    const s = startCopyKindsSync(kinds, { targets: () => [target('host:devbox', 'host')] })
    expect(Object.keys(watchers)).toEqual([])
    await tick(COPY_SWEEP_MS + COPY_FIRST_ROUND_MS)
    expect(steps).toEqual([])
    s.stop()
  })

  it('first round after boot, then a store write rounds only that kind after the debounce; the companion gets none', async () => {
    const s = startCopyKindsSync(kinds, { targets: () => [target('companion', 'companion'), target('host:devbox', 'host')] })
    await tick(COPY_FIRST_ROUND_MS + COPY_DEBOUNCE_MS + 10)
    expect(steps).toEqual([
      'host:devbox status:alpha', 'host:devbox sync:alpha', 'host:devbox put:alpha',
      'host:devbox status:beta', 'host:devbox sync:beta', 'host:devbox put:beta',
    ])
    expect([...followers.alpha.store.keys()].sort()).toEqual(['a1', 'a2'])
    steps = []
    rowsRead = []
    leader.beta = [{ id: 'b1', v: 2 }]
    watchers.beta()
    watchers.beta()
    await tick(COPY_DEBOUNCE_MS - 100)
    expect(steps).toEqual([])
    await tick(200)
    expect(rowsRead).toEqual(['beta'])
    expect(steps).toEqual(['host:devbox put:beta'])
    expect(followers.beta.store.get('b1')?.v).toBe(2)
    s.stop()
  })

  it('a target that joins gets a round of every kind; the sweep asks by digest; stop clears every timer', async () => {
    const s = startCopyKindsSync(kinds, {})
    await tick(1) // its targets listener is attached
    const unregister = registerReplicaTarget(target('host:late', 'host'))
    await tick(COPY_DEBOUNCE_MS + 10)
    expect(steps.filter((x) => x.includes('put:'))).toEqual(['host:late put:alpha', 'host:late put:beta'])
    steps = []
    await tick(COPY_SWEEP_MS)
    await tick(COPY_DEBOUNCE_MS + 10)
    expect(steps).toEqual(['host:late status:alpha', 'host:late status:beta'])
    s.stop()
    steps = []
    expect(Object.keys(watchers)).toEqual([])
    await tick(COPY_SWEEP_MS * 2)
    expect(steps).toEqual([])
    unregister()
  })

  it('held rows run the kind once more after 35 s', async () => {
    const s = startCopyKindsSync(kinds, { targets: () => [target('host:devbox', 'host')] })
    await tick(COPY_FIRST_ROUND_MS + COPY_DEBOUNCE_MS + 10)
    heldIds = new Set(['a2']) // the replica wrote a2 itself (its journal holds it)
    leader.alpha = [{ id: 'a1', v: 1 }, { id: 'a2', v: 5 }]
    steps = []
    watchers.alpha()
    await tick(COPY_DEBOUNCE_MS + 10)
    expect(steps).toEqual(['host:devbox put:alpha', 'host:devbox sync:alpha'])
    heldIds = new Set()
    steps = []
    await tick(HELD_RETRY_MS + 10)
    expect(steps).toEqual(['host:devbox put:alpha'])
    expect(followers.alpha.store.get('a2')?.v).toBe(5)
    s.stop()
  })

  it('a host running the plain host server, its fallback, or no named program gets no copy step', async () => {
    const s = startCopyKindsSync(kinds, {
      targets: () => [target('host:plain', 'host', 'host-server'), target('host:fell', 'host', 'fallback'), target('host:unnamed', 'host', null)],
    })
    await tick(COPY_FIRST_ROUND_MS + COPY_DEBOUNCE_MS + 10)
    watchers.alpha()
    await tick(COPY_SWEEP_MS + COPY_DEBOUNCE_MS + 10)
    expect(steps).toEqual([])
    expect(rowsRead).toEqual([]) // no target keeps copies: no manifest is even built
    s.stop()
  })

  it('held rows of another kind in a later round ride the retry already pending', async () => {
    const s = startCopyKindsSync(kinds, { targets: () => [target('host:devbox', 'host')] })
    await tick(COPY_FIRST_ROUND_MS + COPY_DEBOUNCE_MS + 10)
    heldIds = new Set(['a2', 'b1'])
    leader.alpha = [{ id: 'a1', v: 1 }, { id: 'a2', v: 5 }]
    watchers.alpha()
    await tick(COPY_DEBOUNCE_MS + 10) // alpha held: the retry is set
    leader.beta = [{ id: 'b1', v: 7 }]
    watchers.beta()
    await tick(COPY_DEBOUNCE_MS + 10) // beta held too, while the retry is pending
    heldIds = new Set()
    steps = []
    await tick(HELD_RETRY_MS)
    expect(steps.filter((x) => x.includes('put:'))).toEqual(['host:devbox put:alpha', 'host:devbox put:beta'])
    expect(followers.alpha.store.get('a2')?.v).toBe(5)
    expect(followers.beta.store.get('b1')?.v).toBe(7)
    s.stop()
  })

  it('a change of the copy choice rounds now: a kind turned off is purged once, turned on again it copies', async () => {
    const choice = { sessions: true, boards: true }
    const s = startCopyKindsSync(kinds, { targets: () => [target('host:devbox', 'host', 'replica', () => choice)] })
    await tick(COPY_FIRST_ROUND_MS + COPY_DEBOUNCE_MS + 10)
    expect([...followers.beta.store.keys()]).toEqual(['b1'])
    steps = []
    choice.boards = false
    copyChoiceChanged()
    await tick(COPY_DEBOUNCE_MS + 10)
    expect(steps).toEqual(['host:devbox purge:beta']) // alpha is unchanged: no step
    expect(followers.beta.store.size).toBe(0)
    steps = []
    copyChoiceChanged()
    await tick(COPY_DEBOUNCE_MS + 10)
    expect(steps).toEqual([]) // purged once, not again
    steps = []
    choice.boards = true
    copyChoiceChanged()
    await tick(COPY_DEBOUNCE_MS + 10)
    expect(steps).toEqual(['host:devbox sync:beta', 'host:devbox put:beta'])
    expect([...followers.beta.store.keys()]).toEqual(['b1'])
    s.stop()
  })

  it('a config change that changes a target\'s choice rounds now; one that changes nothing does not (4f)', async () => {
    const { bus, EventNames } = await import('../../../../src/core/event-bus.js')
    const choice = { sessions: true, boards: true }
    // A replica's choice in config.yaml (the companion's cloud_bridge.copies reads the same way).
    const s = startCopyKindsSync(kinds, { targets: () => [target('host:devbox', 'host', 'replica', () => choice)] })
    try {
      await tick(COPY_FIRST_ROUND_MS + COPY_DEBOUNCE_MS + 10)
      expect([...followers.beta.store.keys()]).toEqual(['b1'])
      // Another setting saved: no round.
      steps = []
      rowsRead = []
      bus.emit(EventNames.CONFIG_CHANGED, { key: 'focus_bar' }, ['web-ui'])
      await tick(COPY_DEBOUNCE_MS + 10)
      expect(rowsRead).toEqual([])
      // Its boards turned off in config.yaml: a purge at once.
      choice.boards = false
      bus.emit(EventNames.CONFIG_CHANGED, { key: 'cloud_bridge' }, ['web-ui'])
      await tick(COPY_DEBOUNCE_MS + 10)
      expect(steps).toEqual(['host:devbox purge:beta'])
      expect(followers.beta.store.size).toBe(0)
    } finally {
      s.stop()
    }
    // Stopped: a later change starts nothing.
    steps = []
    choice.boards = true
    bus.emit(EventNames.CONFIG_CHANGED, { key: 'cloud_bridge' }, ['web-ui'])
    await tick(COPY_DEBOUNCE_MS + 10)
    expect(steps).toEqual([])
  })

  it('a newer scheduler that stops leaves the older one its round soon', async () => {
    const targets = () => [target('host:devbox', 'host')]
    const older = startCopyKindsSync(kinds, { targets })
    const newer = startCopyKindsSync(kinds, { targets })
    newer.stop()
    await tick(COPY_FIRST_ROUND_MS + COPY_DEBOUNCE_MS + 10)
    rowsRead = []
    copyChoiceChanged()
    await tick(COPY_DEBOUNCE_MS + 10)
    expect(rowsRead.sort()).toEqual(['alpha', 'beta'])
    older.stop()
  })

  it('a confirm whose step was lost on the way goes again within seconds, until it is answered', async () => {
    let lose = 1
    const real = target('host:devbox', 'host')
    const lossy: CopyTarget = {
      ...real,
      post: async (payload) => {
        if (payload.confirm === true && lose > 0) { lose--; steps.push('host:devbox lost:confirm'); return { ok: false, outcome: 'failed', error: 'the host is not connected' } }
        return real.post(payload)
      },
    }
    registerReplicaTarget(lossy)
    leader.alpha = Array.from({ length: 60 }, (_, i) => ({ id: `a${i}`, v: 1 }))
    const s = startCopyKindsSync([kindOf('alpha')], {})
    await tick(COPY_FIRST_ROUND_MS + COPY_DEBOUNCE_MS + 10)
    expect(followers.alpha.store.size).toBe(60)
    leader.alpha = leader.alpha.slice(0, 10)
    for (let i = 0; i < 3; i++) { watchers.alpha(); await tick(COPY_DEBOUNCE_MS + 10) }
    expect(peekKindState('host:devbox', 'alpha')).toMatchObject({ refusals: 3 })
    expect(await confirmCopyKindRemoval('host:devbox', 'alpha')).toBe(true)
    steps = []
    await tick(COPY_DEBOUNCE_MS + 10)
    expect(steps).toEqual(['host:devbox lost:confirm'])
    expect(followers.alpha.store.size).toBe(60)
    // No store write, no sweep: the scheduler sends it again by itself.
    await tick(confirmRetryMs(1))
    expect(steps.slice(1)).toEqual(['host:devbox sync:alpha'])
    expect(followers.alpha.store.size).toBe(10)
    expect(peekKindState('host:devbox', 'alpha')).toMatchObject({ refusals: 0, confirmNext: false })
    steps = []
    await tick(confirmRetryMs(9) * 3)
    expect(steps).toEqual([])
    s.stop()
  })

  it('copyKindNow: that kind to that target at once (not after the debounce), with its result; none without a scheduler', async () => {
    expect(await copyKindNow('beta', 'host:devbox')).toEqual([])
    const s = startCopyKindsSync(kinds, { targets: () => [target('host:devbox', 'host'), target('host:other', 'host')] })
    onTestFinished(() => s.stop())
    await tick(COPY_FIRST_ROUND_MS + COPY_DEBOUNCE_MS + 10)
    steps = []
    leader.beta = [{ id: 'b1', v: 3 }]
    watchers.beta()
    // Asked during the debounce: it goes now, to that target alone.
    expect(await copyKindNow('beta', 'host:devbox')).toEqual([expect.objectContaining({ kind: 'beta', target: 'host:devbox', action: 'synced' })])
    expect(followers.beta.store.get('b1')?.v).toBe(3)
    expect(steps).toEqual(['host:devbox put:beta'])
    // The other target gets it with the scheduler's own round; the asked one holds it already.
    steps = []
    await tick(COPY_DEBOUNCE_MS + 10)
    expect(steps).toEqual(['host:other put:beta'])
    expect(await copyKindNow('beta', 'host:devbox')).toEqual([expect.objectContaining({ kind: 'beta', target: 'host:devbox', action: 'unchanged' })])
    // A kind this scheduler does not copy, a target it does not know: nothing.
    expect(await copyKindNow('gamma', 'host:devbox')).toEqual([])
    expect(await copyKindNow('beta', 'host:nowhere')).toEqual([])
    s.stop()
    expect(await copyKindNow('beta', 'host:devbox')).toEqual([])
  })

  it('S1: a slow other target never holds the ask: a round of another kind to it runs, and the ask goes beside it', async () => {
    let release: (() => void) | null = null
    const real = target('host:slow', 'host')
    const slow: CopyTarget = { ...real, post: async (payload) => {
      if ((payload as { op?: string }).op === 'put' && release === null) await new Promise<void>((r) => { release = r })
      return real.post(payload)
    } }
    const s = startCopyKindsSync(kinds, { targets: () => [slow, target('host:devbox', 'host')] })
    try {
      // The scheduler's round of alpha is stuck on the slow target.
      watchers.alpha()
      await tick(COPY_DEBOUNCE_MS + 10)
      await vi.waitFor(() => expect(release).not.toBeNull())
      leader.beta = [{ id: 'b1', v: 9 }]
      expect(await copyKindNow('beta', 'host:devbox')).toEqual([expect.objectContaining({ kind: 'beta', target: 'host:devbox', action: 'synced' })])
      expect(steps.filter((x) => x.includes('beta'))).toEqual(['host:devbox status:beta', 'host:devbox sync:beta', 'host:devbox put:beta'])
      release!()
    } finally { s.stop() }
  })

  it('S1: a round of the same kind running now answers the ask when it reaches that target (or did already), not when it ends', async () => {
    const gates: Record<string, (() => void) | null> = { 'host:slow': null, 'host:last': null }
    const gated = (id: string): CopyTarget => {
      const real = target(id, 'host')
      return { ...real, post: async (payload) => {
        if ((payload as { op?: string }).op === 'status' && gates[id] === null) await new Promise<void>((r) => { gates[id] = r })
        return real.post(payload)
      } }
    }
    const s = startCopyKindsSync([kindOf('alpha')], { targets: () => [target('host:devbox', 'host'), gated('host:slow'), gated('host:last')] })
    try {
      watchers.alpha()
      await tick(COPY_DEBOUNCE_MS + 10)
      await vi.waitFor(() => expect(gates['host:slow']).not.toBeNull())
      // host:devbox took it already in this round: answered at once.
      expect(await copyKindNow('alpha', 'host:devbox')).toEqual([expect.objectContaining({ kind: 'alpha', target: 'host:devbox' })])
      const asked = copyKindNow('alpha', 'host:slow')
      let answered = false
      void asked.then(() => { answered = true })
      await tick(10)
      expect(answered).toBe(false)
      gates['host:slow']!()
      // Answered while the round still waits on host:last.
      expect(await asked).toEqual([expect.objectContaining({ kind: 'alpha', target: 'host:slow' })])
      await vi.waitFor(() => expect(gates['host:last']).not.toBeNull())
      gates['host:last']!()
    } finally { s.stop() }
  })

  it('S2: a round that fails answers its waiters at once', async () => {
    let fail: (() => void) | null = null
    const broken: CopyTarget = { ...target('host:devbox', 'host'), available: async () => { await new Promise<void>((r) => { fail = r }); throw new Error('probe broke') } }
    const s = startCopyKindsSync([kindOf('alpha')], { targets: () => [broken] })
    try {
      watchers.alpha()
      await tick(COPY_DEBOUNCE_MS + 10)
      await vi.waitFor(() => expect(fail).not.toBeNull())
      const asked = copyKindNow('alpha', 'host:devbox')
      fail!()
      expect(await asked).toEqual([])
    } finally { s.stop() }
    // A one-target round that throws answers at once too.
    const s2 = startCopyKindsSync([kindOf('beta')], { targets: () => { throw new Error('no targets') } })
    try { expect(await copyKindNow('beta', 'host:devbox')).toEqual([]) } finally { s2.stop() }
  })
})
