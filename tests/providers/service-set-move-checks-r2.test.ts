/**
 * What a service set move asks the shared daemon before it touches anything, review round 2
 * (src/providers/service-set-move-checks.ts), with a fake link:
 *   M5  a daemon older than the per-Walnut split keeps one trigger and job set for every Walnut, so
 *       the move must not send it an empty set (that clears the other Walnut's triggers too);
 *   M3  a trigger the offline journal holds stays armed even after an empty set, and a fire not
 *       acked stays there: both are no drop;
 *   M2  each disarmed trigger's exact memory (seen items, cursor) is taken from the shared daemon
 *       and handed to the set's daemon, so its first check there does not report every item again.
 */
import { describe, expect, it } from 'vitest'
import { dropWalnutScope, moveBlocker, seedTriggerMemory, takeTriggerMemory, type MoveCheckLink } from '../../src/providers/service-set-move-checks.js'

const HOME = '/home/u/.open-walnut'

function link(caps: string[], reply: (cmd: string, params: Record<string, unknown>) => Record<string, unknown> = () => ({ ok: true })) {
  const sent: Array<{ cmd: string; params: Record<string, unknown> }> = []
  const l: MoveCheckLink = {
    hostKey: 'h', home: HOME,
    send: async (cmd, params) => { sent.push({ cmd, params }); return reply(cmd, params) },
    hasCapability: (c) => caps.includes(c),
    workUnderWay: () => 0,
    walnutId: async () => '0123456789abcdef0123',
  }
  return { l, sent }
}

describe('moveBlocker and dropWalnutScope (M5, M3)', () => {
  it('M5: a daemon with no walnut-scope-v1 blocks the move, and is never sent an empty set', async () => {
    expect(await moveBlocker(link([]).l, [])).toMatch(/older than the per-Walnut split \(no walnut-scope-v1\).*clear the other Walnut's too/)
    const { l, sent } = link(['plugin-jobs-v1'])
    await expect(dropWalnutScope(l)).rejects.toThrow(/walnut-scope-v1/)
    expect(sent).toEqual([])
  })

  it('M2: triggers there and no way to take their memory block the move; none, or a daemon that can, do not', async () => {
    expect(await moveBlocker(link(['walnut-scope-v1']).l, ['t1'])).toMatch(/no trigger-state-snapshot-v1/)
    expect(await moveBlocker(link(['walnut-scope-v1']).l, [])).toBe(null)
    expect(await moveBlocker(link(['walnut-scope-v1', 'trigger-state-snapshot-v1']).l, ['t1'])).toBe(null)
  })

  it('M3: a trigger left armed by a journal hold, or one with fires still to deliver, is no drop', async () => {
    const caps = ['walnut-scope-v1']
    await expect(dropWalnutScope(link(caps, () => ({ ok: true, armed: 1, draining: 0 })).l)).rejects.toThrow(/1 of this Walnut's triggers there stay armed/)
    await expect(dropWalnutScope(link(caps, () => ({ ok: true, armed: 0, draining: 2 })).l)).rejects.toThrow(/2 of this Walnut's triggers there still have fires/)
    await expect(dropWalnutScope(link(caps, () => ({ ok: true, armed: 0, draining: 0 })).l)).resolves.toBeUndefined()
  })
})

describe('takeTriggerMemory and seedTriggerMemory (M2)', () => {
  const state = { epoch: 'e', seq: 3, seen: { a: 1 } }
  const ok = (tid: string) => ({ ok: true, supported: true, complete: true, frozen: true, triggerId: tid, state, digest: `d-${tid}`, seenReliableUntil: Date.now() + 86_400_000 })

  it('takes each trigger\'s exact state after the drop, waits out a check still running, skips one with nothing kept', async () => {
    let tries = 0
    const { l, sent } = link(['trigger-state-snapshot-v1'], (_cmd, p) => {
      if (p.triggerId === 'busy' && tries++ < 2) return { ok: true, supported: false, reason: 'check_running' }
      if (p.triggerId === 'none') return { ok: true, supported: false, reason: 'state_missing' }
      return ok(String(p.triggerId))
    })
    const waits: number[] = []
    const got = await takeTriggerMemory(l, ['t1', 'busy', 'none'], async (ms) => { waits.push(ms) })
    expect(got).toEqual([{ triggerId: 't1', state, digest: 'd-t1' }, { triggerId: 'busy', state, digest: 'd-busy' }])
    expect(sent.every((s) => s.cmd === 'triggers.state.snapshot' && s.params.home === HOME)).toBe(true)
    expect(waits).toEqual([2_000, 2_000])
  })

  it('a memory that cannot be taken gives the move up', async () => {
    const { l } = link(['trigger-state-snapshot-v1'], () => ({ ok: true, supported: false, reason: 'state_corrupt' }))
    await expect(takeTriggerMemory(l, ['t1'], async () => {})).rejects.toThrow(/trigger t1: its memory could not be taken \(state_corrupt\)/)
  })

  it('S1: a memory holding an entry older than 30 days is still carried, whole', async () => {
    // A watcher that has not fired since an old item aged out keeps that entry (pruned only on a fire).
    const old = Date.now() - 40 * 86_400_000
    const aged = { epoch: 'e', seq: 9, seen: { gone: old, fresh: Date.now() - 1_000 } }
    const { l } = link(['trigger-state-snapshot-v1'], () => ({ ...ok('t1'), state: aged, seenReliableUntil: old + 30 * 86_400_000 }))
    expect(await takeTriggerMemory(l, ['t1'], async () => {})).toEqual([{ triggerId: 't1', state: aged, digest: 'd-t1' }])
  })

  it('hands each to the set\'s daemon; one it already keeps stays; a daemon that cannot take it is an error', async () => {
    const memory = [{ triggerId: 't1', state, digest: 'd-t1' }, { triggerId: 't2', state, digest: 'd-t2' }]
    const { l, sent } = link(['trigger-state-seed-v1'], (_c, p) => (p.triggerId === 't2' ? { ok: true, seeded: false, reason: 'state_exists' } : { ok: true, seeded: true }))
    await seedTriggerMemory(l, memory)
    expect(sent).toEqual(memory.map((m) => ({ cmd: 'triggers.state.seed', params: { home: HOME, ...m } })))
    await expect(seedTriggerMemory(link([]).l, memory)).rejects.toThrow(/no trigger-state-seed-v1/)
    await expect(seedTriggerMemory(link(['trigger-state-seed-v1'], () => ({ ok: true, seeded: false, reason: 'armed' })).l, memory)).rejects.toThrow(/trigger t1: armed/)
    await seedTriggerMemory(link([]).l, [])
  })
})
