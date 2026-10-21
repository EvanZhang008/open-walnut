/**
 * Stage 4d of docs/plan/walnut-companion-unified-replica.md on a real CLOUD_MODE server:
 * the box's memory and skill reads take the Mac's copy (core/companion-host-replica.ts),
 * a memory save there is a `memory` record in its journal (core/companion-memory.ts), a
 * skill write needs the Mac, and v1's note resolve (note_read by id or title) reads the
 * copy (replica/notes-source.ts).
 *
 * Pinned:
 *   - before the Mac drains `memory`, the memory reads and saves are the box's disk's;
 *   - once it does, GET /api/memory/global and /api/v1/memory/global answer the copy, a
 *     web or v1 PUT is a journal record (the disk untouched) shown at once, a stale lock
 *     is a 409 with the hash the box shows, and after the ack the box shows its text until
 *     a copy round from after the ack;
 *   - the skill reads (web and v1, one and the list) answer the copy, with the Mac's
 *     skill even when the box's disk no longer has it; every skill write is a 503
 *     needs_leader `skill_changes_need_mac`; the references stay the box's own;
 *   - /api/v1/notes/resolve answers from the copy by id, path and title, 404 and 409 in
 *     the route's shape.
 */
import crypto from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import type { Server as HttpServer } from 'node:http'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { createMockConstants } from '../../helpers/mock-constants.js'

vi.mock('../../../src/constants.js', () => createMockConstants('walnut-companion-memory-skills-cloud', { CLOUD_MODE: true }))

let bridgeCfg: { enabled: boolean; url?: string; token?: string } = { enabled: false }
vi.mock('../../../src/integrations/cloud-bridge-config.js', async (orig) => ({
  ...(await orig<typeof import('../../../src/integrations/cloud-bridge-config.js')>()),
  getBridgeConfigForHost: async () => bridgeCfg,
}))

import { GLOBAL_SKILLS_DIR, MEMORY_FILE, NOTES_DIR, WALNUT_HOME } from '../../../src/constants.js'
import { startServer, stopServer } from '../../../src/web/server.js'
import { _resetDeviceAuthForTesting } from '../../../src/core/device-auth.js'
import { _resetCloudIngestForTesting, postToCloudJournal } from '../../../src/core/cloud-ingest.js'
import { _resetHostReplicaForTesting, forgetCompanionHostReplica, syncCompanionHostReplica } from '../../../src/core/host-replica.js'
import { companionCopyHolds } from '../../../src/core/companion-host-replica.js'
import { companionJournalRecords } from '../../../src/core/companion-journal.js'
import { APPLIED_V2_KINDS } from '../../../src/core/offline-merge/apply-v2.js'

let server: HttpServer
let port = 0
const sha = (t: string) => crypto.createHash('sha256').update(t, 'utf-8').digest('hex')
const sha12 = (t: string) => crypto.createHash('sha256').update(t).digest('hex').slice(0, 12)
const tok = () => crypto.randomBytes(16).toString('hex')
const T = { local: tok(), phone: tok() }
const MEMORY = '# Memory\n\n- Acme launch is on Friday\n'
const SKILL = '---\nname: acme-tool\ndescription: How to run the Acme tool\n---\n# Acme tool\n\nRun it twice.\n'

/** A note's text with its id already stamped (the disk routes stamp a missing one). */
const withId = (rel: string, text: string): string => `---\nid: n_${crypto.createHash('sha1').update(rel).digest('hex').slice(0, 11)}\n---\n${text}`
async function writeNote(rel: string, text: string): Promise<void> {
  const file = path.join(NOTES_DIR, rel)
  await fs.mkdir(path.dirname(file), { recursive: true })
  await fs.writeFile(file, withId(rel, text))
}
async function api(p: string, init: RequestInit = {}): Promise<{ status: number; body: Record<string, any>; asOf: string | null }> {
  const r = await fetch(`http://127.0.0.1:${port}${p}`, {
    ...init,
    headers: { Authorization: `Bearer ${T.phone}`, ...(init.body ? { 'Content-Type': 'application/json' } : {}) },
  })
  return { status: r.status, body: await r.json().catch(() => ({})) as Record<string, any>, asOf: r.headers.get('x-walnut-copy-as-of') }
}
const put = (p: string, body: unknown) => api(p, { method: 'PUT', body: JSON.stringify(body) })
const memoryRecords = () => companionJournalRecords().filter((r) => r.kind === 'memory')

beforeAll(async () => {
  await fs.mkdir(WALNUT_HOME, { recursive: true })
  const now = new Date().toISOString()
  await fs.writeFile(path.join(WALNUT_HOME, 'auth.json'), JSON.stringify({ devices: [
    { name: 'my-phone', id: 'd00000000000000c3', tokenHash: sha(T.phone), createdAt: now },
    { name: 'bridge-local', id: 'd00000000000000d4', tokenHash: sha(T.local), createdAt: now, kind: 'machine' },
  ] }), { mode: 0o600 })
  await writeNote('Acme/launch-plan.md', '# Acme launch plan\n\nShip the beta on Friday.\n')
  await writeNote('Acme/vendors.md', '# Acme vendors\n\nCall the printer.\n')
  await writeNote('Beta/vendors.md', '# Beta vendors\n\nCall the florist.\n')
  await fs.mkdir(path.dirname(MEMORY_FILE), { recursive: true })
  await fs.writeFile(MEMORY_FILE, MEMORY)
  await fs.mkdir(path.join(GLOBAL_SKILLS_DIR, 'acme-tool', 'references'), { recursive: true })
  await fs.writeFile(path.join(GLOBAL_SKILLS_DIR, 'acme-tool', 'SKILL.md'), SKILL)
  await fs.writeFile(path.join(GLOBAL_SKILLS_DIR, 'acme-tool', 'references', 'flags.md'), 'Use --twice.\n')
  _resetDeviceAuthForTesting()
  server = await startServer({ port: 0, dev: true })
  const addr = server.address()
  if (!addr || typeof addr === 'string') throw new Error('no port')
  port = addr.port
  bridgeCfg = { enabled: true, url: `ws://127.0.0.1:${port}/bridge`, token: T.local }
  _resetCloudIngestForTesting()
  _resetHostReplicaForTesting()
  await syncCompanionHostReplica()
  expect(companionCopyHolds('memory')).toBe(true)
  expect(companionCopyHolds('skills')).toBe(true)
}, 60_000)

afterAll(async () => {
  await stopServer()
  await fs.rm(WALNUT_HOME, { recursive: true, force: true }).catch(() => {})
})

describe('memory on the box', () => {
  it('before the Mac drains memory, the reads and saves are the box\'s disk\'s', async () => {
    // A Mac that drains the older kinds only.
    await postToCloudJournal('offline.drain', { home: '/x', kinds: APPLIED_V2_KINDS.filter((k) => k !== 'memory') })
    await fs.writeFile(MEMORY_FILE, `${MEMORY}- Disk only\n`)
    const r = await api('/api/memory/global')
    expect(r.body.memory.content).toContain('Disk only')
    expect(r.asOf).toBeNull()
    const saved = await put('/api/memory/global', { content: `${MEMORY}- Saved to disk\n`, expectedHash: r.body.memory.contentHash })
    expect(saved.status).toBe(200)
    expect(await fs.readFile(MEMORY_FILE, 'utf8')).toContain('Saved to disk')
    expect(memoryRecords()).toEqual([])
    await fs.writeFile(MEMORY_FILE, MEMORY)
  })

  it('once it does, the reads answer the copy and a save is a journal record shown at once', async () => {
    await postToCloudJournal('offline.drain', { home: '/x', kinds: [...APPLIED_V2_KINDS] })
    // The box's disk moves on without a round: the reads still show the copy.
    await fs.writeFile(MEMORY_FILE, `${MEMORY}- Disk only, never sent\n`)
    const web = await api('/api/memory/global')
    expect(web).toMatchObject({ status: 200, body: { memory: { path: 'MEMORY.md', content: MEMORY, contentHash: sha12(MEMORY) } } })
    expect(web.asOf).toBeTruthy()
    expect((await api('/api/v1/memory/global')).body.memory.content).toBe(MEMORY)
    expect((await api('/api/memory/user')).status).toBe(404)
    const next = `${MEMORY}- Book the venue\n`
    const saved = await put('/api/memory/global', { content: next, expectedHash: web.body.memory.contentHash })
    expect(saved).toMatchObject({ status: 200, body: { ok: true, contentHash: sha12(next) } })
    expect(memoryRecords().map((r) => r.doc)).toEqual(['global'])
    expect(await fs.readFile(MEMORY_FILE, 'utf8')).toContain('Disk only, never sent')
    expect((await api('/api/memory/global')).body.memory.content).toBe(next)
    expect((await api('/api/v1/memory/global')).body.memory.content).toBe(next)
    // A stale lock: 409 with the hash this box shows.
    const stale = await put('/api/memory/global', { content: 'x', expectedHash: web.body.memory.contentHash })
    expect(stale).toMatchObject({ status: 409, body: { code: 'conflict', currentHash: sha12(next) } })
    // The v1 PUT (no lock) is a second record behind the first.
    const v1 = await put('/api/v1/memory/global', { content: `${next}- Order the cake\n` })
    expect(v1.status).toBe(200)
    expect(memoryRecords()).toHaveLength(2)
    expect((await api('/api/memory/global')).body.memory.content).toContain('Order the cake')
    // A round meanwhile (the Mac has not taken them) does not replace what the box shows.
    forgetCompanionHostReplica()
    await syncCompanionHostReplica()
    expect((await api('/api/memory/global')).body.memory.content).toContain('Order the cake')
    await fs.writeFile(MEMORY_FILE, MEMORY)
  })

  it('after the ack the box shows its text until a copy round from after the ack', async () => {
    const drained = await postToCloudJournal('offline.drain', { home: '/x', kinds: [...APPLIED_V2_KINDS] })
    const seqs = (drained.records as Array<{ seq: number; kind: string }>).filter((r) => r.kind === 'memory').map((r) => r.seq)
    expect(seqs).toHaveLength(2)
    expect(await postToCloudJournal('offline.ack', { home: '/x', seqs, now: Date.now() })).toMatchObject({ ok: true })
    expect(memoryRecords()).toEqual([])
    expect((await api('/api/memory/global')).body.memory.content).toContain('Order the cake')
    // The Mac's merge, sent by its next round.
    await new Promise((r) => setTimeout(r, 5))
    const merged = `${MEMORY}- Book the venue\n- Order the cake\n- Added on the Mac\n`
    await fs.writeFile(MEMORY_FILE, merged)
    forgetCompanionHostReplica()
    await syncCompanionHostReplica()
    expect((await api('/api/memory/global')).body.memory.content).toBe(merged)
  })
})

describe('skills on the box', () => {
  it('the reads answer the copy, even for a skill the box\'s disk no longer has', async () => {
    await fs.rm(path.join(GLOBAL_SKILLS_DIR, 'acme-tool', 'SKILL.md'))
    const one = await api('/api/skills/acme-tool')
    expect(one).toMatchObject({ status: 200, body: { skill: { dirName: 'acme-tool', name: 'acme-tool', content: SKILL, location: '' } } })
    expect(one.asOf).toBeTruthy()
    const v1 = await api('/api/v1/skills/acme-tool')
    expect(v1.body.skill.description).toBe('How to run the Acme tool')
    const list = await api('/api/skills')
    expect(list.body.skills.find((s: { dirName: string }) => s.dirName === 'acme-tool')?.content).toBe(SKILL)
    const v1list = await api('/api/v1/skills')
    const row = v1list.body.skills.find((s: { dirName: string }) => s.dirName === 'acme-tool')
    expect(row).toBeTruthy()
    expect(row.content).toBeUndefined()
    expect((await api('/api/skills/no-such-skill')).status).toBe(404)
    expect((await api('/api/v1/skills/no-such-skill')).body).toMatchObject({ error: { code: 'not_found' } })
    // Its references are the box's own files.
    expect((await api('/api/skills/acme-tool/references')).status).not.toBe(503)
  })

  it('every skill write needs the Mac', async () => {
    const writes: Array<[string, string, unknown]> = [
      ['POST', '/api/skills', { dirName: 'new-skill', content: '# New' }],
      ['PUT', '/api/skills/acme-tool', { content: '# Changed' }],
      ['PATCH', '/api/skills/acme-tool', { enabled: false }],
      ['DELETE', '/api/skills/acme-tool', undefined],
      ['POST', '/api/v1/skills', { dirName: 'new-skill', content: '# New' }],
      ['PUT', '/api/v1/skills/acme-tool', { content: '# Changed' }],
      ['DELETE', '/api/v1/skills/acme-tool', undefined],
    ]
    for (const [method, p, body] of writes) {
      const r = await api(p, { method, ...(body ? { body: JSON.stringify(body) } : {}) })
      expect({ p, method, status: r.status, why: r.body.error?.why }).toEqual({ p, method, status: 503, why: 'skill_changes_need_mac' })
    }
    await expect(fs.stat(path.join(GLOBAL_SKILLS_DIR, 'new-skill'))).rejects.toThrow()
  })
})

describe('note resolve on the box', () => {
  it('answers from the copy by id, path and title', async () => {
    const id = withId('Acme/launch-plan.md', '').match(/id: (\S+)/)![1]
    // The disk loses the note: the answer still comes from the copy.
    await fs.rm(path.join(NOTES_DIR, 'Acme/launch-plan.md'))
    expect((await api(`/api/v1/notes/resolve?ref=${id}`)).body).toEqual({ id, path: 'Acme/launch-plan.md', title: null, matchedBy: 'id' })
    expect((await api('/api/v1/notes/resolve?ref=Acme/launch-plan')).body).toMatchObject({ id, path: 'Acme/launch-plan.md', matchedBy: 'path' })
    expect((await api('/api/v1/notes/resolve?ref=Acme%20launch%20plan')).body).toMatchObject({ path: 'Acme/launch-plan.md', matchedBy: 'name' })
    const both = await api('/api/v1/notes/resolve?ref=vendors')
    expect(both).toMatchObject({ status: 409, body: { error: { code: 'conflict' } } })
    expect((await api('/api/v1/notes/resolve?ref=n_nosuchnote00')).body).toMatchObject({ error: { code: 'not_found' } })
  })
})
