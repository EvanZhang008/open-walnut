/**
 * The Mac's drain of `note` records (src/core/offline-merge/notes.ts, the table in
 * docs/plan/walnut-replica-servers-impl.md section 6). Every row of the table, the
 * conflict copy's name and its own id, a note the Mac renamed while a host edited it,
 * a redrain, the merge context (restore after a delete, two creates, a host's second
 * save on top of its first), and the merge off the loop: a 1 MB conflicting pair never
 * gives the loop thread 50 ms of work between two stall recorder checkpoints, and a
 * worker past its deadline is the over-budget row.
 *
 * Real files in a temp vault; the blobs, the notes index and the file lock are in memory.
 */
import { describe, it, expect, beforeEach, afterEach, afterAll } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { applyNoteRecord, cutUtf8, sha256, withoutIdLine, type NoteDrainDeps, type NoteRecordLike, type NoteMode } from '../../../src/core/offline-merge/notes'
import { mergeNoteOffLoop, runWorker } from '../../../src/core/offline-merge/note-merge-worker'
import { mergeVersions } from '../../../src/lib/three-way-merge'
import { withNoteId } from '../../../src/core/parse-frontmatter'
import { startStallRecorder, stopStallRecorder } from '../../../src/core/stall-recorder'
import { cpuCheckpoint, cpuCheckpoints } from '../../../src/core/stall-recorder-checkpoints'
import { ON_BUN } from '../../../src/lib/runtime'
import type { ConflictEntry } from '../../../src/core/offline-merge/conflict-log'

const T0 = Date.parse('2026-10-17T10:00:00.000Z')
const MIN = 60_000

let tmp = ''
let root = ''
let cache = ''
let blobs = new Map<string, Buffer>()
let ids = new Map<string, string>()
let events: string[] = []
let letters: ConflictEntry[] = []
let seq = 0

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wp11-notes-'))
  root = path.join(tmp, 'notes')
  cache = path.join(tmp, 'cache')
  fs.mkdirSync(root, { recursive: true })
  blobs = new Map(); ids = new Map(); events = []; letters = []; seq = 0
})
afterEach(() => { fs.rmSync(tmp, { recursive: true, force: true }) })

type Merge = NoteDrainDeps['merge']
const inline: Merge = async (base, versions, opts) => mergeVersions(base, versions, opts)

function deps(over: Partial<NoteDrainDeps> = {}): NoteDrainDeps {
  return {
    root, cacheDir: cache, hostLabel: 'marina', hostKey: 'marina',
    fetchBlob: async (sha) => {
      const b = blobs.get(sha)
      if (!b) throw new Error(`no blob ${sha}`)
      return b
    },
    merge: inline,
    pathOfId: (id) => ids.get(id),
    lock: (_abs, fn) => fn(),
    written: (rel, _content, created) => { events.push(`${created ? 'create' : 'write'} ${rel}`) },
    remove: async (rel) => { fs.rmSync(path.join(root, rel)); events.push(`remove ${rel}`) },
    ensureId: (content, current) => withNoteId(content, current).content,
    stamp: () => '2026-10-17 1200',
    ...over,
  }
}

const hooks = { conflicts: (e: ConflictEntry[]) => { letters.push(...e) } }

function blob(text: string): string {
  const sha = sha256(text)
  blobs.set(sha, Buffer.from(text, 'utf8'))
  return sha
}

function rec(p: string, mode: NoteMode, base: string | null, ours: string | null, extra: Partial<NoteRecordLike> = {}): NoteRecordLike {
  seq++
  return {
    seq, at: 0, opId: `op-${seq}`, path: p, mode,
    baseHash: base === null ? null : sha256(base).slice(0, 12),
    baseBlob: base === null ? null : blob(base),
    oursBlob: ours === null ? null : blob(ours),
    ...extra,
  }
}

/** The Mac's own note, written at `at` (its mtime is the Mac's time for the merge). */
function mac(rel: string, text: string, at = T0): void {
  const abs = path.join(root, rel)
  fs.mkdirSync(path.dirname(abs), { recursive: true })
  fs.writeFileSync(abs, text)
  fs.utimesSync(abs, at / 1000, at / 1000)
}

function read(rel: string): string | null {
  try { return fs.readFileSync(path.join(root, rel), 'utf8') } catch { return null }
}

/** Every .md in the vault, vault-relative, sorted. */
function vault(dir = root): string[] {
  const out: string[] = []
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const abs = path.join(dir, e.name)
    if (e.isDirectory()) out.push(...vault(abs))
    else if (e.name.endsWith('.md')) out.push(path.relative(root, abs).split(path.sep).join('/'))
  }
  return out.sort()
}

const idOf = (text: string | null): string | undefined => /\nid: *([^\n]+)/.exec(text ?? '')?.[1]?.trim()
const note = (id: string, body: string): string => `---\nid: ${id}\n---\n${body}`

const BASE = note('n-1', 'title\n\none\ntwo\nthree\nfour\nfive\n')

describe('the drain table (section 6)', () => {
  it('bytes == ours: nothing is written, no letter', async () => {
    const ours = note('n-1', 'title\n\none\ntwo\nthree and more\nfour\nfive\n')
    mac('a.md', ours)
    const out = await applyNoteRecord(deps(), hooks, rec('a.md', 'put', BASE, ours, { noteId: 'n-1' }), T0 + 10 * MIN)
    expect(out).toMatchObject({ action: 'noop', path: 'a.md', copies: [], entries: [] })
    expect(events).toEqual([])
    expect(letters).toEqual([])
  })

  it('hash == base: the host version is written; the Mac\'s id line is kept even when the body came without one', async () => {
    mac('a.md', BASE)
    const ours = 'title\n\none\ntwo\nthree\nfour\nfive\nsix\n'
    const out = await applyNoteRecord(deps(), hooks, rec('a.md', 'put', BASE, ours, { noteId: 'n-1' }), T0 + 10 * MIN)
    expect(out.action).toBe('fast-forward')
    expect(read('a.md')).toBe(note('n-1', ours))
    expect(events).toEqual(['write a.md'])
    expect(letters).toEqual([])
    expect(vault()).toEqual(['a.md'])
  })

  it('changed on the Mac, merges clean: both edits, no copy, no letter', async () => {
    mac('a.md', note('n-1', 'title\n\none mac\ntwo\nthree\nfour\nfive\n'), T0 + 5 * MIN)
    const ours = note('n-1', 'title\n\none\ntwo\nthree\nfour\nfive host\n')
    const out = await applyNoteRecord(deps(), hooks, rec('a.md', 'put', BASE, ours, { noteId: 'n-1' }), T0 + 10 * MIN)
    expect(out.action).toBe('merged')
    expect(read('a.md')).toBe(note('n-1', 'title\n\none mac\ntwo\nthree\nfour\nfive host\n'))
    expect(letters).toEqual([])
    expect(vault()).toEqual(['a.md'])
  })

  it('a conflicting region: the newer side in the note, the other version whole in a copy with its own id, one letter', async () => {
    mac('a.md', note('n-1', 'title\n\none\ntwo mac\nthree\nfour\nfive mac\n'), T0 + 5 * MIN)
    const ours = note('n-1', 'title\n\none\ntwo host\nthree\nfour\nfive\n')
    const out = await applyNoteRecord(deps(), hooks, rec('a.md', 'put', BASE, ours, { noteId: 'n-1' }), T0 + 10 * MIN)
    expect(out.action).toBe('conflict')
    // The host saved later: its region wins; the Mac's clean edit (five mac) still lands.
    expect(read('a.md')).toBe(note('n-1', 'title\n\none\ntwo host\nthree\nfour\nfive mac\n'))
    const copy = 'a (conflict Mac 2026-10-17 1200).md'
    expect(out.copies).toEqual([copy])
    expect(vault()).toEqual(['a (conflict Mac 2026-10-17 1200).md', 'a.md'])
    // The losing version, every region its own: nothing of the Mac's is lost.
    expect(withoutIdLine(read(copy)!)).toBe(withoutIdLine(note('n-1', 'title\n\none\ntwo mac\nthree\nfour\nfive mac\n')))
    expect(idOf(read(copy))).toBeTruthy()
    expect(idOf(read(copy))).not.toBe('n-1')
    expect(letters).toHaveLength(1)
    expect(letters[0]).toMatchObject({ kind: 'note', why: 'conflict', notePath: 'a.md', copyPath: copy, lostVersion: 'mac', kept: 'replica' })
  })

  it('a conflicting region the Mac wrote later: the Mac\'s side in the note, the host version as the copy', async () => {
    mac('a.md', note('n-1', 'title\n\none\ntwo mac\nthree\nfour\nfive\n'), T0 + 20 * MIN)
    const ours = note('n-1', 'title\n\none\ntwo host\nthree\nfour\nfive host\n')
    const out = await applyNoteRecord(deps(), hooks, rec('a.md', 'put', BASE, ours, { noteId: 'n-1' }), T0 + 10 * MIN)
    expect(out.action).toBe('conflict')
    expect(read('a.md')).toBe(note('n-1', 'title\n\none\ntwo mac\nthree\nfour\nfive host\n'))
    expect(out.copies).toEqual(['a (conflict marina 2026-10-17 1200).md'])
    expect(withoutIdLine(read(out.copies[0])!)).toBe(withoutIdLine(ours))
    expect(letters).toMatchObject([{ why: 'conflict', lostVersion: 'marina/op-1', kept: 'mac' }])
  })

  it('over the diff budget: the whole note is one region, the newer whole, the other in a copy', async () => {
    const tight: Merge = async (b, v, o) => mergeVersions(b, v, { ...o, maxEditLength: 2 })
    const macText = note('n-1', 'title\n\none mac\ntwo\nthree mac\nfour\nfive mac\n')
    mac('a.md', macText, T0 + 5 * MIN)
    const ours = note('n-1', 'title host\n\none\ntwo host\nthree\nfour host\nfive\n')
    const out = await applyNoteRecord(deps({ merge: tight }), hooks, rec('a.md', 'put', BASE, ours, { noteId: 'n-1' }), T0 + 10 * MIN)
    expect(out.action).toBe('conflict')
    expect(read('a.md')).toBe(ours)
    expect(withoutIdLine(read(out.copies[0])!)).toBe(withoutIdLine(macText))
    expect(letters).toMatchObject([{ why: 'over-budget', lostVersion: 'mac' }])
  })

  it('a worker past its deadline: the over-budget row, by the times alone', async () => {
    const late: Merge = (b, v, o) => runWorker(b, v, o, 1)
    const macText = note('n-1', 'title\n\none mac\ntwo\nthree\nfour\nfive\n')
    mac('a.md', macText, T0 + 5 * MIN)
    const ours = note('n-1', 'title\n\none host\ntwo\nthree\nfour\nfive\n')
    const out = await applyNoteRecord(deps({ merge: late }), hooks, rec('a.md', 'put', BASE, ours, { noteId: 'n-1' }), T0 + 10 * MIN)
    expect(out.action).toBe('conflict')
    expect(read('a.md')).toBe(ours)
    expect(withoutIdLine(read(out.copies[0])!)).toBe(withoutIdLine(macText))
    expect(letters).toMatchObject([{ why: 'deadline', lostVersion: 'mac' }])
  })

  it('the Mac deleted the note: the host edit is kept as a copy, the path stays deleted, one letter', async () => {
    const ours = note('n-1', 'title\n\none\ntwo host\nthree\nfour\nfive\n')
    const out = await applyNoteRecord(deps(), hooks, rec('a.md', 'put', BASE, ours, { noteId: 'n-1' }), T0 + 10 * MIN)
    expect(out.action).toBe('copied')
    expect(read('a.md')).toBeNull()
    expect(vault()).toEqual(['a (conflict marina 2026-10-17 1200).md'])
    expect(withoutIdLine(read(out.copies[0])!)).toBe(withoutIdLine(ours))
    expect(letters).toMatchObject([{ why: 'mac-deleted', kept: 'mac', copyPath: out.copies[0] }])
  })

  it('a create where the Mac has its own note: the Mac\'s stays, the new one is a copy, one letter', async () => {
    const macText = note('n-2', 'the Mac\'s own\n')
    mac('dir/b.md', macText)
    const ours = 'made on the phone\n'
    const out = await applyNoteRecord(deps(), hooks, rec('dir/b', 'create', null, ours), T0 + 10 * MIN)
    expect(out.action).toBe('copied')
    expect(read('dir/b.md')).toBe(macText)
    expect(out.copies).toEqual(['dir/b (conflict marina 2026-10-17 1200).md'])
    expect(withoutIdLine(read(out.copies[0])!)).toContain('made on the phone')
    expect(letters).toMatchObject([{ why: 'create-exists', kept: 'mac' }])
  })

  it('a create of a free path: written with an id of its own, no letter', async () => {
    const out = await applyNoteRecord(deps(), hooks, rec('dir/new.md', 'create', null, 'fresh\n'), T0 + 10 * MIN)
    expect(out.action).toBe('created')
    expect(read('dir/new.md')).toMatch(/^---\nid: [^\n]+\n---\nfresh\n$/)
    expect(events).toEqual(['create dir/new.md'])
    expect(letters).toEqual([])
  })

  it('a delete of an unchanged note: deleted through the delete route, no letter', async () => {
    mac('a.md', BASE)
    const out = await applyNoteRecord(deps(), hooks, rec('a.md', 'delete', BASE, null, { noteId: 'n-1' }), T0 + 10 * MIN)
    expect(out.action).toBe('deleted')
    expect(read('a.md')).toBeNull()
    expect(events).toEqual(['remove a.md'])
    expect(letters).toEqual([])
  })

  it('a delete of a note the Mac edited since: the edit beats the delete, one letter', async () => {
    const edited = note('n-1', 'title\n\none edited\ntwo\nthree\nfour\nfive\n')
    mac('a.md', edited)
    const out = await applyNoteRecord(deps(), hooks, rec('a.md', 'delete', BASE, null, { noteId: 'n-1' }), T0 + 10 * MIN)
    expect(out.action).toBe('kept')
    expect(read('a.md')).toBe(edited)
    expect(letters).toMatchObject([{ why: 'delete-kept', kept: 'mac' }])
  })

  it('a delete of a note already gone: nothing', async () => {
    const out = await applyNoteRecord(deps(), hooks, rec('a.md', 'delete', BASE, null), T0 + 10 * MIN)
    expect(out).toMatchObject({ action: 'noop', copies: [], entries: [] })
    expect(events).toEqual([])
  })
})

describe('copies, ids and paths', () => {
  it('a copy name already taken by another text gets " 2"; the same text found again is reused', async () => {
    mac('a (conflict Mac 2026-10-17 1200).md', 'someone else\'s file\n')
    mac('a.md', note('n-1', 'title\n\none\ntwo mac\nthree\nfour\nfive\n'), T0 + 5 * MIN)
    const ours = note('n-1', 'title\n\none\ntwo host\nthree\nfour\nfive\n')
    const r = rec('a.md', 'put', BASE, ours, { noteId: 'n-1' })
    const out = await applyNoteRecord(deps(), hooks, r, T0 + 10 * MIN)
    expect(out.copies).toEqual(['a (conflict Mac 2026-10-17 1200) 2.md'])
    expect(read('a (conflict Mac 2026-10-17 1200).md')).toBe('someone else\'s file\n')
    // The same record drained again (an ack lost in a crash): no second copy, no second letter.
    const again = await applyNoteRecord(deps(), hooks, r, T0 + 10 * MIN)
    expect(again).toMatchObject({ copies: [], entries: [] })
    expect(vault()).toHaveLength(3)
    expect(letters).toHaveLength(1)
  })

  it('a note whose name is near the 255-byte limit: the copy\'s stem is cut to fit, never inside a code point', async () => {
    // A stem of 222 bytes (the note's own name, 225, fits): its copy name was 256 bytes,
    // ENAMETOOLONG on every retry, until the record was given up and its text lost.
    // The emoji (U+1F600, 4 bytes each, a surrogate pair in JS) put the cut point inside a code point.
    const stem = 'x'.repeat(102) + '\uD83D\uDE00'.repeat(30)
    expect(Buffer.byteLength(stem)).toBe(222)
    const rel = `dir/${stem}.md`
    mac(rel, note('n-1', 'title\n\none\ntwo mac\nthree\nfour\nfive\n'), T0 + 5 * MIN)
    // Someone's own file already has the cut copy name: the clash suffix still fits.
    const cut = 'x'.repeat(102) + '\uD83D\uDE00'.repeat(28)
    mac(`dir/${cut} (conflict Mac 2026-10-17 1200).md`, 'someone else\'s file\n')
    const ours = note('n-1', 'title\n\none\ntwo host\nthree\nfour\nfive\n')
    const out = await applyNoteRecord(deps(), hooks, rec(rel, 'put', BASE, ours, { noteId: 'n-1' }), T0 + 10 * MIN)
    expect(out.action).toBe('conflict')
    expect(out.copies).toEqual([`dir/${cut} (conflict Mac 2026-10-17 1200) 2.md`])
    const name = path.posix.basename(out.copies[0])
    expect(Buffer.byteLength(name)).toBeLessThanOrEqual(255)
    // Valid UTF-8: the name survives a round trip through bytes unchanged.
    expect(Buffer.from(name, 'utf8').toString('utf8')).toBe(name)
    expect(withoutIdLine(read(out.copies[0])!)).toBe(withoutIdLine(note('n-1', 'title\n\none\ntwo mac\nthree\nfour\nfive\n')))
    expect(letters).toMatchObject([{ why: 'conflict', copyPath: out.copies[0] }])
  })

  it('cutUtf8 keeps whole code points: CJK, emoji and plain ASCII', () => {
    expect(cutUtf8('abc', 10)).toBe('abc')
    expect(cutUtf8('\u65e5\u672c\u8a9e', 7)).toBe('\u65e5\u672c')
    expect(cutUtf8('a\uD83D\uDE00b', 4)).toBe('a')
    expect(cutUtf8('a\uD83D\uDE00b', 5)).toBe('a\uD83D\uDE00')
  })

  it('no two notes ever share an id: every copy gets a fresh one', async () => {
    mac('a.md', note('n-1', 'title\n\none\ntwo mac\nthree\nfour\nfive mac\n'), T0 + 5 * MIN)
    for (let i = 0; i < 3; i++) {
      const ours = note('n-1', `title\n\none\ntwo host ${i}\nthree\nfour\nfive\n`)
      // Three hosts, each from the same base, each later than the last.
      await applyNoteRecord(deps({ hostKey: `h${i}`, hostLabel: `h${i}` }), hooks, rec('a.md', 'put', BASE, ours, { noteId: 'n-1' }), T0 + (10 + i) * MIN)
    }
    const all = vault()
    expect(all.length).toBeGreaterThan(2)
    const seen = all.map((rel) => idOf(read(rel)))
    expect(seen.every(Boolean)).toBe(true)
    expect(new Set(seen).size).toBe(all.length)
    expect(idOf(read('a.md'))).toBe('n-1')
  })

  it('a note the Mac renamed while a host edited it: merged clean at its new path, no letter', async () => {
    // The Mac moved a.md to dir/renamed.md and edited another line; the notes index knows the id.
    mac('dir/renamed.md', note('n-1', 'title\n\none mac\ntwo\nthree\nfour\nfive\n'), T0 + 5 * MIN)
    ids.set('n-1', 'dir/renamed.md')
    const ours = note('n-1', 'title\n\none\ntwo\nthree\nfour\nfive host\n')
    const out = await applyNoteRecord(deps(), hooks, rec('a.md', 'put', BASE, ours, { noteId: 'n-1' }), T0 + 10 * MIN)
    expect(out).toMatchObject({ action: 'merged', path: 'dir/renamed.md', copies: [], entries: [] })
    expect(read('dir/renamed.md')).toBe(note('n-1', 'title\n\none mac\ntwo\nthree\nfour\nfive host\n'))
    expect(read('a.md')).toBeNull()
    expect(vault()).toEqual(['dir/renamed.md'])
    expect(letters).toEqual([])
  })

  it('an id the index does not know falls back to the record path', async () => {
    mac('a.md', BASE)
    const out = await applyNoteRecord(deps(), hooks, rec('a.md', 'put', BASE, BASE + 'more\n', { noteId: 'n-unknown' }), T0)
    expect(out.path).toBe('a.md')
    expect(read('a.md')).toBe(BASE + 'more\n')
  })

  it('an id the base does not carry never moves the write to another note (an id typed into a save, a create)', async () => {
    mac('Projects/Plan.md', BASE)
    const diary = note('n-diary', 'Dear diary.\n')
    mac('Private/Diary.md', diary)
    ids.set('n-diary', 'Private/Diary.md')
    const ours = BASE.replace('five', 'five host')
    const out = await applyNoteRecord(deps(), hooks, rec('Projects/Plan.md', 'put', BASE, ours, { noteId: 'n-diary' }), T0 + 10 * MIN)
    expect(out.path).toBe('Projects/Plan.md')
    expect(read('Projects/Plan.md')).toBe(ours)
    const made = await applyNoteRecord(deps(), hooks, rec('Projects/New.md', 'create', null, 'A new note.\n', { noteId: 'n-diary' }), T0 + 11 * MIN)
    expect(made.path).toBe('Projects/New.md')
    expect(read('Private/Diary.md')).toBe(diary)
    expect(vault().filter((p) => p.startsWith('Private/'))).toEqual(['Private/Diary.md'])
  })

  it('a path out of the vault is refused (the batch retries, then files it in the conflict log)', async () => {
    await expect(applyNoteRecord(deps(), hooks, rec('../escape.md', 'put', BASE, BASE), T0)).rejects.toThrow(/outside the vault/)
    expect(fs.existsSync(path.join(tmp, 'escape.md'))).toBe(false)
  })

  it('a body the host cannot hand over fails the record, and nothing is written', async () => {
    mac('a.md', BASE)
    const r = rec('a.md', 'put', BASE, BASE + 'x\n')
    blobs.delete(r.oursBlob!)
    await expect(applyNoteRecord(deps(), hooks, r, T0)).rejects.toThrow(/no blob/)
    expect(read('a.md')).toBe(BASE)
  })
})

describe('the merge context: several hosts and saves of one note', () => {
  it('a delete and an edit of the same base: the edit wins in either order and the note is back', async () => {
    const edit = note('n-1', 'title\n\none\ntwo edited\nthree\nfour\nfive\n')
    // Delete first, then the edit.
    mac('a.md', BASE)
    await applyNoteRecord(deps({ hostKey: 'h1' }), hooks, rec('a.md', 'delete', BASE, null, { noteId: 'n-1' }), T0 + 5 * MIN)
    expect(read('a.md')).toBeNull()
    const back = await applyNoteRecord(deps({ hostKey: 'h2', hostLabel: 'h2' }), hooks, rec('a.md', 'put', BASE, edit, { noteId: 'n-1' }), T0 + 10 * MIN)
    expect(back.action).toBe('restored')
    expect(read('a.md')).toBe(edit)
    expect(letters).toMatchObject([{ why: 'restored', kept: 'replica' }])
    expect(vault()).toEqual(['a.md'])
    // The other order: the edit, then the delete it beats.
    fs.rmSync(tmp, { recursive: true, force: true }); fs.mkdirSync(root, { recursive: true }); letters = []
    mac('a.md', BASE)
    await applyNoteRecord(deps({ hostKey: 'h2' }), hooks, rec('a.md', 'put', BASE, edit, { noteId: 'n-1' }), T0 + 10 * MIN)
    const kept = await applyNoteRecord(deps({ hostKey: 'h1' }), hooks, rec('a.md', 'delete', BASE, null, { noteId: 'n-1' }), T0 + 5 * MIN)
    expect(kept.action).toBe('kept')
    expect(read('a.md')).toBe(edit)
    expect(letters).toMatchObject([{ why: 'delete-kept' }])
  })

  it('two creates of one new path: the newer is the note and the older a copy, in either order', async () => {
    const run = async (first: 'a' | 'b'): Promise<{ note: string; copies: string[] }> => {
      fs.rmSync(tmp, { recursive: true, force: true }); fs.mkdirSync(root, { recursive: true })
      const a = { d: deps({ hostKey: 'ha', hostLabel: 'ha' }), r: rec('new.md', 'create', null, 'from host a\n'), at: T0 + 5 * MIN }
      const b = { d: deps({ hostKey: 'hb', hostLabel: 'hb' }), r: rec('new.md', 'create', null, 'from host b\n'), at: T0 + 9 * MIN }
      for (const x of first === 'a' ? [a, b] : [b, a]) await applyNoteRecord(x.d, hooks, x.r, x.at)
      return { note: withoutIdLine(read('new.md')!), copies: vault().filter((p) => p !== 'new.md').map((p) => `${p}=${withoutIdLine(read(p)!)}`) }
    }
    const ab = await run('a')
    const ba = await run('b')
    expect(ab.note).toBe(withoutIdLine(note('x', 'from host b\n')))
    expect(ab).toEqual(ba)
    expect(ab.copies).toHaveLength(1)
    expect(letters.filter((e) => e.why === 'create-both')).toHaveLength(2)
    expect(ab.copies[0]).toMatch(/^new \(conflict ha 2026-10-17 1200\)\.md=.*from host a/s)
  })

  it('a host\'s second save on top of its first replaces it: merged with the Mac\'s edit, no copy', async () => {
    mac('a.md', note('n-1', 'title\n\none mac\ntwo\nthree\nfour\nfive\n'), T0 + 5 * MIN)
    const first = note('n-1', 'title\n\none\ntwo\nthree\nfour first\nfive\n')
    const second = note('n-1', 'title\n\none\ntwo\nthree\nfour second\nfive\n')
    await applyNoteRecord(deps(), hooks, rec('a.md', 'put', BASE, first, { noteId: 'n-1' }), T0 + 10 * MIN)
    expect(read('a.md')).toBe(note('n-1', 'title\n\none mac\ntwo\nthree\nfour first\nfive\n'))
    // The second save was journaled after the first froze: its base is the first.
    await applyNoteRecord(deps(), hooks, rec('a.md', 'put', first, second, { noteId: 'n-1' }), T0 + 11 * MIN)
    expect(read('a.md')).toBe(note('n-1', 'title\n\none mac\ntwo\nthree\nfour second\nfive\n'))
    expect(vault()).toEqual(['a.md'])
    expect(letters).toEqual([])
  })

  it('a host saved twice, then deleted: a redrain of the whole chain (an ack lost) leaves the note deleted', async () => {
    mac('a.md', BASE)
    const first = note('n-1', 'title\n\none first\ntwo\nthree\nfour\nfive\n')
    const second = note('n-1', 'title\n\none second\ntwo\nthree\nfour\nfive\n')
    const chain = [
      rec('a.md', 'put', BASE, first, { noteId: 'n-1' }),
      rec('a.md', 'put', first, second, { noteId: 'n-1' }),
      rec('a.md', 'delete', second, null, { noteId: 'n-1' }),
    ]
    const ats = [T0 + 5 * MIN, T0 + 6 * MIN, T0 + 7 * MIN]
    const actions: string[] = []
    for (let i = 0; i < chain.length; i++) actions.push((await applyNoteRecord(deps(), hooks, chain[i], ats[i])).action)
    for (let i = 0; i < chain.length; i++) actions.push((await applyNoteRecord(deps(), hooks, chain[i], ats[i])).action)
    expect(actions).toEqual(['fast-forward', 'fast-forward', 'deleted', 'noop', 'noop', 'noop'])
    expect(vault()).toEqual([])
    expect(letters).toEqual([])
  })

  it('a Mac edit after a replay starts over from the note as it is', async () => {
    mac('a.md', BASE, T0)
    const h1 = note('n-1', 'title\n\none h1\ntwo\nthree\nfour\nfive\n')
    await applyNoteRecord(deps({ hostKey: 'h1' }), hooks, rec('a.md', 'put', BASE, h1, { noteId: 'n-1' }), T0 + 5 * MIN)
    // The Mac edits the note the replay left; then a second host's edit of the old base arrives.
    mac('a.md', note('n-1', 'title\n\none h1\ntwo\nthree\nfour\nfive mac\n'), T0 + 20 * MIN)
    const h2 = note('n-1', 'title\n\none\ntwo h2\nthree\nfour\nfive\n')
    const out = await applyNoteRecord(deps({ hostKey: 'h2' }), hooks, rec('a.md', 'put', BASE, h2, { noteId: 'n-1' }), T0 + 10 * MIN)
    expect(out.action).toBe('merged')
    expect(read('a.md')).toBe(note('n-1', 'title\n\none h1\ntwo h2\nthree\nfour\nfive mac\n'))
    expect(letters).toEqual([])
  })
})

describe('merging off the loop', () => {
  const stallDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wp11-notes-stalls-'))
  afterAll(async () => {
    await stopStallRecorder()
    fs.rmSync(stallDir, { recursive: true, force: true })
  })

  const monoMs = (): number => Number(process.hrtime.bigint()) / 1e6
  const big = (edit: (i: number) => string | null): string =>
    note('n-big', Array.from({ length: 14_000 }, (_, i) => edit(i) ?? `base line ${i} ${'x'.repeat(60)}`).join('\n') + '\n')

  /** Run `fn` and give the most loop thread CPU (ms) between two stall recorder checkpoints in it. */
  async function loopCpu<T>(fn: () => Promise<T>): Promise<{ value: T; maxCpuMs: number; maxWallMs: number; checkpoints: number }> {
    await startStallRecorder({ force: true, dir: stallDir, profile: false, systemContext: false })
    // A 10 ms timer keeps the loop turning, so the end-of-iteration checkpoints run.
    // bun has none (stall-recorder-checkpoints.ts says why): there the timer takes one.
    const tick = setInterval(() => { if (ON_BUN) cpuCheckpoint() }, 10)
    const from = monoMs()
    try {
      const value = await fn()
      await new Promise((r) => setTimeout(r, 120))
      const to = monoMs()
      const cps = [...cpuCheckpoints()].filter((c) => c.mono >= from - 150 && c.mono <= to).sort((a, b) => a.mono - b.mono)
      expect(cps.length).toBeGreaterThan(5)
      expect(cps[0].mono).toBeLessThanOrEqual(from + 150)
      let maxCpuMs = 0
      let maxWallMs = 0
      for (let i = 1; i < cps.length; i++) {
        maxCpuMs = Math.max(maxCpuMs, (cps[i].cpuUs - cps[i - 1].cpuUs) / 1000)
        maxWallMs = Math.max(maxWallMs, cps[i].mono - cps[i - 1].mono)
      }
      return { value, maxCpuMs, maxWallMs, checkpoints: cps.length }
    } finally {
      clearInterval(tick)
      await stopStallRecorder()
    }
  }

  it('a 1 MB note both sides edited, one region in conflict: merged in the worker, the loop never runs 50 ms between checkpoints', async () => {
    const base = big(() => null)
    expect(base.length).toBeGreaterThan(1_000_000)
    const macText = big((i) => (i % 1000 === 0 ? `mac edit ${i}` : i === 7_301 ? 'mac 7301' : null))
    const ours = big((i) => (i % 1000 === 500 ? `host edit ${i}` : i === 7_301 ? 'host 7301' : null))
    mac('big.md', macText, T0 + 5 * MIN)
    const slow: Merge = (b, v, o) => runWorker(b, v, o, 120_000)
    const r = await loopCpu(() => applyNoteRecord(deps({ merge: slow }), hooks, rec('big.md', 'put', base, ours, { noteId: 'n-big' }), T0 + 10 * MIN))
    console.log(`[notes off-loop] 1 MB one-region: max loop CPU ${r.maxCpuMs.toFixed(1)} ms, max gap ${r.maxWallMs.toFixed(1)} ms, ${r.checkpoints} checkpoints`)
    expect(r.maxCpuMs).toBeLessThan(50)
    expect(r.value.action).toBe('conflict')
    const want = big((i) => (i % 1000 === 0 ? `mac edit ${i}` : i % 1000 === 500 ? `host edit ${i}` : i === 7_301 ? 'host 7301' : null))
    expect(read('big.md') === want).toBe(true)
    expect(letters).toMatchObject([{ why: 'conflict', lostVersion: 'mac' }])
    expect(read(r.value.copies[0])).toContain('mac 7301')
  }, 180_000)

  it('a 1 MB note both sides rewrote: the 2 s deadline gives the over-budget row, the loop never runs 50 ms between checkpoints', async () => {
    const base = big(() => null)
    const macText = big((i) => `mac rewrote ${i} ${'y'.repeat(60)}`)
    const ours = big((i) => `host rewrote ${i} ${'z'.repeat(60)}`)
    mac('big.md', macText, T0 + 5 * MIN)
    const started = Date.now()
    const r = await loopCpu(() => applyNoteRecord(deps({ merge: mergeNoteOffLoop }), hooks, rec('big.md', 'put', base, ours, { noteId: 'n-big' }), T0 + 10 * MIN))
    console.log(`[notes off-loop] 1 MB rewrite: max loop CPU ${r.maxCpuMs.toFixed(1)} ms, max gap ${r.maxWallMs.toFixed(1)} ms, ${r.checkpoints} checkpoints, ${Date.now() - started} ms`)
    expect(r.maxCpuMs).toBeLessThan(50)
    expect(r.value.action).toBe('conflict')
    expect(read('big.md') === ours).toBe(true)
    expect(withoutIdLine(read(r.value.copies[0])!) === withoutIdLine(macText)).toBe(true)
    expect(letters).toMatchObject([{ why: 'deadline', lostVersion: 'mac' }])
  }, 180_000)
})
