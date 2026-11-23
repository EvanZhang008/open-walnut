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
        sessions: async () => [...live.shared].map(([id, inTurn]) => (inTurn ? { id, busy: `session ${id}: in a turn` } : { id })),
        openWork: async () => null,
        stop: async (id) => { log.push(`stop:${id}`); live.shared.delete(id); return { ok: true } },
        hold: () => { held = true; log.push('hold') },
        drained: async () => true,
        release: () => {
          held = false; log.push('release')
          for (const q of queue.splice(0)) deliver(q.id, q.text)
        },
        stopFollower: async () => { log.push('follower-off') },
        dropScope: async () => { log.push('drop-scope') },
        restore: async () => { log.push('restore') },
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
    // The follower is stopped right after the hold (it could start work there by itself), before the
    // sessions are judged again and stopped; the triggers and jobs go last, before the flip.
    expect(h.log.filter((l) => !l.startsWith('store:'))).toEqual(['hold', 'follower-off', 'stop:s1', 'stop:s2', 'drop-scope', 'flip', 'reconnect', 'confirm', 'release', 'report:moved'])
    // The done record is on disk before the confirm (low 11).
    expect(h.log.indexOf('store:done')).toBeLessThan(h.log.indexOf('confirm'))
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
    expect((out as { why: string }).why).toMatch(/went on for the whole wait \(30 min; last: session busy: in a turn\); nothing was stopped/)
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
      sessions: async () => { calls++; return [calls === 2 ? { id: 's1', busy: 'session s1: in a turn' } : { id: 's1' }] },
    })
    expect(out.result).toBe('moved')
    // The follower stopped for the look is given back before the release.
    expect(h.log.slice(0, 5)).toEqual(['store:waiting', 'hold', 'follower-off', 'restore', 'release'])
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
    const out = await runMove(h.deps({ stop: async (id) => { h.log.push(`stop:${id}`); return id === 's1' ? { ok: true } : { ok: false, why: 'session s2: a CLI of it still runs (live pid 7)' } } }))
    expect(out).toMatchObject({ result: 'gave_up', stopped: ['s1'] })
    expect((out as { why: string }).why).toMatch(/s2: a CLI of it still runs/)
    // The shared daemon gets back what the hold took, then the work is released; nothing flips.
    const seq = h.log.filter((l) => !l.startsWith('store:'))
    expect(seq.slice(seq.indexOf('stop:s2'))).toEqual(['stop:s2', 'restore', 'release', 'report:gave_up'])
    expect(h.log).not.toContain('drop-scope')
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

  it('B5: work that outlives a turn counts as busy, and so does other open work there: the move waits, never stops it', async () => {
    const h = fakeHost()
    h.live.shared.set('s1', false)
    let looks = 0
    const out = await runMove(h.deps({
      // A background test run of s1 ends after two looks; then a host_exec run of a task goes on for one more.
      sessions: async () => { looks++; return [looks <= 2 ? { id: 's1', busy: 'session s1: a background command or subagent it started' } : { id: 's1' }] },
      openWork: async () => (looks === 3 ? '1 host_exec run of this Walnut\'s tasks still runs there' : null),
    }))
    expect(out.result).toBe('moved')
    // No stop before the work ended: the first hold comes on the fourth look.
    expect(h.log.filter((l) => l === 'hold').length).toBe(1)
    expect(looks).toBe(5)
  })

  it('B5: at the bound the give-up names the work that kept it busy (a /loop), and nothing is stopped', async () => {
    const h = fakeHost()
    h.live.shared.set('s1', false)
    const out = await runMove(h.deps({ sessions: async () => [{ id: 's1', busy: 'session s1: a /loop it armed' }] }))
    expect(out).toMatchObject({ result: 'gave_up' })
    expect((out as { why: string }).why).toMatch(/last: session s1: a \/loop it armed/)
    expect(h.log.some((l) => l.startsWith('stop:') || l === 'hold')).toBe(false)
  })

  it('B5: a start or send that passed just before the hold is waited for, not stopped under', async () => {
    const h = fakeHost()
    h.live.shared.set('s1', false)
    let drains = 0
    const out = await runMove(h.deps({ drained: async () => ++drains > 1 }))
    expect(out.result).toBe('moved')
    expect(h.log.filter((l) => !l.startsWith('store:')).slice(0, 4)).toEqual(['hold', 'release', 'hold', 'follower-off'])
  })

  it('B5: a session that became busy right before its stop ends the try: restored, released, nothing flipped', async () => {
    const h = fakeHost()
    h.live.shared.set('s1', false)
    const out = await runMove(h.deps({ stop: async () => ({ ok: false, busy: true, why: 'session s1: in a turn' }) }))
    expect(out).toMatchObject({ result: 'gave_up' })
    expect((out as { why: string }).why).toMatch(/in a turn right before its stop/)
    expect(h.log).toContain('restore')
    expect(h.log).not.toContain('flip')
  })

  it('B3: the follower is stopped before the second look, so a session it started meanwhile is seen and stopped too', async () => {
    const h = fakeHost()
    h.live.shared.set('s1', false)
    const out = await runMove(h.deps({
      stopFollower: async () => { h.log.push('follower-off'); h.live.shared.set('by-follower', false) },
    }))
    expect(out).toMatchObject({ result: 'moved', stopped: ['s1', 'by-follower'] })
    expect(h.log.indexOf('follower-off')).toBeLessThan(h.log.indexOf('stop:s1'))
  })

  it('B4: a session the move cannot take (an ACP session) gives the move up before anything is stopped', async () => {
    const h = fakeHost()
    h.live.shared.set('s1', false)
    const out = await runMove(h.deps({ sessions: async () => [{ id: 's1' }, { id: 'acp', blocks: 'session acp: an ACP session' }] }))
    expect(out).toMatchObject({ result: 'gave_up' })
    expect((out as { why: string }).why).toMatch(/an ACP session; nothing was stopped/)
    expect(h.log.some((l) => l.startsWith('stop:') || l === 'hold')).toBe(false)
  })

  it('B6: the triggers and plugin jobs are dropped before the flip; a drop that fails gives everything back, nothing flipped', async () => {
    const h = fakeHost()
    h.live.shared.set('s1', false)
    const out = await runMove(h.deps({ dropScope: async () => { h.log.push('drop-scope'); throw new Error('1 clock routine there still had fires to deliver') } }))
    expect(out).toMatchObject({ result: 'gave_up' })
    expect((out as { why: string }).why).toMatch(/triggers and plugin jobs .* were not dropped \(1 clock routine/)
    const seq = h.log.filter((l) => !l.startsWith('store:'))
    expect(seq.slice(seq.indexOf('drop-scope'))).toEqual(['drop-scope', 'restore', 'release', 'report:gave_up'])
  })

  it('should-fix 7: a follower that does not stop gives up before any session is stopped', async () => {
    const h = fakeHost()
    h.live.shared.set('s1', false)
    const out = await runMove(h.deps({ stopFollower: async () => { throw new Error('it still reads running') } }))
    expect(out).toMatchObject({ result: 'gave_up' })
    expect((out as { why: string }).why).toMatch(/follower on the shared daemon did not stop \(it still reads running\)/)
    expect(h.log.some((l) => l.startsWith('stop:'))).toBe(false)
    expect(h.log).toContain('release')
  })

  it('should-fix 10: failures in a row back off (the wait doubles) and end after a few tries, until an update names the set', async () => {
    const h = fakeHost()
    h.live.shared.set('s1', false)
    const failing = h.deps({ stop: async () => ({ ok: false, why: 'session s1: it owns scheduled crons (a /loop), which its stop would end' }) })
    const waits: number[] = []
    let out: MoveOutcome | null = null
    for (let i = 0; i < 4; i++) {
      const at = h.now
      out = await runMove(failing)
      waits.push((h.record()!.nextTryAt ?? 0) - at)
      h.now = (h.record()!.nextTryAt ?? h.now) + 1
    }
    expect(waits.slice(0, 3)).toEqual([2, 4, 8].map((x) => x * 3600_000))
    expect(out).toMatchObject({ result: 'gave_up', failures: 4, final: true })
    expect((out as { why: string }).why).toMatch(/owns scheduled crons/)
    h.now += 7 * 24 * 3600_000
    expect(await runMove(failing)).toMatchObject({ result: 'not_due', why: expect.stringMatching(/failed 4 times in a row/) })
    // An update that names the set tries anew, and a success clears the count.
    expect(await runMove(h.deps({ force: true }))).toMatchObject({ result: 'moved' })
    expect(h.record()).toMatchObject({ phase: 'done' })
    expect(h.record()!.failures).toBeUndefined()
  })

  it('should-fix 4 (SSH): the host reboots right after the flip and the set does not come up: put back, the shared daemon reached again', async () => {
    const h = fakeHost({ setAnswers: false })
    h.live.shared.set('s1', false)
    const out = await runMove({ ...h.deps(), link: 'ssh' })
    expect(out).toMatchObject({ result: 'reverted' })
    expect(h.target).toBe('shared')
    expect(h.log.filter((l) => !l.startsWith('store:')).slice(-4)).toEqual(['unflip', 'reconnect', 'release', 'report:reverted'])
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
