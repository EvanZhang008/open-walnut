/**
 * A note record the Mac does not apply is never acked without its text (WP11 review):
 * the daemon frees a record's bodies at its ack (offline-journal-core.ts), so a note
 * record that is given up, refused, or only lettered in memory used to lose the text
 * written away while its letter said "the change is attached". Through the real drain
 * (runOfflineHandover), the real conflict log, ledger and vault of a temp home:
 *   - the concrete trigger: a note whose name is near the 255-byte limit, edited on both
 *     sides, gets a conflict copy whose name fits (it was ENAMETOOLONG, then given up);
 *   - a given-up note record's entry carries its base and its text in full, and a later
 *     save of the same note in the drain is given up with it (never merged onto a base
 *     that went into the letter);
 *   - a body the host cannot hand over at the give-up: the record is not acked;
 *   - a note write the Mac refused when its forward reached it: lettered with its text;
 *   - a conflict log that cannot be written: the note record waits, never acked into a
 *     letter that exists only in memory.
 */
import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { createMockConstants } from '../../helpers/mock-constants.js'

vi.mock('../../../src/constants.js', () => createMockConstants('walnut-drain-notes-giveup'))
vi.mock('../../../src/core/sessions/session-send-core.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../src/core/sessions/session-send-core.js')>()),
  deliverToSession: vi.fn(async () => ({ delivery: 'queued' })),
}))
const inbox = vi.hoisted(() => ({ letters: [] as Array<{ subject: string; markdown: string }> }))
vi.mock('../../../src/core/human-inbox/store.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../src/core/human-inbox/store.js')>()),
  sendLetter: vi.fn(async (l: { subject: string; markdown: string }) => {
    inbox.letters.push(l)
    return { id: `letter-${inbox.letters.length}` }
  }),
}))
// The notes index update is the indexer's own business (a debounced timer): not here.
vi.mock('../../../src/core/notes-indexer.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../src/core/notes-indexer.js')>()),
  scheduleNotesIndexUpdate: () => undefined,
}))
/** The merge on the calling thread; `failNext` merges throw first (a worker that crashed). */
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

const SID = 'cdcdcdcd-6666-4666-8666-666666666666'
const HOST = 'marina'
let seqN = 5000
let opN = 0
const sha = (s: string): string => crypto.createHash('sha256').update(s).digest('hex')
const note = (id: string, body: string): string => `---\nid: ${id}\n---\n${body}`
const BASE = note('n-plan', 'title\n\none\ntwo\nthree\nfour\nfive\n')

/** A host journal with its blobs: a record stays until an ack reaches it, which frees its bodies. */
function journal(records: Array<Record<string, unknown>>, blobs: Map<string, Buffer>) {
  const pending = [...records]
  /** Bodies the host will not hand over (a link that drops on reads). */
  const refuse = new Set<string>()
  /** Bodies the host hands over once, then no longer holds (a sweep took them). */
  const goneAfterRead = new Set<string>()
  const gone = new Set<string>()
  return {
    pending, blobs, refuse, goneAfterRead,
    conn: {
      hostKey: HOST, journalV2: true,
      send: async (cmd: string, p?: Record<string, unknown>) => {
        if (cmd === 'offline.drain') return { ok: true, records: pending.slice(), now: Date.now() }
        if (cmd === 'offline.blob') {
          const key = String(p?.sha ?? '')
          const body = blobs.get(key)
          // The daemon's own answer for a body it does not hold (offline-journal-core.ts readBlob).
          if (gone.has(key)) return { ok: false, code: 'not_found', message: 'this host does not hold that body' }
          if (goneAfterRead.has(key)) gone.add(key)
          if (!body || refuse.has(key)) return { ok: false, error: 'this host does not hold that body' }
          const offset = Number(p?.offset) || 0
          return { ok: true, size: body.length, offset, data: body.subarray(offset).toString('base64'), done: true }
        }
        if (cmd === 'offline.ack') {
          for (const s of (p?.seqs as number[]) ?? []) {
            const i = pending.findIndex((r) => r.seq === s)
            if (i === -1) continue
            const [r] = pending.splice(i, 1)
            // As the daemon does: an acked record's bodies are freed.
            for (const b of [r.baseBlob, r.oursBlob]) if (typeof b === 'string') blobs.delete(b)
          }
        }
        return { ok: true }
      },
    },
  }
}

/** A `note` journal record of `rel`, its bodies put in `blobs`. */
function noteRec(blobs: Map<string, Buffer>, rel: string, base: string | null, ours: string, over: Record<string, unknown> = {}) {
  const put = (text: string): string => { const h = sha(text); blobs.set(h, Buffer.from(text, 'utf8')); return h }
  return {
    v: 2, seq: ++seqN, at: Date.now(), kind: 'note', opId: `op-ng-${(++opN).toString(16).padStart(12, '0')}`, rev: 1,
    actor: { kind: 'session', sid: SID }, path: rel, mode: base === null ? 'create' : 'put',
    baseHash: base === null ? null : sha(base).slice(0, 12), baseBlob: base === null ? null : put(base), oursBlob: put(ours),
    ...over,
  }
}

/** The Mac's own note, written at `at`. */
function mac(rel: string, text: string, at = Date.now() - 3_600_000): void {
  const abs = path.join(NOTES_DIR, rel)
  fs.mkdirSync(path.dirname(abs), { recursive: true })
  fs.writeFileSync(abs, text)
  fs.utimesSync(abs, at / 1000, at / 1000)
}

const readNote = (rel: string): string | null => { try { return fs.readFileSync(path.join(NOTES_DIR, rel), 'utf8') } catch { return null } }

/** Every conflict log entry on disk, of every drain so far. */
function entriesOnDisk(): ConflictEntry[] {
  let names: string[] = []
  try { names = fs.readdirSync(conflictDir()) } catch { return [] }
  return names.filter((n) => n.endsWith('.json')).sort().flatMap((n) => readConflictLog(n.slice(0, -5))?.entries ?? [])
}

const settle = (ms = 30) => new Promise((r) => setTimeout(r, ms))

beforeEach(() => {
  _resetOfflineHandoverForTesting()
  _resetHostClocksForTesting()
  // No retry steps: a record that throws is given up in the drain that took it.
  _setHandoverBackoffForTesting([])
  merge.failNext = 0
  inbox.letters.length = 0
  fs.rmSync(conflictDir(), { recursive: true, force: true })
})
afterAll(() => { _setHandoverBackoffForTesting(null); closeDb() })

describe('note records the Mac does not apply keep their text', () => {
  it('a note near the 255-byte name limit edited on both sides: merged, its conflict copy name fits, nothing given up', async () => {
    // A 222-character stem: the note's own name (225) fits, its copy name was 256, which
    // every vault file system refuses (ENAMETOOLONG on each retry, then given up).
    const stem = 'x'.repeat(222)
    const rel = `long/${stem}.md`
    const macText = note('n-plan', 'title\n\none\ntwo mac\nthree\nfour\nfive\n')
    mac(rel, macText)
    // A note whose own name is 253 characters, edited away only: its write's temp file
    // (`<name>.<pid>.<hex>.tmp`) was too long as well.
    const longest = `long/${'y'.repeat(250)}.md`
    mac(longest, BASE)
    const blobs = new Map<string, Buffer>()
    const ours = note('n-plan', 'title\n\none\ntwo host\nthree\nfour\nfive\n')
    const j = journal([noteRec(blobs, rel, BASE, ours), noteRec(blobs, longest, BASE, ours)], blobs)
    await runOfflineHandover(j.conn as never)
    await settle()
    expect(j.pending).toHaveLength(0)
    // The host saved later: its line is the note; the Mac's version is the copy.
    expect(readNote(rel)).toBe(ours)
    expect(readNote(longest)).toBe(ours)
    expect(fs.readdirSync(path.join(NOTES_DIR, 'long')).filter((n) => n.endsWith('.tmp'))).toEqual([])
    const copies = fs.readdirSync(path.join(NOTES_DIR, 'long')).filter((n) => n.includes(' (conflict '))
    expect(copies).toHaveLength(1)
    expect(Buffer.byteLength(copies[0])).toBeLessThanOrEqual(255)
    expect(readNote(`long/${copies[0]}`)).toContain('two mac')
    const entries = entriesOnDisk()
    expect(entries.map((e) => `${e.kind}:${e.why ?? ''}`)).toEqual(['note:conflict'])
    expect(inbox.letters).toHaveLength(1)
  })

  it('a given-up note record carries its base and its text in full, and a later save of the same note is given up with it', async () => {
    const rel = 'dir/plan.md'
    const macText = note('n-plan', 'title\n\none mac\ntwo\nthree\nfour\nfive\n')
    mac(rel, macText)
    const blobs = new Map<string, Buffer>()
    const first = note('n-plan', 'title\n\none\ntwo\nthree\nfour\nfive host\n')
    const second = note('n-plan', 'title\n\none\ntwo\nthree\nfour\nfive host, again\n')
    // The host saved twice; the second save was made on top of the first.
    const r1 = noteRec(blobs, rel, BASE, first, { noteId: 'n-plan' })
    const r2 = noteRec(blobs, rel, first, second, { noteId: 'n-plan' })
    const j = journal([r1, r2], blobs)
    merge.failNext = 1
    await runOfflineHandover(j.conn as never)
    await settle()
    // Both acked (the host freed their bodies), the Mac's note untouched.
    expect(j.pending).toHaveLength(0)
    expect(j.blobs.size).toBe(0)
    expect(readNote(rel)).toBe(macText)
    const entries = entriesOnDisk()
    expect(entries).toHaveLength(2)
    expect(entries[0]).toMatchObject({ kind: 'given-up', seq: r1.seq, notePath: rel, base: BASE, replica: first })
    expect(entries[0].reason).toMatch(/injected/)
    expect(entries[1]).toMatchObject({ kind: 'given-up', seq: r2.seq, notePath: rel, base: first, replica: second })
    expect(entries[1].reason).toMatch(/earlier change to this note/)
    expect(inbox.letters).toHaveLength(1)
    expect(inbox.letters[0].markdown).toContain(`[note ${rel}]`)
  })

  it('a give-up whose text the host cannot hand over is not acked; the next drain applies it', async () => {
    const rel = 'dir/held.md'
    mac(rel, BASE)
    const blobs = new Map<string, Buffer>()
    const ours = note('n-plan', 'title\n\none\ntwo\nthree\nfour\nfive held\n')
    const r = noteRec(blobs, rel, BASE, ours)
    const j = journal([r], blobs)
    j.refuse.add(r.oursBlob)
    await runOfflineHandover(j.conn as never)
    await settle()
    expect(j.pending).toHaveLength(1)
    expect(entriesOnDisk()).toEqual([])
    expect(inbox.letters).toHaveLength(0)
    expect(readNote(rel)).toBe(BASE)
    // The host hands it over again: the record applies (a fast-forward), no letter.
    j.refuse.clear()
    await runOfflineHandover(j.conn as never)
    await settle()
    expect(j.pending).toHaveLength(0)
    expect(readNote(rel)).toBe(ours)
    expect(inbox.letters).toHaveLength(0)
  })

  it('a give-up whose text the host no longer holds is lettered as lost and acked, so the host\'s later records are not held behind it', async () => {
    const rel = 'dir/swept.md'
    const macText = note('n-swept', 'title\n\none mac\ntwo\nthree\nfour\nfive\n')
    mac(rel, macText)
    const blobs = new Map<string, Buffer>()
    const ours = note('n-swept', 'title\n\none\ntwo\nthree\nfour\nfive swept\n')
    const r = noteRec(blobs, rel, BASE, ours, { noteId: 'n-swept' })
    const j = journal([r], blobs)
    // The apply reads the body, fails, and by the letter the host no longer holds it.
    j.goneAfterRead.add(r.oursBlob)
    merge.failNext = 1
    await runOfflineHandover(j.conn as never)
    await settle()
    expect(j.pending).toHaveLength(0)
    expect(readNote(rel)).toBe(macText)
    const entries = entriesOnDisk()
    expect(entries).toHaveLength(1)
    expect(entries[0]).toMatchObject({ kind: 'given-up', seq: r.seq, notePath: rel, bodiesLost: true })
    expect(entries[0].replica).toBeUndefined()
    expect(inbox.letters).toHaveLength(1)
    expect(inbox.letters[0].markdown).toContain('no longer on the host')
    expect(inbox.letters[0].markdown).not.toContain('The change is attached')
  })

  it('a note write the Mac refused when its forward reached it is lettered with its text', async () => {
    const rel = 'dir/refused.md'
    mac(rel, BASE)
    const blobs = new Map<string, Buffer>()
    const ours = note('n-plan', 'title\n\none refused\ntwo\nthree\nfour\nfive\n')
    const r = noteRec(blobs, rel, BASE, ours)
    recordApplied({ hostKey: HOST, home: WALNUT_HOME, opId: r.opId, rev: 1 }, { outcome: 'refused', status: 409, detail: 'conflict', source: 'http' })
    const j = journal([r], blobs)
    await runOfflineHandover(j.conn as never)
    await settle()
    expect(j.pending).toHaveLength(0)
    expect(readNote(rel)).toBe(BASE)
    expect(entriesOnDisk()).toMatchObject([{ kind: 'refused', seq: r.seq, notePath: rel, base: BASE, replica: ours }])
  })

  it('a conflict log that cannot be written: the note record waits on the host, then is lettered with its text once the disk takes it', async () => {
    _setHandoverBackoffForTesting([1, 1])
    const rel = 'dir/full-disk.md'
    mac(rel, BASE)
    const blobs = new Map<string, Buffer>()
    const ours = note('n-plan', 'title\n\none\ntwo\nthree full\nfour\nfive\n')
    // A person's note (a paired phone): its refusal is lettered. A session's refusal goes back to
    // the session alone (letter.ts refusedBySession).
    const { createDevice, listDeviceRecords } = await import('../../../src/core/device-auth.js')
    await createDevice('full-disk-phone')
    const deviceId = (await listDeviceRecords()).find((d) => d.name === 'full-disk-phone')!.id
    const r = noteRec(blobs, rel, BASE, ours, { actor: { kind: 'device', deviceId, name: 'full-disk-phone' } })
    recordApplied({ hostKey: HOST, home: WALNUT_HOME, opId: r.opId, rev: 1 }, { outcome: 'refused', status: 409, detail: 'conflict', source: 'http' })
    const j = journal([r], blobs)
    const full = vi.spyOn(fs, 'fdatasyncSync').mockImplementation(() => { throw Object.assign(new Error('ENOSPC (injected)'), { code: 'ENOSPC' }) })
    try {
      // Past every retry step: a task record is acked here with its entry in memory only.
      for (let i = 0; i < 6; i++) {
        await runOfflineHandover(j.conn as never).catch(() => undefined)
        await settle(10)
      }
      expect(j.pending).toHaveLength(1)
      expect(j.blobs.size).toBe(2)
      expect(inbox.letters).toHaveLength(0)
    } finally {
      full.mockRestore()
    }
    for (let i = 0; i < 6 && j.pending.length; i++) {
      await runOfflineHandover(j.conn as never).catch(() => undefined)
      await settle(10)
    }
    expect(j.pending).toHaveLength(0)
    expect(entriesOnDisk()).toMatchObject([{ kind: 'refused', seq: r.seq, notePath: rel, base: BASE, replica: ours }])
    expect(inbox.letters).toHaveLength(1)
    expect(inbox.letters[0].markdown).toContain(`[note ${rel}]`)
  })
})
