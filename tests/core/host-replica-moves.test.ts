/**
 * The leader's side of moves in a host's copy (core/host-replica.ts, attachment-replica.ts,
 * replication/manifest-moves.ts), against the REAL daemon cores behind an in-process
 * transport. The one tree (notes_unified) moves every note at once: a host whose daemon takes
 * moves ('host-replica-moves-v1') gets `renamed` and keeps its copy without a refusal or a
 * re-upload; a host without it gets no `renamed` and refuses as before (the half rule). In the
 * one tree the notes walk leaves Walnut's own memory and skills out (their own kinds).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import { createMockConstants } from '../helpers/mock-constants.js'

vi.mock('../../src/constants.js', () => createMockConstants('walnut-host-replica-moves'))
vi.mock('../../src/core/skill-store.js', () => ({ listAllSkills: async () => [] }))
const cfg = vi.hoisted(() => ({ value: {} as Record<string, unknown> }))
vi.mock('../../src/core/config-manager.js', () => ({ getConfig: async () => cfg.value }))

import { NOTES_DIR, MEMORY_FILE, WALNUT_HOME } from '../../src/constants.js'
import { forgetHostReplica, noteEntries, syncHostReplica, sha12, _resetHostReplicaForTesting, _hostReplicaSavedForTesting, type ReplicaTarget } from '../../src/core/host-replica.js'
import { _resetAttachmentReplicaForTesting } from '../../src/core/attachment-replica.js'
import { createHostReplica } from '../../src/providers/host-replica-core.js'
import { createAttachmentCopy } from '../../src/providers/attachment-copy-core.js'
import { _resetReplicaStatusForTesting, needsConfirm, peekKindState } from '../../src/core/replication/replica-status.js'
import { setNoteMoves } from '../../src/core/notes/note-path-moves.js'
import type { MoveMap } from '../../src/core/artifacts/unify/map.js'
import { log } from '../../src/logging/index.js'
import { _resetRoundOutagesForTesting } from '../../src/core/replication/round-outage.js'

const COUNT = 300
const MAP: MoveMap = { exact: {}, rules: [{ from: 'acme/', to: 'projects/Acme/notes/' }, { from: '', to: 'notes/' }] }

function write(rel: string, body: string | Buffer): void {
  const abs = path.join(NOTES_DIR, rel)
  fs.mkdirSync(path.dirname(abs), { recursive: true })
  fs.writeFileSync(abs, body)
}

let tmp = ''
let calls: Array<{ cmd: string; params: Record<string, unknown> }> = []

/** A daemon: the real cores, answered as cmdReplica / cmdAttachments answer. */
function host(hostKey: string, opts: { moves: boolean; attachments?: boolean }) {
  const dir = path.join(tmp, hostKey)
  const replica = createHostReplica({
    fs, path, dir, now: () => Date.now(),
    keyOf: (v) => crypto.createHash('sha1').update(v).digest('hex').slice(0, 16), hash: sha12, log: () => {},
  })
  const pics = createAttachmentCopy({ fs, path, crypto, dirOf: () => path.join(dir, 'pics'), log: () => {} })
  const target: ReplicaTarget = {
    hostKey, moves: opts.moves, attachments: opts.attachments,
    send: async (cmd, params) => {
      calls.push({ cmd, params })
      if (cmd.startsWith('attachments.')) return pics.command(params.home as string, cmd, params)
      try {
        const home = params.home as string
        if (cmd === 'replica.sync') return { ok: true, ...replica.sync(home, params.kind, params.entries, params.asOf, params.opts as Record<string, unknown> | undefined, { confirm: params.confirm, confirmFor: params.confirmFor }, params) }
        if (cmd === 'replica.put') return { ok: true, ...replica.put(home, params.kind, params.files) }
        if (cmd === 'replica.drop') return { ok: true, ...replica.drop(home, params.kind) }
        return { ok: false, error: `unknown command: ${cmd}` }
      } catch (err) {
        const e = err as Error & { code?: unknown; detail?: unknown }
        return { ok: false, error: e.message, ...(typeof e.code === 'string' ? { errorKind: e.code, detail: e.detail } : {}) }
      }
    },
  }
  return { target, replica, pics }
}

const noteSyncs = () => calls.filter((c) => c.cmd === 'replica.sync' && c.params.kind === 'notes').map((c) => c.params)
const notePuts = () => calls.filter((c) => c.cmd === 'replica.put' && c.params.kind === 'notes')

/** The one tree's move, as boot does it: the files move, then the process takes the record's map and pairs. */
function moveIntoTree(): void {
  const pairs: Array<[string, string]> = []
  // The record names every file the move made (migrate-unified.ts), the pictures too.
  for (const name of fs.readdirSync(path.join(NOTES_DIR, 'acme'), { recursive: true }) as string[]) {
    if (fs.statSync(path.join(NOTES_DIR, 'acme', name)).isFile()) pairs.push([`acme/${name}`, `projects/Acme/notes/${name}`])
  }
  pairs.push(['family/a.md', 'notes/family/a.md'])
  fs.mkdirSync(path.join(NOTES_DIR, 'projects/Acme'), { recursive: true })
  fs.renameSync(path.join(NOTES_DIR, 'acme'), path.join(NOTES_DIR, 'projects/Acme/notes'))
  fs.mkdirSync(path.join(NOTES_DIR, 'notes'), { recursive: true })
  fs.renameSync(path.join(NOTES_DIR, 'family'), path.join(NOTES_DIR, 'notes/family'))
  // Walnut's own files in the tree: their own kinds, never notes.
  write('memory/task-1/MEMORY.md', '# Task memory')
  write('projects/Acme/memory/task-2/MEMORY.md', '# Task memory 2')
  write('skills/acme-tool/SKILL.md', '# Skill')
  write('projects/Acme/skills/acme-tool/SKILL.md', '# Project skill')
  setNoteMoves(MAP, pairs)
}

beforeEach(async () => {
  await _hostReplicaSavedForTesting()
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'whrm-'))
  fs.rmSync(NOTES_DIR, { recursive: true, force: true })
  fs.mkdirSync(path.dirname(MEMORY_FILE), { recursive: true })
  fs.writeFileSync(MEMORY_FILE, '# Memory\n')
  for (let i = 0; i < COUNT; i++) write(`acme/day-${String(i).padStart(3, '0')}.md`, `# Day ${i}\nShipped build ${i}.`)
  write('acme/_attachment/logo.png', Buffer.from('png-logo'))
  for (let i = 0; i < 210; i++) write(`acme/pics/p${i}.png`, Buffer.from(`png-${i}`))
  write('family/a.md', '---\nid: n_fam01\n---\n# Family')
  calls = []
  cfg.value = {}
  _resetReplicaStatusForTesting()
  setNoteMoves(null)
  _resetHostReplicaForTesting()
  _resetAttachmentReplicaForTesting()
  _resetRoundOutagesForTesting()
  fs.rmSync(path.join(WALNUT_HOME, 'cache', 'host-replica'), { recursive: true, force: true })
})
afterEach(() => {
  setNoteMoves(null)
  fs.rmSync(tmp, { recursive: true, force: true })
})

describe('a host that takes moves', () => {
  it('keeps its copy through the move: renamed rides the changes, the host accepts, no body goes again', async () => {
    const h = host('devbox', { moves: true })
    expect((await syncHostReplica(h.target))[0]).toMatchObject({ kind: 'notes', action: 'synced', entries: COUNT + 1 })
    calls = []
    moveIntoTree()
    const [notes] = await syncHostReplica(h.target)
    expect(notes).toMatchObject({ kind: 'notes', action: 'synced', entries: COUNT + 1, sent: 0, moved: COUNT + 1 })
    const [sync] = noteSyncs()
    expect(sync.entries).toBeUndefined()
    expect((sync.renamed as unknown[]).length).toBe(COUNT + 1)
    expect(sync.renamed).toContainEqual(['acme/day-042.md', 'projects/Acme/notes/day-042.md'])
    expect(notePuts()).toEqual([])
    expect(h.replica.answer(WALNUT_HOME, 'note_read', { path: 'projects/Acme/notes/day-042' }, '')).toMatchObject({ ok: true, result: { content: '# Day 42\nShipped build 42.' } })
    expect(h.replica.answer(WALNUT_HOME, 'note_read', { id: 'n_fam01' }, '')).toMatchObject({ ok: true, result: { path: 'notes/family/a' } })
    // The next round has nothing to say.
    calls = []
    expect((await syncHostReplica(h.target))[0]).toMatchObject({ kind: 'notes', action: 'unchanged' })
  })

  it('a host that took a manifest from after the move gets no record pairs with a later whole list', async () => {
    const h = host('devbox', { moves: true })
    await syncHostReplica(h.target)
    moveIntoTree()
    expect((await syncHostReplica(h.target))[0]).toMatchObject({ action: 'synced', moved: COUNT + 1 })
    // The host's daemon restarts (it forgets the base); a note changes: the changes go, the host
    // does not know their base, and the whole list follows, without the move's pairs.
    const again = host('devbox', { moves: true })
    calls = []
    write('projects/Acme/notes/day-001.md', '# Day 1\nEdited.')
    const [notes] = await syncHostReplica(again.target)
    expect(notes).toMatchObject({ action: 'synced', sent: 1 })
    const syncs = noteSyncs()
    expect(syncs.map((p) => (p.entries ? 'whole' : 'changes'))).toEqual(['changes', 'whole'])
    expect(syncs.every((p) => p.renamed === undefined)).toBe(true)
  })

  it('a host whose base this server no longer knows gets the whole list with the record\'s moves', async () => {
    const h = host('devbox', { moves: true })
    await syncHostReplica(h.target)
    // The leader restarts with nothing kept (its cache gone), the host keeps its copy.
    _resetHostReplicaForTesting()
    await _hostReplicaSavedForTesting()
    fs.rmSync(path.join(WALNUT_HOME, 'cache', 'host-replica'), { recursive: true, force: true })
    calls = []
    moveIntoTree()
    const [notes] = await syncHostReplica(h.target)
    expect(notes).toMatchObject({ action: 'synced', sent: 0, moved: COUNT + 1 })
    expect(noteSyncs()[0].entries).toHaveLength(COUNT + 1)
  })

  it('the pictures move with the record\'s pairs and are not sent again', async () => {
    const h = host('devbox', { moves: true, attachments: true })
    await syncHostReplica(h.target)
    expect(h.pics.keys(WALNUT_HOME)).toHaveLength(211)
    calls = []
    moveIntoTree()
    await syncHostReplica(h.target)
    const picSync = calls.find((c) => c.cmd === 'attachments.sync')!
    expect((picSync.params.renamed as unknown[]).length).toBe(211)
    expect(calls.filter((c) => c.cmd === 'attachments.put')).toEqual([])
    expect(h.pics.keys(WALNUT_HOME)).toContain('projects/Acme/notes/pics/p7.png')
    expect(h.pics.keys(WALNUT_HOME)).not.toContain('acme/pics/p7.png')
  })
})

describe('a host without the capability', () => {
  it('gets no renamed and refuses the move as before: the half rule is unchanged', async () => {
    const h = host('oldbox', { moves: false, attachments: true })
    await syncHostReplica(h.target)
    calls = []
    moveIntoTree()
    const [notes] = await syncHostReplica(h.target)
    expect(notes).toMatchObject({ kind: 'notes', action: 'failed' })
    expect(notes.error).toMatch(/manifest_removes_most_rows/)
    expect(noteSyncs().every((p) => p.renamed === undefined)).toBe(true)
    const picSync = calls.find((c) => c.cmd === 'attachments.sync')!
    expect(picSync.params.renamed).toBeUndefined()
    // The copy as it was.
    expect(h.replica.answer(WALNUT_HOME, 'note_read', { path: 'acme/day-042' }, '')).toMatchObject({ ok: true })
  })

  it('stops sending a manifest it refused three times until something could change the answer', async () => {
    const h = host('oldbox', { moves: false, attachments: true })
    await syncHostReplica(h.target)
    moveIntoTree()
    const picSyncs = () => calls.filter((c) => c.cmd === 'attachments.sync')
    const refuseThrice = async (t: ReplicaTarget) => {
      calls = []
      for (let i = 0; i < 3; i++) expect((await syncHostReplica(t))[0]).toMatchObject({ action: 'failed' })
      expect(noteSyncs().length).toBeGreaterThanOrEqual(3)
      expect(picSyncs()).toHaveLength(3)
    }
    const quiet = async (t: ReplicaTarget) => {
      calls = []
      for (let i = 0; i < 3; i++) expect((await syncHostReplica(t))[0]).toMatchObject({ kind: 'notes', action: 'unchanged' })
      expect(noteSyncs()).toEqual([])
      expect(picSyncs()).toEqual([])
    }
    await refuseThrice(h.target)
    // Refused as it is three times: the same manifest is not sent again, and nothing warns.
    await quiet(h.target)
    // Settings still offers the confirm the three refusals earned.
    const st = peekKindState('host:oldbox', 'host-notes')!
    expect(st.refusals).toBe(3)
    expect(needsConfirm(st)).toBe(true)

    // The host's connection, build or box changed: the held manifest goes once more, and its
    // refusal holds it again at once (the count stays).
    forgetHostReplica('oldbox')
    calls = []
    expect((await syncHostReplica(h.target))[0]).toMatchObject({ action: 'failed' })
    expect(noteSyncs().length).toBeGreaterThan(0)
    expect(picSyncs()).toHaveLength(1)
    await quiet(h.target)

    // The host's daemon updates and takes moves, the keys unchanged: the move goes as moves.
    const updated = { ...h.target, moves: true }
    calls = []
    expect((await syncHostReplica(updated))[0]).toMatchObject({ kind: 'notes', action: 'synced', moved: COUNT + 1 })
    expect(picSyncs()).toHaveLength(1)
    expect(picSyncs()[0]!.params.renamed).toBeDefined()
    expect(h.replica.answer(WALNUT_HOME, 'note_read', { path: 'projects/Acme/notes/day-042' }, '')).toMatchObject({ ok: true })
  })

  it('a refusal that stands while notes keep changing warns once, not every round (2026-11-20 spike)', async () => {
    // The companion's build could not take moves: each note written after the move made a new
    // manifest, the refusal streak restarted, and every round wrote two warns.
    const h = host('oldbox', { moves: false, attachments: true })
    await syncHostReplica(h.target)
    moveIntoTree()
    const warns: string[] = []
    const infos: string[] = []
    const w = vi.spyOn(log.session, 'warn').mockImplementation((m: string) => { warns.push(m) })
    const i = vi.spyOn(log.session, 'info').mockImplementation((m: string) => { infos.push(m) })
    try {
      for (let n = 0; n < 8; n++) {
        write(`notes/new-${n}.md`, `# New ${n}`)
        expect((await syncHostReplica(h.target))[0]).toMatchObject({ kind: 'notes', action: 'failed' })
      }
    } finally {
      w.mockRestore()
      i.mockRestore()
    }
    // The notes refusal starts once; the pictures' manifest holds still, so it is held after three.
    expect(warns.filter((m) => m === 'host replica: the host refused a manifest that removes most of its copy')).toHaveLength(1)
    expect(warns.filter((m) => /round failed/.test(m))).toEqual([])
    // The pictures' refusal: a warn when it starts and when it is held, nothing between or after.
    expect(warns.filter((m) => m === 'host replica: the host refused a picture list that removes most of its copy')).toHaveLength(2)
    expect(infos.filter((m) => m === 'host replica: a target refused a manifest that removes most of its copy, its rounds keep it until that changes')).toHaveLength(1)
    expect(infos.filter((m) => m === 'host replica attachments: a target refused a manifest that removes most of its copy, its rounds keep it until that changes')).toHaveLength(1)
    // Settings still shows the refusal; the copy is as it was.
    expect(peekKindState('host:oldbox', 'host-notes')?.lastRefusal).toMatchObject({ error: 'manifest_removes_most_rows' })
    expect(h.replica.answer(WALNUT_HOME, 'note_read', { path: 'acme/day-042' }, '')).toMatchObject({ ok: true })
    // The host updates and takes the move: the refusal ends with one line.
    const ended: string[] = []
    const i2 = vi.spyOn(log.session, 'info').mockImplementation((m: string) => { ended.push(m) })
    try {
      expect((await syncHostReplica({ ...h.target, moves: true }))[0]).toMatchObject({ kind: 'notes', action: 'synced' })
    } finally {
      i2.mockRestore()
    }
    expect(ended).toContain('host replica: a target took a manifest it had refused')
  })

  it('a refusal undone before the host updates is over: the next one warns again', async () => {
    const h = host('oldbox', { moves: false })
    await syncHostReplica(h.target)
    moveIntoTree()
    expect((await syncHostReplica(h.target))[0]).toMatchObject({ kind: 'notes', action: 'failed' })
    expect(peekKindState('host:oldbox', 'host-notes')?.lastRefusal).toBeDefined()
    // The move is undone: the list is again the one the host took, so nothing goes and nothing stands.
    fs.renameSync(path.join(NOTES_DIR, 'projects/Acme/notes'), path.join(NOTES_DIR, 'acme'))
    fs.renameSync(path.join(NOTES_DIR, 'notes/family'), path.join(NOTES_DIR, 'family'))
    for (const d of ['projects', 'notes', 'memory', 'skills']) fs.rmSync(path.join(NOTES_DIR, d), { recursive: true, force: true })
    setNoteMoves(null)
    expect((await syncHostReplica(h.target))[0]).toMatchObject({ kind: 'notes', action: 'unchanged' })
    expect(peekKindState('host:oldbox', 'host-notes')?.lastRefusal).toBeUndefined()
    // The move again: a new refusal, and news again.
    moveIntoTree()
    const warns: string[] = []
    const w = vi.spyOn(log.session, 'warn').mockImplementation((m: string) => { warns.push(m) })
    try {
      expect((await syncHostReplica(h.target))[0]).toMatchObject({ kind: 'notes', action: 'failed' })
    } finally {
      w.mockRestore()
    }
    expect(warns).toContain('host replica: the host refused a manifest that removes most of its copy')
  })

  it('a refused manifest goes again when the user leaves the old folder out, the keys unchanged', async () => {
    const h = host('oldbox', { moves: false, attachments: true })
    await syncHostReplica(h.target)
    moveIntoTree()
    calls = []
    for (let i = 0; i < 4; i++) await syncHostReplica(h.target)
    expect(noteSyncs().length).toBeGreaterThanOrEqual(3)
    // The user excludes the folder the copy still holds under its old name.
    cfg.value = { hosts: { oldbox: { keep: { notes_exclude: ['acme'] } } } }
    calls = []
    expect((await syncHostReplica(h.target))[0]).toMatchObject({ kind: 'notes', action: 'synced' })
  })
})

describe('the notes walk in the one tree', () => {
  it('leaves Walnut\'s own memory and skills out; before the tree, a folder of that name is the user\'s', async () => {
    write('memory/my-notes.md', '# Mine')
    expect((await noteEntries([])).map((e) => e.k)).toContain('memory/my-notes.md')
    fs.rmSync(path.join(NOTES_DIR, 'memory'), { recursive: true })
    moveIntoTree()
    const keys = (await noteEntries([])).map((e) => e.k)
    expect(keys).toHaveLength(COUNT + 1)
    expect(keys.filter((k) => /(^|\/)(memory|skills)\//.test(k))).toEqual([])
    expect(keys).toContain('projects/Acme/notes/day-000.md')
  })
})
