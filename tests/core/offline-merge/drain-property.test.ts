/**
 * Seeded property run of the REAL Mac drain (docs/plan/walnut-replica-servers-impl.md WP9):
 * runOfflineHandover into the task store of a temp home, with the real ledger and the
 * real conflict log, two host journals drained at once or in a random order, folded
 * records whose fields carry their own times, a Mac edit made before the drain, and
 * injected failures of the conflict log write (the batch stops and retries).
 *
 * The pure model in task-fields-property.test.ts is the fast tier for the rule table;
 * this one catches what a model cannot: lost updates between concurrent drains, the
 * ledger and conflict log order, and fold times.
 *
 * Invariants per run:
 *   - every record is acked in the end;
 *   - a scalar only one writer changed equals that writer's value;
 *   - a scalar several writers changed equals the newest write (each field by its own time);
 *   - the description keeps the line every writer replaced (they replace different lines);
 *   - a second drain of every record changes nothing;
 *   - a scalar two writers changed to different values is in the conflict log, one only one
 *     writer changed is not.
 * DRAIN_PROPERTY_RUNS sets the run count (default 50).
 */
import { describe, it, expect, vi, afterAll } from 'vitest'
import fs from 'node:fs'
import { createMockConstants } from '../../helpers/mock-constants.js'

vi.mock('../../../src/constants.js', () => createMockConstants('walnut-drain-property'))
vi.mock('../../../src/core/sessions/session-send-core.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../src/core/sessions/session-send-core.js')>()),
  deliverToSession: vi.fn(async () => ({ delivery: 'queued' })),
}))

import { runOfflineHandover, _resetOfflineHandoverForTesting, _setHandoverBackoffForTesting } from '../../../src/core/offline-handover.js'
import { addTask, getTask, updateTaskRaw } from '../../../src/core/task-manager.js'
import { closeDb } from '../../../src/core/task-db.js'
import { _resetHostClocksForTesting } from '../../../src/core/offline-merge/host-clock.js'
import { ConflictLog, conflictDir, readConflictLog, type ConflictEntry } from '../../../src/core/offline-merge/conflict-log.js'

const RUNS = Number(process.env.DRAIN_PROPERTY_RUNS) || 50
const SID = 'eeeeeeee-5555-4555-8555-555555555555'
const SCALARS = ['title', 'priority', 'due_date'] as const
type Scalar = typeof SCALARS[number]
const PRIORITIES = ['immediate', 'important', 'backlog']
const BASE_LINES = ['l0', 'l1', 'l2', 'l3', 'l4', 'l5']
const BASE_DESC = BASE_LINES.join('\n') + '\n'

function prng(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

interface Write { writer: string; field: string; value: unknown; at: number }

/** A fake daemon journal: records stay until acked by seq. */
function daemon(hostKey: string, records: Array<Record<string, unknown>>) {
  const pending = [...records]
  return {
    pending,
    conn: {
      hostKey, journalV2: true,
      send: async (cmd: string, p?: Record<string, unknown>) => {
        if (cmd === 'offline.ack') {
          for (const s of (p?.seqs as number[]) ?? []) { const i = pending.findIndex((r) => r.seq === s); if (i !== -1) pending.splice(i, 1) }
          return { ok: true }
        }
        if (cmd === 'offline.drain') return { ok: true, records: pending.slice(), now: Date.now() }
        return { ok: true }
      },
    },
  }
}

async function drainAll(ds: Array<ReturnType<typeof daemon>>, together: boolean): Promise<void> {
  for (let i = 0; i < 20 && ds.some((d) => d.pending.length); i++) {
    if (together) await Promise.all(ds.map((d) => runOfflineHandover(d.conn as never).catch(() => undefined)))
    else for (const d of ds) await runOfflineHandover(d.conn as never).catch(() => undefined)
    await new Promise((r) => setTimeout(r, 5))
  }
}

function entriesFor(taskId: string): ConflictEntry[] {
  let names: string[] = []
  try { names = fs.readdirSync(conflictDir()).filter((n) => n.endsWith('.json')) } catch { return [] }
  return names.flatMap((n) => readConflictLog(n.slice(0, -5))?.entries ?? []).filter((e) => e.taskId === taskId)
}

afterAll(() => { vi.restoreAllMocks(); _setHandoverBackoffForTesting(null); closeDb() })

const norm = (v: unknown): unknown => (v === undefined || v === null ? '' : v)

/** One seeded run: a Mac edit, then two host journals drained, then the invariants. */
async function oneRun(seed: number): Promise<void> {
  const rnd = prng(seed)
  const pick = <T>(xs: readonly T[]): T => xs[Math.floor(rnd() * xs.length)]
  _resetOfflineHandoverForTesting()
  _resetHostClocksForTesting()
  _setHandoverBackoffForTesting([1, 1, 1, 1, 1, 1, 1, 1])
  const task = (await addTask({ title: `Base ${seed}`, project: 'Acme', description: BASE_DESC } as never)).task
  const id = task.id
  // Distinct write times a minute apart, in a random order.
  const t0 = Date.now() - 3 * 3600_000
  const slots = Array.from({ length: 16 }, (_, i) => t0 + (i + 1) * 60_000).sort(() => rnd() - 0.5)
  const baseOf: Record<string, unknown> = { title: task.title, priority: 'none', due_date: '' }
  const writes: Write[] = []
  const descWriters: string[] = []
  const records: Record<string, Array<Record<string, unknown>>> = { marina: [], 'acme-box': [] }
  for (const w of [{ name: 'mac', line: 0 }, { name: 'marina', line: 2 }, { name: 'acme-box', line: 4 }]) {
    const fields: Scalar[] = SCALARS.filter(() => rnd() < 0.5)
    const editsDesc = rnd() < 0.6
    if (!fields.length && !editsDesc) continue
    const vals: Record<string, unknown> = {}
    for (const f of fields) vals[f] = f === 'title' ? `T-${w.name}-${seed}` : f === 'priority' ? pick(PRIORITIES) : `2031-0${1 + Math.floor(rnd() * 9)}-1${Math.floor(rnd() * 9)}`
    const desc = editsDesc ? BASE_LINES.map((l, i) => (i === w.line ? `${w.name} line` : l)).join('\n') + '\n' : undefined
    if (desc) descWriters.push(w.name)
    if (w.name === 'mac') {
      const at = slots.pop()!
      await updateTaskRaw(id, { ...vals, ...(desc ? { description: desc } : {}) } as never, { fieldTimes: { at: new Date(at).toISOString() } })
      for (const f of fields) writes.push({ writer: 'mac', field: f, value: vals[f], at })
      continue
    }
    // One save, or a fold of saves made at different times (each field keeps its own).
    const fold = rnd() < 0.5
    const recFields: Record<string, { base: unknown; value: unknown; at?: number }> = {}
    const times: number[] = []
    const own = (): number | undefined => { if (!fold) return undefined; const at = slots.pop()!; times.push(at); return at }
    for (const f of fields) { const at = own(); recFields[f] = { base: baseOf[f], value: vals[f], ...(at !== undefined ? { at } : {}) } }
    if (desc) { const at = own(); recFields.description = { base: BASE_DESC, value: desc, ...(at !== undefined ? { at } : {}) } }
    const recAt = fold ? Math.max(...times) : slots.pop()!
    for (const f of fields) writes.push({ writer: w.name, field: f, value: vals[f], at: recFields[f].at ?? recAt })
    records[w.name].push({
      v: 2, seq: 1, at: recAt, kind: 'task-fields', opId: `op-dp-${seed}-${w.name}`, rev: fold ? 2 : 1,
      actor: { kind: 'session', sid: SID }, op: 'task_update', taskId: id, fields: recFields,
    })
  }
  const hosts = Object.entries(records).filter(([, r]) => r.length)
  const ds = hosts.map(([h, r]) => daemon(h, r))
  const together = rnd() < 0.5
  if (!together && rnd() < 0.5) ds.reverse()
  // The conflict log write fails now and then: the batch stops, the record is retried.
  const flushOrig = ConflictLog.prototype.flush
  const spy = vi.spyOn(ConflictLog.prototype, 'flush').mockImplementation(function (this: ConflictLog) {
    if (rnd() < 0.2) throw new Error('EIO (injected)')
    return flushOrig.call(this)
  })
  await drainAll(ds, together)
  spy.mockRestore()
  await drainAll(ds, together)
  const where = `seed ${seed} (${together ? 'together' : ds.map((d) => d.conn.hostKey).join(' then ')})`
  expect(ds.every((d) => d.pending.length === 0), `every record acked, ${where}`).toBe(true)
  const t = (await getTask(id)) as unknown as Record<string, unknown>
  const entries = entriesFor(id)
  for (const f of SCALARS) {
    const ws = writes.filter((w) => w.field === f)
    if (!ws.length) { expect(norm(t[f]), `${f} untouched, ${where}`).toEqual(baseOf[f]); continue }
    const newest = ws.reduce((a, b) => (b.at > a.at ? b : a))
    expect(norm(t[f]), `${f} is the newest write, ${where}`).toEqual(newest.value)
    const distinct = new Set(ws.map((w) => JSON.stringify(w.value))).size
    const listed = entries.filter((e) => e.kind === 'task-field' && e.field === f).length
    if (distinct >= 2) expect(listed, `${f} both changed is lettered, ${where}`).toBeGreaterThan(0)
    if (ws.length === 1) expect(listed, `${f} one writer is not lettered, ${where}`).toBe(0)
  }
  for (const w of descWriters) expect(String(t.description), `description keeps ${w}'s line, ${where}`).toContain(`${w} line`)
  // A second drain of every record (a crash before the ack) changes nothing.
  const before = JSON.stringify(t)
  await drainAll(hosts.map(([h, r]) => daemon(h, r)), together)
  expect(JSON.stringify(await getTask(id)), `a second drain changes nothing, ${where}`).toBe(before)
}

describe('the real drain, seeded', () => {
  it(`${RUNS} runs: two host journals and a Mac edit end the same in any drain order`, async () => {
    for (let s = 1; s <= RUNS; s++) await oneRun(0x5eed00 + s)
  }, Math.max(120_000, RUNS * 400))
})
