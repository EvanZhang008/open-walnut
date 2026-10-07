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
    expect(fs.readdirSync(dir, { recursive: true }).map(String).some((f) => f.includes('notes'))).toBe(false)
    expect(r.answer(HOME, 'note_read', { path: 'Projects/Retro' }, '')).toBeNull()
    expect(r.drop(HOME, 'notes')).toEqual({ dropped: false })
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
