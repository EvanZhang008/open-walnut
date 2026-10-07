/**
 * The primary's side of a host's read copy (core/host-replica.ts), against the
 * REAL daemon core (host-replica-core.ts) behind an in-process transport: what
 * is copied (note text only, no dot or attachment folders, none the user left
 * out), what each round sends (only what changed; nothing when nothing did),
 * and what a kind turned off does (removed from the host).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import { createMockConstants } from '../helpers/mock-constants.js'

vi.mock('../../src/constants.js', () => createMockConstants('walnut-host-replica'))
/** Where the shipped skills are served from: a deploy's stage dir, new with every deploy. */
let stageDir = '/stage/one'
vi.mock('../../src/core/skill-store.js', () => ({
  listAllSkills: async () => [
    { dirName: 'walnut-board', name: 'walnut-board', description: 'Keep a Board', location: `${stageDir}/dist/data/skills/walnut-board/SKILL.md`, content: '---\nname: walnut-board\n---\nboard body' },
    { dirName: 'deploy', name: 'deploy', description: 'Ship it', location: '/home/me/.claude/skills/deploy/SKILL.md', content: '---\nname: deploy\n---\ndeploy body' },
  ],
}))

import { NOTES_DIR, MEMORY_FILE, WALNUT_HOME } from '../../src/constants.js'
import { hostKeepFor, noteEntries, syncHostReplica, forgetHostReplica, sha12, type ReplicaTarget } from '../../src/core/host-replica.js'
import { createHostReplica } from '../../src/providers/host-replica-core.js'
import type { Config } from '../../src/core/types.js'

let daemonDir = ''
let daemon: ReturnType<typeof createHostReplica>
let calls: Array<{ cmd: string; params: Record<string, unknown> }> = []
let config: Config = {} as Config
let afterSync: (() => void) | null = null

vi.mock('../../src/core/config-manager.js', () => ({ getConfig: async () => config }))

function write(rel: string, body: string): void {
  const abs = path.join(NOTES_DIR, rel)
  fs.mkdirSync(path.dirname(abs), { recursive: true })
  fs.writeFileSync(abs, body)
}

/** The daemon's command surface, as cmdReplica answers it. */
const target: ReplicaTarget = {
  hostKey: 'devbox',
  send: async (cmd, params) => {
    calls.push({ cmd, params })
    try {
      const home = params.home as string
      if (cmd === 'replica.sync') {
        const r = daemon.sync(home, params.kind, params.entries, params.asOf, params.opts as Record<string, unknown> | undefined)
        afterSync?.()
        return { ok: true, ...r }
      }
      if (cmd === 'replica.put') return { ok: true, ...daemon.put(home, params.kind, params.files) }
      if (cmd === 'replica.drop') return { ok: true, ...daemon.drop(home, params.kind) }
      return { ok: false, error: `unknown command: ${cmd}` }
    } catch (err) {
      return { ok: false, error: (err as Error).message }
    }
  },
}

const read = (name: string, args: Record<string, unknown>) => daemon.answer(WALNUT_HOME, name, args, '')
const cmds = () => calls.map((c) => `${c.cmd}:${String(c.params.kind)}`)

beforeEach(() => {
  fs.rmSync(NOTES_DIR, { recursive: true, force: true })
  fs.mkdirSync(path.dirname(MEMORY_FILE), { recursive: true })
  fs.writeFileSync(MEMORY_FILE, '# Memory\n- deploy with the script\n')
  write('Projects/Release plan.md', '---\nid: n_rel01\ntitle: Release plan\n---\nShip on Friday.')
  write('Projects/Retro.md', '# Retro\nThe build broke twice.')
  write('health/Checkup.md', '# Checkup\nBlood test.')
  write('.obsidian/workspace.md', 'editor state')
  write('_attachment/scan.md', 'ocr text')
  write('Projects/diagram.png', 'binary')
  write('Big.md', 'x'.repeat(1024 * 1024 + 1))
  daemonDir = fs.mkdtempSync(path.join(os.tmpdir(), 'whp-'))
  daemon = createHostReplica({
    fs, path, dir: daemonDir, now: () => Date.now(),
    keyOf: (v) => crypto.createHash('sha1').update(v).digest('hex').slice(0, 16),
    hash: sha12, log: () => {},
  })
  calls = []
  config = {} as Config
  afterSync = null
  stageDir = '/stage/one'
  forgetHostReplica('devbox')
})
afterEach(() => { fs.rmSync(daemonDir, { recursive: true, force: true }) })

describe('what a host keeps', () => {
  it('everything unless the user turned it off', () => {
    expect(hostKeepFor({} as Config, 'devbox')).toEqual({ notes: true, notesExclude: [], memory: true, skills: true })
    const c = { hosts: { devbox: { hostname: 'h', keep: { notes: false, notes_exclude: [' /health/ ', '', 'finance'], skills: false } } } } as unknown as Config
    expect(hostKeepFor(c, 'devbox')).toEqual({ notes: false, notesExclude: ['health', 'finance'], memory: true, skills: false })
    expect(hostKeepFor(c, 'oldbox').notes).toBe(true)
  })

  it('note text only: no dot folders, no attachments, nothing over 1 MB, none left out', async () => {
    const entries = await noteEntries(['health'])
    expect(entries.map((e) => e.k).sort()).toEqual(['Projects/Release plan.md', 'Projects/Retro.md'])
    const plan = entries.find((e) => e.k === 'Projects/Release plan.md')!
    expect(plan.h).toBe(sha12(fs.readFileSync(path.join(NOTES_DIR, 'Projects/Release plan.md'), 'utf8')))
    expect(plan.m).toMatchObject({ title: 'Release plan', id: 'n_rel01' })
    expect(entries.find((e) => e.k === 'Projects/Retro.md')!.m).toMatchObject({ title: 'Retro' })
    expect((await noteEntries([])).map((e) => e.k)).toContain('health/Checkup.md')
  })
})

describe('a round', () => {
  it('first round copies every kind; the next sends nothing; reads work from the copy', async () => {
    const results = await syncHostReplica(target)
    expect(results.map((r) => `${r.kind}:${r.action}`)).toEqual(['notes:synced', 'memory:synced', 'skills:synced'])
    expect(cmds()).toEqual(['replica.sync:notes', 'replica.put:notes', 'replica.sync:memory', 'replica.put:memory', 'replica.sync:skills', 'replica.put:skills'])
    // The contentHash a later note_edit needs is the server's own.
    const note = read('note_read', { path: 'Projects/Retro' })
    expect(note).toMatchObject({ ok: true, result: { content: '# Retro\nThe build broke twice.', contentHash: sha12('# Retro\nThe build broke twice.') } })
    expect(read('memory_read', { doc: 'global' })).toMatchObject({ ok: true, result: { memory: { content: '# Memory\n- deploy with the script\n', path: 'MEMORY.md' } } })
    expect(read('skill_read', { dirName: 'deploy' })).toMatchObject({ ok: true, result: { skill: { name: 'deploy', content: '---\nname: deploy\n---\ndeploy body' } } })
    calls = []
    expect((await syncHostReplica(target)).map((r) => r.action)).toEqual(['unchanged', 'unchanged', 'unchanged'])
    expect(calls).toEqual([])
  })

  it('a changed note sends that note only; a deleted one leaves the host', async () => {
    await syncHostReplica(target)
    calls = []
    write('Projects/Retro.md', '# Retro\nThird time lucky.')
    fs.rmSync(path.join(NOTES_DIR, 'health/Checkup.md'))
    await syncHostReplica(target)
    const put = calls.find((c) => c.cmd === 'replica.put')!
    expect((put.params.files as Array<{ k: string }>).map((f) => f.k)).toEqual(['Projects/Retro.md'])
    expect(read('note_read', { path: 'Projects/Retro' })).toMatchObject({ ok: true, result: { content: '# Retro\nThird time lucky.' } })
    expect(read('note_read', { path: 'health/Checkup' })).toMatchObject({ ok: false, error: { code: 'not_found' } })
  })

  it('a folder left out, and a kind turned off, are removed from the host', async () => {
    await syncHostReplica(target)
    config = { hosts: { devbox: { hostname: 'h', keep: { notes_exclude: ['health'], skills: false } } } } as unknown as Config
    calls = []
    await syncHostReplica(target)
    expect(read('note_read', { path: 'health/Checkup' })).toMatchObject({ ok: false, error: { code: 'not_found' } })
    expect(read('skill_read', { dirName: 'deploy' })).toBeNull()
    expect(fs.readdirSync(daemonDir, { recursive: true }).map(String).some((f) => f.includes('skills'))).toBe(false)
    expect(cmds()).toContain('replica.drop:skills')
    // Off stays off without asking again every round.
    calls = []
    await syncHostReplica(target)
    expect(cmds()).not.toContain('replica.drop:skills')
  })

  it('the search exclusions travel with the manifest', async () => {
    config = { search: { excluded_folders: ['health'] } } as unknown as Config
    await syncHostReplica(target)
    expect(calls[0].params.opts).toEqual({ searchExclude: ['health'] })
    const r = read('note_search', { q: 'blood' }) as { ok: true; result: { results: unknown[] } }
    expect(r.result.results).toEqual([])
  })

  it('a note that changes between the manifest and its body is sent on the next round, never a mismatched one', async () => {
    afterSync = () => { write('Projects/Retro.md', '# Retro\nEdited mid-round.'); afterSync = null }
    await syncHostReplica(target)
    expect(read('note_read', { path: 'Projects/Retro' })).toMatchObject({ ok: false })
    calls = []
    await syncHostReplica(target)
    expect(read('note_read', { path: 'Projects/Retro' })).toMatchObject({ ok: true, result: { content: '# Retro\nEdited mid-round.' } })
  })

  it('a skill keeps no path of this machine, so a deploy (a new stage dir) resends no skill', async () => {
    await syncHostReplica(target)
    const skill = read('skill_read', { dirName: 'walnut-board' }) as { ok: true; result: { skill: Record<string, unknown> } }
    expect(skill.result.skill).toMatchObject({ name: 'walnut-board', content: '---\nname: walnut-board\n---\nboard body' })
    expect(skill.result.skill).not.toHaveProperty('location')
    stageDir = '/stage/two'
    forgetHostReplica('devbox') // the deploy restarted the server: a new connection
    calls = []
    await syncHostReplica(target)
    expect(cmds()).toEqual(['replica.sync:notes', 'replica.sync:memory', 'replica.sync:skills'])
  })

  it('a new connection sends every manifest again; a failing host does not stop the other kinds', async () => {
    await syncHostReplica(target)
    forgetHostReplica('devbox')
    calls = []
    await syncHostReplica(target)
    expect(cmds()).toEqual(['replica.sync:notes', 'replica.sync:memory', 'replica.sync:skills'])
    const flaky: ReplicaTarget = { hostKey: 'flaky', send: async (cmd, params) => (params.kind === 'notes' ? { ok: false, error: 'disk full' } : target.send(cmd, params)) }
    const res = await syncHostReplica(flaky)
    expect(res.map((r) => `${r.kind}:${r.action}`)).toEqual(['notes:failed', 'memory:synced', 'skills:synced'])
    expect(res[0].error).toBe('disk full')
  })

  it('hosts that start a round together share one walk of the vault; a later round walks again', async () => {
    const fsp = (await import('node:fs/promises')).default
    const readdir = fsp.readdir.bind(fsp) as (...a: unknown[]) => Promise<unknown>
    // A real vault takes a while to walk; this one is tiny, so slow its top folder down.
    const spy = vi.spyOn(fsp, 'readdir').mockImplementation((async (...a: unknown[]) => {
      if (String(a[0]) === NOTES_DIR) await new Promise((r) => setTimeout(r, 100))
      return readdir(...a)
    }) as typeof fsp.readdir)
    const walks = () => spy.mock.calls.filter((c) => String(c[0]) === NOTES_DIR).length
    try {
      const other: ReplicaTarget = { hostKey: 'devbox2', send: target.send }
      forgetHostReplica('devbox2')
      const [a, b] = await Promise.all([syncHostReplica(target), syncHostReplica(other)])
      expect(walks()).toBe(1)
      expect(a[0]).toMatchObject({ kind: 'notes', action: 'synced' })
      expect(b[0]).toMatchObject({ kind: 'notes', entries: a[0].entries })
      write('Projects/Retro.md', '# Retro\nWalked again.')
      await syncHostReplica(target)
      expect(walks()).toBe(2)
      expect(read('note_read', { path: 'Projects/Retro' })).toMatchObject({ ok: true, result: { content: '# Retro\nWalked again.' } })
    } finally {
      spy.mockRestore()
    }
  })

  it('one round per host at a time; a request during a round runs one more', async () => {
    let release: () => void = () => {}
    const gate = new Promise<void>((r) => { release = r })
    let syncs = 0
    const slow: ReplicaTarget = { hostKey: 'slow', send: async (cmd, params) => { if (cmd === 'replica.sync') { syncs++; if (syncs === 1) await gate } return target.send(cmd, params) } }
    const first = syncHostReplica(slow)
    await new Promise((r) => setTimeout(r, 20))
    expect(await syncHostReplica(slow)).toEqual([])
    release()
    await first
    // The rerun found nothing new to send for notes, so it asked once per kind in round two.
    expect(syncs).toBe(3)
  })
})
