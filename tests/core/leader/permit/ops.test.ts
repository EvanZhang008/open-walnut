/**
 * Op ids registered before an outward send (design section 6): the rules, the client's book,
 * the witness's file, and named schedules on the simulated network. Each guard has a case
 * that removes it and must go red.
 */
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  DEFAULT_PERMIT_PARAMS, OpBook, PermitNotHeld, PermitWitness, applyOps, createFilePermitStore, decodeStored, encodeStored, genesisConfigId, judge,
  registrationConflict, type HeldOp, type PermitRecord, type WitnessState,
} from '../../../../src/core/leader/permit/index.js'
import { CALM, World, pilot, type MachineNode } from './sim.js'

const P = DEFAULT_PERMIT_PARAMS
const W = ['w1', 'w2', 'w3']
const G = genesisConfigId(W)
const rec = (number: number, kind: PermitRecord['kind'], by: string, extra: Partial<PermitRecord> = {}): PermitRecord => ({
  number, kind, by, holder: by, nonce: 'n1', validMs: P.validMs, list: W, cfg: G, epoch: 0, ...extra,
})
const held = (h: PermitRecord, ops: HeldOp[] = []): WitnessState => ({ held: h, acceptedAt: 0, list: W, joint: null, cfg: G, epoch: 0, progress: null, ops })

describe('the op entries a witness keeps', () => {
  it('a registration, then its outcome; an outcome never goes back to none, and sent never to not-sent', () => {
    let e = applyOps([], rec(2, 'renew', 'A', { ops: { register: ['op1'] } }), 10, P.opRetainMs)
    expect(e).toEqual([{ id: 'op1', state: 'registered', by: 'A', nonce: 'n1', at: 10 }])
    e = applyOps(e, rec(3, 'renew', 'A', { ops: { sent: ['op1'] } }), 20, P.opRetainMs)
    expect(e[0]).toMatchObject({ state: 'sent', at: 20 })
    e = applyOps(e, rec(4, 'members', 'B', { ledger: [{ id: 'op1', state: 'not-sent', by: 'A', nonce: 'n1' }] }), 30, P.opRetainMs)
    expect(e[0]).toMatchObject({ state: 'sent', at: 20 })
    e = applyOps(e, rec(5, 'members', 'B', { ledger: [{ id: 'op1', state: 'registered', by: 'A', nonce: 'n1' }] }), 30, P.opRetainMs)
    expect(e[0]!.state).toBe('sent')
  })

  it('drops an entry whose outcome has been known longer than opRetainMs, and never one with no outcome', () => {
    let e = applyOps([], rec(2, 'renew', 'A', { ops: { register: ['a', 'b'] } }), 0, P.opRetainMs)
    e = applyOps(e, rec(3, 'renew', 'A', { ops: { sent: ['a'] } }), 1_000, P.opRetainMs)
    e = applyOps(e, rec(4, 'renew', 'A'), 1_000 + P.opRetainMs + 1, P.opRetainMs)
    expect(e.map((x) => [x.id, x.state])).toEqual([['b', 'registered']])
    e = applyOps(e, rec(5, 'renew', 'A'), 100 * P.opRetainMs, P.opRetainMs)
    expect(e.map((x) => x.id)).toEqual(['b'])
  })

  it('refuses a registration of an id it holds, except the same incarnation sending it again with no outcome', () => {
    const e = applyOps([], rec(2, 'renew', 'A', { ops: { register: ['op1'] } }), 0, P.opRetainMs)
    expect(registrationConflict(e, { register: ['op1'] }, 'A', 'n1')).toBeNull()
    expect(registrationConflict(e, { register: ['op1'] }, 'A', 'n2')).toBe('op-known: op1')
    expect(registrationConflict(e, { register: ['op1'] }, 'B', 'n9')).toBe('op-known: op1')
    const sent = applyOps(e, rec(3, 'renew', 'A', { ops: { sent: ['op1'] } }), 0, P.opRetainMs)
    expect(registrationConflict(sent, { register: ['op1'] }, 'A', 'n1')).toBe('op-known: op1')
  })

  it('a witness takes a registration only from the live holder of the same incarnation', () => {
    const s = held(rec(1, 'grant', 'A'))
    const ok = judge(s, 'w1', rec(2, 'renew', 'A', { ops: { register: ['op1'] } }), 1, P)
    expect(ok.ok && ok.next.ops.map((x) => x.id)).toEqual(['op1'])
    expect(judge(s, 'w1', rec(2, 'renew', 'A', { nonce: 'n2', ops: { register: ['op1'] } }), 1, P)).toEqual({ ok: false, reason: 'not-holder' })
    expect(judge(s, 'w1', rec(2, 'renew', 'B', { ops: { register: ['op1'] } }), 1, P)).toEqual({ ok: false, reason: 'not-holder' })
    // Once the record ran out here, nobody registers on it.
    expect(judge(s, 'w1', rec(2, 'renew', 'A', { ops: { register: ['op1'] } }), P.validMs + P.witnessMarginMs + 1, P).ok).toBe(false)
    const known = held(rec(1, 'grant', 'B'), [{ id: 'op1', state: 'registered', by: 'A', nonce: 'n1', at: 0 }])
    expect(judge(known, 'w1', rec(2, 'renew', 'B', { ops: { register: ['op1'] } }), 1, P)).toEqual({ ok: false, reason: 'op-known: op1' })
  })

  it('refuses malformed op changes and ledgers', () => {
    const s = held(rec(1, 'grant', 'A'))
    expect(judge(s, 'w1', rec(2, 'grant', 'A', { ops: { register: ['x'] } }), P.validMs * 2, P)).toEqual({ ok: false, reason: 'bad-ops' })
    expect(judge(s, 'w1', rec(2, 'renew', 'A', { ops: { register: ['x', 'x'] } }), 1, P)).toEqual({ ok: false, reason: 'bad-ops' })
    expect(judge(s, 'w1', rec(2, 'renew', 'A', { ops: { register: ['x'], sent: ['x'] } }), 1, P)).toEqual({ ok: false, reason: 'bad-ops' })
    expect(judge(s, 'w1', rec(2, 'renew', 'A', { ops: { register: [''] } }), 1, P)).toEqual({ ok: false, reason: 'bad-ops' })
    expect(judge(s, 'w1', rec(2, 'renew', 'A', { ops: { register: Array.from({ length: 201 }, (_, i) => `o${i}`) } }), 1, P)).toEqual({ ok: false, reason: 'bad-ops' })
    expect(judge(s, 'w1', rec(2, 'renew', 'A', { ledger: [] }), 1, P)).toEqual({ ok: false, reason: 'bad-ledger' })
  })

  it('keeps its entries on disk and refuses a file whose entries are malformed', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'permit-ops-'))
    try {
      const file = path.join(dir, 'w1.json')
      const store = createFilePermitStore(file)
      const ops = [{ id: 'op1', state: 'registered' as const, by: 'A', nonce: 'n1' }]
      store.save({ held: rec(2, 'renew', 'A'), list: W, joint: null, cfg: G, epoch: 0, progress: null, ops })
      let t = 0
      const w = new PermitWitness({ id: 'w1', store, clock: { now: () => t }, params: P })
      expect(w.handle({ type: 'read' }).ops).toEqual(ops)
      const bad = JSON.parse(encodeStored({ held: null, list: W, joint: null, cfg: G, epoch: 0, progress: null, ops: [{ id: '', state: 'sent', by: 'A', nonce: 'n' }] }))
      expect(() => decodeStored(JSON.stringify(bad), 'x')).toThrow(/bad op entries/)
      t = 5
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe("a machine's book of op ids", () => {
  it('free, then pending, then registered once a record carrying it was chosen; refuses what others hold', () => {
    const b = new OpBook({ by: 'B', nonce: 'nb' }, () => 0, P.opRetainMs)
    expect(b.status('x')).toBe('free')
    expect(b.askRegister(['x'])).toEqual([])
    expect(b.status('x')).toBe('pending')
    expect(b.changes()).toEqual({ register: ['x'] })
    b.chosen({ register: ['x'] })
    expect(b.status('x')).toBe('registered')
    b.learn([{ id: 'y', state: 'registered', by: 'A', nonce: 'na' }, { id: 'z', state: 'sent', by: 'A', nonce: 'na' }])
    expect(b.askRegister(['y', 'z'])).toEqual([{ id: 'y', status: 'unknown' }, { id: 'z', status: 'sent' }])
    expect(b.unresolved().map((e) => e.id)).toEqual(['y'])
  })

  it('an id asked for that a witness reports as someone else\'s leaves what the next proposal carries', () => {
    const b = new OpBook({ by: 'B', nonce: 'nb' }, () => 0, P.opRetainMs)
    b.askRegister(['x'])
    b.learn([{ id: 'x', state: 'registered', by: 'A', nonce: 'na' }])
    expect(b.changes()).toBeUndefined()
    expect(b.status('x')).toBe('unknown')
  })

  it('an op this process began to send, or reported, is never "registered" again, also once its entry aged out (review round 3 B-1)', () => {
    let t = 0
    const b = new OpBook({ by: 'A', nonce: 'na' }, () => t, P.opRetainMs)
    b.askRegister(['x', 'y'])
    b.chosen({ register: ['x', 'y'] })
    expect([b.status('x'), b.status('y')]).toEqual(['registered', 'registered'])
    b.beginSend('x')
    expect(b.status('x')).toBe('sending')
    b.askOutcome('x', true)
    b.askOutcome('x', false) // a late "not sent" changes nothing
    b.askOutcome('y', false)
    expect([b.status('x'), b.status('y')]).toEqual(['sent', 'not-sent'])
    expect(b.changes()).toEqual({ sent: ['x'], notSent: ['y'] })
    b.chosen(b.changes())
    b.learn([{ id: 'x', state: 'sent', by: 'A', nonce: 'na' }, { id: 'y', state: 'not-sent', by: 'A', nonce: 'na' }])
    expect(b.learnedOutcomes().map((e) => [e.id, e.state])).toEqual([['x', 'sent'], ['y', 'not-sent']])
    // An hour on: the witnesses dropped both entries, and so did the book's copy of them.
    t += P.opRetainMs + 1
    b.learn([])
    expect(b.ledger()).toEqual([])
    expect([b.status('x'), b.status('y')]).toEqual(['sent', 'not-sent'])
    expect(b.askRegister(['x'])).toEqual([{ id: 'x', status: 'sent' }])
    expect(b.unresolved()).toEqual([])
  })

  it('an op reported before its registration stood is never asked for again: no proposal names one id twice (the old book did, and every witness refused it as bad-ops)', () => {
    const b = new OpBook({ by: 'A', nonce: 'na' }, () => 0, P.opRetainMs)
    b.askRegister(['x'])
    b.askOutcome('x', true)
    expect(b.status('x')).toBe('sent')
    expect(b.askRegister(['x'])).toEqual([{ id: 'x', status: 'sent' }])
    expect(b.changes()).toEqual({ sent: ['x'] })
  })

  it('an earlier incarnation of the same machine is someone else', () => {
    const b = new OpBook({ by: 'A', nonce: 'n2' }, () => 0, P.opRetainMs)
    b.learn([{ id: 'x', state: 'registered', by: 'A', nonce: 'n1' }])
    expect(b.status('x')).toBe('unknown')
    expect(b.unresolved().map((e) => e.id)).toEqual(['x'])
  })
})

// --- Named schedules -----------------------------------------------------------------

function world(witnesses = W): World {
  const w = new World(P, { ...CALM }, 11)
  for (const id of witnesses) w.addWitness(id, W.includes(id) ? { bootstrap: W } : { joinFrom: 0 })
  return w
}

function holds(w: World, id: string, list = W): MachineNode {
  const m = w.addMachine(id, list)
  m.c.requestGrant()
  w.run(w.now + 1_000)
  expect(m.c.mayAct()).toBe(true)
  return m
}

/** B takes the permission after A is gone (A's records run out on the witnesses). */
function bTakesOver(w: World, list = W, cfg?: string, epoch?: number): MachineNode {
  w.run(w.now + P.validMs + P.witnessMarginMs + 1_000)
  const b = w.addMachine('B', list, { cfg, epoch })
  b.c.read()
  w.run(w.now + 100)
  b.c.requestGrant()
  w.run(w.now + 1_000)
  expect(b.c.mayAct()).toBe(true)
  return b
}

describe('registered, sent, and the sender gone before it reported', () => {
  it('the next holder reads it as unknown: never registers it again, and lists it for the user', () => {
    const w = world()
    const a = holds(w, 'A')
    a.c.registerOps(['mail-1'])
    w.run(w.now + 1_000)
    expect(a.c.opStatus('mail-1')).toBe('registered')
    expect(() => a.c.assertMaySend('mail-1')).not.toThrow()
    // It sent, then its process died before any report.
    w.restartMachine('A', W, 10 * 60_000)
    const b = bTakesOver(w)
    expect(b.c.opStatus('mail-1')).toBe('unknown')
    expect(b.c.unresolvedOps().map((e) => e.id)).toEqual(['mail-1'])
    expect(b.c.registerOps(['mail-1']).refused).toEqual([{ id: 'mail-1', status: 'unknown' }])
    expect(() => b.c.assertMaySend('mail-1')).toThrow(PermitNotHeld)
  })

  it('every witness of a majority refuses the id to a later holder, whatever that holder knows', () => {
    const w = world()
    const a = holds(w, 'A')
    a.c.registerOps(['mail-1'])
    w.run(w.now + 1_000)
    w.restartMachine('A', W, 10 * 60_000)
    const b = bTakesOver(w)
    // Straight to each witness, as a client that ignored what it read would send it.
    const top = b.c.highestSeen()
    const answers = W.map((id) => w.witnesses.get(id)!.w!.handle({
      type: 'propose', record: { ...b.c.pendingRecord() ?? rec(top, 'renew', 'B'), number: top + 1, kind: 'renew', holder: 'B', by: 'B', nonce: b.c.incarnation(), ops: { register: ['mail-1'] } },
    }))
    expect(answers.map((r) => r.reason)).toEqual(['op-known: mail-1', 'op-known: mail-1', 'op-known: mail-1'])
  })
})

describe('a registration short of a majority', () => {
  it('allows no send until a majority took it', () => {
    const w = world()
    const a = holds(w, 'A')
    w.partition('A', 'w2')
    w.partition('A', 'w3')
    a.c.registerOps(['mail-2'])
    w.run(w.now + 1_000)
    expect(a.c.opStatus('mail-2')).toBe('pending')
    expect(() => a.c.assertMaySend('mail-2')).toThrow(/not registered with a majority/)
    w.partition('A', 'w2', false)
    a.c.retransmit()
    w.run(w.now + 1_000)
    expect(() => a.c.assertMaySend('mail-2')).not.toThrow()
  })

  it('a holder that lost the permission registers nothing', () => {
    const w = world()
    const a = holds(w, 'A')
    for (const id of W) w.partition('A', id)
    w.run(w.now + P.validMs)
    expect(() => a.c.registerOps(['mail-3'])).toThrow(PermitNotHeld)
  })
})

describe('why a send waits for the majority', () => {
  /**
   * A registers while cut from w2 and w3, so only w1 takes it; then A dies, and w1 is down
   * while B takes over. `early`: A sent while the registration was short of a majority.
   */
  function run(early: boolean): number {
    const w = world()
    const a = holds(w, 'A')
    w.partition('A', 'w2')
    w.partition('A', 'w3')
    a.c.registerOps(['mail-9'])
    w.run(w.now + 1_000)
    expect(a.c.opStatus('mail-9')).toBe('pending')
    let sends = 0
    if (early) sends++
    else expect(() => a.c.beginSend('mail-9')).toThrow(/not registered with a majority/)
    w.restartMachine('A', W, 10 * 60_000)
    w.crashWitness('w1', 10 * 60_000)
    const b = bTakesOver(w)
    b.c.registerOps(['mail-9'])
    w.run(w.now + 1_000)
    if (b.c.opStatus('mail-9') === 'registered') {
      b.c.beginSend('mail-9')
      sends++
    }
    return sends
  }

  it('waiting: the op goes out once, from the next holder', () => {
    expect(run(false)).toBe(1)
  })

  it('negative control: a send on a registration only a minority took is sent again by the next holder', () => {
    expect(run(true)).toBe(2)
  })
})

describe('an outcome reported', () => {
  it('a later holder sees it sent and does not send it again', () => {
    const w = world()
    const a = holds(w, 'A')
    a.c.registerOps(['mail-4'])
    w.run(w.now + 1_000)
    a.c.reportOutcome('mail-4', true)
    a.c.renew()
    w.run(w.now + 1_000)
    w.restartMachine('A', W, 10 * 60_000)
    const b = bTakesOver(w)
    expect(b.c.opStatus('mail-4')).toBe('sent')
    // What its data must record before the witnesses drop the entry (review round 3 S-1).
    expect(b.c.learnedOutcomes().map((e) => [e.id, e.state])).toEqual([['mail-4', 'sent']])
    expect(b.c.unresolvedOps()).toEqual([])
    expect(b.c.registerOps(['mail-4']).refused).toEqual([{ id: 'mail-4', status: 'sent' }])
  })
})

describe('one process sends one op at most once (review round 3 B-1)', () => {
  it('after beginSend, and after its report, assertMaySend refuses: before the report stands, after, and an hour on', () => {
    const w = world()
    const a = holds(w, 'A')
    pilot(w, 'A', { wantsLead: true, tickMs: 1_000, backoff: false })
    a.c.registerOps(['mail-5'])
    w.run(w.now + 1_000)
    a.c.beginSend('mail-5')
    expect(a.c.opStatus('mail-5')).toBe('sending')
    expect(() => a.c.assertMaySend('mail-5')).toThrow(/sending/)
    expect(() => a.c.beginSend('mail-5')).toThrow(PermitNotHeld)
    a.c.reportOutcome('mail-5', true)
    expect(() => a.c.assertMaySend('mail-5')).toThrow(/op sent/)
    w.run(w.now + 20_000)
    expect(W.map((id) => w.witnesses.get(id)!.w!.handle({ type: 'read' }).ops?.find((e) => e.id === 'mail-5')?.state)).toEqual(['sent', 'sent', 'sent'])
    // Still holding an hour later: every witness dropped the entry; the process still knows.
    w.run(w.now + P.opRetainMs + 60_000)
    expect(a.c.mayAct()).toBe(true)
    expect(W.map((id) => w.witnesses.get(id)!.w!.handle({ type: 'read' }).ops?.some((e) => e.id === 'mail-5'))).toEqual([false, false, false])
    expect(a.c.opStatus('mail-5')).toBe('sent')
    expect(() => a.c.assertMaySend('mail-5')).toThrow(/op sent/)
    expect(a.c.registerOps(['mail-5']).refused).toEqual([{ id: 'mail-5', status: 'sent' }])
  })
})

describe('the entries cross a witness list change', () => {
  /** A registers under w1-w3, then replaces the whole list in two changes; B holds under w4-w6. */
  function run(dropLedger: boolean) {
    const w = world([...W, 'w4', 'w5', 'w6'])
    const a = holds(w, 'A')
    if (dropLedger) (a.c as unknown as { ops: { ledger: () => [] } }).ops.ledger = () => []
    a.c.registerOps(['mail-5'])
    w.run(w.now + 1_000)
    expect(a.c.opStatus('mail-5')).toBe('registered')
    a.c.changeWitnesses(['w1', 'w4', 'w5'])
    w.run(w.now + 2_000)
    a.c.changeWitnesses(['w4', 'w5', 'w6'])
    w.run(w.now + 2_000)
    const cfg = a.c.config()
    expect(cfg.list).toEqual(['w4', 'w5', 'w6'])
    w.restartMachine('A', W, 10 * 60_000)
    const b = bTakesOver(w, cfg.list, cfg.cfg, cfg.epoch)
    b.c.registerOps(['mail-5'])
    w.run(w.now + 1_000)
    return b.c.opStatus('mail-5')
  }

  it('an op registered under the old list is unknown under the new one: no second send', () => {
    expect(run(false)).toBe('unknown')
  })

  it('negative control: list changes that carry no entries let the next holder register it and send it twice', () => {
    expect(run(true)).toBe('registered')
  })
})
