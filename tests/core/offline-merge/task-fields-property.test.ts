/**
 * Property suite for the Mac's per-field merge (docs/plan/walnut-replica-servers-impl.md
 * section 7 and 9 WP9), seeded (mulberry32; WALNUT_SIM_RUNS, default 1000, 50,000 in the
 * large run; WALNUT_SIM_SEED):
 *   a random base task, random Mac edits and random replica edits with random times and
 *   host clock skew, two host journals plus a companion queue drained in random order,
 *   each drained 1 to 3 times with random crashes between an apply and its ledger row.
 * Invariants:
 *   - a field only one side changed equals that side;
 *   - a SCALAR both sides changed equals the newer write;
 *   - TEXT: a clean merge contains every line either side added; a conflicting merge
 *     equals the newer side with the other side in the conflict list;
 *   - the result is independent of drain order (every scalar; a text field one writer
 *     changed: two writers' whole-field conflicts can be order dependent by the rule);
 *   - a second drain changes nothing;
 *   - each step's letter lists exactly the fields both sides changed to different values
 *     (a text field: those whose merge conflicted).
 * The merge runs on the real resolver (task-fields.ts) over a model of the Mac's row that
 * stores what writePatch stores: the patch and its field_at times.
 */
import { describe, it, expect } from 'vitest'
import { resolveTaskFields, UNKNOWN_BASE, type MacTask } from '../../../src/core/offline-merge/task-fields.js'
import { sameFieldValue } from '../../../src/core/task-field-times.js'

const RUNS = Number(process.env.WALNUT_SIM_RUNS ?? 1000)
const SEED = Number(process.env.WALNUT_SIM_SEED ?? 0x5eed)

function mulberry32(a: number): () => number {
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const SCALARS: Record<string, unknown[]> = {
  title: ['Dock', 'Wharf', 'Quay', 'Pier', 'Jetty'],
  priority: ['none', 'backlog', 'important', 'immediate'],
  phase: ['TODO', 'IN_PROGRESS', 'NEED_ACTION', 'COMPLETE'],
  pinned: [false, true],
  due_date: ['', '2026-11-01', '2026-12-01'],
  project: ['Acme', 'Marina', 'Inbox Two'],
}
const TEXTS = ['description', 'note']
const WORDS = ['alpha', 'beta', 'gamma', 'delta', 'epsilon', 'zeta', 'eta', 'theta', 'iota', 'kappa']
const T0 = Date.parse('2026-10-01T00:00:00.000Z')

/** `at` is the true time; the writer's clock says `hostAt` and the drain adds the measured `offset`. */
interface Rec { queue: string; opId: string; at: number; hostAt: number; offset: number; fields: Record<string, { base: unknown; value: unknown }> }
interface Scenario { base: Record<string, unknown>; mac: Record<string, unknown>; macAt: Record<string, number>; queues: Record<string, Rec[]>; baseAt: number }

const pick = <T,>(rng: () => number, xs: readonly T[]): T => xs[Math.floor(rng() * xs.length)]

function otherThan(rng: () => number, xs: unknown[], v: unknown): unknown {
  const rest = xs.filter((x) => !sameFieldValue(x, v))
  return pick(rng, rest)
}

function randomText(rng: () => number): string {
  const n = 2 + Math.floor(rng() * 5)
  return Array.from({ length: n }, () => `${pick(rng, WORDS)} ${pick(rng, WORDS)}\n`).join('')
}

/** One to three line edits (replace, insert, delete), never equal to the input. */
function editText(rng: () => number, text: string): string {
  for (;;) {
    const lines = text.split(/(?<=\n)/).filter(Boolean)
    const k = 1 + Math.floor(rng() * 3)
    for (let i = 0; i < k; i++) {
      const at = Math.floor(rng() * (lines.length + 1))
      const op = rng()
      const fresh = `${pick(rng, WORDS)}-${Math.floor(rng() * 1000)}\n`
      if (op < 0.4 && lines.length) lines[Math.min(at, lines.length - 1)] = fresh
      else if (op < 0.8) lines.splice(at, 0, fresh)
      else if (lines.length > 1) lines.splice(Math.min(at, lines.length - 1), 1)
    }
    const out = lines.join('')
    if (out !== text) return out
  }
}

/** Distinct times: equal times would make "newer" a tie, which the rule breaks for the Mac by design. */
function timePool(rng: () => number, n: number): number[] {
  const set = new Set<number>()
  while (set.size < n) set.add(T0 + 1000 + Math.floor(rng() * 1_000_000))
  return [...set]
}

function scenario(rng: () => number): Scenario {
  const times = timePool(rng, 40)
  let ti = 0
  const base: Record<string, unknown> = {}
  for (const [f, xs] of Object.entries(SCALARS)) base[f] = pick(rng, xs)
  for (const f of TEXTS) base[f] = randomText(rng)
  const mac = { ...base }
  const macAt: Record<string, number> = {}
  for (const f of [...Object.keys(SCALARS), ...TEXTS]) {
    if (rng() < 0.4) {
      mac[f] = TEXTS.includes(f) ? editText(rng, String(base[f])) : otherThan(rng, SCALARS[f], base[f])
      macAt[f] = times[ti++]
    }
  }
  const queues: Record<string, Rec[]> = {}
  let op = 0
  for (const q of ['host-marina', 'host-acme', 'companion']) {
    queues[q] = []
    // This writer's clock runs up to 10 minutes off; the drain measured it (offset).
    const skew = Math.floor((rng() - 0.5) * 1_200_000)
    const n = Math.floor(rng() * 3)
    const used = new Set<string>()
    for (let i = 0; i < n; i++) {
      const fields: Record<string, { base: unknown; value: unknown }> = {}
      const k = 1 + Math.floor(rng() * 3)
      for (let j = 0; j < k; j++) {
        const f = pick(rng, [...Object.keys(SCALARS), ...TEXTS])
        // One record per field and writer: the journal coalesces a later save into it.
        if (used.has(f)) continue
        used.add(f)
        const value = TEXTS.includes(f) ? editText(rng, String(base[f])) : otherThan(rng, SCALARS[f], base[f])
        fields[f] = { base: rng() < 0.1 ? UNKNOWN_BASE : base[f], value }
      }
      if (Object.keys(fields).length) {
        const at = times[ti++]
        queues[q].push({ queue: q, opId: `op-${q}-${++op}`, at, hostAt: at - skew, offset: skew, fields })
      }
    }
  }
  return { base, mac, macAt, queues, baseAt: T0 }
}

/** The Mac's row: values, field_at, and the op keys merged into it (applied_ops, same row write). */
interface Row { values: Record<string, unknown>; fieldAt: Record<string, number>; applied: Set<string> }
interface Step { rec: Rec; before: Row; listed: Set<string>; patch: Record<string, unknown> }

function macRow(s: Scenario): Row {
  const fieldAt: Record<string, number> = {}
  for (const f of [...Object.keys(SCALARS), ...TEXTS]) fieldAt[f] = s.macAt[f] ?? s.baseAt
  return { values: { ...s.mac }, fieldAt, applied: new Set() }
}

const view = (row: Row): MacTask => {
  const field_at: Record<string, string> = {}
  for (const [f, t] of Object.entries(row.fieldAt)) field_at[f] = new Date(t).toISOString()
  return { ...row.values, group_id: '', field_at, updated_at: new Date(T0).toISOString(), created_at: new Date(T0).toISOString() }
}

/** What writePatch stores for one record: the patch values and their field_at times. */
function apply(row: Row, rec: Rec, steps: Step[]): void {
  // Merged into this row already (a crash came between the row write and the ledger): a no-op.
  if (row.applied.has(rec.opId)) return
  const before: Row = { values: { ...row.values }, fieldAt: { ...row.fieldAt }, applied: new Set(row.applied) }
  const res = resolveTaskFields({ mac: view(row), fields: rec.fields, at: rec.hostAt + rec.offset })
  for (const [f, v] of Object.entries(res.patch)) if (f !== 'group_id') row.values[f] = v
  let later = false
  for (const [f, t] of Object.entries(res.fieldTimes)) if (f !== 'group_id') { if (t !== row.fieldAt[f]) later = true; row.fieldAt[f] = t }
  if (Object.keys(res.patch).length || later) row.applied.add(rec.opId)
  const listed = new Set(res.conflicts.map((c) => (c.field === 'project+group_id' ? 'project' : c.field)))
  steps.push({ rec, before, listed, patch: res.patch })
}

/**
 * Drain the queues in `order`; each queue is drained up to 3 times, a crash between an
 * apply and its ledger row ends a pass (the record is applied, the ledger never heard).
 */
function drainAll(s: Scenario, order: string[], rng: () => number): { row: Row; steps: Step[] } {
  const row = macRow(s)
  const steps: Step[] = []
  const ledger = new Set<string>()
  for (const q of order) {
    const passes = 1 + Math.floor(rng() * 3)
    for (let pass = 0; pass < passes; pass++) {
      const last = pass === passes - 1
      let crashed = false
      for (const rec of s.queues[q]) {
        if (ledger.has(rec.opId)) continue
        apply(row, rec, steps)
        if (!last && rng() < 0.3) { crashed = true; break }
        ledger.add(rec.opId)
      }
      if (!crashed) break
    }
  }
  return { row, steps }
}

const lineSet = (t: unknown): Set<string> => new Set(String(t ?? '').split(/(?<=\n)/).filter(Boolean))
const added = (base: unknown, side: unknown): string[] => { const b = lineSet(base); return [...lineSet(side)].filter((l) => !b.has(l)) }

/** Check one run; returns a failure message or null. */
function checkRun(s: Scenario, rng: () => number): string | null {
  const queues = Object.keys(s.queues)
  const shuffled = (): string[] => { const o = [...queues]; for (let i = o.length - 1; i > 0; i--) { const j = Math.floor(rng() * (i + 1)); [o[i], o[j]] = [o[j], o[i]] } return o }
  const a = drainAll(s, shuffled(), rng)
  const b = drainAll(s, shuffled(), rng)
  const all = Object.values(s.queues).flat()
  for (const f of [...Object.keys(SCALARS), ...TEXTS]) {
    const writers = all.filter((r) => f in r.fields)
    const macChanged = f in s.macAt
    const isText = TEXTS.includes(f)
    // A field only one side changed equals that side.
    if (!writers.length && !sameFieldValue(a.row.values[f], s.mac[f])) return `${f}: only the Mac changed it, got ${JSON.stringify(a.row.values[f])}`
    if (!macChanged && writers.length === 1 && !sameFieldValue(a.row.values[f], writers[0].fields[f].value)) return `${f}: only one writer changed it, got ${JSON.stringify(a.row.values[f])}`
    // A scalar both changed equals the newer write.
    if (!isText && writers.length) {
      const cands = [...writers.map((r) => ({ at: r.at, v: r.fields[f].value })), ...(macChanged ? [{ at: s.macAt[f], v: s.mac[f] }] : [])]
      const newest = cands.reduce((x, y) => (y.at > x.at ? y : x))
      if (!sameFieldValue(a.row.values[f], newest.v)) return `${f}: expected the newest ${JSON.stringify(newest.v)}, got ${JSON.stringify(a.row.values[f])}`
    }
    // Independent of drain order: every scalar, and a text field one writer changed.
    if ((!isText || writers.length <= 1) && !sameFieldValue(a.row.values[f], b.row.values[f])) return `${f}: drain order changed the result`
  }
  for (const st of a.steps) {
    for (const [f, w] of Object.entries(st.rec.fields)) {
      const mac = st.before.values[f]
      const isText = TEXTS.includes(f)
      const unknown = w.base === UNKNOWN_BASE
      const both = !sameFieldValue(mac, w.value) && (unknown || !sameFieldValue(mac, w.base))
      const result = f in st.patch ? st.patch[f] : mac
      if (isText && both && !unknown) {
        const clean = !st.listed.has(f)
        if (clean) {
          const lines = lineSet(result)
          for (const l of [...added(w.base, mac), ...added(w.base, w.value)]) if (!lines.has(l)) return `${f}: a clean merge dropped the added line ${JSON.stringify(l)}`
        } else {
          const replicaNewer = st.rec.at > st.before.fieldAt[f]
          if (!sameFieldValue(result, replicaNewer ? w.value : mac)) return `${f}: a conflicting merge did not keep the newer side`
        }
      } else {
        // A base-unknown write is listed only when the Mac's value was kept over it.
        const expectListed = unknown ? both && sameFieldValue(result, mac) : both
        if (expectListed !== st.listed.has(f)) return `${f}: listed=${st.listed.has(f)} but expected=${expectListed} (both-changed-differently=${both}, unknown base=${unknown})`
      }
    }
  }
  // A second drain changes nothing. With the ledger every record is skipped; the one window
  // without it (a crash after a record's row write, before its ledger row) replays that
  // record, which drainAll does at random above (and the row's applied_ops makes a no-op).
  // Values alone are idempotent for every scalar: re-applying EVERY record with no ledger
  // and no markers leaves them as they are. (A text merge is not always: with repeated lines
  // a diff can align a merged text differently and add a line twice, or a write that lost a
  // conflict can merge cleanly into a later winner; the ledger and applied_ops prevent both.)
  const bare: Row = { values: { ...a.row.values }, fieldAt: { ...a.row.fieldAt }, applied: new Set() }
  for (const r of all) apply(bare, r, [])
  for (const f of Object.keys(SCALARS)) if (!sameFieldValue(bare.values[f], a.row.values[f])) return `${f}: re-applying every record changed it`
  return null
}

describe(`task-fields property suite (${RUNS} runs, seed ${SEED})`, () => {
  it('every invariant holds on every run', () => {
    let failures = 0
    let first = ''
    for (let run = 0; run < RUNS; run++) {
      const rng = mulberry32(SEED + run * 7919)
      const s = scenario(rng)
      const why = checkRun(s, rng)
      if (why) { failures++; if (!first) first = `run ${run} (seed ${SEED}): ${why}` }
    }
    expect(first).toBe('')
    expect(failures).toBe(0)
  }, 600_000)
})
