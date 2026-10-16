/**
 * Notes on a host replica read from the daemon's copy (src/replica/notes-source.ts,
 * WP6). High fidelity: the copy is the REAL host-replica core in a temp dir,
 * answered through the REAL follower-reads gate (the daemon twins inline both),
 * so every read takes the path a follower frame takes; only the WebSocket
 * between them is left out. The tree is compared with the leader's own disk
 * walk (core/notes-tree.ts scanTree) over the same notes written to a vault.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createHostReplica } from '../../src/providers/host-replica-core.js'
import { createFollowerReads } from '../../src/providers/follower-reads-core.js'
import { createCopyNotesSource, noteKey, treeFromKeys, type NotesCopyReader } from '../../src/replica/notes-source.js'
import { scanTree } from '../../src/core/notes-tree.js'

const HOME = '/fixture/marina-home'
const OTHER = '/fixture/acme-home'
const sha12 = (s: string) => crypto.createHash('sha256').update(s).digest('hex').slice(0, 12)

let dir = ''
let clock = 1_000_000

/** The daemon's side: a host copy, and the gate a follower frame passes. */
function makeDaemon() {
  const replica = createHostReplica({
    fs, path, dir: path.join(dir, 'copy'), now: () => clock,
    keyOf: (v) => crypto.createHash('sha1').update(v).digest('hex').slice(0, 16), hash: sha12, log: () => {},
  })
  const gate = createFollowerReads({
    path, homeDir: '/nonexistent', realpath: () => null, sliceOwner: () => undefined, journalOwner: () => undefined,
    liveSessions: () => [], journalSize: () => -1, readJournal: () => '', replica, log: () => {},
  })
  const calls: Array<{ cmd: string; keys?: number }> = []
  /** What the follower of `home` hears for one frame. */
  const ask = (home: string, frame: Record<string, unknown>): Record<string, unknown> => {
    calls.push({ cmd: String(frame.cmd), ...(Array.isArray(frame.keys) ? { keys: frame.keys.length } : {}) })
    const d = gate.gate(home, { ...frame })
    if ('answer' in d) return { ok: true, ...d.answer }
    if ('refuse' in d) return { ok: false, error: d.refuse, errorKind: 'not_found' }
    if ('error' in d) return { ok: false, error: d.error }
    return { ok: false, error: 'passed to a handler' }
  }
  const push = (home: string, notes: Record<string, string>, meta: Record<string, Record<string, unknown>> = {}) => {
    clock += 1000
    const entries = Object.entries(notes).map(([k, body]) => ({ k, h: sha12(body), n: Buffer.byteLength(body), m: { title: path.posix.basename(k, '.md'), updatedAt: new Date(clock).toISOString(), ...meta[k] } }))
    const { need } = replica.sync(home, 'notes', entries, clock)
    replica.put(home, 'notes', need.map((k) => ({ k, body: notes[k]! })))
  }
  return { replica, ask, push, calls }
}

/** The replica's side: NotesCopyReader over the follower frames of `home`. */
function readerFor(d: ReturnType<typeof makeDaemon>, home: string, maxBytes?: number): NotesCopyReader {
  const fail = (r: Record<string, unknown>) => { if (r.ok !== true && r.errorKind !== 'not_found') throw new Error(String(r.error)) }
  return {
    async list() { const r = d.ask(home, { cmd: 'replica.list', kind: 'notes' }); fail(r); return r as never },
    async read(key) { const r = d.ask(home, { cmd: 'replica.read', kind: 'notes', key }); fail(r); return r.ok ? (r as never) : null },
    async readMany(keys) {
      if (maxBytes === undefined) { const r = d.ask(home, { cmd: 'replica.readMany', kind: 'notes', keys }); fail(r); return r as never }
      // The same core with a small budget: how a 13 MB vault arrives in 4 MB answers.
      d.calls.push({ cmd: 'replica.readMany', keys: keys.length })
      return d.replica.readMany(home, 'notes', keys, maxBytes) as never
    },
  }
}

beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wns-')); clock = 1_000_000 })
afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }) })

/** Unicode in paths and bodies as escapes (the repo keeps sources ASCII). */
const UNI = 'Journal/\u00e9t\u00e9 \u6e2c\u8a66.md'
const NOTES: Record<string, string> = {
  'Alpha.md': '---\nid: n_alpha1\ntags: [plan, Release Day]\n---\n# Alpha\n\nSee [[Beta]] and [[Projects/Gamma|the gamma note]]. #ideas\n\n```\n#not-a-tag\n```\n',
  'Beta.md': '# Beta\r\nBack to [[Alpha]] #ideas.\r\n',
  'Projects/Gamma.md': '# Gamma\n[[Beta]] again, and [[Twin]] named twice.\n',
  'Projects/Twin.md': '# Twin A\n',
  'Archive/Twin.md': '# Twin B\n',
  [UNI]: '# \u00c9t\u00e9\n\nCaf\u00e9 \u2603 \u{1F330} [[Alpha]]\n',
  'zeta/b.md': 'b\n',
  'Zeta2/a.md': 'a\n',
  'Archive/Old/deep.md': 'deep\n',
}

describe('the tree', () => {
  it('is byte for byte the leader\'s disk tree for the same notes (order, folders first, Unicode names)', async () => {
    const vault = path.join(dir, 'vault')
    for (const [k, body] of Object.entries(NOTES)) {
      fs.mkdirSync(path.join(vault, path.dirname(k)), { recursive: true })
      fs.writeFileSync(path.join(vault, k), body)
    }
    // The Mac never sends a hidden folder; its disk tree skips it too.
    fs.mkdirSync(path.join(vault, '.obsidian'), { recursive: true })
    fs.writeFileSync(path.join(vault, '.obsidian', 'x.md'), 'hidden')
    const d = makeDaemon()
    d.push(HOME, NOTES)
    const src = createCopyNotesSource(readerFor(d, HOME))
    const disk = JSON.stringify({ tree: await scanTree(vault, '') })
    const copy = await src.tree()
    expect(copy.json).toBe(disk)
    expect(copy.notes).toBe(Object.keys(NOTES).length)
    expect(treeFromKeys(['.git/x.md', 'a/~$lock.md', 'ok.md']).map((n) => n.path)).toEqual(['ok.md'])
  })

  it('another Walnut\'s copy on the same host is never in it', async () => {
    const d = makeDaemon()
    d.push(HOME, { 'Mine.md': 'm' })
    d.push(OTHER, { 'Theirs.md': 't' })
    const t = JSON.parse((await createCopyNotesSource(readerFor(d, HOME)).tree()).json)
    expect(t.tree.map((n: { path: string }) => n.path)).toEqual(['Mine.md'])
    expect(await createCopyNotesSource(readerFor(d, HOME)).content('Theirs')).toBeNull()
  })
})

describe('a body', () => {
  it('comes back byte for byte with its hash, id and time: Unicode, CRLF, and a 1 MB note', async () => {
    const big = '# Big\n' + 'x'.repeat(1024 * 1024 - 20) + '\n\u00e9\n'
    const d = makeDaemon()
    d.push(HOME, { ...NOTES, 'Big.md': big }, { 'Alpha.md': { id: 'n_alpha1' } })
    const src = createCopyNotesSource(readerFor(d, HOME))
    const uni = await src.content(UNI.replace(/\.md$/, ''))
    expect(uni).toMatchObject({ content: NOTES[UNI], contentHash: sha12(NOTES[UNI]!) })
    expect(uni!.updatedAt).toMatch(/^\d{4}-\d\d-\d\dT/)
    expect((await src.content('Beta.md'))!.content).toBe('# Beta\r\nBack to [[Alpha]] #ideas.\r\n')
    expect((await src.content('Alpha'))!.id).toBe('n_alpha1')
    expect((await src.content('Big'))!.content).toBe(big)
    expect(await src.content('Nope')).toBeNull()
    expect(await src.content('../Alpha')).toBeNull()
    expect(noteKey('/a/../b')).toBeNull()
    expect(noteKey('\\Projects\\Gamma')).toBe('Projects/Gamma.md')
  })
})

describe('links, backlinks, tags, list and search', () => {
  it('follow the leader indexer\'s rules: name and path links, an alias label, an ambiguous name, tags from frontmatter and text but not code', async () => {
    const d = makeDaemon()
    d.push(HOME, NOTES, { 'Alpha.md': { id: 'n_alpha1' } })
    const src = createCopyNotesSource(readerFor(d, HOME))
    const fwd = (await src.links('Alpha')).links
    expect(fwd).toEqual([
      { dstId: 'Beta.md', dstName: 'Beta', status: 'resolved', title: 'Beta', path: 'Beta.md' },
      { dstId: 'Projects/Gamma.md', dstName: 'Projects/Gamma', status: 'resolved', title: 'Gamma', path: 'Projects/Gamma.md' },
    ])
    const twin = (await src.links('Projects/Gamma')).links.find((l) => l.dstName === 'Twin')!
    expect(twin).toMatchObject({ status: 'ambiguous', dstId: null })
    const back = (await src.backlinks('Alpha')).backlinks
    expect(back.map((b) => b.path).sort()).toEqual(['Beta.md', UNI].sort())
    expect(back.find((b) => b.path === 'Beta.md')).toMatchObject({ id: 'Beta.md', title: 'Beta', name: 'Beta', status: 'resolved' })
    expect(back.find((b) => b.path === 'Beta.md')!.snippet).toContain('[[Alpha]]')
    const ambiguous = (await src.backlinks('Archive/Twin')).backlinks
    expect(ambiguous).toEqual([expect.objectContaining({ path: 'Projects/Gamma.md', status: 'ambiguous', candidates: expect.arrayContaining(['Archive/Twin.md', 'Projects/Twin.md']) })])
    expect((await src.tags()).tags).toEqual([{ tag: 'ideas', count: 2 }, { tag: 'plan', count: 1 }, { tag: 'release-day', count: 1 }])
    expect((await src.notesForTag('#Ideas')).notes.map((n) => n.path).sort()).toEqual(['Alpha.md', 'Beta.md'])
    const flat = (await src.list()).notes
    expect(flat.find((n) => n.path === 'Alpha.md')).toEqual({ id: 'n_alpha1', title: 'Alpha', path: 'Alpha.md', name: 'Alpha' })
    const hits = await src.search('gamma again', 10)
    expect(hits.degraded).toBe('offline-keyword')
    expect(hits.results[0]).toMatchObject({ path: 'Projects/Gamma.md', matchType: 'exact' })
    expect((await src.search('caf\u00e9', 10)).results.map((r) => r.path)).toEqual([UNI])
  })

  it('a new manifest invalidates the cache: the tree and the index follow it, and only the bodies that moved are read again', async () => {
    const d = makeDaemon()
    d.push(HOME, NOTES)
    let t = 0
    const src = createCopyNotesSource(readerFor(d, HOME), { now: () => t, listTtlMs: 1000 })
    const first = (await src.tree()).json
    await src.backlinks('Alpha')
    const readsBefore = d.calls.filter((c) => c.cmd === 'replica.readMany')
    expect(readsBefore.reduce((n, c) => n + (c.keys ?? 0), 0)).toBe(Object.keys(NOTES).length)
    // Warm: the tree inside the list window asks the daemon nothing.
    const lists = d.calls.filter((c) => c.cmd === 'replica.list').length
    expect((await src.tree()).json).toBe(first)
    expect(d.calls.filter((c) => c.cmd === 'replica.list').length).toBe(lists)
    // The Mac sends a new manifest: one note edited, one added.
    d.push(HOME, { ...NOTES, 'Beta.md': '# Beta\nNo link now.\n', 'New.md': '# New\n[[Alpha]]\n' })
    t += 1001
    const next = JSON.parse((await src.tree()).json)
    expect(next.tree.map((n: { path: string }) => n.path)).toContain('New.md')
    expect((await src.backlinks('Alpha')).backlinks.map((b) => b.path).sort()).toEqual(['New.md', UNI].sort())
    const again = d.calls.filter((c) => c.cmd === 'replica.readMany').slice(readsBefore.length)
    expect(again.reduce((n, c) => n + (c.keys ?? 0), 0)).toBe(2)
  })

  it('a caller with a newer manifest than the index build in flight waits for it, then gets the newer parse (WP6 fix round)', async () => {
    const h = (b: string) => crypto.createHash('sha256').update(b).digest('hex').slice(0, 12)
    let bodies: Record<string, string> = { 'Alpha.md': '# Alpha\n', 'Beta.md': '# Beta\nsee [[Alpha]]\n' }
    let release: (() => void) | null = null
    let holdNext = true
    const reader: NotesCopyReader = {
      list: async () => {
        const entries = Object.entries(bodies).map(([k, b]) => ({ k, h: h(b), n: b.length }))
        return { entries, asOf: null, manifestHash: h(entries.map((e) => e.k + e.h).join('|')) }
      },
      read: async (k) => (bodies[k] === undefined ? null : { k, h: h(bodies[k]!), body: bodies[k]! }),
      readMany: async (keys) => {
        const snap = { ...bodies }
        if (holdNext) { holdNext = false; await new Promise<void>((r) => { release = r }) }
        return { files: keys.filter((k) => snap[k] !== undefined).map((k) => ({ k, h: h(snap[k]!), body: snap[k]! })), missing: keys.filter((k) => snap[k] === undefined), more: [] }
      },
    }
    let t = 0
    const src = createCopyNotesSource(reader, { now: () => t, listTtlMs: 1000 })
    // Caller 1 starts the build for the old manifest; it is held inside readMany.
    const first = src.backlinks('Alpha')
    await new Promise((r) => setTimeout(r, 10))
    // The Mac sends a new manifest: Beta no longer links Alpha, Gamma does.
    bodies = { 'Alpha.md': '# Alpha\n', 'Beta.md': '# Beta\nno link\n', 'Gamma.md': '# Gamma\n[[Alpha]]\n' }
    t += 1001
    const second = src.backlinks('Alpha')
    await new Promise((r) => setTimeout(r, 10))
    release!()
    expect((await first).backlinks.map((b) => b.path)).toEqual(['Beta.md'])
    expect((await second).backlinks.map((b) => b.path)).toEqual(['Gamma.md'])
  })

  it('a vault larger than one answer arrives in several readMany answers', async () => {
    const d = makeDaemon()
    const notes: Record<string, string> = {}
    for (let i = 0; i < 40; i++) notes[`bulk/n${String(i).padStart(2, '0')}.md`] = `# n${i}\n${'y'.repeat(3000)} [[n${String((i + 1) % 40).padStart(2, '0')}]]\n`
    d.push(HOME, notes)
    const src = createCopyNotesSource(readerFor(d, HOME, 32 * 1024))
    expect((await src.backlinks('bulk/n05')).backlinks.map((b) => b.path)).toEqual(['bulk/n04.md'])
    expect(d.calls.filter((c) => c.cmd === 'replica.readMany').length).toBeGreaterThan(3)
  })
})
