/**
 * A note record applied again after its first apply failed part way (a restart, a full
 * cache disk), and a Mac writer that takes no file lock changing the note during the
 * merge (src/core/offline-merge/notes.ts settle). The redrain has no ledger row
 * (recordApplied runs only after applyV2 returns), so only the merge context can tell
 * that the record merged already: it is saved before the note is written.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { applyNoteRecord, sha256, type NoteDrainDeps, type NoteRecordLike, type NoteMode } from '../../../src/core/offline-merge/notes'
import { mergeVersions } from '../../../src/lib/three-way-merge'
import { withNoteId } from '../../../src/core/parse-frontmatter'
import type { ConflictEntry } from '../../../src/core/offline-merge/conflict-log'

const T0 = Date.parse('2026-10-17T10:00:00.000Z')
const MIN = 60_000
let tmp = ''
let root = ''
let cache = ''
let blobs = new Map<string, Buffer>()
let letters: ConflictEntry[] = []
let seq = 0

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'adv-notes-'))
  root = path.join(tmp, 'notes')
  cache = path.join(tmp, 'cache')
  fs.mkdirSync(root, { recursive: true })
  blobs = new Map(); letters = []; seq = 0
})
afterEach(() => { fs.rmSync(tmp, { recursive: true, force: true }) })

function deps(over: Partial<NoteDrainDeps> = {}): NoteDrainDeps {
  return {
    root, cacheDir: cache, hostLabel: 'marina', hostKey: 'marina',
    fetchBlob: async (sha) => { const b = blobs.get(sha); if (!b) throw new Error('no blob'); return b },
    merge: async (base, versions, opts) => mergeVersions(base, versions, opts),
    pathOfId: () => undefined,
    lock: (_abs, fn) => fn(),
    written: () => undefined,
    remove: async (rel) => { fs.rmSync(path.join(root, rel)) },
    ensureId: (content, current) => withNoteId(content, current).content,
    stamp: () => '2026-10-17 1200',
    ...over,
  }
}
const hooks = { conflicts: (e: ConflictEntry[]) => { letters.push(...e) } }
function blob(text: string): string { const h = sha256(text); blobs.set(h, Buffer.from(text, 'utf8')); return h }
function rec(p: string, mode: NoteMode, base: string | null, ours: string | null, extra: Partial<NoteRecordLike> = {}): NoteRecordLike {
  seq++
  return {
    seq, at: 0, opId: `op-${seq}`, path: p, mode,
    baseHash: base === null ? null : sha256(base).slice(0, 12),
    baseBlob: base === null ? null : blob(base), oursBlob: ours === null ? null : blob(ours), ...extra,
  }
}
function mac(rel: string, text: string, at = T0): void {
  const abs = path.join(root, rel)
  fs.mkdirSync(path.dirname(abs), { recursive: true })
  fs.writeFileSync(abs, text)
  fs.utimesSync(abs, at / 1000, at / 1000)
}
const read = (rel: string): string => fs.readFileSync(path.join(root, rel), 'utf8')
const count = (text: string, line: string): number => text.split('\n').filter((l) => l === line).length
const note = (id: string, body: string): string => `---\nid: ${id}\n---\n${body}`
const BASE = note('n-1', 'title\n\none\ntwo\nthree\nfour\nfive\n')

describe('a note record applied again after a failed try, and a writer without the file lock', () => {
  it('process death right after the note write (written throws once): the host line is not doubled', async () => {
    // Both sides inserted a line after "two": the merge takes both blocks.
    mac('a.md', note('n-1', 'title\n\none\ntwo\nmac line\nthree\nfour\nfive\n'))
    const r = rec('a.md', 'put', BASE, note('n-1', 'title\n\none\ntwo\nhost line\nthree\nfour\nfive\n'), { noteId: 'n-1' })
    let die = true
    const d = deps({ written: () => { if (die) { die = false; throw new Error('server killed (injected) right after the note write') } } })
    await expect(applyNoteRecord(d, hooks, r, T0 + 10 * MIN)).rejects.toThrow(/injected/)
    const afterFirst = read('a.md')
    expect(count(afterFirst, 'host line')).toBe(1)
    expect(count(afterFirst, 'mac line')).toBe(1)
    // The batch retries the record (no ledger row): same record, same drain time.
    await applyNoteRecord(d, hooks, r, T0 + 10 * MIN)
    const afterRedrain = read('a.md')
    expect(count(afterRedrain, 'host line')).toBe(1)
    expect(count(afterRedrain, 'mac line')).toBe(1)
  })

  it('a merge-context body write that fails once (ENOTDIR under cache/note-merge): the host line is not doubled', async () => {
    mac('b.md', note('n-1', 'title\n\none\ntwo\nmac line\nthree\nfour\nfive\n'))
    const r = rec('b.md', 'put', BASE, note('n-1', 'title\n\none\ntwo\nhost line\nthree\nfour\nfive\n'), { noteId: 'n-1' })
    // cache/note-merge/bodies is a file: putBody fails, before the note is written.
    fs.mkdirSync(path.join(cache, 'note-merge'), { recursive: true })
    fs.writeFileSync(path.join(cache, 'note-merge', 'bodies'), 'not a dir')
    await expect(applyNoteRecord(deps(), hooks, r, T0 + 10 * MIN)).rejects.toThrow()
    expect(count(read('b.md'), 'host line')).toBe(0)
    fs.rmSync(path.join(cache, 'note-merge', 'bodies'), { force: true })
    await applyNoteRecord(deps(), hooks, r, T0 + 10 * MIN)
    const text = read('b.md')
    expect(count(text, 'host line')).toBe(1)
    expect(count(text, 'mac line')).toBe(1)
  })

  it('a Mac-side writer that does not take the user file lock (a session Edit, an external editor) writes during the merge: the first try writes nothing and the retry merges over its text', async () => {
    mac('d.md', note('n-1', 'title\n\none mac\ntwo\nthree\nfour\nfive\n'))
    const r = rec('d.md', 'put', BASE, note('n-1', 'title\n\none\ntwo\nthree\nfour\nfive host\n'), { noteId: 'n-1' })
    const d = deps({
      merge: async (base, versions, opts) => {
        // While the worker merges (up to 2 s), the note changes on disk.
        fs.writeFileSync(path.join(root, 'd.md'), note('n-1', 'title\n\none mac\ntwo\nthree typed meanwhile\nfour\nfive\n'))
        return mergeVersions(base, versions, opts)
      },
    })
    // The first try sees the change and writes nothing; the batch's retry merges over it.
    await expect(applyNoteRecord(d, hooks, r, T0 + 10 * MIN)).rejects.toThrow(/changed on this Mac while it was merged/)
    expect(read('d.md')).toBe(note('n-1', 'title\n\none mac\ntwo\nthree typed meanwhile\nfour\nfive\n'))
    await applyNoteRecord(deps(), hooks, r, T0 + 10 * MIN)
    expect(read('d.md')).toBe(note('n-1', 'title\n\none mac\ntwo\nthree typed meanwhile\nfour\nfive host\n'))
    expect(letters).toEqual([])
  })

  it('control: the same redrain with the context saved is a no-op', async () => {
    mac('c.md', note('n-1', 'title\n\none\ntwo\nmac line\nthree\nfour\nfive\n'))
    const r = rec('c.md', 'put', BASE, note('n-1', 'title\n\none\ntwo\nhost line\nthree\nfour\nfive\n'), { noteId: 'n-1' })
    await applyNoteRecord(deps(), hooks, r, T0 + 10 * MIN)
    const first = read('c.md')
    await applyNoteRecord(deps(), hooks, r, T0 + 10 * MIN)
    expect(read('c.md')).toBe(first)
    expect(count(first, 'host line')).toBe(1)
  })
})
