/**
 * Through the real drain (runOfflineHandover) of a temp home, modelled on
 * drain-notes-giveup.test.ts:
 *   A. a note save the Mac applied over HTTP (ledger row, rev 1) whose answer was lost: the
 *      client's retry was journaled away and the next save folded into it (rev 2);
 *   B. a drain whose note write landed but whose merge-context save failed (an IO error),
 *      retried by the backoff;
 *   C. a give-up whose BASE the host no longer holds while it still holds the save itself.
 */
import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { createMockConstants } from '../../helpers/mock-constants.js'

vi.mock('../../../src/constants.js', () => createMockConstants('walnut-drain-notes-redrain'))
vi.mock('../../../src/core/sessions/session-send-core.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../src/core/sessions/session-send-core.js')>()),
  deliverToSession: vi.fn(async () => ({ delivery: 'queued' })),
}))
const inbox = vi.hoisted(() => ({ letters: [] as Array<{ subject: string; markdown: string }> }))
vi.mock('../../../src/core/human-inbox/store.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../src/core/human-inbox/store.js')>()),
  sendLetter: vi.fn(async (l: { subject: string; markdown: string }) => { inbox.letters.push(l); return { id: `letter-${inbox.letters.length}` } }),
}))
vi.mock('../../../src/core/notes-indexer.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../src/core/notes-indexer.js')>()),
  scheduleNotesIndexUpdate: () => undefined,
}))
const merge = vi.hoisted(() => ({ failNext: 0 }))
vi.mock('../../../src/core/offline-merge/note-merge-worker.js', async (importOriginal) => {
  const orig = await importOriginal<typeof import('../../../src/core/offline-merge/note-merge-worker.js')>()
  const lib = await import('../../../src/lib/three-way-merge.js')
  return {
    ...orig,
    mergeNoteOffLoop: async (base: string, versions: Parameters<typeof lib.mergeVersions>[1], opts?: Parameters<typeof lib.mergeVersions>[2]) => {
      if (merge.failNext > 0) { merge.failNext--; throw new Error('the note merge worker exited (1) without an answer (injected)') }
      return lib.mergeVersions(base, versions, opts)
    },
  }
})

import { runOfflineHandover, _resetOfflineHandoverForTesting, _setHandoverBackoffForTesting } from '../../../src/core/offline-handover.js'
import { closeDb } from '../../../src/core/task-db.js'
import { _resetHostClocksForTesting } from '../../../src/core/offline-merge/host-clock.js'
import { conflictDir, readConflictLog, type ConflictEntry } from '../../../src/core/offline-merge/conflict-log.js'
import { recordApplied } from '../../../src/core/offline-merge/ledger.js'
import { NOTES_DIR, WALNUT_HOME } from '../../../src/constants.js'

const SID = 'cdcdcdcd-7777-4777-8777-777777777777'
const HOST = 'marina'
let seqN = 7000
let opN = 0
const sha = (s: string): string => crypto.createHash('sha256').update(s).digest('hex')
const note = (id: string, body: string): string => `---\nid: ${id}\n---\n${body}`

function journal(records: Array<Record<string, unknown>>, blobs: Map<string, Buffer>) {
  const pending = [...records]
  const goneAfterRead = new Set<string>()
  const gone = new Set<string>()
  const acks: number[][] = []
  return {
    pending, blobs, goneAfterRead, acks,
    conn: {
      hostKey: HOST, journalV2: true,
      send: async (cmd: string, p?: Record<string, unknown>) => {
        if (cmd === 'offline.drain') return { ok: true, records: pending.slice(), now: Date.now() }
        if (cmd === 'offline.blob') {
          const key = String(p?.sha ?? '')
          const body = blobs.get(key)
          if (gone.has(key)) return { ok: false, code: 'not_found', message: 'this host does not hold that body' }
          if (goneAfterRead.has(key)) gone.add(key)
          if (!body) return { ok: false, error: 'this host does not hold that body' }
          const offset = Number(p?.offset) || 0
          return { ok: true, size: body.length, offset, data: body.subarray(offset).toString('base64'), done: true }
        }
        if (cmd === 'offline.ack') {
          acks.push(((p?.seqs as number[]) ?? []).slice())
          for (const s of (p?.seqs as number[]) ?? []) {
            const i = pending.findIndex((r) => r.seq === s)
            if (i === -1) continue
            const [r] = pending.splice(i, 1)
            for (const b of [r.baseBlob, r.oursBlob]) if (typeof b === 'string') blobs.delete(b)
          }
        }
        return { ok: true }
      },
    },
  }
}

function noteRec(blobs: Map<string, Buffer>, rel: string, base: string | null, ours: string, over: Record<string, unknown> = {}) {
  const put = (text: string): string => { const h = sha(text); blobs.set(h, Buffer.from(text, 'utf8')); return h }
  return {
    v: 2, seq: ++seqN, at: Date.now(), kind: 'note', opId: `op-adv-${(++opN).toString(16).padStart(12, '0')}`, rev: 1,
    actor: { kind: 'session', sid: SID }, path: rel, mode: base === null ? 'create' : 'put',
    baseHash: base === null ? null : sha(base).slice(0, 12), baseBlob: base === null ? null : put(base), oursBlob: put(ours),
    ...over,
  }
}

function mac(rel: string, text: string, at = Date.now() - 3_600_000): void {
  const abs = path.join(NOTES_DIR, rel)
  fs.mkdirSync(path.dirname(abs), { recursive: true })
  fs.writeFileSync(abs, text)
  fs.utimesSync(abs, at / 1000, at / 1000)
}
const readNote = (rel: string): string | null => { try { return fs.readFileSync(path.join(NOTES_DIR, rel), 'utf8') } catch { return null } }
const count = (text: string | null, line: string): number => (text ?? '').split('\n').filter((l) => l === line).length
function entriesOnDisk(): ConflictEntry[] {
  let names: string[] = []
  try { names = fs.readdirSync(conflictDir()) } catch { return [] }
  return names.filter((n) => n.endsWith('.json')).sort().flatMap((n) => readConflictLog(n.slice(0, -5))?.entries ?? [])
}
const settle = (ms = 30) => new Promise((r) => setTimeout(r, ms))
const BASE = note('n-adv', 'title\n\none\ntwo\nthree\nfour\nfive\n')

beforeEach(() => {
  _resetOfflineHandoverForTesting()
  _resetHostClocksForTesting()
  _setHandoverBackoffForTesting([])
  merge.failNext = 0
  inbox.letters.length = 0
  fs.rmSync(conflictDir(), { recursive: true, force: true })
})
afterAll(() => { _setHandoverBackoffForTesting(null); closeDb() })

describe('a note record is never applied twice, nor acked without its text', () => {
  it('A. a save the Mac applied over HTTP, retried away and folded with the next save (rev 2): its line is in the note once', async () => {
    const rel = 'adv/forwarded.md'
    // The first save (op X) reached the Mac over HTTP and was applied; its answer was lost.
    const o1 = note('n-adv', 'title\n\none\ntwo\nnew line\nthree\nfour\nfive\n')
    mac(rel, o1)
    const blobs = new Map<string, Buffer>()
    // The client's retry of X was journaled away (base: the copy, B); the next save (op Y,
    // the line typed right below) folded into it: opId X, rev 2, saveOpIds [Y].
    const o2 = note('n-adv', 'title\n\none\ntwo\nnew line\nand the next one\nthree\nfour\nfive\n')
    const r = noteRec(blobs, rel, BASE, o2, { rev: 2, saveOpIds: ['op-adv-save-y'], noteId: 'n-adv' })
    recordApplied({ hostKey: HOST, home: WALNUT_HOME, opId: r.opId as string, rev: 1 }, { outcome: 'applied', status: 200, source: 'http' })
    const j = journal([r], blobs)
    await runOfflineHandover(j.conn as never)
    await settle()
    const text = readNote(rel)
    expect(j.pending).toHaveLength(0)
    expect(count(text, 'new line')).toBe(1)
    expect(count(text, 'and the next one')).toBe(1)
  })

  it('A2. a save in flight when the Mac slept (applied, answer lost), then the next save (a new op id) journaled away on the last confirmed base: its line is in the note once', async () => {
    const rel = 'adv/next-save.md'
    // s1 landed on the Mac (the line "first new line"); its answer never came back.
    mac(rel, note('n-adv', 'title\n\none\ntwo\nthree\nfour\nfive\nfirst new line\n'))
    const blobs = new Map<string, Buffer>()
    // s2: the editor still holds hash(BASE) and sends everything it has, plus the next line.
    const r = noteRec(blobs, rel, BASE, note('n-adv', 'title\n\none\ntwo\nthree\nfour\nfive\nfirst new line\nsecond new line\n'), { noteId: 'n-adv' })
    const j = journal([r], blobs)
    await runOfflineHandover(j.conn as never)
    await settle()
    const text = readNote(rel)
    expect(j.pending).toHaveLength(0)
    expect(count(text, 'first new line')).toBe(1)
  })

  it('B. the note was written, the merge context was not (an IO error), and the backoff retried the record: the host line is in the note once', async () => {
    _setHandoverBackoffForTesting([150])
    const rel = 'adv/retried.md'
    mac(rel, note('n-adv', 'title\n\none\ntwo\nmac line\nthree\nfour\nfive\n'))
    const blobs = new Map<string, Buffer>()
    const r = noteRec(blobs, rel, BASE, note('n-adv', 'title\n\none\ntwo\nhost line\nthree\nfour\nfive\n'), { noteId: 'n-adv' })
    const j = journal([r], blobs)
    const bodies = path.join(WALNUT_HOME, 'cache', 'note-merge', 'bodies')
    fs.rmSync(bodies, { recursive: true, force: true })
    fs.mkdirSync(path.dirname(bodies), { recursive: true })
    fs.writeFileSync(bodies, 'not a directory (injected IO failure)')
    await runOfflineHandover(j.conn as never)
    expect(j.pending).toHaveLength(1)
    fs.rmSync(bodies, { force: true })
    // The scheduled retry (150 ms) drains it again.
    for (let i = 0; i < 40 && j.pending.length; i++) await settle(50)
    const text = readNote(rel)
    expect(j.pending).toHaveLength(0)
    expect(count(text, 'host line')).toBe(1)
  })

  it('C. a give-up whose base the host no longer holds: the save it still holds is attached before the ack frees it', async () => {
    const rel = 'adv/base-gone.md'
    mac(rel, note('n-adv', 'title\n\none mac\ntwo\nthree\nfour\nfive\n'))
    const blobs = new Map<string, Buffer>()
    const ours = note('n-adv', 'title\n\none\ntwo\nthree\nfour\nfive the only copy of this line\n')
    const r = noteRec(blobs, rel, BASE, ours, { noteId: 'n-adv' })
    const j = journal([r], blobs)
    j.goneAfterRead.add(r.baseBlob as string)
    merge.failNext = 1
    await runOfflineHandover(j.conn as never)
    await settle()
    const entries = entriesOnDisk()
    const everywhere = [JSON.stringify(entries), ...fs.readdirSync(path.join(NOTES_DIR, 'adv')).map((n) => fs.readFileSync(path.join(NOTES_DIR, 'adv', n), 'utf8'))].join('\n')
    expect(j.pending.length === 1 || everywhere.includes('five the only copy of this line')).toBe(true)
  })
})
