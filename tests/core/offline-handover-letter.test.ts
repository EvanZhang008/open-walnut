/**
 * The conflict letter of a host drain (docs/plan/walnut-replica-servers-impl.md section 7,
 * "The letter"), through the real drain, the real inbox store and the real route the
 * letter links to, in a temp home:
 *   - a clean drain (fast-forwards, clean merges, replays) sends no letter;
 *   - many conflicts in one drain send ONE letter listing each, capped at 16 KB;
 *   - every link in it resolves: /tasks/<id> names a task that exists, and each
 *     /api/v1/offline-conflicts/<drainId>#<n> serves that entry in full.
 */
import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest'
import express from 'express'
import type { AddressInfo } from 'node:net'
import { createMockConstants } from '../helpers/mock-constants.js'

vi.mock('../../src/constants.js', () => createMockConstants('walnut-handover-letter'))
vi.mock('../../src/core/sessions/session-send-core.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/core/sessions/session-send-core.js')>()),
  deliverToSession: vi.fn(async () => ({ delivery: 'queued' })),
}))

import { runOfflineHandover, _resetOfflineHandoverForTesting, _setHandoverBackoffForTesting } from '../../src/core/offline-handover.js'
import { addTask, getTask, updateTask } from '../../src/core/task-manager.js'
import { closeDb } from '../../src/core/task-db.js'
import { getLetter, listLetters } from '../../src/core/human-inbox/store.js'
import { offlineConflictsV1Router } from '../../src/web/routes/offline-conflicts-v1.js'
import { LETTER_BODY_MAX } from '../../src/core/offline-merge/letter.js'

const SID = 'abababab-7777-4777-8777-777777777777'
let seq = 0
type Rec = Record<string, unknown> & { seq: number }
const rec = (taskId: string, fields: Record<string, { base: unknown; value: unknown }>, at = Date.now()): Rec =>
  ({ v: 2, seq: ++seq, at, kind: 'task-fields', opId: `op-letter-${seq}`, rev: 1, actor: { kind: 'session', sid: SID }, op: 'task_update', taskId, fields })

async function drain(records: Rec[]): Promise<void> {
  let handed = false
  await runOfflineHandover({
    hostKey: 'marina', journalV2: true,
    send: async (cmd) => {
      if (cmd === 'offline.ack') return { ok: true }
      if (cmd === 'offline.drain') { const r = handed ? [] : records; handed = true; return { ok: true, records: r, now: Date.now() } }
      return { ok: true }
    },
  })
}

const letterCount = async (): Promise<number> => (await listLetters()).letters.length

beforeEach(() => {
  _resetOfflineHandoverForTesting()
  _setHandoverBackoffForTesting([])
})

afterAll(() => {
  _setHandoverBackoffForTesting(null)
  closeDb()
})

describe('offline handover letter', () => {
  it('no letter on a clean drain: fast-forwards and a clean text merge', async () => {
    const id = (await addTask({ title: 'Clean', project: 'Acme', description: 'one\ntwo\nthree\n' })).task.id
    await updateTask(id, { priority: 'backlog' })
    const before = await letterCount()
    await drain([
      rec(id, { title: { base: 'Clean', value: 'Clean, renamed away' } }),
      rec(id, { description: { base: 'one\ntwo\nthree\n', value: 'one\ntwo\nthree\nfour\n' } }),
    ])
    expect((await getTask(id)).title).toBe('Clean, renamed away')
    expect(await letterCount()).toBe(before)
  })

  it('no letter for an ordinary away park with a clock and an away priority change, even from a copy that lacked the fields', async () => {
    const id = (await addTask({ title: 'Parked away', project: 'Acme' })).task.id
    await updateTask(id, { phase: 'IN_PROGRESS' } as never)
    const before = await letterCount()
    // Records made away after the Mac's write and before the drain (past times): the first
    // record's updated_at bump must not make the Mac look newer for the second's field.
    await new Promise((r) => setTimeout(r, 20))
    const later = Date.now()
    await new Promise((r) => setTimeout(r, 20))
    await drain([
      // A copy without the field queues base 'unknown': the away write is newer and wins.
      rec(id, { phase: { base: 'IN_PROGRESS', value: 'WAITING' }, wait_until: { base: 'unknown', value: '6h' } }, later),
      rec(id, { priority: { base: 'unknown', value: 'immediate' } }, later),
      // A copy that shipped the field: the base is its empty value.
      rec(id, { due_date: { base: '', value: '2031-01-02' } }, later),
    ])
    const t = await getTask(id)
    expect({ phase: t.phase, clock: !!t.wait_until, priority: t.priority, due: t.due_date }).toEqual({ phase: 'WAITING', clock: true, priority: 'immediate', due: '2031-01-02' })
    expect(await letterCount()).toBe(before)
  })

  it('many conflicts in one drain send one letter; every link resolves', async () => {
    const ids: string[] = []
    const records: Rec[] = []
    for (let i = 0; i < 40; i++) {
      const id = (await addTask({ title: `Contested ${i}`, project: 'Acme' })).task.id
      ids.push(id)
      const queuedAt = Date.now() - 60_000
      await updateTask(id, { priority: 'backlog', title: `Mac title ${i} ${'x'.repeat(200)}` })
      records.push(rec(id, { priority: { base: 'none', value: 'immediate' }, title: { base: `Contested ${i}`, value: `Away title ${i}` } }, queuedAt))
    }
    const before = await letterCount()
    await drain(records)
    const letters = (await listLetters()).letters
    expect(letters.length).toBe(before + 1)
    const letter = letters.find((l) => /did not merge cleanly/.test(l.subject))!
    expect(letter.subject).toContain('80 changes')
    const detail = await getLetter(letter.id)
    const markdown = String((detail as unknown as { body?: string | null }).body ?? '')
    expect(markdown.length).toBeGreaterThan(0)
    expect(Buffer.byteLength(markdown)).toBeLessThanOrEqual(LETTER_BODY_MAX)
    const links = [...markdown.matchAll(/\]\((\/[^)\s"]+)\)/g)].map((m) => m[1])
    expect(links.length).toBeGreaterThan(0)
    const app = express()
    app.use('/api/v1', offlineConflictsV1Router)
    const server = app.listen(0, '127.0.0.1')
    await new Promise<void>((r) => server.once('listening', () => r()))
    try {
      const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
      for (const link of links) {
        if (link.startsWith('/tasks/')) {
          const id = decodeURIComponent(link.slice('/tasks/'.length))
          expect(ids).toContain(id)
          expect((await getTask(id)).id).toBe(id)
          continue
        }
        const [p, frag] = link.split('#')
        const res = await fetch(`${base}${p}`)
        expect(res.status).toBe(200)
        const json = (await res.json()) as { entries: unknown[] }
        if (frag !== undefined) expect(json.entries[Number(frag)]).toBeTruthy()
        else expect(json.entries).toHaveLength(80)
      }
    } finally {
      await new Promise<void>((r) => server.close(() => r()))
    }
  }, 60_000)
})
