/**
 * The primary's side of a host's read copy (core/host-replica.ts), against the
 * REAL daemon cores (host-replica-core.ts, attachment-copy-core.ts) behind an
 * in-process transport: what is copied (note text only, no dot or attachment
 * folders, none the user left out; the rest of the memory dir and the skills'
 * references, as the companion gets them; the pictures and files to a daemon
 * that keeps them), what each round sends (only what changed; nothing when
 * nothing did), and what a kind turned off does (removed from the host).
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
/** A skill with reference files, on disk (set by the tests that need one). */
let refSkillDir = ''
vi.mock('../../src/core/skill-store.js', () => ({
  listAllSkills: async () => [
    { dirName: 'walnut-board', name: 'walnut-board', description: 'Keep a Board', location: `${stageDir}/dist/data/skills/walnut-board/SKILL.md`, content: '---\nname: walnut-board\n---\nboard body' },
    { dirName: 'deploy', name: 'deploy', description: 'Ship it', location: '/home/me/.claude/skills/deploy/SKILL.md', content: '---\nname: deploy\n---\ndeploy body' },
    ...(refSkillDir ? [{ dirName: 'acme-tool', name: 'acme-tool', description: 'Run the tool', location: path.join(refSkillDir, 'SKILL.md'), content: '---\nname: acme-tool\n---\ntool body' }] : []),
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
  it('everything unless the user turned it off, the same for every target', () => {
    for (const key of ['devbox', 'companion']) expect(hostKeepFor({} as Config, key)).toEqual({ notes: true, notesExclude: [], memory: true, skills: true, attachments: true })
    const c = { hosts: { devbox: { hostname: 'h', keep: { notes: false, notes_exclude: [' /health/ ', '', 'finance'], skills: false } } } } as unknown as Config
    // No notes, no pictures of them.
    expect(hostKeepFor(c, 'devbox')).toEqual({ notes: false, notesExclude: ['health', 'finance'], memory: true, skills: false, attachments: false })
    expect(hostKeepFor(c, 'oldbox').notes).toBe(true)
    const pics = { hosts: { devbox: { hostname: 'h', keep: { attachments: false } } } } as unknown as Config
    expect(hostKeepFor(pics, 'devbox')).toMatchObject({ notes: true, attachments: false })
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
    // A note left out is the Mac's: never "not found" here.
    expect(read('note_read', { path: 'health/Checkup' })).toMatchObject({ ok: false, error: { code: 'needs_leader', detail: { why: 'not_kept_here' } } })
    // A kind turned off answers needs-the-Mac, never "not found" or nothing.
    expect(read('skill_read', { dirName: 'deploy' })).toMatchObject({ ok: false, error: { code: 'needs_leader', detail: { why: 'not_kept_here' } } })
    // No skill is left there: only the mark that the user turned them off.
    expect(fs.readdirSync(daemonDir, { recursive: true }).map(String).filter((f) => f.includes('skills') && !/skills$/.test(f) && !/skills[\\/]index\.json$/.test(f))).toEqual([])
    expect(cmds()).toContain('replica.drop:skills')
    // Off stays off without asking again every round.
    calls = []
    await syncHostReplica(target)
    expect(cmds()).not.toContain('replica.drop:skills')
  })

  it('one note left out (no .md, another case) leaves the host; the rest stays', async () => {
    await syncHostReplica(target)
    expect(read('note_read', { path: 'Projects/Retro' })).toMatchObject({ ok: true })
    config = { hosts: { devbox: { hostname: 'h', keep: { notes_exclude: ['projects/retro'] } } } } as unknown as Config
    calls = []
    await syncHostReplica(target)
    const sync = calls.find((c) => c.cmd === 'replica.sync' && c.params.kind === 'notes')!
    expect((sync.params.entries as Array<{ k: string }>).map((e) => e.k)).not.toContain('Projects/Retro.md')
    expect((sync.params.entries as Array<{ k: string }>).map((e) => e.k)).toContain('Projects/Release plan.md')
    expect(sync.params.opts).toMatchObject({ keepExclude: ['projects/retro'] })
    expect(read('note_read', { path: 'Projects/Retro' })).toMatchObject({ ok: false, error: { code: 'needs_leader', detail: { why: 'not_kept_here' } } })
    expect(read('note_read', { path: 'Projects/Release plan' })).toMatchObject({ ok: true })
    // The note back in: copied again.
    config = { hosts: { devbox: { hostname: 'h' } } } as unknown as Config
    await syncHostReplica(target)
    expect(read('note_read', { path: 'Projects/Retro' })).toMatchObject({ ok: true })
  })

  it('the companion\'s keep settings are cloud_bridge.keep, the same shape and defaults', () => {
    const c = { cloud_bridge: { keep: { notes_exclude: ['health/Checkup.md'], memory: false } } } as unknown as Config
    const companion = { notes: true, notesExclude: ['health/Checkup.md'], memory: false, skills: true, attachments: true }
    expect(hostKeepFor(c, 'companion', { companion: true })).toEqual(companion)
    // A host never reads the companion's.
    expect(hostKeepFor(c, 'devbox')).toEqual({ notes: true, notesExclude: [], memory: true, skills: true, attachments: true })
    // The cloud box's daemon (the Mac's sessions on the companion's machine) keeps what the companion keeps, pictures too.
    expect(hostKeepFor(c, '__cloudbox__')).toEqual(companion)
    expect(hostKeepFor({ cloud_bridge: { keep: { attachments: false } } } as unknown as Config, '__cloudbox__').attachments).toBe(false)
    // An older build's keys under hosts.companion are the companion's; a real host of that name keeps its own.
    expect(hostKeepFor({ hosts: { companion: { keep: { skills: false } } } } as unknown as Config, 'companion', { companion: true }).skills).toBe(false)
    const real = { cloud_bridge: { keep: { memory: false } }, hosts: { companion: { hostname: 'box.example.com', keep: { skills: false } } } } as unknown as Config
    expect([hostKeepFor(real, 'companion').memory, hostKeepFor(real, 'companion').skills]).toEqual([true, false])
    expect([hostKeepFor(real, 'companion', { companion: true }).memory, hostKeepFor(real, 'companion', { companion: true }).skills]).toEqual([false, true])
  })

  it('the search exclusions travel with the manifest', async () => {
    config = { search: { excluded_folders: ['health'] } } as unknown as Config
    await syncHostReplica(target)
    // WP11: the folders this host does not keep and the notes too large to copy travel too (its away writes refuse them).
    expect(calls[0].params.opts).toEqual({ searchExclude: ['health'], keepExclude: [], tooBig: ['Big.md'] })
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

// -- Stage 4e of docs/plan/walnut-companion-unified-replica.md: one copy for every
// replica. A host's daemon gets what the companion gets, decided by its keep settings only. --

import { MEMORY_DIR, REPOS_MEMORY_DIR } from '../../src/constants.js'
import { COMPANION_REPLICA_HOST } from '../../src/core/host-replica.js'
import { createAttachmentCopy } from '../../src/providers/attachment-copy-core.js'
import { _resetAttachmentReplicaForTesting } from '../../src/core/attachment-replica.js'

describe('every target gets the same copy', () => {
  let extraDir = ''
  beforeEach(() => {
    extraDir = fs.mkdtempSync(path.join(os.tmpdir(), 'whx-'))
    _resetAttachmentReplicaForTesting()
  })
  afterEach(() => {
    refSkillDir = ''
    fs.rmSync(path.join(MEMORY_DIR, 'daily'), { recursive: true, force: true })
    fs.rmSync(REPOS_MEMORY_DIR, { recursive: true, force: true })
    fs.rmSync(extraDir, { recursive: true, force: true })
    _resetAttachmentReplicaForTesting()
  })

  /** The manifest each kind's replica.sync carried, by kind. */
  const manifests = (from: number): Record<string, string[]> => Object.fromEntries(calls.slice(from).filter((c) => c.cmd === 'replica.sync')
    .map((c) => [String(c.params.kind), (c.params.entries as Array<{ k: string }>).map((e) => e.k).sort()]))

  it('a host gets the rest of the memory dir and the skills\' references, as the companion does; its readers take only the docs', async () => {
    fs.mkdirSync(path.join(MEMORY_DIR, 'daily'), { recursive: true })
    fs.writeFileSync(path.join(MEMORY_DIR, 'daily', '2026-10-21.md'), '# 2026-10-21\n- shipped the build\n')
    fs.mkdirSync(path.join(REPOS_MEMORY_DIR, 'marina'), { recursive: true })
    fs.writeFileSync(path.join(REPOS_MEMORY_DIR, 'marina', 'SKILL.md'), '# marina\nThe marina repo.\n')
    refSkillDir = path.join(extraDir, 'acme-tool')
    fs.mkdirSync(path.join(refSkillDir, 'references'), { recursive: true })
    fs.writeFileSync(path.join(refSkillDir, 'references', 'flags.md'), 'Use --twice.\n')
    await syncHostReplica(target)
    const host = manifests(0)
    expect(host.memory).toEqual(['f/daily/2026-10-21.md', 'files.v1', 'global', 'r/marina'])
    expect(host.skills).toEqual(['acme-tool', 'acme-tool/references/flags.md', 'deploy', 'walnut-board'])
    // The companion's round carries the very same manifest.
    const from = calls.length
    forgetHostReplica(COMPANION_REPLICA_HOST)
    await syncHostReplica({ hostKey: COMPANION_REPLICA_HOST, send: target.send })
    expect(manifests(from)).toEqual(host)
    // Stored and served by the daemon core as more keys of the kind.
    expect(daemon.read(WALNUT_HOME, 'memory', 'f/daily/2026-10-21.md')?.body).toBe('# 2026-10-21\n- shipped the build\n')
    expect(daemon.read(WALNUT_HOME, 'skills', 'acme-tool/references/flags.md')?.body).toBe('Use --twice.\n')
    // The daemon's own readers never take one for a doc or a skill.
    expect(read('memory_read', { doc: 'global' })).toMatchObject({ ok: true, result: { memory: { path: 'MEMORY.md' } } })
    expect(read('memory_read', { doc: 'files.v1' })).toMatchObject({ ok: false, error: { code: 'bad_request' } })
    expect(read('memory_read', { doc: 'f/daily/2026-10-21.md' })).toMatchObject({ ok: false, error: { code: 'bad_request' } })
    expect(daemon.memoryDocs(WALNUT_HOME).map((d) => d.path)).toEqual(['MEMORY.md'])
    expect(read('skill_read', { dirName: 'acme-tool' })).toMatchObject({ ok: true, result: { skill: { name: 'acme-tool', content: '---\nname: acme-tool\n---\ntool body' } } })
    expect(read('skill_read', { dirName: 'acme-tool/references/flags.md' })).toMatchObject({ ok: false, error: { code: 'bad_request' } })
    expect(daemon.ops(WALNUT_HOME).map((o) => o.name)).toEqual(['note_read', 'note_search', 'memory_read', 'skill_read'])
    // A reference changed on the Mac goes alone.
    calls = []
    fs.writeFileSync(path.join(refSkillDir, 'references', 'flags.md'), 'Use --thrice.\n')
    await syncHostReplica(target)
    const put = calls.find((c) => c.cmd === 'replica.put' && c.params.kind === 'skills')!
    expect((put.params.files as Array<{ k: string }>).map((f) => f.k)).toEqual(['acme-tool/references/flags.md'])
  })

  it('pictures and files go to a daemon that keeps them, through the real core; none to one without it', async () => {
    write('health/xray.png', 'left out')
    write('Projects/_attachment/logo.png', 'logo bytes')
    config = { hosts: { devbox: { hostname: 'h', keep: { notes_exclude: ['health'] } } } } as unknown as Config
    const picsDir = path.join(extraDir, 'pics')
    const pics = createAttachmentCopy({ fs, path, crypto, dirOf: () => picsDir, log: () => {} })
    const homes: string[] = []
    const keeper: ReplicaTarget = {
      hostKey: 'devbox', attachments: true,
      send: async (cmd, params, timeoutMs) => {
        if (!cmd.startsWith('attachments.')) return target.send(cmd, params, timeoutMs)
        calls.push({ cmd, params })
        homes.push(String(params.home))
        return pics.command(params.home as string, cmd, params)
      },
    }
    // A daemon without attachment-copy-v1: the same round, no picture command.
    await syncHostReplica(target)
    expect(cmds().some((c) => c.startsWith('attachments.'))).toBe(false)
    calls = []
    await syncHostReplica(keeper)
    expect(cmds().filter((c) => c.startsWith('attachments.'))).toEqual(['attachments.status:undefined', 'attachments.sync:undefined', 'attachments.put:undefined', 'attachments.put:undefined'])
    expect([...new Set(homes)]).toEqual([WALNUT_HOME])
    expect(pics.held(WALNUT_HOME)).toBe(true)
    // The served files of the vault, never a note, never a folder left out.
    expect(pics.keys(WALNUT_HOME)).toEqual(['Projects/_attachment/logo.png', 'Projects/diagram.png'])
    expect(await pics.readFile(WALNUT_HOME, 'Projects/_attachment/logo.png')).toEqual(Buffer.from('logo bytes'))
    // Unchanged: the next round asks the status and sends nothing.
    calls = []
    await syncHostReplica(keeper)
    expect(cmds().filter((c) => c.startsWith('attachments.'))).toEqual(['attachments.status:undefined'])
    // Turned off for that host: removed there, and not asked again every round.
    config = { hosts: { devbox: { hostname: 'h', keep: { notes_exclude: ['health'], attachments: false } } } } as unknown as Config
    calls = []
    await syncHostReplica(keeper)
    expect(cmds().filter((c) => c.startsWith('attachments.'))).toEqual(['attachments.drop:undefined'])
    expect(pics.held(WALNUT_HOME)).toBe(false)
    // No bytes are left there: only the index that says the pictures are off for it.
    expect(fs.readdirSync(picsDir)).toEqual(['index.json'])
    expect(pics.isOff(WALNUT_HOME)).toBe(true)
    calls = []
    await syncHostReplica(keeper)
    expect(cmds().filter((c) => c.startsWith('attachments.'))).toEqual([])
    // On again: filled again. Notes off: no pictures either.
    config = { hosts: { devbox: { hostname: 'h' } } } as unknown as Config
    await syncHostReplica(keeper)
    expect(pics.keys(WALNUT_HOME)).toEqual(['Projects/_attachment/logo.png', 'Projects/diagram.png', 'health/xray.png'])
    config = { hosts: { devbox: { hostname: 'h', keep: { notes: false } } } } as unknown as Config
    await syncHostReplica(keeper)
    expect(pics.held(WALNUT_HOME)).toBe(false)
  })

  it('a new connection asks the status and sends the manifest again', async () => {
    write('Projects/_attachment/logo.png', 'logo bytes')
    const pics = createAttachmentCopy({ fs, path, crypto, dirOf: () => path.join(extraDir, 'pics'), log: () => {} })
    const keeper: ReplicaTarget = {
      hostKey: 'devbox', attachments: true,
      send: async (cmd, params, timeoutMs) => {
        if (!cmd.startsWith('attachments.')) return target.send(cmd, params, timeoutMs)
        calls.push({ cmd, params })
        return pics.command(params.home as string, cmd, params)
      },
    }
    await syncHostReplica(keeper)
    forgetHostReplica('devbox')
    calls = []
    await syncHostReplica(keeper)
    expect(cmds().filter((c) => c.startsWith('attachments.'))).toEqual(['attachments.status:undefined', 'attachments.sync:undefined'])
  })
})

// -- WP11 (docs/plan/walnut-replica-servers-impl.md sections 4 and 6): a note an away
// write holds on the host, merged by the drain, and the copy catching up after the ack. --

import { HELD_RERUN_MS, noteRecordsAcked, _resetHostReplicaForTesting } from '../../src/core/host-replica.js'
import { applyNoteRecord, sha256 as sha256Full } from '../../src/core/offline-merge/notes.js'
import { mergeVersions } from '../../src/lib/three-way-merge.js'
import { withNoteId } from '../../src/core/parse-frontmatter.js'

describe('away notes: held on the host, merged on the Mac, copied after the ack', () => {
  afterEach(() => { _resetHostReplicaForTesting(); vi.useRealTimers() })

  it('the drain merges a note while the host holds it; after the ack the copy is the Mac\'s text within one rerun', async () => {
    await syncHostReplica(target)
    const base = fs.readFileSync(path.join(NOTES_DIR, 'Projects/Retro.md'), 'utf8')
    const away = '# Retro\nThe build broke twice.\nWritten on the host while away.'
    // The host's journal: one pending write of Retro, then acked by the drain.
    let pending = true
    let ackAt = 0
    daemon.setJournalView({
      overlay: () => (pending ? new Map([['Projects/Retro.md', { body: away, h: sha12(away), n: away.length }]]) : null),
      held: (_home, asOf) => (pending || asOf <= ackAt ? new Set(['Projects/Retro.md']) : new Set()),
    })
    // The Mac edits the note itself; its round finds the key held and arms a rerun.
    write('Projects/Retro.md', '# Retro (Mac)\nThe build broke twice.')
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    calls = []
    const first = await syncHostReplica(target)
    expect(first.find((r) => r.kind === 'notes')).toMatchObject({ action: 'synced', held: 1 })
    expect(read('note_read', { path: 'Projects/Retro' })).toMatchObject({ ok: true, result: { content: away } })
    // The drain merges the away write into the Mac's note while the host still holds it.
    const blobs = new Map([[sha256Full(base), base], [sha256Full(away), away]])
    const out = await applyNoteRecord({
      root: NOTES_DIR, cacheDir: path.join(WALNUT_HOME, 'cache'), hostLabel: 'devbox', hostKey: 'devbox',
      fetchBlob: async (sha) => Buffer.from(blobs.get(sha)!, 'utf8'),
      merge: async (b, v, o) => mergeVersions(b, v, o), pathOfId: () => undefined, lock: (_a, fn) => fn(),
      written: () => undefined, remove: async () => undefined, ensureId: (c, cur) => withNoteId(c, cur).content,
    }, { conflicts: () => undefined }, { seq: 1, at: Date.now(), opId: 'op-r1', path: 'Projects/Retro.md', mode: 'put', baseBlob: sha256Full(base), oursBlob: sha256Full(away) }, Date.now())
    expect(out.action).toBe('merged')
    const merged = fs.readFileSync(path.join(NOTES_DIR, 'Projects/Retro.md'), 'utf8')
    expect(merged).toContain('# Retro (Mac)')
    expect(merged).toContain('Written on the host while away.')
    // The ack: the record leaves the journal; the key waits for a copy made after it.
    pending = false
    ackAt = Date.now() - 1
    noteRecordsAcked('devbox')
    calls = []
    await new Promise((r) => setImmediate(r))
    await vi.advanceTimersByTimeAsync(HELD_RERUN_MS + 10)
    // The rerun has fired; its round does real file I/O, so wait in real time, not in
    // setImmediate turns: Node polls I/O between two immediates, bun runs 400 of them in
    // under a millisecond with the walk still pending. Real timers from here also mean no
    // second rerun (another HELD_RERUN_MS) can land inside the wait.
    vi.useRealTimers()
    await vi.waitFor(() => expect(cmds()).toContain('replica.put:notes'), { timeout: 10_000, interval: 10 })
    expect(read('note_read', { path: 'Projects/Retro' })).toMatchObject({ ok: true, result: { content: merged, contentHash: sha12(merged) } })
  }, 30_000)
})
