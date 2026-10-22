/**
 * Stage 4d of docs/plan/walnut-companion-unified-replica.md on a real CLOUD_MODE server:
 * the box's notes stop depending on its git-written disk. Its notes search, global notes
 * and diary context read its copy of the Mac's notes (core/companion-notes.ts), it keeps
 * no notes index of its own (boot rows notes-indexer and notes-watcher are the Mac's),
 * and whatever it cannot read from the copy or journal for the Mac needs the Mac.
 *
 * Pinned:
 *   - before the copy is held: the notes reads (v2 and v1), a save, a search and the
 *     global notes answer 503 needs_leader `kind_not_copied`, the disk untouched; the
 *     diary context says the diary is on the Mac;
 *   - the box never stamps an id into a note on its disk: no index file, a reconcile is a
 *     no-op, the index write routes need the Mac;
 *   - a search (v2 and v1) is a keyword search of the copy with the box's pending saves,
 *     in the string bands, with folder rows counted in the copy;
 *   - the global notes read the copy (web and v1); a save is a `note` record for
 *     `global-notes.md`, shown at once, a stale lock a 409 with the hash the box shows;
 *   - the diary context reads the newest dated entries of the copy;
 *   - with a Mac that does not drain notes, every note change (save, create, move, paste,
 *     the global notes) needs the Mac (`mac_too_old`), never the box's disk.
 *
 * Both sides share one data dir: the "Mac's" notes are the files under NOTES_DIR.
 */
import crypto from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import type { Server as HttpServer } from 'node:http'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { createMockConstants } from '../../helpers/mock-constants.js'

vi.mock('../../../src/constants.js', () => createMockConstants('walnut-companion-notes-docs-cloud', { CLOUD_MODE: true }))

let bridgeCfg: { enabled: boolean; url?: string; token?: string } = { enabled: false }
vi.mock('../../../src/integrations/cloud-bridge-config.js', async (orig) => ({
  ...(await orig<typeof import('../../../src/integrations/cloud-bridge-config.js')>()),
  getBridgeConfigForHost: async () => bridgeCfg,
}))

import { NOTES_DIR, WALNUT_HOME } from '../../../src/constants.js'
import { startServer, stopServer } from '../../../src/web/server.js'
import { _resetDeviceAuthForTesting } from '../../../src/core/device-auth.js'
import { _resetCloudIngestForTesting, postToCloudJournal } from '../../../src/core/cloud-ingest.js'
import { _resetHostReplicaForTesting, syncCompanionHostReplica } from '../../../src/core/host-replica.js'
import { _resetAttachmentReplicaForTesting } from '../../../src/core/attachment-replica.js'
import { companionCopyHolds } from '../../../src/core/companion-host-replica.js'
import { companionJournalRecords } from '../../../src/core/companion-journal.js'
import { APPLIED_V2_KINDS } from '../../../src/core/offline-merge/apply-v2.js'
import { NOTES_INDEX_PATH } from '../../../src/core/notes-index.js'
import { reconcileNoteNow } from '../../../src/core/notes-indexer.js'
import { stampAllIds } from '../../../src/core/notes-identity.js'
import { loadContextSources } from '../../../src/core/context-sources.js'
import type { AgentDefinition } from '../../../src/core/types.js'

let server: HttpServer
let port = 0
const sha = (t: string) => crypto.createHash('sha256').update(t, 'utf-8').digest('hex')
const sha12 = (t: string) => crypto.createHash('sha256').update(t).digest('hex').slice(0, 12)
const tok = () => crypto.randomBytes(16).toString('hex')
const T = { local: tok(), phone: tok() }

const withId = (rel: string, text: string): string => `---\nid: n_${crypto.createHash('sha1').update(rel).digest('hex').slice(0, 11)}\n---\n${text}`
const disk = (rel: string) => fs.readFile(path.join(NOTES_DIR, rel), 'utf8').catch(() => null)
async function writeNote(rel: string, text: string, stamp = true): Promise<void> {
  const file = path.join(NOTES_DIR, rel)
  await fs.mkdir(path.dirname(file), { recursive: true })
  await fs.writeFile(file, stamp ? withId(rel, text) : text)
}
async function api(p: string, init: RequestInit = {}): Promise<{ status: number; body: Record<string, any> }> {
  const r = await fetch(`http://127.0.0.1:${port}${p}`, {
    ...init,
    headers: { Authorization: `Bearer ${T.phone}`, ...(init.body ? { 'Content-Type': 'application/json' } : {}) },
  })
  return { status: r.status, body: await r.json().catch(() => ({})) as Record<string, any> }
}
const put = (p: string, body: unknown) => api(p, { method: 'PUT', body: JSON.stringify(body) })
const post = (p: string, body: unknown) => api(p, { method: 'POST', body: JSON.stringify(body) })
const why = (r: { status: number; body: Record<string, any> }) => ({ status: r.status, why: r.body.error?.why })
const noteRecords = () => companionJournalRecords().filter((r) => r.kind === 'note')
const mentor = { id: 'mentor', name: 'Mentor', context_sources: [{ id: 'journal_recent', enabled: true }] } as unknown as AgentDefinition
const GLOBAL = '# Scratch\n\nCall the venue.\n'

beforeAll(async () => {
  await fs.mkdir(WALNUT_HOME, { recursive: true })
  const now = new Date().toISOString()
  await fs.writeFile(path.join(WALNUT_HOME, 'auth.json'), JSON.stringify({ devices: [
    { name: 'my-phone', id: 'd00000000000000c3', tokenHash: sha(T.phone), createdAt: now },
    { name: 'bridge-local', id: 'd00000000000000d4', tokenHash: sha(T.local), createdAt: now, kind: 'machine' },
  ] }), { mode: 0o600 })
  await writeNote('Acme/launch-plan.md', '# Acme launch plan\n\nShip the beta on Friday.\n')
  await writeNote('Acme/vendors.md', '# Acme vendors\n\nCall the printer.\n')
  await writeNote('Beta/vendors.md', '# Beta vendors\n\nCall the florist about the tulips.\n')
  await writeNote('journal/Dairy/2026-10-19.md', 'Sunday: a long walk.\n')
  await writeNote('journal/Dairy/2026-10-20.md', 'Monday: the florist called back.\n')
  await writeNote('journal/Dairy/ideas.md', 'Not a dated entry.\n')
  await fs.writeFile(path.join(NOTES_DIR, 'global-notes.md'), GLOBAL)
  _resetDeviceAuthForTesting()
  server = await startServer({ port: 0, dev: true })
  const addr = server.address()
  if (!addr || typeof addr === 'string') throw new Error('no port')
  port = addr.port
  bridgeCfg = { enabled: true, url: `ws://127.0.0.1:${port}/bridge`, token: T.local }
  _resetCloudIngestForTesting()
  _resetHostReplicaForTesting()
  _resetAttachmentReplicaForTesting()
}, 60_000)

afterAll(async () => {
  _resetAttachmentReplicaForTesting()
  await stopServer()
  await fs.rm(WALNUT_HOME, { recursive: true, force: true }).catch(() => {})
})

describe('before the copy is held', () => {
  it('the notes reads, a save, a search and the global notes need the Mac; the disk is untouched', async () => {
    expect(companionCopyHolds('notes')).toBe(false)
    const reads = [
      await api('/api/notes-v2/'),
      await api('/api/notes-v2/content/Acme/launch-plan.md'),
      await api('/api/notes-v2/tags'),
      await api('/api/v1/notes/content/Acme/launch-plan.md'),
      await api('/api/v1/notes/resolve?ref=vendors'),
      await api('/api/notes-v2/search?q=florist'),
      await api('/api/v1/notes/search?q=florist'),
      await api('/api/notes/global'),
      await api('/api/v1/notes/global'),
    ]
    for (const r of reads) expect(why(r)).toEqual({ status: 503, why: 'kind_not_copied' })
    const writes = [
      await put('/api/notes-v2/content/Acme/launch-plan.md', { content: 'x' }),
      await post('/api/v1/notes', { path: 'Acme/new', content: 'x' }),
      await post('/api/notes-v2/move', { from: 'Acme/vendors.md', to: 'Acme/old.md' }),
      await put('/api/notes/global', { content: 'x' }),
    ]
    for (const r of writes) expect(why(r)).toEqual({ status: 503, why: 'kind_not_copied' })
    expect(await disk('Acme/launch-plan.md')).toContain('Ship the beta')
    expect(await disk('Acme/old.md')).toBeNull()
    expect(await disk('global-notes.md')).toBe(GLOBAL)
    expect(await loadContextSources(mentor, {})).toContain('the diary is on your Mac')
  })
})

describe('no notes index on the box', () => {
  it('nothing stamps an id into a note on the box\'s disk; the index writes need the Mac', async () => {
    const raw = '# Raw\n\nWritten by git sync without an id.\n'
    await writeNote('Acme/raw.md', raw, false)
    expect(await reconcileNoteNow('Acme/raw.md')).toBeNull()
    expect(await stampAllIds()).toMatchObject({ stamped: 0 })
    expect(why(await post('/api/notes-v2/index/stamp-ids', {}))).toEqual({ status: 503, why: 'notes_index_is_the_macs' })
    expect(why(await post('/api/notes-v2/index/rebuild', {}))).toEqual({ status: 503, why: 'notes_index_is_the_macs' })
    expect(await disk('Acme/raw.md')).toBe(raw)
    await expect(fs.stat(NOTES_INDEX_PATH)).rejects.toThrow()
    await fs.rm(path.join(NOTES_DIR, 'Acme/raw.md'))
  })
})

describe('once the copy is held', () => {
  it('a search is a keyword search of the copy, with the box\'s saves and folder rows (v2 and v1)', async () => {
    await syncCompanionHostReplica()
    expect(companionCopyHolds('notes')).toBe(true)
    await postToCloudJournal('offline.drain', { home: '/x', kinds: [...APPLIED_V2_KINDS] })
    // The disk loses a note without a round: the copy still finds it.
    await fs.rm(path.join(NOTES_DIR, 'Beta/vendors.md'))
    const v2 = await api('/api/notes-v2/search?q=florist&mode=string')
    expect(v2.status).toBe(200)
    expect(v2.body.results.map((r: { path: string }) => r.path)).toEqual(expect.arrayContaining(['Beta/vendors.md', 'journal/Dairy/2026-10-20.md']))
    const hit = v2.body.results.find((r: { path: string }) => r.path === 'Beta/vendors.md')
    expect(hit).toMatchObject({ matchType: 'exact', title: 'Beta vendors' })
    expect(hit.snippet).toContain('<mark>')
    // A title holding the whole query ranks first.
    const title = await api('/api/notes-v2/search?q=launch%20plan&mode=string')
    expect(title.body.results[0]).toMatchObject({ path: 'Acme/launch-plan.md' })
    // A folder whose name holds the query, its notes counted in the copy.
    const folder = await api('/api/notes-v2/search?q=acme&mode=string')
    expect(folder.body.folders).toEqual(expect.arrayContaining([expect.objectContaining({ path: 'Acme', noteCount: 2 })]))
    // A save on the box is found at once.
    const before = await api('/api/notes-v2/content/Acme/vendors.md')
    const text = withId('Acme/vendors.md', '# Acme vendors\n\nCall the printer and the caterer.\n')
    expect((await put('/api/notes-v2/content/Acme/vendors.md', { content: text, expectedHash: before.body.contentHash })).status).toBe(200)
    const saved = await api('/api/v1/notes/search?q=caterer&mode=string')
    expect(saved.body.results.map((r: { path: string }) => r.path)).toEqual(['Acme/vendors.md'])
    await expect(fs.stat(NOTES_INDEX_PATH)).rejects.toThrow()
    await writeNote('Beta/vendors.md', '# Beta vendors\n\nCall the florist about the tulips.\n')
  })

  it('the global notes read the copy; a save is a note record shown at once; a stale lock is a 409', async () => {
    await fs.writeFile(path.join(NOTES_DIR, 'global-notes.md'), 'Disk only, never sent.\n')
    const web = await api('/api/notes/global')
    expect(web).toMatchObject({ status: 200, body: { content: GLOBAL, contentHash: sha12(GLOBAL) } })
    expect((await api('/api/v1/notes/global')).body.content).toBe(GLOBAL)
    const next = `${GLOBAL}Book the hall.\n`
    expect(await put('/api/notes/global', { content: next, expectedHash: web.body.contentHash })).toMatchObject({ status: 200, body: { ok: true, contentHash: sha12(next) } })
    expect(noteRecords().filter((r) => r.path === 'global-notes.md').map((r) => r.mode)).toEqual(['put'])
    expect(await disk('global-notes.md')).toBe('Disk only, never sent.\n')
    expect((await api('/api/notes/global')).body.content).toBe(next)
    expect((await api('/api/v1/notes/global')).body.content).toBe(next)
    const stale = await put('/api/notes/global', { content: 'x', expectedHash: web.body.contentHash })
    expect(stale).toMatchObject({ status: 409, body: { currentHash: sha12(next) } })
    const staleV1 = await put('/api/v1/notes/global', { content: 'x', expectedHash: web.body.contentHash })
    expect(staleV1).toMatchObject({ status: 409, body: { error: { code: 'conflict' }, currentHash: sha12(next) } })
    await fs.writeFile(path.join(NOTES_DIR, 'global-notes.md'), GLOBAL)
  })

  it('the diary context reads the newest dated entries of the copy', async () => {
    await fs.rm(path.join(NOTES_DIR, 'journal/Dairy/2026-10-20.md'))
    const ctx = await loadContextSources(mentor, {})
    expect(ctx).toContain('--- 2026-10-20 ---')
    expect(ctx).toContain('the florist called back')
    expect(ctx).toContain('--- 2026-10-19 ---')
    expect(ctx).not.toContain('Not a dated entry')
    expect(ctx.indexOf('2026-10-20')).toBeLessThan(ctx.indexOf('2026-10-19'))
    await writeNote('journal/Dairy/2026-10-20.md', 'Monday: the florist called back.\n')
  })

  it('with a Mac that does not drain notes, every note change needs the Mac; the disk is untouched', async () => {
    await postToCloudJournal('offline.drain', { home: '/x', kinds: APPLIED_V2_KINDS.filter((k) => k !== 'note') })
    const answers = [
      await put('/api/notes-v2/content/Acme/launch-plan.md', { content: 'x' }),
      await post('/api/v1/notes', { path: 'Acme/new', content: 'x' }),
      await post('/api/notes-v2/move', { from: 'Acme/launch-plan.md', to: 'Acme/plan.md' }),
      await post('/api/notes-v2/attachment', { notePath: 'Acme/launch-plan.md', data: Buffer.from('png').toString('base64'), mediaType: 'image/png' }),
      await put('/api/notes/global', { content: 'x' }),
      await put('/api/v1/notes/global', { content: 'x' }),
    ]
    for (const r of answers) expect(why(r)).toEqual({ status: 503, why: 'mac_too_old' })
    expect(await disk('Acme/launch-plan.md')).toContain('Ship the beta')
    expect(await disk('Acme/plan.md')).toBeNull()
    await expect(fs.stat(path.join(NOTES_DIR, 'Acme/_attachment'))).rejects.toThrow()
    // The reads still take the copy.
    expect((await api('/api/notes-v2/content/Acme/launch-plan.md')).body.content).toContain('Ship the beta')
  })
})
