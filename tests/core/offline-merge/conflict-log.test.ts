/**
 * The offline drain's conflict log (src/core/offline-merge/conflict-log.ts) under the real
 * drain into a temp home's task store:
 *   - every conflict is on disk BEFORE the record it is about is acked;
 *   - a crash after the ack and before the letter (the letter never marked sent) resends
 *     the letter at the next drain, once;
 *   - the log is append only: N entries write each entry once (a cost ratchet), a torn
 *     last line is skipped, and an entry taken back stays out after a reread.
 * The inbox write is recorded here (a stand-in for the store), so the test can make the
 * first send fail the way a crash between the ack and the letter leaves things.
 */
import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { createMockConstants } from '../../helpers/mock-constants.js'

vi.mock('../../../src/constants.js', () => createMockConstants('walnut-conflict-log'))
vi.mock('../../../src/core/sessions/session-send-core.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../src/core/sessions/session-send-core.js')>()),
  deliverToSession: vi.fn(async () => ({ delivery: 'queued' })),
}))
const inbox = vi.hoisted(() => ({ letters: [] as Array<{ subject: string; markdown?: string }>, failNext: 0 }))
vi.mock('../../../src/core/human-inbox/store.js', () => ({
  sendLetter: async (input: { subject: string; markdown?: string }) => {
    if (inbox.failNext > 0) { inbox.failNext--; throw new Error('process died before the letter') }
    inbox.letters.push(input)
    return { id: `letter-${inbox.letters.length}` }
  },
}))

import { runOfflineHandover, _resetOfflineHandoverForTesting, _setHandoverBackoffForTesting } from '../../../src/core/offline-handover.js'
import { addTask, updateTask } from '../../../src/core/task-manager.js'
import { closeDb } from '../../../src/core/task-db.js'
import { ConflictLog, conflictDir, readConflictLog, unsentConflictLogs, type ConflictEntry } from '../../../src/core/offline-merge/conflict-log.js'
import { WALNUT_HOME } from '../../../src/constants.js'

const SID = 'ffffffff-6666-4666-8666-666666666666'
let seq = 0

async function conflictingRecord(): Promise<Record<string, unknown> & { seq: number }> {
  const id = (await addTask({ title: 'Contested', project: 'Acme' })).task.id
  const queuedAt = Date.now() - 60_000
  await updateTask(id, { priority: 'backlog' })
  return { v: 2, seq: ++seq, at: queuedAt, kind: 'task-fields', opId: `op-conflict-${seq}`, rev: 1, actor: { kind: 'session', sid: SID }, op: 'task_update', taskId: id, fields: { priority: { base: 'none', value: 'immediate' } } }
}

function logFiles(): string[] {
  try { return fs.readdirSync(conflictDir()).filter((n) => n.endsWith('.json')) } catch { return [] }
}

async function drain(records: Array<Record<string, unknown> & { seq: number }>, onAck?: () => void): Promise<void> {
  let handed = false
  await runOfflineHandover({
    hostKey: 'marina', journalV2: true,
    send: async (cmd) => {
      if (cmd === 'offline.ack') { onAck?.(); return { ok: true } }
      if (cmd === 'offline.drain') { const r = handed ? [] : records; handed = true; return { ok: true, records: r, now: Date.now() } }
      return { ok: true }
    },
  })
  // The boot resend runs in the background of the first drain.
  await new Promise((r) => setTimeout(r, 50))
}

beforeEach(() => {
  _resetOfflineHandoverForTesting()
  _setHandoverBackoffForTesting([])
  inbox.letters.length = 0
  inbox.failNext = 0
  fs.rmSync(conflictDir(), { recursive: true, force: true })
})

afterAll(() => {
  _setHandoverBackoffForTesting(null)
  closeDb()
})

describe('conflict log', () => {
  it('the conflict is written before its record is acked', async () => {
    const r = await conflictingRecord()
    let onDiskAtAck: unknown[] = []
    await drain([r], () => {
      onDiskAtAck = logFiles().flatMap((f) => readConflictLog(f.slice(0, -5))?.entries ?? [])
    })
    expect(onDiskAtAck).toMatchObject([{ kind: 'task-field', seq: r.seq, opId: r.opId, field: 'priority', mac: 'backlog', replica: 'immediate', kept: 'mac', base: 'none' }])
    expect(inbox.letters).toHaveLength(1)
    expect(unsentConflictLogs()).toEqual([])
  })

  it('a crash after the ack and before the letter resends the letter at boot, once', async () => {
    const r = await conflictingRecord()
    inbox.failNext = 1
    await drain([r])
    expect(inbox.letters).toHaveLength(0)
    expect(unsentConflictLogs()).toHaveLength(1)
    // Boot: the first drain of the new process sends what the old one left.
    _resetOfflineHandoverForTesting()
    await drain([])
    expect(inbox.letters).toHaveLength(1)
    expect(inbox.letters[0].subject).toContain('did not merge cleanly')
    expect(unsentConflictLogs()).toEqual([])
    // Another boot: nothing is sent again.
    _resetOfflineHandoverForTesting()
    await drain([])
    expect(inbox.letters).toHaveLength(1)
  })
})

describe('the conflict log is append only', () => {
  const big = (tag: string, n: number): string => Array.from({ length: 400 }, (_, i) => `${tag} ${n} line ${i} ${'x'.repeat(40)}`).join('\n')
  const entry = (n: number): ConflictEntry => ({ kind: 'task-field', seq: n, opId: `op-cost-${n}`, recordKind: 'task-fields', taskId: `t-${n}`, field: 'description', base: big('base', n), mac: big('mac', n), replica: big('away', n), kept: 'mac' })

  it('150 durable conflicts of about 20 KB each write under 10x the final log size (a rewrite per record wrote ~75x)', () => {
    const log = new ConflictLog('marina', WALNUT_HOME)
    let bytes = 0
    const orig = fs.writeSync
    const spy = vi.spyOn(fs, 'writeSync').mockImplementation(((fd: number, data: unknown, ...rest: unknown[]) => {
      bytes += typeof data === 'string' ? Buffer.byteLength(data) : Buffer.isBuffer(data) ? data.length : 0
      return (orig as (...a: unknown[]) => number)(fd, data, ...rest)
    }) as never)
    try {
      for (let n = 0; n < 150; n++) log.addDurable([entry(n)])
    } finally {
      spy.mockRestore()
    }
    const onDisk = fs.readdirSync(conflictDir()).filter((f) => f.startsWith(log.drainId)).reduce((sum, f) => sum + fs.statSync(path.join(conflictDir(), f)).size, 0)
    expect(onDisk).toBeGreaterThan(150 * 50_000)
    expect(bytes).toBeLessThan(10 * onDisk)
    const back = readConflictLog(log.drainId)!
    expect(back.entries).toHaveLength(150)
    expect(back.entries[149]).toMatchObject({ seq: 149, replica: big('away', 149) })
  })

  it('a torn last line is skipped, an entry taken back stays out, and the letter mark reads back', () => {
    const log = new ConflictLog('marina', WALNUT_HOME)
    const [a, b, c] = [entry(1), entry(2), entry(3)]
    log.addDurable([a, b])
    log.retract([a])
    log.addDurable([c])
    fs.appendFileSync(path.join(conflictDir(), `${log.drainId}.ndjson`), '{"i":9,"e":{"kind":"task-fi')
    expect(readConflictLog(log.drainId)!.entries.map((e) => e.seq)).toEqual([2, 3])
    expect(unsentConflictLogs().map((l) => l.drainId)).toContain(log.drainId)
    log.markSent('letter-x')
    expect(readConflictLog(log.drainId)!.letter).toMatchObject({ letterId: 'letter-x' })
    expect(unsentConflictLogs().map((l) => l.drainId)).not.toContain(log.drainId)
    // Taking back every entry on disk leaves no file, as before the first entry.
    const lone = new ConflictLog('acme-box', WALNUT_HOME)
    const d = entry(4)
    lone.addDurable([d])
    lone.retract([d])
    expect(fs.readdirSync(conflictDir()).filter((f) => f.startsWith(lone.drainId))).toEqual([])
  })
})

describe('lettered logs at the start of every drain (WP9 re-review round 2)', () => {
  const entry = (n: number): ConflictEntry => ({ kind: 'task-field', seq: n, opId: `op-lettered-${n}`, recordKind: 'task-fields', taskId: `t-${n}`, field: 'title', base: 'a', mac: 'b', replica: 'c', kept: 'mac' })
  it('a lettered log is read once per process, and one lettered longer ago than the ledger keeps op ids is removed', async () => {
    const { resendUnsentConflictLetters } = await import('../../../src/core/offline-merge/letter.js')
    const { LEDGER_TTL_MS } = await import('../../../src/core/offline-merge/ledger.js')
    const recent = new ConflictLog('marina', WALNUT_HOME)
    recent.addDurable([entry(41)])
    recent.markSent('letter-recent')
    await resendUnsentConflictLetters()
    const reads = vi.spyOn(fs, 'readFileSync')
    try {
      await resendUnsentConflictLetters()
      expect(reads.mock.calls.filter(([f]) => String(f).includes(recent.drainId))).toEqual([])
    } finally {
      reads.mockRestore()
    }
    expect(fs.readdirSync(conflictDir()).filter((f) => f.startsWith(recent.drainId)).length).toBeGreaterThan(0)
    // A log lettered elsewhere (not by this process), scanned a month later.
    const old = new ConflictLog('acme-box', WALNUT_HOME)
    old.addDurable([entry(42)])
    old.markSent('letter-old')
    await resendUnsentConflictLetters(Date.now() + LEDGER_TTL_MS + 60_000)
    expect(fs.readdirSync(conflictDir()).filter((f) => f.startsWith(old.drainId))).toEqual([])
  })
})
