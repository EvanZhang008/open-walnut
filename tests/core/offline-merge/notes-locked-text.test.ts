/**
 * The Mac's drain of `note` records never writes a locked note's file made away
 * (src/core/offline-merge/notes.ts, docs/reference/locked-notes.md): a text saved on a host that
 * carries the mark is refused before any create, merge or conflict copy, and kept in the entry;
 * a note on the Mac whose envelope line an outside editor bent still keeps a change made away off it.
 * Real files in a temp vault; the blobs and the file lock are in memory.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { applyNoteRecord, sha256, type NoteDrainDeps, type NoteMode, type NoteRecordLike } from '../../../src/core/offline-merge/notes'
import { mergeVersions } from '../../../src/lib/three-way-merge'
import { withNoteId } from '../../../src/core/parse-frontmatter'
import { buildLockedNoteText } from '../../../src/core/notes/locked-note'
import type { ConflictEntry } from '../../../src/core/offline-merge/conflict-log'

const T0 = Date.parse('2026-11-20T10:00:00.000Z')
const envelope = { key: 'item-away', iv: 'AAAAAAAAAAAAAAAA', ct: 'YXdheWNpcGhlcnRleHQ=' }
const LOCKED = buildLockedNoteText({ id: 'n-1', envelope })

let tmp = ''
let root = ''
let blobs = new Map<string, Buffer>()
let letters: ConflictEntry[] = []
let written: string[] = []
let seq = 0

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'locked-away-'))
  root = path.join(tmp, 'notes')
  fs.mkdirSync(root, { recursive: true })
  blobs = new Map(); letters = []; written = []; seq = 0
})
afterEach(() => { fs.rmSync(tmp, { recursive: true, force: true }) })

function deps(): NoteDrainDeps {
  return {
    root, cacheDir: path.join(tmp, 'cache'), hostLabel: 'marina', hostKey: 'marina',
    fetchBlob: async (sha) => blobs.get(sha) ?? Promise.reject(new Error(`no blob ${sha}`)),
    merge: async (base, versions, opts) => mergeVersions(base, versions, opts),
    pathOfId: () => undefined,
    lock: (_abs, fn) => fn(),
    written: (rel) => { written.push(rel) },
    remove: async (rel) => { fs.rmSync(path.join(root, rel)) },
    ensureId: (content, current) => withNoteId(content, current).content,
    stamp: () => '2026-11-20 1200',
  }
}
const hooks = { conflicts: (e: ConflictEntry[]) => { letters.push(...e) } }

function blob(text: string): string {
  const sha = sha256(text)
  blobs.set(sha, Buffer.from(text, 'utf8'))
  return sha
}
function rec(p: string, mode: NoteMode, base: string | null, ours: string | null): NoteRecordLike {
  seq++
  return {
    seq, at: 0, opId: `op-${seq}`, path: p, mode, noteId: 'n-1',
    baseHash: base === null ? null : sha256(base).slice(0, 12),
    baseBlob: base === null ? null : blob(base),
    oursBlob: ours === null ? null : blob(ours),
  }
}
const disk = (rel: string) => { try { return fs.readFileSync(path.join(root, rel), 'utf8') } catch { return null } }
const files = () => fs.readdirSync(root).sort()

const PLAIN = '---\nid: n-1\n---\nPlain text\n\none\ntwo\n'

describe('a locked note\'s file saved away', () => {
  const lockedTexts: Array<[string, string]> = [
    ['a copied locked file', LOCKED],
    ['a made-up mark', '---\nid: n-1\nwalnut_locked: 1\n---\nPlain text\n'],
    ['a bent envelope', `${LOCKED.trimEnd()} trailing\n`],
  ]

  for (const [what, ours] of lockedTexts) {
    it(`${what} is never created, merged or copied; it stays in the entry`, async () => {
      // A create of a new path, a create over the Mac's own note, and a save over a plain note.
      fs.writeFileSync(path.join(root, 'b.md'), PLAIN)
      fs.writeFileSync(path.join(root, 'c.md'), PLAIN)
      for (const [rel, mode, base] of [['a.md', 'create', null], ['b.md', 'create', null], ['c.md', 'put', PLAIN]] as const) {
        const out = await applyNoteRecord(deps(), hooks, rec(rel, mode, base, ours), T0)
        expect(out).toMatchObject({ action: 'kept', path: rel, copies: [] })
      }
      expect(disk('a.md')).toBeNull()
      expect(disk('b.md')).toBe(PLAIN)
      expect(disk('c.md')).toBe(PLAIN)
      expect(files()).toEqual(['b.md', 'c.md'])
      expect(written).toEqual([])
      expect(letters.map((e) => [e.notePath, e.why, e.kept, e.replica])).toEqual([
        ['a.md', 'locked-text', 'mac', ours], ['b.md', 'locked-text', 'mac', ours], ['c.md', 'locked-text', 'mac', ours],
      ])
    })
  }

  it('a delete made away is not a text: it drains as before', async () => {
    fs.writeFileSync(path.join(root, 'd.md'), PLAIN)
    const out = await applyNoteRecord(deps(), hooks, rec('d.md', 'delete', PLAIN, null), T0)
    expect(out.action).toBe('deleted')
  })
})

describe('a note on the Mac whose envelope line was bent', () => {
  it('a change made away is kept off it, as off any locked note', async () => {
    const bent = `${LOCKED.trimEnd()} trailing\n`
    fs.writeFileSync(path.join(root, 'e.md'), bent)
    const out = await applyNoteRecord(deps(), hooks, rec('e.md', 'put', PLAIN, `${PLAIN}three\n`), T0)
    expect(out.action).toBe('kept')
    expect(disk('e.md')).toBe(bent)
    expect(files()).toEqual(['e.md'])
    expect(letters.map((e) => e.why)).toEqual(['locked'])
  })
})
