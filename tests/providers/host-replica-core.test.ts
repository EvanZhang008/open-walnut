/**
 * The host's read copy of notes, memory and skills (host-replica-core.ts):
 * manifest diff, hash-checked bodies, removal, and the reads answered from it.
 * Real fs in a temp dir, real sha256: the same deps the daemon twins pass.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import { createHostReplica, type ReplicaEntry } from '../../src/providers/host-replica-core.js'

const HOME = '/fixture/walnut-home'
const sha12 = (s: string) => crypto.createHash('sha256').update(s).digest('hex').slice(0, 12)

let dir = ''
let clock = 1_000_000

function make() {
  return createHostReplica({
    fs, path, dir, now: () => clock,
    keyOf: (v) => crypto.createHash('sha1').update(v).digest('hex').slice(0, 16),
    hash: sha12,
    log: () => {},
  })
}

const notes: Record<string, { body: string; m: Record<string, unknown> }> = {
  'Projects/Release plan.md': { body: '---\nid: n_rel01\n---\n# Release plan\nShip the build on Friday. The rollback is ready.', m: { title: 'Release plan', id: 'n_rel01', updatedAt: '2026-10-01T10:00:00.000Z' } },
  'Projects/Retro.md': { body: '# Retro\nThe build broke twice; the rollback worked.', m: { title: 'Retro', updatedAt: '2026-10-02T10:00:00.000Z' } },
  'health/Checkup.md': { body: '# Checkup\nBlood test on Friday.', m: { title: 'Checkup', updatedAt: '2026-10-03T10:00:00.000Z' } },
  // Unicode: a CJK title (escapes keep the source ASCII).
  'journal/\u65e5\u8bb0.md': { body: '# \u65e5\u8bb0\n\u4eca\u5929\u53d1\u5e03\u4e86 build.', m: { title: '\u65e5\u8bb0', updatedAt: '2026-10-04T10:00:00.000Z' } },
}

function manifest(src = notes): ReplicaEntry[] {
  return Object.entries(src).map(([k, v]) => ({ k, h: sha12(v.body), n: Buffer.byteLength(v.body), m: v.m }))
}

function fill(r: ReturnType<typeof make>, src = notes) {
  const { need } = r.sync(HOME, 'notes', manifest(src), clock)
  return r.put(HOME, 'notes', need.map((k) => ({ k, body: src[k].body })))
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'whr-'))
  clock = 1_000_000
})
afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }) })

describe('manifest and bodies', () => {
  it('asks for every body once, then for none; answers nothing before it has any', () => {
    const r = make()
    expect(r.answer(HOME, 'note_read', { path: 'Projects/Retro' }, '')).toBeNull()
    expect(r.ops(HOME)).toEqual([])
    const first = r.sync(HOME, 'notes', manifest(), clock)
    expect(first.need.sort()).toEqual(Object.keys(notes).sort())
    expect(r.status(HOME).notes).toMatchObject({ entries: 0, pending: 4, asOf: null })
    // A second manifest before the bodies replaces what was asked for, never adds to it.
    const again = r.sync(HOME, 'notes', manifest(), clock)
    expect(again.need).toHaveLength(4)
    expect(r.status(HOME).notes.pending).toBe(4)
    expect(r.put(HOME, 'notes', again.need.map((k) => ({ k, body: notes[k].body })))).toEqual({ stored: 4, rejected: 0, remaining: 0 })
    expect(r.status(HOME).notes).toMatchObject({ entries: 4, pending: 0, asOf: new Date(clock).toISOString() })
    expect(r.sync(HOME, 'notes', manifest(), clock + 1).need).toEqual([])
    expect(r.ops(HOME).map((o) => o.name)).toEqual(['note_read', 'note_search'])
  })

  it('stores only the body the manifest named, of the hash it named', () => {
    const r = make()
    const { need } = r.sync(HOME, 'notes', manifest(), clock)
    const res = r.put(HOME, 'notes', [
      { k: need[0], body: 'not the text the manifest hashed' },
      { k: 'Unasked.md', body: 'x' },
      { k: need[1], body: notes[need[1]].body },
    ])
    expect(res).toEqual({ stored: 1, rejected: 2, remaining: 3 })
    // Incomplete: the copy's age is not claimed until every body is in.
    expect(r.status(HOME).notes.asOf).toBeNull()
  })

  it('a changed note keeps its old text until the new one arrives, then swaps; a removed note goes', () => {
    const r = make()
    fill(r)
    clock += 60_000
    const changed = { ...notes, 'Projects/Retro.md': { body: '# Retro\nThird time lucky.', m: notes['Projects/Retro.md'].m } }
    delete (changed as Record<string, unknown>)['health/Checkup.md']
    const { need } = r.sync(HOME, 'notes', manifest(changed), clock)
    expect(need).toEqual(['Projects/Retro.md'])
    const before = r.answer(HOME, 'note_read', { path: 'Projects/Retro' }, '')
    expect(before?.ok && before.result.content).toContain('rollback worked')
    expect(r.answer(HOME, 'note_read', { path: 'health/Checkup' }, '')).toMatchObject({ ok: false, error: { code: 'not_found' } })
    r.put(HOME, 'notes', [{ k: 'Projects/Retro.md', body: changed['Projects/Retro.md'].body }])
    const after = r.answer(HOME, 'note_read', { path: 'Projects/Retro.md' }, '')
    expect(after?.ok && after.result).toMatchObject({ content: '# Retro\nThird time lucky.', contentHash: sha12('# Retro\nThird time lucky.'), as_of: new Date(clock).toISOString() })
    // The removed note's body file is gone from disk, not just from the index.
    const files = fs.readdirSync(path.join(dir), { recursive: true }).map(String)
    expect(files.filter((f) => f.includes(`${path.sep}f${path.sep}`))).toHaveLength(3)
  })

  it('a key is never a path on this host', () => {
    const r = make()
    const evil = { '../../escape.md': { body: 'nope', m: { title: 'x' } } }
    fill(r, evil)
    expect(fs.existsSync(path.join(dir, '..', '..', 'escape.md'))).toBe(false)
    for (const f of fs.readdirSync(dir, { recursive: true }).map(String)) expect(path.resolve(dir, f).startsWith(dir)).toBe(true)
  })

  it('drop removes the copy from disk and from the answers', () => {
    const r = make()
    fill(r)
    expect(r.drop(HOME, 'notes')).toEqual({ dropped: true })
    // No body and no row is left: only the mark that the user turned the notes off here.
    const left = fs.readdirSync(dir, { recursive: true }).map(String).filter((f) => f.includes('notes'))
    expect(left.filter((f) => !/notes$/.test(f) && !/notes[\\/]index\.json$/.test(f))).toEqual([])
    expect(r.status(HOME).notes).toMatchObject({ entries: 0, asOf: null, off: true })
    expect(r.isOff(HOME, 'notes')).toBe(true)
    // A read of a kind turned off is the leader's: needs_leader, never "not found".
    expect(r.answer(HOME, 'note_read', { path: 'Projects/Retro' }, '')).toMatchObject({ ok: false, error: { code: 'needs_leader', detail: { why: 'not_kept_here' } } })
    expect(r.drop(HOME, 'notes')).toEqual({ dropped: false })
    // The next manifest (notes on again) clears the mark.
    r.sync(HOME, 'notes', [], 1)
    expect(r.isOff(HOME, 'notes')).toBe(false)
  })

  it('a restarted daemon answers from what it kept', () => {
    fill(make())
    const r = make()
    const hit = r.answer(HOME, 'note_read', { id: 'n_rel01' }, 'why')
    expect(hit?.ok && hit.result).toMatchObject({ path: 'Projects/Release plan', id: 'n_rel01', offline: true })
  })

  it('refuses a bad kind, a bad manifest, and a home it was not given', () => {
    const r = make()
    expect(() => r.sync(HOME, 'inbox', [], 0)).toThrow(/unknown kind/)
    expect(() => r.sync('', 'notes', [], 0)).toThrow(/missing home/)
    expect(() => r.sync(HOME, 'notes', 'nope', 0)).toThrow(/bad entries/)
    // Malformed lines are skipped, not trusted.
    expect(r.sync(HOME, 'notes', [{ k: 'a.md', h: 'XYZ' }, { k: '', h: sha12('a') }, null], 0).need).toEqual([])
  })
})

describe('reads from the copy', () => {
  it('note_read by path (with or without .md), by id, and by title; says how old the copy is', () => {
    const r = make()
    fill(r)
    const byPath = r.answer(HOME, 'note_read', { path: 'Projects/Retro' }, 'The server is away.')
    expect(byPath).toMatchObject({ ok: true, result: { path: 'Projects/Retro', contentHash: sha12(notes['Projects/Retro.md'].body), updatedAt: '2026-10-02T10:00:00.000Z', offline: true, as_of: new Date(clock).toISOString() } })
    expect(byPath?.ok && String(byPath.result.outcome)).toContain('The server is away.')
    expect(r.answer(HOME, 'note_read', { path: '/Projects/Retro.md' }, '')?.ok).toBe(true)
    expect(r.answer(HOME, 'note_read', { path: 'n_rel01' }, '')).toMatchObject({ ok: true, result: { id: 'n_rel01' } })
    expect(r.answer(HOME, 'note_read', { path: 'release plan' }, '')).toMatchObject({ ok: true, result: { path: 'Projects/Release plan' } })
    expect(r.answer(HOME, 'note_read', { path: '\u65e5\u8bb0' }, '')).toMatchObject({ ok: true, result: { path: 'journal/\u65e5\u8bb0' } })
    expect(r.answer(HOME, 'note_read', { path: 'Nope' }, '')).toMatchObject({ ok: false, error: { code: 'not_found' } })
    expect(r.answer(HOME, 'note_read', {}, '')).toMatchObject({ ok: false, error: { code: 'bad_request' } })
  })

  it('a title two notes share asks for the path', () => {
    const r = make()
    fill(r, { 'a/Plan.md': { body: '# Plan\na', m: { title: 'Plan' } }, 'b/Plan.md': { body: '# Plan\nb', m: { title: 'Plan' } } })
    expect(r.answer(HOME, 'note_read', { path: 'Plan' }, '')).toMatchObject({ ok: false, error: { code: 'ambiguous', detail: { candidates: ['a/Plan.md', 'b/Plan.md'] } } })
    expect(r.answer(HOME, 'note_read', { path: 'b/Plan' }, '')).toMatchObject({ ok: true, result: { content: '# Plan\nb' } })
  })

  it('note_search: every word, title first, a snippet, the search exclusions, the limit', () => {
    const r = make()
    const { need } = r.sync(HOME, 'notes', manifest(), clock, { searchExclude: ['health'] })
    r.put(HOME, 'notes', need.map((k) => ({ k, body: notes[k].body })))
    const res = r.answer(HOME, 'note_search', { q: 'build rollback' }, '')
    expect(res?.ok).toBe(true)
    const rows = (res as { result: { results: Array<Record<string, unknown>>; degraded: string } }).result
    expect(rows.degraded).toBe('offline-keyword')
    expect(rows.results.map((x) => x.path)).toEqual(['Projects/Release plan', 'Projects/Retro'])
    expect(rows.results[0]).toMatchObject({ id: 'n_rel01', title: 'Release plan', matchType: 'exact' })
    expect(String(rows.results[1].snippet)).toContain('build broke')
    // "Friday" is in Checkup too, but health/ is left out of search as on the server.
    const friday = r.answer(HOME, 'note_search', { q: 'friday' }, '') as { result: { results: Array<{ path: string }> } }
    expect(friday.result.results.map((x) => x.path)).toEqual(['Projects/Release plan'])
    // No note has both words: the notes with the most of them.
    const partial = r.answer(HOME, 'note_search', { q: 'retro zebra' }, '') as { result: { results: Array<{ path: string }> } }
    expect(partial.result.results.map((x) => x.path)).toEqual(['Projects/Retro'])
    const cjk = r.answer(HOME, 'note_search', { q: '\u53d1\u5e03' }, '') as { result: { results: Array<{ path: string }> } }
    expect(cjk.result.results.map((x) => x.path)).toEqual(['journal/\u65e5\u8bb0'])
    const one = r.answer(HOME, 'note_search', { q: 'the', limit: 1 }, '') as { result: { results: unknown[] } }
    expect(one.result.results).toHaveLength(1)
    expect(r.answer(HOME, 'note_search', { q: '  ' }, '')).toMatchObject({ ok: false, error: { code: 'bad_request' } })
  })

  it('memory_read and skill_read answer the objects the server routes answer', () => {
    const r = make()
    const global = { path: 'MEMORY.md', title: 'Global Memory', category: 'global', content: '# Memory\n- deploy with the script', contentHash: sha12('# Memory'), createdAt: 'x', updatedAt: 'y' }
    const skill = { dirName: 'walnut-board', name: 'walnut-board', description: 'Keep a Board', content: '---\nname: walnut-board\n---\nbody' }
    for (const [kind, k, obj] of [['memory', 'global', global], ['skills', 'walnut-board', skill]] as const) {
      const body = JSON.stringify(obj)
      const { need } = r.sync(HOME, kind, [{ k, h: sha12(body), n: body.length }], clock)
      r.put(HOME, kind, need.map((key) => ({ k: key, body })))
    }
    expect(r.answer(HOME, 'memory_read', { doc: 'global' }, '')).toMatchObject({ ok: true, result: { memory: global, offline: true } })
    expect(r.answer(HOME, 'memory_read', { doc: 'user' }, '')).toMatchObject({ ok: false, error: { code: 'not_found' } })
    expect(r.answer(HOME, 'memory_read', { doc: 'other' }, '')).toMatchObject({ ok: false, error: { code: 'bad_request' } })
    expect(r.answer(HOME, 'skill_read', { dirName: 'walnut-board' }, '')).toMatchObject({ ok: true, result: { skill } })
    expect(r.answer(HOME, 'skill_read', { dirName: '../x' }, '')).toMatchObject({ ok: false, error: { code: 'bad_request' } })
    // Notes were never sent: their reads are not this copy's to answer.
    expect(r.answer(HOME, 'note_read', { path: 'a' }, '')).toBeNull()
    expect(r.answer(HOME, 'task_get', { id: 'x' }, '')).toBeNull()
  })

  it('copies of two Walnuts on one host never mix', () => {
    const r = make()
    fill(r)
    expect(r.answer('/other/home', 'note_read', { path: 'Projects/Retro' }, '')).toBeNull()
  })
})

describe('what the copy leaves out is the leader\'s (4f)', () => {
  const without = (k: string) => Object.fromEntries(Object.entries(notes).filter(([key]) => key !== k))
  const fillLeavingOut = (r: ReturnType<typeof make>, keepExclude: string[], tooBig: string[] = []) => {
    const src = without('Projects/Retro.md')
    const { need } = r.sync(HOME, 'notes', manifest(src), clock, { keepExclude, tooBig })
    r.put(HOME, 'notes', need.map((k) => ({ k, body: src[k].body })))
  }

  it('one note left out (no .md, any case): its reads need the leader, a plain miss is still not found', () => {
    const r = make()
    fillLeavingOut(r, ['projects/RETRO'])
    expect(r.keepsNote(HOME, 'Projects/Retro.md')).toBe(false)
    expect(r.keepsNote(HOME, 'Projects/Release plan.md')).toBe(true)
    // By its path: sure it is the leader's.
    const byPath = r.answer(HOME, 'note_read', { path: 'Projects/Retro' }, '')
    expect(byPath).toMatchObject({ ok: false, error: { code: 'needs_leader', detail: { why: 'not_kept_here' } } })
    expect(byPath?.ok === false && byPath.error.message).toMatch(/kept only on your Mac/)
    // By a title or an id the copy lacks: it may be the left-out note, so never "not found".
    expect(r.answer(HOME, 'note_read', { path: 'Retro' }, '')).toMatchObject({ ok: false, error: { code: 'needs_leader', detail: { why: 'not_kept_here' } } })
    expect(r.answer(HOME, 'note_read', { id: 'n_gone99' }, '')).toMatchObject({ ok: false, error: { code: 'needs_leader', detail: { why: 'not_kept_here' } } })
    // A path that is not left out is not on the leader either.
    expect(r.answer(HOME, 'note_read', { path: 'Projects/Nope' }, '')).toMatchObject({ ok: false, error: { code: 'not_found' } })
    // What is kept still reads.
    expect(r.answer(HOME, 'note_read', { path: 'Projects/Release plan' }, '')).toMatchObject({ ok: true })
    expect(r.list(HOME, 'notes')).toMatchObject({ keep: { exclude: ['projects/RETRO'], tooBig: [] } })
  })

  it('a search over a copy that leaves notes out says so; a full copy answers as before', () => {
    const r = make()
    fillLeavingOut(r, ['Projects/Retro.md'])
    const res = r.answer(HOME, 'note_search', { q: 'build' }, '') as { ok: true; result: Record<string, unknown> }
    expect(res.result.partial).toEqual({ why: 'not_kept_here', message: expect.stringMatching(/kept only on your Mac/) })
    expect(String(res.result.outcome)).toMatch(/kept only on your Mac/)
    // Another Walnut's copy on the same host keeps every note (the default).
    const WHOLE = '/fixture/whole-home'
    const { need } = r.sync(WHOLE, 'notes', manifest(), clock)
    r.put(WHOLE, 'notes', need.map((k) => ({ k, body: notes[k].body })))
    const plain = r.answer(WHOLE, 'note_search', { q: 'build' }, '') as { ok: true; result: Record<string, unknown> }
    expect(plain.result).not.toHaveProperty('partial')
    expect(String(plain.result.outcome)).not.toMatch(/only on your Mac/)
    expect(r.list(WHOLE, 'notes')).not.toHaveProperty('keep')
    expect(r.answer(WHOLE, 'note_read', { path: 'Nope' }, '')).toMatchObject({ ok: false, error: { code: 'not_found' } })
  })

  it('a note held back by the size cap counts as left out', () => {
    const r = make()
    fill(r)
    r.sync(HOME, 'notes', manifest(), clock, { tooBig: ['Big.md'] })
    expect(r.notesPartial(HOME)).toBe(true)
    expect(r.answer(HOME, 'note_read', { path: 'big' }, '')).toMatchObject({ ok: false, error: { code: 'needs_leader', detail: { why: 'not_kept_here' } } })
  })

  it('a kind turned off answers needs the leader and is named on the notes manifest', () => {
    const r = make()
    fill(r)
    const body = JSON.stringify({ path: 'MEMORY.md', content: 'x' })
    const { need } = r.sync(HOME, 'memory', [{ k: 'global', h: sha12(body), n: body.length }], clock)
    r.put(HOME, 'memory', need.map((k) => ({ k, body })))
    r.drop(HOME, 'memory')
    expect(r.answer(HOME, 'memory_read', { doc: 'global' }, '')).toMatchObject({ ok: false, error: { code: 'needs_leader', detail: { why: 'not_kept_here' }, message: 'Your memory is kept only on your Mac, which is not answering this host right now.' } })
    expect(r.list(HOME, 'notes')).toMatchObject({ offKinds: ['memory'] })
    expect(r.list(HOME, 'memory')).toMatchObject({ off: true, entries: [] })
  })
})

describe('the offline host answers reads from the copy', () => {
  const WORKER = 'bbbbbbbb-2222-4222-8222-222222222222'

  async function host() {
    const { createOfflineHost } = await import('../../src/providers/offline-host-core.js')
    const { createEnvelopeKit } = await import('../../src/core/peers/envelope-kit.js')
    const replica = make()
    fill(replica)
    const offlineDir = fs.mkdtempSync(path.join(dir, 'oh-'))
    const h = createOfflineHost({
      fs, path, dir: offlineDir, now: () => clock,
      randomHex: (n) => crypto.randomBytes(n).toString('hex'),
      keyOf: (v) => crypto.createHash('sha1').update(v).digest('hex').slice(0, 12),
      kit: createEnvelopeKit(), log: () => {},
      isLive: () => true, turnActive: () => false, streamOffset: () => 0,
      deliver: async () => ({ ok: true }),
      replica,
    })
    h.configure({ v: 1, home: HOME, hash: 'h1', asOf: clock, host: 'devbox', sessions: [{ sid: WORKER, taskId: 'mworker0-0002' }], tasks: [{ id: 'mworker0-0002', title: 'Worker' }], requests: [] })
    return h
  }

  it('note_read, note_search come from the copy; tools.list names them; writes still need the server', async () => {
    const h = await host()
    const read = await h.handle(HOME, WORKER, 'tools.call', { name: 'note_read', args: { path: 'Projects/Retro' } })
    expect(read).toMatchObject({ ok: true, result: { path: 'Projects/Retro', offline: true } })
    expect(read.ok && String(read.result.outcome)).toContain('is not reachable from this host')
    const list = await h.handle(HOME, WORKER, 'tools.list', {})
    expect(list.ok && (list.result.ops as Array<{ name: string }>).map((o) => o.name)).toEqual(expect.arrayContaining(['task_get', 'note_read', 'note_search']))
    expect(list.ok && (list.result.ops as Array<{ name: string }>).map((o) => o.name)).not.toContain('memory_read')
    const write = await h.handle(HOME, WORKER, 'tools.call', { name: 'note_write', args: { path: 'a', content: 'b' } })
    expect(write).toMatchObject({ ok: false, error: { code: 'hub_unreachable' } })
    // A kind this host does not keep is the server's to answer.
    expect(await h.handle(HOME, WORKER, 'tools.call', { name: 'memory_read', args: { doc: 'global' } })).toMatchObject({ ok: false, error: { code: 'hub_unreachable' } })
  })

  it('answersRead: the reads this host can answer for that Walnut, never a write', async () => {
    const h = await host()
    for (const name of ['task_get', 'task_list', 'session_list', 'request_get', 'note_read', 'note_search']) expect(h.answersRead(name, HOME)).toBe(true)
    // Memory and skills were never sent here: a server that does not answer them is still waited for.
    for (const name of ['memory_read', 'skill_read']) expect(h.answersRead(name, HOME)).toBe(false)
    // Another Walnut's notes are not in this copy.
    expect(h.answersRead('note_read', '/other/home')).toBe(false)
    for (const name of ['task_send', 'task_update', 'task_complete', 'note_write', 'board_set', 'toString', '__proto__', undefined, 7]) expect(h.answersRead(name, HOME)).toBe(false)
  })
})

describe('reads for the replica server (replica-reads-v1, WP6)', () => {
  it('list: every entry in key order with its hash and metadata, the age, and a manifest hash that moves with the copy', () => {
    const r = make()
    expect(r.list(HOME, 'notes')).toMatchObject({ entries: [], asOf: null })
    fill(r)
    const l = r.list(HOME, 'notes')!
    expect(l.entries.map((e) => e.k)).toEqual(Object.keys(notes).sort())
    expect(l.entries[0]).toMatchObject({ k: 'Projects/Release plan.md', h: sha12(notes['Projects/Release plan.md'].body), m: { title: 'Release plan', id: 'n_rel01' } })
    expect(l.asOf).toBe(new Date(clock).toISOString())
    const before = l.manifestHash
    expect(r.list(HOME, 'notes')!.manifestHash).toBe(before)
    // A body that changed: a new hash once its body arrived. A title alone moving: also new.
    clock += 1000
    fill(r, { ...notes, 'health/Checkup.md': { body: '# Checkup\nMoved to Monday.', m: notes['health/Checkup.md'].m } })
    const changed = r.list(HOME, 'notes')!.manifestHash
    expect(changed).not.toBe(before)
    clock += 1000
    fill(r, { ...notes, 'health/Checkup.md': { body: '# Checkup\nMoved to Monday.', m: { ...notes['health/Checkup.md'].m, title: 'Checkup (Mon)' } } })
    expect(r.list(HOME, 'notes')!.manifestHash).not.toBe(changed)
    expect(r.list(HOME, 'secrets')).toBeNull()
    expect(r.list('', 'notes')).toBeNull()
  })

  it('read: one body byte for byte (Unicode, CRLF), null for a key it does not hold or another Walnut\'s', () => {
    const r = make()
    const uni = { 'journal/\u00e9t\u00e9.md': { body: '# \u00c9t\u00e9\r\n\u2603 \u{1F330}\r\n', m: { title: '\u00c9t\u00e9' } } }
    fill(r, { ...notes, ...uni })
    expect(r.read(HOME, 'notes', 'journal/\u00e9t\u00e9.md')).toMatchObject({ k: 'journal/\u00e9t\u00e9.md', body: '# \u00c9t\u00e9\r\n\u2603 \u{1F330}\r\n', h: sha12(uni['journal/\u00e9t\u00e9.md'].body) })
    expect(r.read(HOME, 'notes', 'missing.md')).toBeNull()
    expect(r.read('/fixture/other-home', 'notes', 'Projects/Retro.md')).toBeNull()
    expect(r.read(HOME, 'notes', 42)).toBeNull()
  })

  it('readMany: bodies up to the byte budget, the rest in more, unknown keys in missing; the search cache does not grow', () => {
    const r = make()
    fill(r)
    const keys = Object.keys(notes)
    const all = r.readMany(HOME, 'notes', [...keys, 'gone.md'], 4 * 1024 * 1024)!
    expect(all.files.map((f) => f.k)).toEqual(keys)
    expect(all.missing).toEqual(['gone.md'])
    expect(all.more).toEqual([])
    const small = r.readMany(HOME, 'notes', keys, 100)!
    // At least one per answer, so a reader always moves forward.
    expect(small.files).toHaveLength(1)
    expect(small.more).toEqual(keys.slice(1))
    expect(r.readMany(HOME, 'notes', 'x', 100)).toBeNull()
    expect(r.readMany(HOME, 'secrets', keys, 100)).toBeNull()
  })
})

// -- WP11 (docs/plan/walnut-replica-servers-impl.md sections 4 and 6): keys an away write
// holds, the half rule and its confirmation, and the away writes read over the copy. --

describe('away notes: held keys, the half rule, the overlay', () => {
  /** A journal view: `pending` keys always held; `acked` keys held until a manifest later than their ack. */
  function view(pending: Record<string, string | null>, acked: Record<string, number> = {}) {
    return {
      overlay: () => new Map(Object.entries(pending).map(([k, body]) => [k, body === null ? null : { body, h: sha12(body), n: Buffer.byteLength(body), m: { title: 'away' } }])),
      held: (_home: string, asOf: number) => new Set([...Object.keys(pending), ...Object.keys(acked).filter((k) => asOf <= acked[k])]),
    }
  }

  it('a key a pending away write holds is neither replaced nor removed by a manifest', () => {
    const r = make()
    fill(r)
    r.setJournalView(view({ 'Projects/Retro.md': '# Retro\nEdited while away.' }))
    clock += 60_000
    const changed = { ...notes, 'Projects/Retro.md': { body: '# Retro\nThe Mac wrote this.', m: notes['Projects/Retro.md'].m } }
    const res = r.sync(HOME, 'notes', manifest(changed), clock)
    expect(res).toMatchObject({ need: [], held: 1, heldKeys: ['Projects/Retro.md'], removed: 0 })
    // A manifest without the note: still kept.
    const without = { ...notes } as Record<string, { body: string; m: Record<string, unknown> }>
    delete without['Projects/Retro.md']
    expect(r.sync(HOME, 'notes', manifest(without), clock)).toMatchObject({ held: 1, removed: 0 })
    // Every read sees the away write over the copy.
    expect(JSON.stringify(r.answer(HOME, 'note_read', { path: 'Projects/Retro' }, ''))).toContain('Edited while away.')
    expect(r.read(HOME, 'notes', 'Projects/Retro.md')).toMatchObject({ body: '# Retro\nEdited while away.' })
    expect(r.list(HOME, 'notes')!.entries.find((e) => e.k === 'Projects/Retro.md')).toMatchObject({ h: sha12('# Retro\nEdited while away.') })
    // The base the write was made on is what the copy itself still holds.
    r.setJournalView(null)
    expect(r.read(HOME, 'notes', 'Projects/Retro.md')).toMatchObject({ body: notes['Projects/Retro.md'].body })
  })

  it('a pending delete hides the note from every read, and the copy keeps it', () => {
    const r = make()
    fill(r)
    r.setJournalView(view({ 'health/Checkup.md': null }))
    expect(r.read(HOME, 'notes', 'health/Checkup.md')).toBeNull()
    expect(r.list(HOME, 'notes')!.entries.map((e) => e.k)).not.toContain('health/Checkup.md')
    expect(r.answer(HOME, 'note_read', { path: 'health/Checkup' }, '')).toMatchObject({ ok: false })
    r.setJournalView(null)
    expect(r.read(HOME, 'notes', 'health/Checkup.md')).not.toBeNull()
  })

  it('with away writes pending, every read of 3,000 notes takes the overlay once, never once per note', () => {
    // Before: each key's lookup read the overlay again and copied the whole index, so a
    // search or a readMany of N notes was O(N^2) on the daemon's loop (a second at 3,000).
    const r = make()
    const many: Record<string, { body: string; m: Record<string, unknown> }> = {}
    for (let i = 0; i < 3000; i++) {
      many[`bulk/n${String(i).padStart(4, '0')}.md`] = { body: `# Note ${i}\nplain words ${i}`, m: { title: `Note ${i}`, updatedAt: '2026-10-01T10:00:00.000Z' } }
    }
    fill(r, many)
    const edited = '# Note 7\nrewritten while away'
    const made = '# Fresh\nwritten while away'
    const ov = new Map<string, { body: string; h: string; n: number; m?: Record<string, unknown> } | null>([
      ['bulk/n0007.md', { body: edited, h: sha12(edited), n: edited.length, m: { title: 'Note 7' } }],
      ['bulk/n0008.md', null],
      ['bulk/fresh.md', { body: made, h: sha12(made), n: made.length, m: { title: 'Fresh' } }],
    ])
    let calls = 0
    r.setJournalView({ overlay: () => { calls++; return ov }, held: () => new Set(ov.keys()) })
    const counted = <T>(fn: () => T): { value: T; calls: number } => { calls = 0; const value = fn(); return { value, calls } }

    const search = counted(() => r.answer(HOME, 'note_search', { q: 'away', limit: 100 }, '') as { ok: true; result: { results: Array<{ path: string; snippet: string }> } })
    expect(search.calls).toBe(1)
    expect(search.value.result.results.map((x) => x.path)).toEqual(['bulk/fresh', 'bulk/n0007'])
    expect(search.value.result.results[1].snippet).toContain('rewritten while away')

    const keys = [...Object.keys(many), 'bulk/fresh.md']
    const bulk = counted(() => r.readMany(HOME, 'notes', keys, 64 * 1024 * 1024)!)
    expect(bulk.calls).toBe(1)
    expect(bulk.value.files).toHaveLength(3000)
    expect(bulk.value.missing).toEqual(['bulk/n0008.md'])
    expect(bulk.value.files.find((f) => f.k === 'bulk/n0007.md')).toMatchObject({ h: sha12(edited), body: edited })
    expect(bulk.value.files.find((f) => f.k === 'bulk/fresh.md')).toMatchObject({ body: made })

    const listed = counted(() => r.list(HOME, 'notes')!)
    expect(listed.calls).toBe(1)
    expect(listed.value.entries).toHaveLength(3000)
    expect(listed.value.entries.map((e) => e.k)).not.toContain('bulk/n0008.md')

    expect(counted(() => r.answer(HOME, 'note_read', { path: 'bulk/n0007' }, '')).calls).toBe(1)
    expect(counted(() => r.read(HOME, 'notes', 'bulk/fresh.md')).calls).toBe(1)
    expect(counted(() => r.answer(HOME, 'note_read', { path: 'Fresh' }, '')).value).toMatchObject({ ok: true, result: { content: made } })
    r.setJournalView(null)
  })

  it('an acked key awaits a copy made after the ack: an older manifest keeps it, a newer one replaces it', () => {
    const r = make()
    fill(r)
    const ackAt = clock + 30_000
    r.setJournalView(view({}, { 'Projects/Retro.md': ackAt }))
    const changed = { ...notes, 'Projects/Retro.md': { body: '# Retro\nMerged on the Mac.', m: notes['Projects/Retro.md'].m } }
    expect(r.sync(HOME, 'notes', manifest(changed), ackAt - 1)).toMatchObject({ need: [], held: 1 })
    expect(r.sync(HOME, 'notes', manifest(changed), ackAt + 1)).toMatchObject({ need: ['Projects/Retro.md'], held: 0 })
  })
})

describe('the half rule (section 4): a manifest that would empty most of a large copy', () => {
  const many = (n: number, from = 0) => Object.fromEntries(Array.from({ length: n }, (_, i) => [`bulk/n${from + i}.md`, { body: `# Note ${from + i}\nbody ${from + i}`, m: { title: `Note ${from + i}` } }]))
  const keysHash = (src: Record<string, unknown>) => sha12(Object.keys(src).sort().join('\n'))

  it('at 200 rows, removing more than half is refused with its sizes; the copy is left as it was', () => {
    const r = make()
    const all = many(200)
    fill(r, all)
    const kept = many(99)
    let err: (Error & { code?: string; detail?: Record<string, unknown> }) | null = null
    try { r.sync(HOME, 'notes', manifest(kept), clock + 1) } catch (e) { err = e as typeof err }
    expect(err?.code).toBe('manifest_removes_most_rows')
    expect(err?.detail).toEqual({ local: 200, removing: 101, entries: 99, keys: keysHash(kept) })
    expect(r.status(HOME).notes.entries).toBe(200)
    expect(r.read(HOME, 'notes', 'bulk/n150.md')).not.toBeNull()
    // Exactly half is not most: taken.
    expect(r.sync(HOME, 'notes', manifest(many(100)), clock + 2)).toMatchObject({ removed: 100 })
  })

  it('below the floor any manifest is taken, an empty one too', () => {
    const r = make()
    fill(r, many(199))
    expect(r.sync(HOME, 'notes', [], clock + 1)).toMatchObject({ removed: 199 })
    expect(r.status(HOME).notes.entries).toBe(0)
  })

  it('confirm:true bound to this manifest (its count and the hash of its sorted keys) takes it; bound to another, refused', () => {
    const r = make()
    fill(r, many(240))
    const kept = many(10, 500)
    const wrong = () => r.sync(HOME, 'notes', manifest(kept), clock + 1, undefined, { confirm: true, confirmFor: { entries: 10, keys: keysHash(many(10)) } })
    expect(wrong).toThrow(/manifest_removes_most_rows/)
    expect(() => r.sync(HOME, 'notes', manifest(kept), clock + 1, undefined, { confirm: true })).toThrow(/manifest_removes_most_rows/)
    expect(() => r.sync(HOME, 'notes', manifest(kept), clock + 1, undefined, { confirm: false, confirmFor: { entries: 10, keys: keysHash(kept) } })).toThrow(/manifest_removes_most_rows/)
    const ok = r.sync(HOME, 'notes', manifest(kept), clock + 1, undefined, { confirm: true, confirmFor: { entries: 10, keys: keysHash(kept) } })
    expect(ok).toMatchObject({ removed: 240, need: Object.keys(kept) })
  })

  it('what the user leaves out goes however much it is; the rest still counts (4f)', () => {
    const r = make()
    const archive = Object.fromEntries(Object.entries(many(210)).map(([k, v]) => [k.replace('bulk/', 'Archive/'), v]))
    const rest = many(10, 900)
    fill(r, { ...archive, ...rest })
    // The Archive folder left out (any case): 210 of 220 go, taken.
    expect(r.sync(HOME, 'notes', manifest(rest), clock + 1, { keepExclude: ['archive'] })).toMatchObject({ removed: 210 })
    expect(r.status(HOME).notes.entries).toBe(10)
    // A manifest that drops most of a copy for no chosen reason is still refused.
    const r2 = make()
    fill(r2, { ...archive, ...rest })
    expect(() => r2.sync(HOME, 'notes', manifest(rest), clock + 1, { keepExclude: ['elsewhere'] })).toThrow(/manifest_removes_most_rows/)
    expect(r2.status(HOME).notes.entries).toBe(220)
  })

  it('keys an away write holds count as kept, not as removed', () => {
    const r = make()
    const all = many(200)
    fill(r, all)
    // 120 of the 200 are held: the manifest of 0 removes 80, under half.
    const held = new Set(Object.keys(all).slice(0, 120))
    r.setJournalView({ overlay: () => null, held: () => held })
    expect(r.sync(HOME, 'notes', [], clock + 1)).toMatchObject({ removed: 80, held: 120 })
    expect(r.status(HOME).notes.entries).toBe(120)
  })
})
