/**
 * A host replica's memory and skills reads while it answers alone (src/replica/host-copy-reads.ts;
 * 4f of docs/plan/walnut-companion-unified-replica.md): from the copy its daemon keeps, through
 * the follower link, never from this server's own data dir. The copy is the REAL host-replica
 * core in a temp dir answered through the REAL follower-reads gate (what a follower frame
 * reaches); the routes are the real web memory and skills routers and the v1 memory router.
 *
 * Pinned:
 *   - kept (the default): every read answers the copy's content, in the routes' own shapes;
 *     the data dir's own MEMORY.md and skills are never read;
 *   - turned off for this host: 503 not_kept_here; not held yet: kind_not_copied; an older
 *     Mac's copy without the memory folder: the folder reads need the Mac, the two docs read;
 *   - a copy that cannot be read: copy_unreadable; no reader at all: the kind's needs-the-Mac;
 *   - bodies past one answer's budget arrive over several reads;
 *   - writes, and every read off a host replica, pass to the routes.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import http from 'node:http'
import type net from 'node:net'
import express from 'express'
import { createMockConstants } from '../helpers/mock-constants.js'

vi.mock('../../src/constants.js', () => createMockConstants('walnut-host-copy-reads', { CLOUD_MODE: false }))

import { GLOBAL_SKILLS_DIR, MEMORY_FILE, WALNUT_HOME } from '../../src/constants.js'
import { _resetServerRoleForTesting } from '../../src/core/server-role.js'
import { createHostReplica } from '../../src/providers/host-replica-core.js'
import { createFollowerReads } from '../../src/providers/follower-reads-core.js'
import { hostCopyReads, installHostCopyReads } from '../../src/replica/host-copy-reads.js'
import { memoryRouter } from '../../src/web/routes/memory.js'
import { createSkillsRouter } from '../../src/web/routes/skills.js'
import { searchMemoryV1Router } from '../../src/web/routes/search-memory-v1.js'

const HOME = '/fixture/marina-home'
const sha12 = (s: string) => crypto.createHash('sha256').update(s).digest('hex').slice(0, 12)
const ENV = ['WALNUT_ROLE', 'WALNUT_PLACEMENT', 'WALNUT_HOST_SERVER'] as const
const saved: Record<string, string | undefined> = {}
const T = '2026-10-20T08:00:00.000Z'

let dir = ''
let clock = 1_000_000
let copies = 0
let port = 0
let server: http.Server

/** The daemon's side: its copy, and the gate a follower frame passes. */
function makeDaemon() {
  const replica = createHostReplica({
    fs, path, dir: path.join(dir, `copy-${++copies}`), now: () => clock,
    keyOf: (v) => crypto.createHash('sha1').update(v).digest('hex').slice(0, 16), hash: sha12, log: () => {},
  })
  const gate = createFollowerReads({
    path, homeDir: '/nonexistent', realpath: () => null, sliceOwner: () => undefined, journalOwner: () => undefined,
    liveSessions: () => [], journalSize: () => -1, readJournal: () => '', replica, log: () => {},
  })
  const calls: string[] = []
  let budget: number | null = null
  const ask = (frame: Record<string, unknown>): Record<string, unknown> => {
    calls.push(String(frame.cmd))
    if (budget !== null && frame.cmd === 'replica.readMany') return { ok: true, ...replica.readMany(HOME, frame.kind, frame.keys, budget)! }
    const d = gate.gate(HOME, { ...frame })
    if ('answer' in d) return { ok: true, ...d.answer }
    if ('refuse' in d) return { ok: false, error: d.refuse, errorKind: 'not_found' }
    if ('error' in d) return { ok: false, error: d.error }
    return { ok: false, error: 'passed to a handler' }
  }
  const push = (kind: 'memory' | 'skills', bodies: Record<string, string>, meta: Record<string, Record<string, unknown>> = {}) => {
    clock += 1000
    const entries = Object.entries(bodies).map(([k, body]) => ({ k, h: sha12(body), n: Buffer.byteLength(body), ...(meta[k] ? { m: meta[k] } : {}) }))
    const { need } = replica.sync(HOME, kind, entries, clock)
    replica.put(HOME, kind, need.map((k) => ({ k, body: bodies[k]! })))
  }
  return { replica, ask, push, calls, smallAnswers: (bytes: number) => { budget = bytes } }
}

const doc = (content: string) => JSON.stringify({ path: 'MEMORY.md', title: 'Global Memory', category: 'global', content, createdAt: T, updatedAt: T })
const MEMORY = {
  global: doc('# Copy memory\n\n- Acme launch on Friday\n'),
  user: JSON.stringify({ path: 'USER.md', title: 'User Profile', category: 'global', content: '# Ada\n', createdAt: T, updatedAt: T }),
  'files.v1': '{"v":1}',
  'f/knowledge/acme.md': '# Acme notes\n\nThe printer is on Main St.\n',
  'f/projects/marina.md': '# Marina\n',
  'f/daily/2026-10-20.md': '# Tuesday\n',
}
const MEMORY_META = {
  'f/knowledge/acme.md': { createdAt: T, updatedAt: T },
  'f/projects/marina.md': { createdAt: T, updatedAt: T },
  'f/daily/2026-10-20.md': { createdAt: T, updatedAt: T },
}
const SKILLS = {
  'acme-tool': JSON.stringify({ dirName: 'acme-tool', name: 'acme-tool', description: 'Run it', content: '# Acme tool\n', enabled: true, source: 'global' }),
  'acme-tool/references/guide.md': 'Step one.\n',
}

let d: ReturnType<typeof makeDaemon>
const useDaemon = (x: ReturnType<typeof makeDaemon>) => { d = x; installHostCopyReads(async (cmd, params) => x.ask({ cmd, ...params })) }

beforeAll(async () => {
  for (const k of ENV) saved[k] = process.env[k]
  Object.assign(process.env, { WALNUT_ROLE: 'replica', WALNUT_PLACEMENT: 'host', WALNUT_HOST_SERVER: '1' })
  _resetServerRoleForTesting()
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'whcr-'))
  // This server's own data dir holds other things: never what a read answers.
  fs.mkdirSync(path.dirname(MEMORY_FILE), { recursive: true })
  fs.writeFileSync(MEMORY_FILE, '# DISK memory\n')
  fs.mkdirSync(path.join(GLOBAL_SKILLS_DIR, 'disk-only'), { recursive: true })
  fs.writeFileSync(path.join(GLOBAL_SKILLS_DIR, 'disk-only', 'SKILL.md'), '---\nname: disk-only\ndescription: x\n---\n# Disk\n')
  const app = express()
  app.use(express.json())
  app.use('/api/memory', memoryRouter)
  app.use('/api/skills', createSkillsRouter())
  app.use('/api/v1', searchMemoryV1Router)
  app.use('/api/v1', hostCopyReads('skills', 'v1'))
  app.use((req, res) => { res.status(299).json({ ran: req.originalUrl }) })
  server = http.createServer(app)
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()))
  port = (server.address() as net.AddressInfo).port
})

afterAll(async () => {
  installHostCopyReads(null)
  await new Promise((r) => server.close(r))
  for (const k of ENV) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k] }
  _resetServerRoleForTesting()
  fs.rmSync(dir, { recursive: true, force: true })
  fs.rmSync(WALNUT_HOME, { recursive: true, force: true })
})

beforeEach(() => {
  const x = makeDaemon()
  x.push('memory', MEMORY, MEMORY_META)
  x.push('skills', SKILLS)
  useDaemon(x)
})

async function get(p: string, method = 'GET'): Promise<{ status: number; body: any; asOf: string | null }> {
  const r = await fetch(`http://127.0.0.1:${port}${p}`, { method, ...(method !== 'GET' ? { headers: { 'content-type': 'application/json' }, body: '{}' } : {}) })
  const text = await r.text()
  return { status: r.status, body: text ? JSON.parse(text) : null, asOf: r.headers.get('x-walnut-copy-as-of') }
}
const why = (r: { status: number; body: any }) => [r.status, r.body?.error?.code, r.body?.error?.why]

describe('kept (the default): the daemon\'s copy answers', () => {
  it('the two docs, the lists, the browse tree and one file, in the routes\' shapes; never the data dir', async () => {
    const g = await get('/api/memory/global')
    expect([g.status, g.body.memory.content, typeof g.body.memory.contentHash]).toEqual([200, '# Copy memory\n\n- Acme launch on Friday\n', 'string'])
    expect(g.asOf).toBeTruthy()
    expect((await get('/api/memory/user')).body.memory.content).toBe('# Ada\n')
    const list = await get('/api/memory')
    expect(list.body.memories.map((m: { path: string }) => m.path).sort()).toEqual(['knowledge/acme.md', 'projects/marina.md'])
    expect((await get('/api/memory?category=project')).body.memories.map((m: { title: string }) => m.title)).toEqual(['Marina'])
    const tree = (await get('/api/memory/browse')).body.tree
    expect([tree.global.title, tree.daily.map((x: { date: string }) => x.date), tree.knowledge.map((x: { path: string }) => x.path)]).toEqual(['Global Memory', ['2026-10-20'], ['knowledge/acme.md']])
    const one = await get('/api/memory/knowledge/acme.md')
    expect([one.status, one.body.memory.title, one.body.memory.category, typeof one.body.memory.contentHash]).toEqual([200, 'Acme notes', 'knowledge', 'string'])
    expect((await get('/api/memory/MEMORY.md')).body.memory.content).toContain('Copy memory')
    expect((await get('/api/memory/knowledge/nothing.md')).status).toBe(404)
    expect((await get('/api/memory/knowledge%2F..%2F..%2Fconfig.yaml')).status).toBe(403)
    // v1
    expect((await get('/api/v1/memory/global')).body.memory.content).toContain('Copy memory')
    expect((await get('/api/v1/memory')).body.memories.length).toBe(2)
    expect((await get('/api/v1/memory/browse')).body.tree.projects.map((x: { title: string }) => x.title)).toEqual(['Marina'])
  })

  it('skills: the list, one skill and its references; the data dir\'s own skill is not there', async () => {
    const list = await get('/api/skills')
    expect(list.body.skills.map((s: { dirName: string }) => s.dirName)).toEqual(['acme-tool'])
    expect(list.body.skills[0].content).toBe('# Acme tool\n')
    expect((await get('/api/skills/acme-tool')).body.skill).toMatchObject({ dirName: 'acme-tool', location: '' })
    expect((await get('/api/skills/disk-only')).status).toBe(404)
    expect((await get('/api/skills/acme-tool/references')).body.files).toEqual([{ name: 'guide.md', size: 10 }])
    expect((await get('/api/skills/acme-tool/references/guide.md')).body).toEqual({ content: 'Step one.\n' })
    expect((await get('/api/skills/acme-tool/references/..%2Fx')).status).toBe(400)
    const v1 = await get('/api/v1/skills')
    expect([v1.status, v1.body.skills.map((s: { dirName: string }) => s.dirName), 'content' in v1.body.skills[0]]).toEqual([200, ['acme-tool'], false])
    expect((await get('/api/v1/skills/acme-tool')).body.skill.dirName).toBe('acme-tool')
  })

  it('bodies past one answer\'s budget arrive over several reads', async () => {
    d.smallAnswers(64)
    const list = await get('/api/memory')
    expect(list.body.memories.map((m: { path: string }) => m.path).sort()).toEqual(['knowledge/acme.md', 'projects/marina.md'])
    expect(d.calls.filter((c) => c === 'replica.readMany').length).toBeGreaterThan(1)
  })
})

describe('what the copy cannot answer needs the Mac', () => {
  it('memory turned off for this host: not_kept_here; the skills still read', async () => {
    d.replica.drop(HOME, 'memory')
    for (const p of ['/api/memory/global', '/api/memory', '/api/memory/browse', '/api/memory/knowledge/acme.md', '/api/v1/memory/global']) {
      expect([p, ...why(await get(p))]).toEqual([p, 503, 'needs_leader', 'not_kept_here'])
    }
    expect((await get('/api/skills')).status).toBe(200)
  })

  it('skills turned off: not_kept_here', async () => {
    d.replica.drop(HOME, 'skills')
    for (const p of ['/api/skills', '/api/skills/acme-tool', '/api/v1/skills']) expect([p, ...why(await get(p))]).toEqual([p, 503, 'needs_leader', 'not_kept_here'])
  })

  it('no copy held yet: kind_not_copied', async () => {
    useDaemon(makeDaemon())
    expect(why(await get('/api/memory/global'))).toEqual([503, 'needs_leader', 'kind_not_copied'])
    expect(why(await get('/api/skills'))).toEqual([503, 'needs_leader', 'kind_not_copied'])
  })

  it('an older Mac\'s copy with the two docs only: the folder reads need the Mac, the docs read', async () => {
    const x = makeDaemon()
    x.push('memory', { global: MEMORY.global })
    useDaemon(x)
    expect((await get('/api/memory/global')).status).toBe(200)
    expect(why(await get('/api/memory'))).toEqual([503, 'needs_leader', 'kind_not_copied'])
    expect(why(await get('/api/memory/browse'))).toEqual([503, 'needs_leader', 'kind_not_copied'])
  })

  it('a copy that cannot be read: copy_unreadable; no reader: the kind\'s needs-the-Mac; telemetry: the Mac\'s', async () => {
    installHostCopyReads(async () => { throw new Error('daemon_needs_upgrade: no replica-reads-v1') })
    expect(why(await get('/api/memory/global'))).toEqual([503, 'needs_leader', 'copy_unreadable'])
    expect(why(await get('/api/skills'))).toEqual([503, 'needs_leader', 'copy_unreadable'])
    installHostCopyReads(null)
    expect(why(await get('/api/memory'))).toEqual([503, 'needs_leader', 'memory_needs_mac'])
    expect(why(await get('/api/skills/acme-tool'))).toEqual([503, 'needs_leader', 'skills_need_mac'])
    expect(why(await get('/api/memory/telemetry'))).toEqual([503, 'needs_leader', 'memory_needs_mac'])
    useDaemon(makeDaemon())
    expect(why(await get('/api/memory/telemetry'))).toEqual([503, 'needs_leader', 'memory_telemetry_needs_mac'])
  })
})

describe('what is not a host replica\'s copy read passes on', () => {
  it('a write passes to the route', async () => {
    expect(await get('/api/v1/skills', 'POST')).toMatchObject({ status: 299, body: { ran: '/api/v1/skills' } })
  })

  it('off a host replica, every read passes to the route', async () => {
    delete process.env.WALNUT_ROLE
    _resetServerRoleForTesting()
    try {
      expect(await get('/api/v1/skills')).toMatchObject({ status: 299, body: { ran: '/api/v1/skills' } })
      expect((await get('/api/memory/global')).body.memory.content).toBe('# DISK memory\n')
    } finally {
      process.env.WALNUT_ROLE = 'replica'
      _resetServerRoleForTesting()
    }
  })
})
