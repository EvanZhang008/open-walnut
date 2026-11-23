/**
 * The move of this Walnut's sessions from another Walnut's shared daemon to its own service set
 * (src/providers/service-set-move.ts), with every effect injected: a fake clock, a fake host with
 * two daemons (the shared one and the set's), the hold that keeps starts and sends waiting, and
 * the kept record. Guards the decided rules: the wait is bounded and never stops a turn; a failed
 * reconnect points the link back and the host stays reachable; a leader restart resumes; a
 * session started just before the flip ends on the shared daemon and is moved, one started just
 * after lands only on the set's service.
 */
import { describe, expect, it } from 'vitest'
import { moveOnce, runMove, settleMove, type MoveDeps, type MoveOutcome, type MoveRecord } from '../../src/providers/service-set-move.js'

const SET = '0123456789abcdef'

/** A host with the shared daemon and the set's, the link pointing at one of them. */
function fakeHost(o: { setAnswers?: boolean; flipFails?: boolean } = {}) {
  let now = 1_000_000
  let held = false
  let target: 'shared' | 'set' = 'shared'
  let flipped = false
  const log: string[] = []
  const queue: Array<{ id: string; text: string }> = []
  /** Live sessions on each daemon: id -> in a turn. */
  const live = { shared: new Map<string, boolean>(), set: new Map<string, boolean>() }
  /** Where each line landed. */
  const landed: Array<{ id: string; text: string; on: 'shared' | 'set' }> = []
  let record: MoveRecord | null = null
  const deliver = (id: string, text: string) => {
    // A stopped session resumes where the link points now (--resume, as after any stop).
    landed.push({ id, text, on: target })
    if (!live[target].has(id)) live[target].set(id, false)
  }
  const host = {
    log, landed, live, queue,
    get now() { return now },
    set now(v: number) { now = v },
    get target() { return target },
    /** A person's message (or a start): held while the move holds, else delivered now. */
    send(id: string, text: string) {
      if (held) { queue.push({ id, text }); log.push(`held:${id}`); return }
      deliver(id, text)
    },
    record: () => record,
    setRecord(r: MoveRecord | null) { record = r },
    deps(extra: Partial<MoveDeps> = {}, onSleep?: () => void): MoveDeps {
      return {
        set: SET, link: 'net', now: () => now,
        sleep: async (ms) => { now += ms; onSleep?.() },
        store: { read: async () => record, write: async (r) => { record = r; log.push(`store:${r?.phase}`) } },
        // This Walnut's own sessions on the shared daemon only.
        sessions: async () => [...live.shared].map(([id, inTurn]) => ({ id, inTurn })),
        stop: async (id) => { log.push(`stop:${id}`); live.shared.delete(id); return true },
        hold: () => { held = true; log.push('hold') },
        release: () => {
          held = false; log.push('release')
          for (const q of queue.splice(0)) deliver(q.id, q.text)
        },
        stopFollower: async () => { log.push('follower-off') },
        flip: async () => { log.push('flip'); if (o.flipFails) throw new Error('route refused'); flipped = true },
        unflip: async () => { log.push('unflip'); flipped = false },
        confirm: async () => { log.push('confirm') },
        reconnect: async () => {
          log.push('reconnect')
          if (flipped && o.setAnswers !== false) { target = 'set'; return SET }
          target = 'shared'
          return flipped ? null : ''
        },
        report: (r) => { log.push(`report:${r.result}`) },
        waitMs: 30 * 60_000, pollMs: 15_000, reconnectMs: 120_000, retryMs: 2 * 3600_000,
        ...extra,
      }
    },
  }
  return host
}

describe('service set move', () => {
  it('moves: waits for no turn, holds, stops each session the normal way, flips, reconnects, confirms, releases', async () => {
    const h = fakeHost()
    h.live.shared.set('s1', false)
    h.live.shared.set('s2', false)
    const out = await runMove(h.deps())
    expect(out).toEqual({ result: 'moved', stopped: ['s1', 's2'] })
    expect(h.log.filter((l) => !l.startsWith('store:'))).toEqual(['hold', 'stop:s1', 'stop:s2', 'follower-off', 'flip', 'reconnect', 'confirm', 'release', 'report:moved'])
    expect(h.record()).toMatchObject({ phase: 'done', set: SET, stopped: ['s1', 's2'] })
    // On disk before the flip: a restart in between knows to point it back.
    expect(h.log.indexOf('store:flipped')).toBeLessThan(h.log.indexOf('flip'))
    // The stopped sessions resume on the set's service at their next message.
    h.send('s1', 'next')
    expect(h.landed).toEqual([{ id: 's1', text: 'next', on: 'set' }])
  })

  it('gives up at the wait bound and never stops a session in a turn', async () => {
    const h = fakeHost()
    h.live.shared.set('busy', true)
    h.live.shared.set('idle', false)
    const out = await runMove(h.deps())
    expect(out.result).toBe('gave_up')
    expect((out as { why: string }).why).toMatch(/ran the whole wait \(30 min\); nothing was stopped/)
    expect(h.log.some((l) => l.startsWith('stop:'))).toBe(false)
    expect(h.log).not.toContain('flip')
    expect(h.log).toContain('report:gave_up')
    expect(h.record()).toMatchObject({ phase: 'gave_up', nextTryAt: h.now + 2 * 3600_000 })
    expect(h.live.shared.get('busy')).toBe(true)
    // Not tried again before its time, unless an update named the set again.
    expect(await runMove(h.deps())).toMatchObject({ result: 'not_due' })
    h.live.shared.set('busy', false)
    expect(await runMove(h.deps({ force: true }))).toMatchObject({ result: 'moved' })
  })

  it('a turn that ends within the bound is waited out, then moved', async () => {
    const h = fakeHost()
    h.live.shared.set('s1', true)
    let sleeps = 0
    const out = await runMove(h.deps({}, () => { if (++sleeps === 3) h.live.shared.set('s1', false) }))
    expect(out.result).toBe('moved')
    expect(sleeps).toBe(3)
  })

  it('a send that slipped in before the hold puts it back and waits: the hold is never kept over a turn', async () => {
    const h = fakeHost()
    h.live.shared.set('s1', false)
    let calls = 0
    const base = h.deps()
    const out = await runMove({
      ...base,
      // The second look (right after the hold) sees the turn a send started a moment before.
      sessions: async () => { calls++; return [{ id: 's1', inTurn: calls === 2 }] },
    })
    expect(out.result).toBe('moved')
    expect(h.log.slice(0, 3)).toEqual(['store:waiting', 'hold', 'release'])
  })

  it('reconnect failure flips back, reconnects to the shared daemon and releases the held work there', async () => {
    const h = fakeHost({ setAnswers: false })
    h.live.shared.set('s1', false)
    const out = await runMove(h.deps({ hold: () => { h.log.push('hold'); /* the real hold */ } }))
    expect(out.result).toBe('reverted')
    expect((out as { why: string }).why).toMatch(/did not answer within 120 s/)
    const seq = h.log.filter((l) => !l.startsWith('store:'))
    expect(seq.slice(seq.indexOf('flip'))).toEqual(['flip', 'reconnect', 'unflip', 'reconnect', 'release', 'report:reverted'])
    // The host stays reachable: the link reaches the shared daemon again.
    expect(h.target).toBe('shared')
    expect(h.record()).toMatchObject({ phase: 'reverted' })
  })

  it('a flip the host refuses changes nothing on the link and is reported', async () => {
    const h = fakeHost({ flipFails: true })
    const out = await runMove(h.deps())
    expect(out).toMatchObject({ result: 'reverted' })
    expect((out as { why: string }).why).toMatch(/route refused/)
    expect(h.target).toBe('shared')
  })

  it('a stop that does not confirm gives up and releases', async () => {
    const h = fakeHost()
    h.live.shared.set('s1', false)
    h.live.shared.set('s2', false)
    const out = await runMove(h.deps({ stop: async (id) => { h.log.push(`stop:${id}`); return id === 's1' } }))
    expect(out).toMatchObject({ result: 'gave_up', stopped: ['s1'] })
    expect(h.log).toContain('release')
    expect(h.log).not.toContain('flip')
  })

  it('a leader restart mid-move: a flip left behind is pointed back first, then the move runs again', async () => {
    const h = fakeHost()
    h.setRecord({ v: 1, at: 1, set: SET, link: 'net', phase: 'flipped', startedAt: 1, stopped: ['old'] })
    h.live.shared.set('s1', false)
    const out = await runMove(h.deps())
    expect(out.result).toBe('moved')
    expect(h.log[0]).toBe('unflip')
    expect(h.record()).toMatchObject({ phase: 'done' })
  })

  it('a leader restart while waiting keeps the wait\'s start: the bound counts across the restart', async () => {
    const h = fakeHost()
    h.setRecord({ v: 1, at: 1, set: SET, link: 'net', phase: 'holding', startedAt: h.now - 31 * 60_000, stopped: [] })
    h.live.shared.set('busy', true)
    const out = await runMove(h.deps())
    expect(out.result).toBe('gave_up')
    expect(h.log.filter((l) => l.startsWith('stop:'))).toEqual([])
  })

  it('a restart that finds the link on the set settles a flipped record as done (confirmed)', async () => {
    const h = fakeHost()
    h.setRecord({ v: 1, at: 1, set: SET, link: 'net', phase: 'flipped', startedAt: 1, stopped: ['s1'] })
    const d = h.deps()
    expect(await settleMove(d)).toBe(true)
    expect(h.log).toContain('confirm')
    expect(h.record()).toMatchObject({ phase: 'done' })
    expect(await settleMove(d)).toBe(false)
  })

  it('a session started just before the flip point ends on the shared daemon and is moved; one started just after lands only on the set', async () => {
    const h = fakeHost()
    // Just before: started on the shared daemon while the move waited.
    h.send('before', 'hello')
    expect(h.landed.at(-1)).toEqual({ id: 'before', text: 'hello', on: 'shared' })
    const base = h.deps()
    const out = await runMove({
      ...base,
      hold: () => {
        base.hold()
        // Just after the flip point: a start comes while the move holds.
        h.send('after', 'first line')
      },
    })
    expect(out.result).toBe('moved')
    // `before` was stopped on the shared daemon; `after` was held, never on the shared daemon.
    expect(h.log).toContain('stop:before')
    expect(h.log).toContain('held:after')
    expect(h.landed.filter((l) => l.id === 'after')).toEqual([{ id: 'after', text: 'first line', on: 'set' }])
    expect(h.live.shared.has('after')).toBe(false)
    // `before` resumes on the set at its next message.
    h.send('before', 'again')
    expect(h.landed.at(-1)).toEqual({ id: 'before', text: 'again', on: 'set' })
    expect(h.live.shared.size).toBe(0)
  })

  it('one move at a time per place', async () => {
    let n = 0
    let release!: () => void
    const gate = new Promise<void>((r) => { release = r })
    const run = async (): Promise<MoveOutcome> => { n++; await gate; return { result: 'moved', stopped: [] } }
    const a = moveOnce('net:h', run)
    const b = moveOnce('net:h', run)
    release()
    expect(await a).toEqual(await b)
    expect(n).toBe(1)
  })
})
