/**
 * A host's copy takes the leader's moves ('host-replica-moves-v1', `renamed` beside a
 * manifest): a move of most of the copy (the one tree moved every note at once) moves the
 * rows and keeps their bodies, while the same manifest without `renamed` is still refused by
 * the half rule, which stays exactly as strict. Both cores: the notes copy
 * (host-replica-core.ts) and the pictures copy (attachment-copy-core.ts). Real fs, real sha256.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import { createHostReplica, type ReplicaEntry } from '../../src/providers/host-replica-core.js'
import { createAttachmentCopy } from '../../src/providers/attachment-copy-core.js'

const HOME = '/fixture/walnut-home'
const sha12 = (s: string) => crypto.createHash('sha256').update(s).digest('hex').slice(0, 12)
const keyOf = (v: string) => crypto.createHash('sha1').update(v).digest('hex').slice(0, 16)

let dir = ''
let clock = 1_000_000
beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'whm-')); clock = 1_000_000 })
afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }) })

const makeNotes = () => createHostReplica({ fs, path, dir, now: () => clock, keyOf, hash: sha12, log: () => {} })

/** 300 notes under the old vault folder `acme/`. */
const OLD: Record<string, string> = {}
for (let i = 0; i < 300; i++) OLD[`acme/day-${String(i).padStart(3, '0')}.md`] = `# Day ${i}\nShipped build ${i}.`
const movedKey = (k: string) => k.replace(/^acme\//, 'projects/Acme/notes/')
const entriesOf = (src: Record<string, string>): ReplicaEntry[] => Object.entries(src).map(([k, body]) => ({ k, h: sha12(body), n: Buffer.byteLength(body), m: { title: k } }))
const NEW: Record<string, string> = Object.fromEntries(Object.entries(OLD).map(([k, b]) => [movedKey(k), b]))
const pairs = (): Array<[string, string]> => Object.keys(OLD).map((k) => [k, movedKey(k)])

function fillNotes(r: ReturnType<typeof makeNotes>): void {
  const { need } = r.sync(HOME, 'notes', entriesOf(OLD), clock)
  expect(r.put(HOME, 'notes', need.map((k) => ({ k, body: OLD[k] })))).toMatchObject({ stored: 300, remaining: 0 })
}

const bodyFiles = (kind: string): string[] => fs.readdirSync(path.join(dir, keyOf(HOME), kind, 'f')).sort()

describe('the notes copy takes moves', () => {
  it('a move of all 300 notes without renamed is refused, as before; with it the rows move and no body is asked again', () => {
    const r = makeNotes()
    fillNotes(r)
    // The guard unchanged: the same manifest as removals and additions is refused, the copy as it was.
    expect(() => r.sync(HOME, 'notes', entriesOf(NEW), clock + 1)).toThrow(/manifest_removes_most_rows/)
    expect(r.status(HOME).notes.entries).toBe(300)
    // With the leader's moves: accepted, nothing to fetch, every row under its new key.
    const res = r.sync(HOME, 'notes', entriesOf(NEW), clock + 1, undefined, undefined, { renamed: pairs() })
    expect(res).toMatchObject({ need: [], entries: 300, removed: 0, moved: 300 })
    expect(r.status(HOME).notes).toMatchObject({ entries: 300, pending: 0 })
    const read = r.answer(HOME, 'note_read', { path: 'projects/Acme/notes/day-007' }, '')
    expect(read).toMatchObject({ ok: true, result: { content: '# Day 7\nShipped build 7.' } })
    expect(r.answer(HOME, 'note_read', { path: 'acme/day-007' }, '')).toMatchObject({ ok: false })
    // Each body file is named after its new key now, as before moves existed; the old names are gone.
    expect(bodyFiles('notes')).toEqual(Object.keys(NEW).map((k) => keyOf(`notes:${k}`)).sort())
    // It survives a restart of the daemon (the index on disk).
    const again = makeNotes()
    expect(again.read(HOME, 'notes', 'projects/Acme/notes/day-299.md')).toMatchObject({ body: '# Day 299\nShipped build 299.' })
  })

  it('a note made later at an old key never overwrites the moved note', () => {
    const r = makeNotes()
    fillNotes(r)
    r.sync(HOME, 'notes', entriesOf(NEW), clock + 1, undefined, undefined, { renamed: pairs() })
    const both = { ...NEW, 'acme/day-000.md': '# A new day zero' }
    const { need } = r.sync(HOME, 'notes', entriesOf(both), clock + 2)
    expect(need).toEqual(['acme/day-000.md'])
    r.put(HOME, 'notes', [{ k: 'acme/day-000.md', body: '# A new day zero' }])
    expect(r.read(HOME, 'notes', 'acme/day-000.md')?.body).toBe('# A new day zero')
    expect(r.read(HOME, 'notes', 'projects/Acme/notes/day-000.md')?.body).toBe('# Day 0\nShipped build 0.')
    // And a restart reads both from disk the same way.
    const again = makeNotes()
    expect(again.read(HOME, 'notes', 'acme/day-000.md')?.body).toBe('# A new day zero')
    expect(again.read(HOME, 'notes', 'projects/Acme/notes/day-000.md')?.body).toBe('# Day 0\nShipped build 0.')
    expect(bodyFiles('notes')).toHaveLength(301)
  })

  it('a crash before the moved index is kept leaves the copy as it was; the next round moves it again', () => {
    const r = makeNotes()
    fillNotes(r)
    // The index write fails (a crash, a full disk) in the round that moves the rows.
    const failing = { ...fs, writeFileSync: ((file: fs.PathOrFileDescriptor, ...rest: unknown[]) => {
      if (String(file).includes('index.json')) throw Object.assign(new Error('EIO: crash'), { code: 'EIO' })
      return (fs.writeFileSync as (...a: unknown[]) => void)(file, ...rest)
    }) as typeof fs.writeFileSync }
    const crashing = createHostReplica({ fs: failing, path, dir, now: () => clock, keyOf, hash: sha12, log: () => {} })
    crashing.sync(HOME, 'notes', entriesOf(NEW), clock + 1, undefined, undefined, { renamed: pairs() })
    // After the restart the copy on disk is the one before the move, every body readable.
    const after = makeNotes()
    expect(after.status(HOME).notes.entries).toBe(300)
    expect(after.read(HOME, 'notes', 'acme/day-123.md')?.body).toBe(OLD['acme/day-123.md'])
    // The old names were kept (the index naming the new ones never reached the disk); the new links are left over.
    expect(bodyFiles('notes')).toEqual([...Object.keys(OLD), ...Object.keys(NEW)].map((k) => keyOf(`notes:${k}`)).sort())
    // The leader's next round sends the move again: taken in full, nothing fetched, nothing lost.
    expect(after.sync(HOME, 'notes', entriesOf(NEW), clock + 2, undefined, undefined, { renamed: pairs() })).toMatchObject({ need: [], moved: 300, removed: 0 })
    expect(after.read(HOME, 'notes', 'projects/Acme/notes/day-123.md')?.body).toBe(OLD['acme/day-123.md'])
    expect(bodyFiles('notes')).toEqual(Object.keys(NEW).map((k) => keyOf(`notes:${k}`)).sort())
  })

  it('after a downgrade, an older daemon writing or removing an old key never touches a moved row\'s body', () => {
    const r = makeNotes()
    fillNotes(r)
    r.sync(HOME, 'notes', entriesOf(NEW), clock + 1, undefined, undefined, { renamed: pairs() })
    const fDir = path.join(dir, keyOf(HOME), 'notes', 'f')
    // What a daemon from before moves does for a note at the old key: its body file is keyOf(kind:k),
    // written through a temp file and a rename, and removed by that name.
    const oldName = path.join(fDir, keyOf('notes:acme/day-009.md'))
    fs.writeFileSync(`${oldName}.tmp`, '# Another note at the old place')
    fs.renameSync(`${oldName}.tmp`, oldName)
    expect(makeNotes().read(HOME, 'notes', 'projects/Acme/notes/day-009.md')?.body).toBe(OLD['acme/day-009.md'])
    fs.rmSync(oldName, { force: true })
    expect(makeNotes().read(HOME, 'notes', 'projects/Acme/notes/day-009.md')?.body).toBe(OLD['acme/day-009.md'])
  })

  it('a body file whose new name cannot be made keeps its old name and stays readable', () => {
    const r = makeNotes()
    fillNotes(r)
    const linking = { ...fs, linkSync: (() => { throw Object.assign(new Error('EPERM: no hard links here'), { code: 'EPERM' }) }) as typeof fs.linkSync }
    const noLinks = createHostReplica({ fs: linking, path, dir, now: () => clock, keyOf, hash: sha12, log: () => {} })
    expect(noLinks.sync(HOME, 'notes', entriesOf(NEW), clock + 1, undefined, undefined, { renamed: pairs() })).toMatchObject({ need: [], moved: 300, removed: 0 })
    expect(bodyFiles('notes')).toEqual(Object.keys(OLD).map((k) => keyOf(`notes:${k}`)).sort())
    expect(makeNotes().read(HOME, 'notes', 'projects/Acme/notes/day-077.md')?.body).toBe(OLD['acme/day-077.md'])
  })

  it('a new body under another file name removes the old file only once the index naming it is written', () => {
    const linking = { ...fs, linkSync: (() => { throw new Error('EPERM') }) as typeof fs.linkSync }
    const r = makeNotes()
    fillNotes(r)
    createHostReplica({ fs: linking, path, dir, now: () => clock, keyOf, hash: sha12, log: () => {} })
      .sync(HOME, 'notes', entriesOf(NEW), clock + 1, undefined, undefined, { renamed: pairs() })
    const failing = { ...fs, writeFileSync: ((file: fs.PathOrFileDescriptor, ...rest: unknown[]) => {
      if (String(file).includes('index.json')) throw new Error('EIO: crash')
      return (fs.writeFileSync as (...a: unknown[]) => void)(file, ...rest)
    }) as typeof fs.writeFileSync }
    const crashing = createHostReplica({ fs: failing, path, dir, now: () => clock, keyOf, hash: sha12, log: () => {} })
    const edited = { ...NEW, 'projects/Acme/notes/day-003.md': '# Day 3\nEdited.' }
    expect(crashing.sync(HOME, 'notes', entriesOf(edited), clock + 2).need).toEqual(['projects/Acme/notes/day-003.md'])
    crashing.put(HOME, 'notes', [{ k: 'projects/Acme/notes/day-003.md', body: '# Day 3\nEdited.' }])
    // The index on disk still names the old file: it is there, and reads as before the edit.
    expect(bodyFiles('notes')).toContain(keyOf('notes:acme/day-003.md'))
    expect(makeNotes().read(HOME, 'notes', 'projects/Acme/notes/day-003.md')?.body).toBe(OLD['acme/day-003.md'])
    // With the index written, the old file goes.
    const ok = makeNotes()
    ok.sync(HOME, 'notes', entriesOf(edited), clock + 3)
    ok.put(HOME, 'notes', [{ k: 'projects/Acme/notes/day-003.md', body: '# Day 3\nEdited.' }])
    expect(bodyFiles('notes')).not.toContain(keyOf('notes:acme/day-003.md'))
    expect(makeNotes().read(HOME, 'notes', 'projects/Acme/notes/day-003.md')?.body).toBe('# Day 3\nEdited.')
  })

  it('every pair the guard let through is moved: the rows it did not count as removed are never deleted', () => {
    const r = makeNotes()
    fillNotes(r)
    // A body file already missing on disk (lost before this round) does not turn a move into a removal.
    fs.rmSync(path.join(dir, keyOf(HOME), 'notes', 'f', keyOf('notes:acme/day-050.md')))
    const res = r.sync(HOME, 'notes', entriesOf(NEW), clock + 1, undefined, undefined, { renamed: pairs() })
    expect(res).toMatchObject({ moved: 300, removed: 0 })
    expect(r.status(HOME).notes.entries).toBe(300)
    expect(bodyFiles('notes')).toHaveLength(299)
  })

  it('a new body for a moved row takes its own file and the old one goes', () => {
    const r = makeNotes()
    fillNotes(r)
    r.sync(HOME, 'notes', entriesOf(NEW), clock + 1, undefined, undefined, { renamed: pairs() })
    const edited = { ...NEW, 'projects/Acme/notes/day-002.md': '# Day 2\nEdited.' }
    const { need } = r.sync(HOME, 'notes', entriesOf(edited), clock + 2)
    expect(need).toEqual(['projects/Acme/notes/day-002.md'])
    r.put(HOME, 'notes', [{ k: 'projects/Acme/notes/day-002.md', body: '# Day 2\nEdited.' }])
    const files = bodyFiles('notes')
    expect(files).toContain(keyOf('notes:projects/Acme/notes/day-002.md'))
    expect(files).not.toContain(keyOf('notes:acme/day-002.md'))
    expect(files).toHaveLength(300)
    expect(makeNotes().read(HOME, 'notes', 'projects/Acme/notes/day-002.md')?.body).toBe('# Day 2\nEdited.')
  })

  it('a moved note whose body changed keeps the old body until the new one arrives', () => {
    const r = makeNotes()
    fillNotes(r)
    const changed = { ...NEW, 'projects/Acme/notes/day-001.md': '# Day 1\nEdited after the move.' }
    const res = r.sync(HOME, 'notes', entriesOf(changed), clock + 1, undefined, undefined, { renamed: pairs() })
    expect(res.need).toEqual(['projects/Acme/notes/day-001.md'])
    expect(r.read(HOME, 'notes', 'projects/Acme/notes/day-001.md')?.body).toBe('# Day 1\nShipped build 1.')
  })

  it('takes only sound pairs: old held and not named, new named and not held, each key once', () => {
    const r = makeNotes()
    fillNotes(r)
    const keep = { ...NEW, 'acme/day-000.md': OLD['acme/day-000.md'] }
    const res = r.sync(HOME, 'notes', entriesOf(keep), clock + 1, undefined, undefined, {
      renamed: [
        ['acme/day-000.md', 'projects/Acme/notes/day-000.md'], // old still named: not a move
        ['acme/day-001.md', 'projects/Acme/notes/day-001.md'],
        ['acme/day-002.md', 'projects/Acme/notes/day-001.md'], // a second old onto one new: refused
        ['nowhere/x.md', 'projects/Acme/notes/day-003.md'], // old not held
        ['acme/day-004.md', 'not/in/the/manifest.md'], // new not named
        'junk', ['acme/day-005.md'], [5, 6],
        ...pairs().slice(6),
      ],
    })
    // 1 + 294 moved; the rest are fetched as before.
    expect(res.moved).toBe(295)
    expect(res.need.sort()).toEqual(['projects/Acme/notes/day-000.md', 'projects/Acme/notes/day-002.md', 'projects/Acme/notes/day-003.md', 'projects/Acme/notes/day-004.md', 'projects/Acme/notes/day-005.md'])
    expect(r.read(HOME, 'notes', 'acme/day-000.md')?.body).toBe(OLD['acme/day-000.md'])
  })

  it('the guard still counts what is really gone: moves of a few and removal of most is refused', () => {
    const r = makeNotes()
    fillNotes(r)
    const few = Object.fromEntries(Object.entries(NEW).slice(0, 100))
    expect(() => r.sync(HOME, 'notes', entriesOf(few), clock + 1, undefined, undefined, { renamed: pairs() })).toThrow(/would remove 200 of 300/)
    expect(r.status(HOME).notes.entries).toBe(300)
    expect(r.read(HOME, 'notes', 'acme/day-150.md')?.body).toBe(OLD['acme/day-150.md'])
  })

  it('a changes-only manifest carries its moves too', () => {
    const r = makeNotes()
    const { need } = r.sync(HOME, 'notes', entriesOf(OLD), clock, undefined, undefined, { manifestId: 'aaaaaaaaaaaa' })
    r.put(HOME, 'notes', need.map((k) => ({ k, body: OLD[k] })))
    const ref = { manifestId: 'bbbbbbbbbbbb', base: 'aaaaaaaaaaaa', changed: entriesOf(NEW), removed: Object.keys(OLD) }
    expect(() => r.sync(HOME, 'notes', undefined, clock + 1, undefined, undefined, ref)).toThrow(/manifest_removes_most_rows/)
    expect(r.sync(HOME, 'notes', undefined, clock + 1, undefined, undefined, { ...ref, renamed: pairs() })).toMatchObject({ need: [], moved: 300, removed: 0 })
  })

  it('a key an away write holds is never moved', () => {
    const r = makeNotes()
    fillNotes(r)
    r.setJournalView({ overlay: () => null, held: () => new Set(['acme/day-010.md']) })
    const res = r.sync(HOME, 'notes', entriesOf(NEW), clock + 1, undefined, undefined, { renamed: pairs() })
    expect(res.moved).toBe(299)
    expect(res.need).toEqual(['projects/Acme/notes/day-010.md'])
    expect(r.read(HOME, 'notes', 'acme/day-010.md')?.body).toBe(OLD['acme/day-010.md'])
  })
})

describe('the pictures copy takes moves', () => {
  const sha = (b: Buffer) => crypto.createHash('sha256').update(b).digest('hex')
  const dirOf = (home: string) => path.join(dir, keyOf(home), 'attachments')
  const pic = (i: number) => Buffer.from(`png-${i}`)
  const OLDK = Array.from({ length: 220 }, (_, i) => `acme/_attachment/p${i}.png`)
  const NEWK = OLDK.map((k) => k.replace(/^acme\//, 'projects/Acme/notes/'))
  const manifest = (keys: string[]) => keys.map((k, i) => ({ k, h: sha(pic(i)), n: pic(i).length }))

  it('a move of every file is refused without renamed and taken with it, the bytes kept', async () => {
    const copy = createAttachmentCopy({ fs, path, crypto, dirOf, now: () => clock, log: () => {} })
    const first = await copy.command(HOME, 'attachments.sync', { entries: manifest(OLDK), asOf: clock })
    for (const k of first.need as string[]) {
      const i = OLDK.indexOf(k)
      expect(await copy.command(HOME, 'attachments.put', { k, h: sha(pic(i)), offset: 0, data: pic(i).toString('base64') })).toMatchObject({ ok: true, stored: true })
    }
    expect(await copy.command(HOME, 'attachments.sync', { entries: manifest(NEWK), asOf: clock + 1 })).toMatchObject({ ok: false, errorKind: 'manifest_removes_most_rows' })
    const renamed = OLDK.map((k, i) => [k, NEWK[i]])
    // A pair whose new path is not a path the copy may name is left out.
    renamed.push(['acme/_attachment/p0.png', '../escape.png'])
    const res = await copy.command(HOME, 'attachments.sync', { entries: manifest(NEWK), asOf: clock + 1, renamed })
    expect(res).toMatchObject({ ok: true, need: [], removed: 0, moved: 220 })
    expect(copy.keys(HOME)).toEqual([...NEWK].sort())
    expect(await copy.readFile(HOME, NEWK[5]!)).toEqual(pic(5))
    expect(fs.readdirSync(path.join(dirOf(HOME), 'b')).length).toBe(220)
  })
})
