/**
 * Stage 4a of docs/plan/walnut-companion-unified-replica.md on a real CLOUD_MODE
 * server: the Mac's notes, memory and skills round (core/host-replica.ts
 * syncCompanionHostReplica, the round a host daemon gets) reaches the companion
 * over the real client (cloud-ingest.ts postToCloudHostReplica: machine token,
 * gzip) and the real door (web/routes/bridge-host-replica.ts), into the box's
 * copy store (core/companion-host-replica.ts, `cache/replica/host/`).
 *
 * Pinned:
 *   - the door: only the Mac's machine credential passes; a bad command is a 400;
 *   - a first round brings every note, MEMORY.md and USER.md, and the skills, with
 *     each note's title; the copy answers the reads a host answers from it
 *     (note_read, note_search, memory_read);
 *   - the box's own files are not touched by a round (the notes git sync wrote);
 *   - a note changed on the Mac goes again alone; a removed one leaves the copy;
 *     an unchanged round sends nothing;
 *   - the memo ends when the box says a kind never arrived whole (a new box);
 *   - an older companion without the door rests the lane for 10 minutes, and a
 *     changed build ends that rest;
 *   - 4b: before the copy is held the box's notes reads are its disk's; once held,
 *     the v2 and v1 reads (tree, content) take the copy, with `x-walnut-copy-as-of`,
 *     and a search stays the box's own;
 *   - 4c: once the Mac drains `note`, a v2 save, a v1 create and a v1 delete are
 *     `note` records in the journal (the disk untouched), shown at once over the
 *     copy; a stale lock hash is a 409 with the text the box shows; after the ack
 *     the box keeps showing its text until a copy round from after the ack, then
 *     the Mac's.
 *
 * Both sides share one data dir: the "Mac's" notes are the files under NOTES_DIR,
 * which on the box are also what git sync wrote; the copy lives apart from them.
 */
import crypto from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import type { Server as HttpServer } from 'node:http'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { createMockConstants } from '../../helpers/mock-constants.js'

vi.mock('../../../src/constants.js', () => createMockConstants('walnut-companion-host-replica-cloud', { CLOUD_MODE: true }))

let bridgeCfg: { enabled: boolean; url?: string; token?: string } = { enabled: false }
vi.mock('../../../src/integrations/cloud-bridge-config.js', async (orig) => ({
  ...(await orig<typeof import('../../../src/integrations/cloud-bridge-config.js')>()),
  getBridgeConfigForHost: async () => bridgeCfg,
}))

import { MEMORY_FILE, NOTES_DIR, WALNUT_HOME } from '../../../src/constants.js'
import { startServer, stopServer } from '../../../src/web/server.js'
import { _resetDeviceAuthForTesting } from '../../../src/core/device-auth.js'
import { _resetCloudIngestForTesting, cloudHostReplicaAvailable, forgetCloudHostReplicaRest, postToCloudHostReplica } from '../../../src/core/cloud-ingest.js'
import { _resetHostReplicaForTesting, syncCompanionHostReplica, forgetCompanionHostReplica } from '../../../src/core/host-replica.js'
import {
  COMPANION_REPLICA_HOME, _resetCompanionHostReplicaForTesting, companionCopyHolds, companionHostReplica, companionHostReplicaDir,
} from '../../../src/core/companion-host-replica.js'
import { postToCloudJournal } from '../../../src/core/cloud-ingest.js'
import { companionJournalRecords } from '../../../src/core/companion-journal.js'
import { APPLIED_V2_KINDS } from '../../../src/core/offline-merge/apply-v2.js'

let server: HttpServer
let port = 0
const sha = (t: string) => crypto.createHash('sha256').update(t, 'utf-8').digest('hex')
const tok = () => crypto.randomBytes(16).toString('hex')
const T = { local: tok(), phone: tok() }
const HOME = COMPANION_REPLICA_HOME

async function door(body: unknown, token = T.local): Promise<{ status: number; body: Record<string, any> }> {
  const r = await fetch(`http://127.0.0.1:${port}/bridge/host-replica`, {
    method: 'POST',
    headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  return { status: r.status, body: await r.json().catch(() => ({})) as Record<string, any> }
}

/** A note's text with its id already stamped: the disk routes stamp a missing one, which would change the Mac's notes under the test. */
const withId = (rel: string, text: string): string => `---\nid: n_${crypto.createHash('sha1').update(rel).digest('hex').slice(0, 11)}\n---\n${text}`
async function writeNote(rel: string, text: string): Promise<void> {
  text = withId(rel, text)
  const file = path.join(NOTES_DIR, rel)
  await fs.mkdir(path.dirname(file), { recursive: true })
  await fs.writeFile(file, text)
}
async function api(p: string, init: RequestInit = {}): Promise<{ status: number; body: Record<string, any>; asOf: string | null }> {
  const r = await fetch(`http://127.0.0.1:${port}${p}`, {
    ...init,
    headers: { Authorization: `Bearer ${T.phone}`, ...(init.body ? { 'Content-Type': 'application/json' } : {}) },
  })
  return { status: r.status, body: await r.json().catch(() => ({})) as Record<string, any>, asOf: r.headers.get('x-walnut-copy-as-of') }
}
const noteRecords = () => companionJournalRecords().filter((r) => r.kind === 'note')
const sha12 = (t: string) => crypto.createHash('sha256').update(t).digest('hex').slice(0, 12)
const sentOf = (results: Array<{ kind: string; sent?: number; action: string }>, kind: string) => results.find((r) => r.kind === kind)

beforeAll(async () => {
  await fs.mkdir(WALNUT_HOME, { recursive: true })
  const now = new Date().toISOString()
  await fs.writeFile(path.join(WALNUT_HOME, 'auth.json'), JSON.stringify({ devices: [
    { name: 'my-phone', id: 'd00000000000000c3', tokenHash: sha(T.phone), createdAt: now },
    { name: 'bridge-local', id: 'd00000000000000d4', tokenHash: sha(T.local), createdAt: now, kind: 'machine' },
  ] }), { mode: 0o600 })
  await writeNote('Acme/launch-plan.md', '# Acme launch plan\n\nShip the beta on Friday.\n')
  await writeNote('Acme/vendors.md', '# Acme vendors\n\nCall the printer.\n')
  await writeNote('journal/2026-10-21.md', '# Tuesday\n\nNotes from the standup: caf\u00e9 budget approved (non-ASCII text).\n')
  await fs.mkdir(path.dirname(MEMORY_FILE), { recursive: true })
  await fs.writeFile(MEMORY_FILE, '# Memory\n\n- Acme launch is on Friday\n')
  _resetDeviceAuthForTesting()
  server = await startServer({ port: 0, dev: true })
  const addr = server.address()
  if (!addr || typeof addr === 'string') throw new Error('no port')
  port = addr.port
  bridgeCfg = { enabled: true, url: `ws://127.0.0.1:${port}/bridge`, token: T.local }
  _resetCloudIngestForTesting()
  _resetHostReplicaForTesting()
}, 60_000)

afterAll(async () => {
  await stopServer()
  await fs.rm(WALNUT_HOME, { recursive: true, force: true }).catch(() => {})
})

describe('the door', () => {
  it('only the Mac\'s machine credential passes; a bad command is a 400', async () => {
    expect((await door({ cmd: 'replica.status' }, '')).status).toBe(401)
    expect((await door({ cmd: 'replica.status' }, tok())).status).toBe(401)
    expect((await door({ cmd: 'replica.status' }, T.phone)).status).toBe(403)
    expect((await door({ cmd: 'replica.nope' })).status).toBe(400)
    expect(await door({ cmd: 'replica.status' })).toMatchObject({ status: 200, body: { ok: true, kinds: { notes: { entries: 0, asOf: null } } } })
  })
})

describe('the Mac\'s rounds', () => {
  it('before the copy is held, the box\'s notes reads are its disk\'s', async () => {
    const r = await api('/api/notes-v2/content/Acme/launch-plan.md')
    expect(r.status).toBe(200)
    expect(r.body.content).toContain('Ship the beta')
    expect(r.asOf).toBeNull()
  })

  it('a first round brings every note with its title, the memory docs and the skills', async () => {
    expect(companionCopyHolds('notes')).toBe(false)
    const before = await fs.readFile(path.join(NOTES_DIR, 'Acme/vendors.md'), 'utf8')
    const results = await syncCompanionHostReplica()
    expect(sentOf(results, 'notes')).toMatchObject({ action: 'synced', entries: 3, sent: 3 })
    expect(sentOf(results, 'memory')).toMatchObject({ action: 'synced', sent: 1 }) // MEMORY.md (no USER.md here)
    expect(sentOf(results, 'skills')?.action).toBe('synced')
    expect(companionCopyHolds('notes')).toBe(true)
    const r = companionHostReplica()!
    const list = r.list(HOME, 'notes')!
    expect(list.entries.map((e) => e.k).sort()).toEqual(['Acme/launch-plan.md', 'Acme/vendors.md', 'journal/2026-10-21.md'])
    expect(list.entries.find((e) => e.k === 'Acme/launch-plan.md')?.m).toMatchObject({ title: 'Acme launch plan' })
    expect(r.read(HOME, 'notes', 'journal/2026-10-21.md')?.body).toContain('caf\u00e9 budget')
    // The reads a host answers from its copy.
    const read = r.answer(HOME, 'note_read', { path: 'Acme/vendors.md' }, 'test')
    expect(read).toMatchObject({ ok: true })
    const search = r.answer(HOME, 'note_search', { q: 'printer' }, 'test') as { ok: true; result: { results: Array<{ path: string }> } }
    expect(search.ok).toBe(true)
    expect(JSON.stringify(search.result)).toContain('Acme/vendors')
    const memory = r.answer(HOME, 'memory_read', { doc: 'global' }, 'test')
    expect(JSON.stringify(memory)).toContain('Acme launch is on Friday')
    // The copy is apart from the box's own files.
    expect(await fs.readFile(path.join(NOTES_DIR, 'Acme/vendors.md'), 'utf8')).toBe(before)
    expect((await fs.stat(companionHostReplicaDir())).isDirectory()).toBe(true)
  })

  it('an unchanged round sends nothing; a changed note goes alone; a removed one leaves the copy', async () => {
    const quiet = await syncCompanionHostReplica()
    expect(quiet.every((r) => r.action === 'unchanged')).toBe(true)
    await writeNote('Acme/vendors.md', '# Acme vendors\n\nCall the printer, then the caterer.\n')
    await fs.rm(path.join(NOTES_DIR, 'journal/2026-10-21.md'))
    const results = await syncCompanionHostReplica()
    expect(sentOf(results, 'notes')).toMatchObject({ action: 'synced', entries: 2, sent: 1 })
    const r = companionHostReplica()!
    expect(r.read(HOME, 'notes', 'Acme/vendors.md')?.body).toContain('the caterer')
    expect(r.read(HOME, 'notes', 'journal/2026-10-21.md')).toBeNull()
  })

  it('a copy that never arrived whole (a new box) gets its rounds again, memo or not', async () => {
    await fs.rm(companionHostReplicaDir(), { recursive: true, force: true })
    _resetCompanionHostReplicaForTesting()
    expect(companionCopyHolds('notes')).toBe(false)
    const results = await syncCompanionHostReplica()
    expect(sentOf(results, 'notes')).toMatchObject({ action: 'synced', sent: 2 })
    expect(companionCopyHolds('notes')).toBe(true)
    expect(companionCopyHolds('memory')).toBe(true)
  })

  it('the copy is read back from disk by a new process', async () => {
    _resetCompanionHostReplicaForTesting()
    expect(companionHostReplica()!.read(HOME, 'notes', 'Acme/launch-plan.md')?.body).toContain('Ship the beta')
  })
})

describe('the box\'s notes reads and saves (4b, 4c)', () => {
  it('the reads take the copy once it is held; a search stays the box\'s own', async () => {
    // The disk moves on without a round: the reads still show the copy.
    await writeNote('Acme/launch-plan.md', '# Acme launch plan\n\nDisk only: never sent.\n')
    const tree = await api('/api/notes-v2/')
    expect(JSON.stringify(tree.body)).toContain('launch-plan')
    expect(tree.asOf).toBeTruthy()
    const v2 = await api('/api/notes-v2/content/Acme/launch-plan.md')
    expect(v2.status).toBe(200)
    expect(v2.body.content).toContain('Ship the beta')
    expect(v2.asOf).toBeTruthy()
    const v1 = await api('/api/v1/notes/content/Acme/launch-plan.md')
    expect(v1.status).toBe(200)
    expect(v1.body.content).toContain('Ship the beta')
    const search = await api('/api/notes-v2/search?q=printer')
    expect(search.body.degraded).not.toBe('offline-keyword')
    await writeNote('Acme/launch-plan.md', '# Acme launch plan\n\nShip the beta on Friday.\n')
  })

  it('before the Mac drains notes, a save takes the old path (the disk)', async () => {
    const put = await api('/api/notes-v2/content/Acme/scratch.md', { method: 'PUT', body: JSON.stringify({ content: '# Scratch\n\nOld path.\n' }) })
    expect(put.status).toBe(200)
    expect(await fs.readFile(path.join(NOTES_DIR, 'Acme/scratch.md'), 'utf8')).toContain('Old path.')
    expect(noteRecords()).toEqual([])
    await fs.rm(path.join(NOTES_DIR, 'Acme/scratch.md'))
  })

  it('once the Mac drains notes, saves are journal records shown over the copy; the disk is untouched', async () => {
    await postToCloudJournal('offline.drain', { home: '/Users/someone/.open-walnut', kinds: [...APPLIED_V2_KINDS] })
    const disk = await fs.readFile(path.join(NOTES_DIR, 'Acme/vendors.md'), 'utf8')
    const before = await api('/api/notes-v2/content/Acme/vendors.md')
    const text = withId('Acme/vendors.md', '# Acme vendors\n\nCall the printer, then the caterer, then the florist.\n')
    const put = await api('/api/notes-v2/content/Acme/vendors.md', { method: 'PUT', body: JSON.stringify({ content: text, expectedHash: before.body.contentHash }) })
    expect(put).toMatchObject({ status: 200, body: { ok: true, contentHash: sha12(text) } })
    expect(noteRecords().map((r) => `${r.path}:${r.mode}`)).toEqual(['Acme/vendors.md:put'])
    expect(await fs.readFile(path.join(NOTES_DIR, 'Acme/vendors.md'), 'utf8')).toBe(disk)
    expect((await api('/api/notes-v2/content/Acme/vendors.md')).body.content).toBe(text)
    expect((await api('/api/v1/notes/content/Acme/vendors.md')).body.content).toBe(text)
    // A stale lock: 409 with what this box shows, so the editor merges.
    const stale = await api('/api/notes-v2/content/Acme/vendors.md', { method: 'PUT', body: JSON.stringify({ content: 'x', expectedHash: before.body.contentHash }) })
    expect(stale.status).toBe(409)
    expect(stale.body).toMatchObject({ currentHash: sha12(text), serverContent: text })
    // A v1 create, then its delete.
    const created = await api('/api/v1/notes', { method: 'POST', body: JSON.stringify({ path: 'Acme/new-idea', content: '# New idea\n\nA kiosk.\n' }) })
    expect(created).toMatchObject({ status: 201, body: { path: 'Acme/new-idea.md' } })
    expect((await api('/api/v1/notes/content/Acme/new-idea.md')).body.content).toContain('A kiosk.')
    expect((await api('/api/v1/notes', { method: 'POST', body: JSON.stringify({ path: 'Acme/new-idea', content: 'again' }) })).status).toBe(409)
    expect((await api('/api/v1/notes/Acme/new-idea.md', { method: 'DELETE' })).status).toBe(200)
    expect((await api('/api/v1/notes/content/Acme/new-idea.md')).status).toBe(404)
    await expect(fs.stat(path.join(NOTES_DIR, 'Acme/new-idea.md'))).rejects.toThrow()
    // A round meanwhile (the Mac has not taken them) replaces nothing the box holds.
    await syncCompanionHostReplica()
    expect((await api('/api/notes-v2/content/Acme/vendors.md')).body.content).toBe(text)
  })

  it('after the ack the box shows its text until a copy round from after the ack, then the Mac\'s', async () => {
    const drained = await postToCloudJournal('offline.drain', { home: '/x', kinds: [...APPLIED_V2_KINDS] })
    const seqs = (drained.records as Array<{ seq: number; kind: string }>).filter((r) => r.kind === 'note').map((r) => r.seq)
    expect(seqs.length).toBeGreaterThan(0)
    const macNow = Date.now()
    expect(await postToCloudJournal('offline.ack', { home: '/x', seqs, now: macNow })).toMatchObject({ ok: true })
    expect(noteRecords()).toEqual([])
    const text = withId('Acme/vendors.md', '# Acme vendors\n\nCall the printer, then the caterer, then the florist.\n')
    expect((await api('/api/notes-v2/content/Acme/vendors.md')).body.content).toBe(text)
    // The Mac merged it with an edit of its own; its next round brings that.
    await new Promise((r) => setTimeout(r, 5))
    const merged = `${text}\nAdded on the Mac.\n`
    await fs.writeFile(path.join(NOTES_DIR, 'Acme/vendors.md'), merged)
    forgetCompanionHostReplica()
    await syncCompanionHostReplica()
    expect((await api('/api/notes-v2/content/Acme/vendors.md')).body.content).toBe(merged)
  })
})

describe('an older companion', () => {
  it('a box without the door rests the lane for 10 minutes; a changed build ends the rest', async () => {
    const realUrl = bridgeCfg.url
    // A server that answers every path with an app shell, as an old build's SPA fallback does.
    const http = await import('node:http')
    const old = http.createServer((_req, res) => { res.writeHead(200, { 'Content-Type': 'text/html' }); res.end('<!doctype html><title>app</title>') })
    await new Promise<void>((r) => old.listen(0, '127.0.0.1', r))
    const oldPort = (old.address() as { port: number }).port
    try {
      _resetCloudIngestForTesting()
      bridgeCfg = { ...bridgeCfg, url: `ws://127.0.0.1:${oldPort}/bridge` }
      expect(await postToCloudHostReplica('replica.status', {})).toMatchObject({ ok: false, errorKind: 'unsupported' })
      expect(await cloudHostReplicaAvailable()).toBe(false)
      expect(await syncCompanionHostReplica()).toEqual([])
      // The companion updated (companion-build/mac.ts companionBuildChanged): asked again at once.
      bridgeCfg = { ...bridgeCfg, url: realUrl }
      _resetCloudIngestForTesting()
      forgetCloudHostReplicaRest()
      forgetCompanionHostReplica()
      expect(await cloudHostReplicaAvailable()).toBe(true)
      const results = await syncCompanionHostReplica()
      expect(results.map((r) => r.action)).not.toContain('failed')
    } finally {
      bridgeCfg = { ...bridgeCfg, url: realUrl }
      await new Promise<void>((r) => old.close(() => r()))
    }
  })
})
