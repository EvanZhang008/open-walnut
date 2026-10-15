/**
 * Journal v2 property suite (plan section 5, section 11 "Large local run"). Seeded
 * mulberry32 only: WALNUT_SIM_RUNS (default 500; 20,000 in the large run) runs, each a
 * random interleaving of appends (v1 kinds, coalescing task-fields and notes, parked v2
 * kinds), drains (a new Mac with kinds and random batch sizes, an old Mac without),
 * acks (explicit seqs, and an old Mac's `upTo`), compaction, a second process on the
 * same dir, retries with the same op id, daemon restarts, and crashes at a line
 * boundary or mid-line (a torn tail, a stale lock of a dead writer). A failing run
 * prints its seed; replay it with WALNUT_SIM_SEED=<seed> WALNUT_SIM_RUNS=1.
 *
 * Invariants, checked after every step against the store's own view and at the end
 * of every run against a fresh store read from disk:
 *   1. no acked record ever returns;
 *   2. no unacked record is lost (every op id the journal answered is pending, at the
 *      rev it last answered, until acked or folded away by a note create+delete);
 *   3. seqs are unique per journal and strictly increasing (all writers, one lock);
 *   4. a frozen record (handed out, not acked) never changes;
 *   5. a torn last line is dropped and reported, and every line left on disk parses;
 *   6. fold by opId keeps the highest rev;
 *   7. replay order == append order (a drain hands out increasing seqs; an old Mac
 *      only the v1 prefix).
 */
import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { JOURNAL_V2_DRAINS, type JournalRecord } from '../../src/providers/offline-journal-core.js'
import { JHOME, journalStore, keyOf } from '../helpers/offline-journal-harness.js'

const RUNS = Math.max(1, Number(process.env.WALNUT_SIM_RUNS) || 500)
const BASE_SEED = Number(process.env.WALNUT_SIM_SEED) || 0x5eed0008
const V1 = ['row', 'settle', 'delivery', 'settings', 'stop', 'resume', 'op']

function mulberry32(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

type Store = ReturnType<typeof journalStore>

interface Model {
  /** opId -> the seq and rev the journal last answered for it. */
  live: Map<string, { seq: number; rev: number; kind: string }>
  acked: Set<number>
  /** seq -> the record as handed out (frozen until acked). */
  handed: Map<number, string>
  lastSeq: number
  ops: string[]
  torn: boolean
}

/** Store `a` keeps its append fd open (as the daemons do); `b` opens per append. */
function newStore(dir: string, clock: { now: number }, keepOpen = false): Store {
  return journalStore(dir, clock, { durable: false, lockWaitMs: 200, keepOpen })
}

function fileOf(dir: string): string { return path.join(dir, `journal-${keyOf(JHOME)}.ndjson`) }

function pendingByOp(store: Store): Map<string, JournalRecord> {
  store.refresh(JHOME)
  const out = new Map<string, JournalRecord>()
  for (const r of store.records(JHOME)) {
    if (out.has(String(r.opId))) throw new Error(`two pending records carry op ${r.opId}`)
    out.set(String(r.opId), r)
  }
  return out
}

/** Invariants 1, 2, 4, 6 against what `store` reads now. */
function check(store: Store, m: Model, where: string): void {
  const pending = pendingByOp(store)
  for (const r of pending.values()) {
    if (m.acked.has(r.seq)) throw new Error(`${where}: acked seq ${r.seq} returned`)
  }
  for (const [opId, want] of m.live) {
    const got = pending.get(opId)
    if (!got) throw new Error(`${where}: op ${opId} (seq ${want.seq}) lost`)
    if (got.seq !== want.seq || (got.rev ?? 1) !== want.rev) throw new Error(`${where}: op ${opId} is seq ${got.seq} rev ${got.rev}, want seq ${want.seq} rev ${want.rev}`)
  }
  if (pending.size !== m.live.size) throw new Error(`${where}: ${pending.size} pending, model holds ${m.live.size}`)
  for (const [seq, snap] of m.handed) {
    const now = [...pending.values()].find((r) => r.seq === seq)
    if (!now) throw new Error(`${where}: frozen seq ${seq} vanished unacked`)
    if (JSON.stringify(now) !== snap) throw new Error(`${where}: frozen seq ${seq} changed`)
  }
}

/** Record what the journal answered for an append (invariants 2, 3, 6). */
function noteAppend(m: Model, r: ReturnType<Store['append']>, kind: string, retryOf?: string): void {
  if (!r.ok) {
    if (r.code === 'queue_full') return
    throw new Error(`append refused: ${r.code} ${r.message}`)
  }
  const prev = m.live.get(r.opId)
  if (r.duplicate) {
    if (!prev || prev.seq !== r.seq || prev.rev !== r.rev) throw new Error(`duplicate of ${r.opId} answered seq ${r.seq}, model ${prev?.seq}`)
    return
  }
  if (retryOf) throw new Error(`a retry of pending ${retryOf} was written again`)
  if (r.seq <= m.lastSeq) throw new Error(`seq ${r.seq} not above ${m.lastSeq}`)
  m.lastSeq = r.seq
  if (r.coalesced) {
    if (!prev) throw new Error(`coalesced into unknown op ${r.opId}`)
    if (m.handed.has(prev.seq)) throw new Error(`a save superseded frozen seq ${prev.seq}`)
    if (r.rev !== prev.rev + 1) throw new Error(`coalesced rev ${r.rev} after ${prev.rev}`)
    if (r.dropped) { m.live.delete(r.opId); return }
    m.live.set(r.opId, { seq: r.seq, rev: r.rev, kind })
    return
  }
  if (prev) throw new Error(`fresh append reused pending op ${r.opId}`)
  m.live.set(r.opId, { seq: r.seq, rev: r.rev, kind })
}

function noteDrain(m: Model, recs: JournalRecord[], kinds: string[] | null, store: Store): void {
  const oldMac = kinds === null
  let last = 0
  for (const r of recs) {
    if (r.seq <= last) throw new Error('drain out of append order')
    last = r.seq
    if (m.acked.has(r.seq)) throw new Error(`drain handed acked seq ${r.seq}`)
    if (oldMac && V1.indexOf(r.kind) === -1) throw new Error(`old Mac handed ${r.kind}`)
    if (!oldMac && V1.indexOf(r.kind) === -1 && kinds.indexOf(r.kind) === -1) throw new Error(`a Mac that drains [${kinds}] was handed ${r.kind}`)
    const snap = JSON.stringify(r)
    const had = m.handed.get(r.seq)
    if (had !== undefined && had !== snap) throw new Error(`redrain of frozen seq ${r.seq} differs`)
    m.handed.set(r.seq, snap)
  }
  if (oldMac) {
    // The prefix rule: the first record after what was handed is not a v1 kind (or the batch ended).
    const all = store.records(JHOME)
    const firstOther = all.find((r) => V1.indexOf(r.kind) === -1)
    if (firstOther && recs.some((r) => r.seq > firstOther.seq)) throw new Error('old Mac handed records past a parked one')
  }
}

function noteAck(m: Model, acked: JournalRecord[], expected: number[]): void {
  const got = acked.map((r) => r.seq).sort((a, b) => a - b)
  const want = [...new Set(expected)].sort((a, b) => a - b)
  if (got.join(',') !== want.join(',')) throw new Error(`ack dropped [${got}] want [${want}]`)
  for (const r of acked) {
    m.acked.add(r.seq)
    m.handed.delete(r.seq)
    m.live.delete(String(r.opId))
  }
}

const ACTORS = [{ kind: 'device' as const, deviceId: 'dev-marina' }, { kind: 'session' as const, sid: 'aaaaaaaa-1111-4111-8111-111111111111' }]
const TASKS = ['mtask-acme-1', 'mtask-acme-2', 'mtask-acme-3']
const PATHS = ['notes/acme.md', 'notes/marina \u00e9t\u00e9.md']

function runOnce(seed: number): void {
  const rnd = mulberry32(seed)
  const pick = <T>(xs: readonly T[]): T => xs[Math.floor(rnd() * xs.length)]
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'journal-prop-'))
  const clock = { now: Date.parse('2026-10-14T12:00:00Z') }
  const m: Model = { live: new Map(), acked: new Set(), handed: new Map(), lastSeq: 0, ops: [], torn: false }
  let a = newStore(dir, clock, true)
  let b = newStore(dir, clock)
  const restart = (both: boolean) => {
    a.close(); a = newStore(dir, clock, true)
    if (both) { b.close(); b = newStore(dir, clock) }
  }
  const answered: Array<{ opId: string; kind: string; body: Record<string, unknown>; opts: Record<string, unknown> }> = []
  try {
    const steps = 20 + Math.floor(rnd() * 40)
    for (let step = 0; step < steps; step++) {
      clock.now += 1 + Math.floor(rnd() * 5000)
      const s = rnd() < 0.2 ? b : a
      const roll = rnd()
      let op = ''
      if (roll < 0.14) {
        op = 'append-v1'
        noteAppend(m, s.append(JHOME, { kind: pick(['settings', 'stop', 'delivery']), sid: 's', n: step }), 'settings')
      } else if (roll < 0.34) {
        op = 'append-fields'
        const opId = `op-c-${seed}-${step}`
        const body = { kind: 'task-fields', op: 'task_update', taskId: pick(TASKS), fields: { [pick(['title', 'description', 'priority'])]: { base: `b${step}`, value: `v${step}\r\n\u4e2d` } } }
        const opts = { actor: pick(ACTORS), opId }
        noteAppend(m, s.append(JHOME, body, opts), 'task-fields')
        answered.push({ opId, kind: 'task-fields', body, opts })
      } else if (roll < 0.44) {
        op = 'append-note'
        const mode = pick(['put', 'create', 'delete'] as const)
        noteAppend(m, s.appendNote(JHOME, { path: pick(PATHS), mode, baseHash: mode === 'create' ? null : 'h', ours: mode === 'delete' ? null : Buffer.from(`body ${step}${rnd() < 0.2 ? '' : '\n'}`) }, { actor: pick(ACTORS) }), 'note')
      } else if (roll < 0.52) {
        op = 'append-parked'
        // A kind no Mac here drains yet (parked): it may sit at the head of the journal.
        noteAppend(m, s.append(JHOME, { kind: pick(['session', 'device-revoke', 'task-move']), n: step }, { actor: ACTORS[0], limit: true }), 'parked')
      } else if (roll < 0.57 && answered.length) {
        op = 'retry'
        const prev = pick(answered)
        const r = s.append(JHOME, prev.body, prev.opts)
        if (m.live.has(prev.opId)) noteAppend(m, r, prev.kind, prev.opId)
        else noteAppend(m, r, prev.kind)
      } else if (roll < 0.67) {
        op = 'drain-new'
        const kinds = rnd() < 0.5 ? JOURNAL_V2_DRAINS.slice() : ['task-fields', 'note']
        noteDrain(m, s.drain(JHOME, { kinds, batch: 1 + Math.floor(rnd() * 8) }).records, kinds, s)
      } else if (roll < 0.72) {
        op = 'drain-old'
        noteDrain(m, s.drain(JHOME, { kinds: null, batch: 1 + Math.floor(rnd() * 8) }).records, null, s)
      } else if (roll < 0.8) {
        op = 'ack-seqs'
        const handed = [...m.handed.keys()]
        const named = handed.filter(() => rnd() < 0.6).concat(rnd() < 0.3 ? [m.lastSeq + 5, ...[...m.live.values()].map((x) => x.seq).slice(0, 1)] : [])
        const r = s.ack(JHOME, { seqs: named })
        noteAck(m, r.acked, named.filter((x) => m.handed.has(x)))
      } else if (roll < 0.84) {
        op = 'ack-upto'
        const upTo = Math.floor(rnd() * (m.lastSeq + 2))
        const r = s.ack(JHOME, { upTo })
        noteAck(m, r.acked, [...m.handed.keys()].filter((x) => x <= upTo))
      } else if (roll < 0.88) {
        op = 'compact'
        s.compact(JHOME)
      } else if (roll < 0.93) {
        op = 'restart'
        restart(true)
      } else if (roll < 0.97) {
        op = 'crash-mid-line'
        // A writer died mid-line (no answer was given for it), leaving a torn tail.
        const line = JSON.stringify({ v: 2, seq: m.lastSeq + 1, opId: 'op-torn', rev: 1, at: clock.now, kind: 'settings', sid: 's' })
        fs.appendFileSync(fileOf(dir), line.slice(0, 1 + Math.floor(rnd() * (line.length - 2))))
        m.torn = true
        restart(true)
      } else {
        op = 'stale-lock'
        // A writer died holding the lock: its pid is gone, so the next writer takes it.
        // (This process's pid with another start time: a reused pid, so no foreign pid is probed.)
        fs.writeFileSync(path.join(dir, `journal-${keyOf(JHOME)}.lock`), `${process.pid} an-earlier-boot`)
        restart(false)
      }
      m.ops.push(op)
      check(a, m, `step ${step} ${op}`)
      if (m.torn && (op.startsWith('append') || op.startsWith('drain') || op.startsWith('ack') || op === 'compact' || op === 'retry')) {
        // Invariant 5: the next locked write cut the torn tail, and reported it.
        for (const l of fs.readFileSync(fileOf(dir), 'utf8').split('\n').filter(Boolean)) JSON.parse(l)
        if (!(s.stats(JHOME, null).tornDropped > 0)) throw new Error(`step ${step} ${op}: a torn tail was cut without a report`)
        m.torn = false
      }
    }
    // The whole run against a fresh read of the disk.
    const fresh = newStore(dir, clock)
    fresh.drain(JHOME, { kinds: [], batch: 0 })
    check(fresh, m, 'end (fresh store)')
    fresh.close()
    for (const l of fs.readFileSync(fileOf(dir), 'utf8').split('\n').filter(Boolean)) JSON.parse(l)
  } catch (err) {
    throw new Error(`seed ${seed} (WALNUT_SIM_SEED=${seed} WALNUT_SIM_RUNS=1): ${(err as Error).message}\nops: ${m.ops.join(' ')}`)
  } finally {
    a.close(); b.close()
    fs.rmSync(dir, { recursive: true, force: true })
  }
}

describe('journal v2 property suite', () => {
  it(`holds every invariant over ${RUNS} seeded runs (base seed ${BASE_SEED})`, async () => {
    const started = Date.now()
    for (let i = 0; i < RUNS; i++) {
      runOnce(BASE_SEED + i)
      // Yield now and then: a worker that never returns to its event loop misses the
      // runner's RPC deadline in the 20,000-run case (an unhandled timeout, exit 1).
      if (i % 50 === 49) await new Promise((r) => setImmediate(r))
    }
    // The seed count, for the large run's record.
    console.log(`[journal-property] ${RUNS} runs green from seed ${BASE_SEED} to ${BASE_SEED + RUNS - 1} in ${Date.now() - started} ms`)
  }, Math.max(120_000, RUNS * 200))

  describe('pinned cases', () => {
    const fieldSave = (title: string) => ({ kind: 'task-fields', op: 'task_update', taskId: 'mtask-acme-1', fields: { title: { base: 'b', value: title } } })
    const dev = { actor: { kind: 'device' as const, deviceId: 'dev-marina' } }

    it('drain, coalesce into the drained record, ack, drain again: the later save comes back', () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'journal-prop-'))
      try {
        const s = newStore(dir, { now: 1 })
        s.append(JHOME, fieldSave('one'), dev)
        const first = s.drain(JHOME, { kinds: JOURNAL_V2_DRAINS }).records
        s.append(JHOME, fieldSave('two'), dev)
        s.ack(JHOME, { seqs: first.map((r) => r.seq) })
        const again = s.drain(JHOME, { kinds: JOURNAL_V2_DRAINS }).records
        expect(again.map((r) => (r.fields as Record<string, { value: string }>).title.value)).toEqual(['two'])
      } finally { fs.rmSync(dir, { recursive: true, force: true }) }
    })

    it('a retried record survives two acks of later seqs', () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'journal-prop-'))
      try {
        const s = newStore(dir, { now: 1 })
        for (const t of ['mtask-acme-1', 'mtask-acme-2', 'mtask-acme-3']) s.append(JHOME, { kind: 'task-move', taskId: t, anchor: null })
        s.drain(JHOME, { kinds: JOURNAL_V2_DRAINS })
        s.ack(JHOME, { seqs: [2] })
        s.ack(JHOME, { seqs: [3] })
        expect(newStore(dir, { now: 1 }).drain(JHOME, { kinds: JOURNAL_V2_DRAINS }).records.map((r) => r.seq)).toEqual([1])
      } finally { fs.rmSync(dir, { recursive: true, force: true }) }
    })

    it('fold by opId keeps the highest rev, whatever order the lines are in', () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'journal-prop-'))
      try {
        const line = (seq: number, rev: number) => JSON.stringify({ v: 2, seq, opId: 'op-fold', rev, at: seq, kind: 'task-fields', op: 'task_update', taskId: 't', fields: { title: { base: 'a', value: `rev${rev}` } } })
        fs.writeFileSync(fileOf(dir), [JSON.stringify({ v: 2, h: 1, home: JHOME, journalId: '0123456789abcdef', nextSeq: 1 }), line(1, 1), line(3, 3), line(2, 2)].join('\n') + '\n')
        const recs = newStore(dir, { now: 1 }).records(JHOME)
        expect(recs.map((r) => [r.seq, r.rev])).toEqual([[3, 3]])
      } finally { fs.rmSync(dir, { recursive: true, force: true }) }
    })

    it('parked kinds at the head never block a new Mac and never reach an old one', () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'journal-prop-'))
      try {
        const s = newStore(dir, { now: 1 })
        s.append(JHOME, { kind: 'session', sid: 'x' })
        s.append(JHOME, { kind: 'settings', sid: 'y' })
        expect(s.drain(JHOME, { kinds: null }).records).toEqual([])
        expect(s.drain(JHOME, { kinds: ['task-fields'] }).records.map((r) => r.kind)).toEqual(['settings'])
      } finally { fs.rmSync(dir, { recursive: true, force: true }) }
    })
  })
})
