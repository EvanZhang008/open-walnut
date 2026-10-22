/**
 * Stage 4d of docs/plan/walnut-companion-unified-replica.md on a real CLOUD_MODE server:
 * the box's other note paths while its copy of the notes is held and the Mac drains
 * notes (core/companion-note-paths.ts, replica/companion-note-writes.ts).
 *
 * Pinned:
 *   - before the Mac drains `note-move`, a move needs the Mac (`mac_too_old`), the box's
 *     disk untouched;
 *   - once it does, a v2 or v1 move is one `note-move` record with the note's id (the
 *     disk untouched), shown at once at its new path (content, tree, resolve) and gone
 *     from the old one; the route's own errors (no source 404, a taken path 409, a
 *     case-only rename 409 as on the Mac's disk, 400) in each route's shape; a save at
 *     the new path and a new note at the old one are their own records after the move;
 *     a round meanwhile changes nothing the box shows; after the ack the box shows the
 *     moves until a copy round from after the ack, then the Mac's;
 *   - a tag rename is a `note` save of every note that carries it, as the box shows it
 *     (frontmatter and inline); the tags read shows it at once; a copy that leaves a
 *     note out (too large) answers needs_leader `tag_rename_needs_mac`;
 *   - making or deleting a folder (web and v1) is needs_leader `folder_changes_need_mac`;
 *   - moving or deleting a picture (web and v1) is needs_leader `attachment_changes_need_mac`;
 *     before the Mac drains `note-attachment` a paste needs the Mac; once it does, a paste
 *     is a record with its bytes, never written to the box's disk, shown at once (web and
 *     v1, the route's own errors); when the journal refuses it the paste fails, nothing kept.
 *
 * Both sides share one data dir: the "Mac's" notes are the files under NOTES_DIR.
 */
import crypto from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import type { Server as HttpServer } from 'node:http'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { createMockConstants } from '../../helpers/mock-constants.js'

vi.mock('../../../src/constants.js', () => createMockConstants('walnut-companion-note-paths-cloud', { CLOUD_MODE: true }))

let bridgeCfg: { enabled: boolean; url?: string; token?: string } = { enabled: false }
vi.mock('../../../src/integrations/cloud-bridge-config.js', async (orig) => ({
  ...(await orig<typeof import('../../../src/integrations/cloud-bridge-config.js')>()),
  getBridgeConfigForHost: async () => bridgeCfg,
}))

import { NOTES_DIR, WALNUT_HOME } from '../../../src/constants.js'
import { startServer, stopServer } from '../../../src/web/server.js'
import { _resetDeviceAuthForTesting } from '../../../src/core/device-auth.js'
import { _resetCloudIngestForTesting, postToCloudJournal } from '../../../src/core/cloud-ingest.js'
import { _resetHostReplicaForTesting, forgetCompanionHostReplica, syncCompanionHostReplica } from '../../../src/core/host-replica.js'
import { companionCopyHolds } from '../../../src/core/companion-host-replica.js'
import { companionJournalDir, companionJournalRecords } from '../../../src/core/companion-journal.js'
import { APPLIED_V2_KINDS } from '../../../src/core/offline-merge/apply-v2.js'

let server: HttpServer
let port = 0
const sha = (t: string) => crypto.createHash('sha256').update(t, 'utf-8').digest('hex')
const tok = () => crypto.randomBytes(16).toString('hex')
const T = { local: tok(), phone: tok() }

/** A note's id as the test stamps it (the disk routes stamp a missing one). */
const idOf = (rel: string) => `n_${crypto.createHash('sha1').update(rel).digest('hex').slice(0, 11)}`
const withId = (rel: string, text: string, extra = ''): string => `---\nid: ${idOf(rel)}\n${extra}---\n${text}`
const disk = (rel: string) => fs.readFile(path.join(NOTES_DIR, rel), 'utf8').catch(() => null)
async function writeNote(rel: string, text: string, extra = ''): Promise<void> {
  const file = path.join(NOTES_DIR, rel)
  await fs.mkdir(path.dirname(file), { recursive: true })
  await fs.writeFile(file, withId(rel, text, extra))
}
async function api(p: string, init: RequestInit = {}): Promise<{ status: number; body: Record<string, any> }> {
  const r = await fetch(`http://127.0.0.1:${port}${p}`, {
    ...init,
    headers: { Authorization: `Bearer ${T.phone}`, ...(init.body ? { 'Content-Type': 'application/json' } : {}) },
  })
  return { status: r.status, body: await r.json().catch(() => ({})) as Record<string, any> }
}
const post = (p: string, body: unknown) => api(p, { method: 'POST', body: JSON.stringify(body) })
const records = () => companionJournalRecords().filter((r) => r.kind === 'note' || r.kind === 'note-move')
const round = async () => { forgetCompanionHostReplica(); await syncCompanionHostReplica() }

const PLAN = '# Acme launch plan\n\nShip the beta on Friday.\n'

beforeAll(async () => {
  await fs.mkdir(WALNUT_HOME, { recursive: true })
  const now = new Date().toISOString()
  await fs.writeFile(path.join(WALNUT_HOME, 'auth.json'), JSON.stringify({ devices: [
    { name: 'my-phone', id: 'd00000000000000c3', tokenHash: sha(T.phone), createdAt: now },
    { name: 'bridge-local', id: 'd00000000000000d4', tokenHash: sha(T.local), createdAt: now, kind: 'machine' },
  ] }), { mode: 0o600 })
  await writeNote('Acme/launch-plan.md', PLAN)
  await writeNote('Acme/vendors.md', '# Acme vendors\n\nCall the printer.\n')
  await writeNote('Beta/vendors.md', '# Beta vendors\n\nCall the florist. #fair\n')
  await writeNote('Beta/budget.md', '# Beta budget\n\nTwo stands.\n', 'tags: [fair, money]\n')
  await fs.mkdir(path.join(NOTES_DIR, '_attachment'), { recursive: true })
  await fs.writeFile(path.join(NOTES_DIR, '_attachment/logo.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]))
  _resetDeviceAuthForTesting()
  server = await startServer({ port: 0, dev: true })
  const addr = server.address()
  if (!addr || typeof addr === 'string') throw new Error('no port')
  port = addr.port
  bridgeCfg = { enabled: true, url: `ws://127.0.0.1:${port}/bridge`, token: T.local }
  _resetCloudIngestForTesting()
  _resetHostReplicaForTesting()
  await syncCompanionHostReplica()
  expect(companionCopyHolds('notes')).toBe(true)
}, 60_000)

afterAll(async () => {
  await stopServer()
  await fs.rm(WALNUT_HOME, { recursive: true, force: true }).catch(() => {})
})

describe('a note move on the box', () => {
  it('before the Mac drains note-move, a move needs the Mac; the disk is untouched', async () => {
    await postToCloudJournal('offline.drain', { home: '/x', kinds: APPLIED_V2_KINDS.filter((k) => k !== 'note-move') })
    expect(await post('/api/notes-v2/move', { from: 'Acme/vendors.md', to: 'Acme/vendors-old.md' })).toMatchObject({ status: 503, body: { error: { code: 'needs_leader', why: 'mac_too_old' } } })
    expect(await disk('Acme/vendors-old.md')).toBeNull()
    expect(await disk('Acme/vendors.md')).toContain('Call the printer.')
    expect(records()).toEqual([])
  })

  it('once it does, a move is one record shown at once at its new path; the disk is untouched', async () => {
    await postToCloudJournal('offline.drain', { home: '/x', kinds: [...APPLIED_V2_KINDS] })
    const plan = withId('Acme/launch-plan.md', PLAN)
    // The tree is listed before the move (a list is reused for 2 seconds).
    expect(JSON.stringify((await api('/api/notes-v2/')).body)).toContain('launch-plan')
    expect(await post('/api/notes-v2/move', { from: 'Acme/launch-plan.md', to: 'Acme/Launch/plan.md' })).toMatchObject({ status: 200, body: { ok: true } })
    expect(records().map((r) => ({ kind: r.kind, from: r.from, to: r.to, noteId: r.noteId }))).toEqual([
      { kind: 'note-move', from: 'Acme/launch-plan.md', to: 'Acme/Launch/plan.md', noteId: idOf('Acme/launch-plan.md') },
    ])
    expect(await disk('Acme/launch-plan.md')).toBe(plan)
    expect(await disk('Acme/Launch/plan.md')).toBeNull()
    expect((await api('/api/notes-v2/content/Acme/Launch/plan.md')).body.content).toBe(plan)
    expect((await api('/api/notes-v2/content/Acme/launch-plan.md')).status).toBe(404)
    // The tree right away (not a list from before the move).
    const tree = JSON.stringify((await api('/api/notes-v2/')).body)
    expect(tree).toContain('Acme/Launch/plan.md')
    expect(tree).not.toContain('launch-plan')
    expect((await api(`/api/v1/notes/resolve?ref=${idOf('Acme/launch-plan.md')}`)).body).toMatchObject({ path: 'Acme/Launch/plan.md', matchedBy: 'id' })
    // The route's own errors, in each route's shape.
    expect(await post('/api/notes-v2/move', { from: 'Acme/launch-plan.md', to: 'Acme/x.md' })).toMatchObject({ status: 404, body: { error: 'Source note not found' } })
    expect(await post('/api/notes-v2/move', { from: 'Acme/vendors.md', to: 'Beta/vendors.md' })).toMatchObject({ status: 409, body: { error: 'Destination note already exists' } })
    expect(await post('/api/notes-v2/move', { from: 'Acme/vendors.md', to: 'Acme/Vendors.md' })).toMatchObject({ status: 409 })
    expect(await post('/api/v1/notes/move', { from: 'Acme/nope.md', to: 'Acme/x.md' })).toMatchObject({ status: 404, body: { error: { code: 'not_found' } } })
    expect(await post('/api/v1/notes/move', { from: 'Acme/vendors.md' })).toMatchObject({ status: 400, body: { error: { code: 'bad_request' } } })
    expect(records()).toHaveLength(1)
    // A v1 move, without .md, into a new folder.
    expect(await post('/api/v1/notes/move', { from: 'Acme/vendors', to: 'Acme/Vendors/list' })).toMatchObject({ status: 200, body: { ok: true } })
    expect((await api('/api/v1/notes/content/Acme/Vendors/list.md')).body.content).toContain('Call the printer.')
    // A save at the new path, then a new note at the old one: their own records, after the moves.
    const shown = await api('/api/notes-v2/content/Acme/Launch/plan.md')
    const edited = `${plan}\nBook the venue.\n`
    expect((await api('/api/notes-v2/content/Acme/Launch/plan.md', { method: 'PUT', body: JSON.stringify({ content: edited, expectedHash: shown.body.contentHash }) })).status).toBe(200)
    expect((await api('/api/notes-v2/content/Acme/launch-plan.md', { method: 'PUT', body: JSON.stringify({ content: '# A new plan\n' }) })).status).toBe(200)
    expect(records().map((r) => `${r.kind}:${r.path ?? `${r.from}>${r.to}`}${r.mode ? `:${r.mode}` : ''}`)).toEqual([
      'note-move:Acme/launch-plan.md>Acme/Launch/plan.md',
      'note-move:Acme/vendors.md>Acme/Vendors/list.md',
      'note:Acme/Launch/plan.md:put',
      'note:Acme/launch-plan.md:create',
    ])
    expect((await api('/api/notes-v2/content/Acme/Launch/plan.md')).body.content).toBe(edited)
    expect((await api('/api/notes-v2/content/Acme/launch-plan.md')).body.content).toBe('# A new plan\n')
    // A round meanwhile (the Mac has not taken them) changes nothing the box shows.
    await round()
    expect((await api('/api/notes-v2/content/Acme/Launch/plan.md')).body.content).toBe(edited)
    expect((await api('/api/notes-v2/content/Acme/vendors.md')).status).toBe(404)
  })

  it('after the ack the box shows the moves until a copy round from after the ack, then the Mac\'s', async () => {
    const drained = await postToCloudJournal('offline.drain', { home: '/x', kinds: [...APPLIED_V2_KINDS] })
    const seqs = (drained.records as Array<{ seq: number; kind: string }>).filter((r) => r.kind === 'note' || r.kind === 'note-move').map((r) => r.seq)
    expect(seqs).toHaveLength(4)
    expect(await postToCloudJournal('offline.ack', { home: '/x', seqs, now: Date.now() })).toMatchObject({ ok: true })
    expect(records()).toEqual([])
    const plan = withId('Acme/launch-plan.md', PLAN)
    expect((await api('/api/notes-v2/content/Acme/Launch/plan.md')).body.content).toBe(`${plan}\nBook the venue.\n`)
    expect((await api('/api/notes-v2/content/Acme/vendors.md')).status).toBe(404)
    expect((await api('/api/notes-v2/content/Acme/launch-plan.md')).body.content).toBe('# A new plan\n')
    // What the Mac made of them, sent by its next round.
    await new Promise((r) => setTimeout(r, 5))
    await fs.mkdir(path.join(NOTES_DIR, 'Acme/Launch'), { recursive: true })
    await fs.mkdir(path.join(NOTES_DIR, 'Acme/Vendors'), { recursive: true })
    await fs.rename(path.join(NOTES_DIR, 'Acme/vendors.md'), path.join(NOTES_DIR, 'Acme/Vendors/list.md'))
    await fs.writeFile(path.join(NOTES_DIR, 'Acme/Launch/plan.md'), `${plan}\nBook the venue.\nAdded on the Mac.\n`)
    await fs.writeFile(path.join(NOTES_DIR, 'Acme/launch-plan.md'), withId('Acme/new-plan', '# A new plan\n'))
    await round()
    expect((await api('/api/notes-v2/content/Acme/Launch/plan.md')).body.content).toContain('Added on the Mac.')
    expect((await api('/api/notes-v2/content/Acme/launch-plan.md')).body.content).toBe(withId('Acme/new-plan', '# A new plan\n'))
    expect((await api('/api/notes-v2/content/Acme/Vendors/list.md')).body.content).toContain('Call the printer.')
  })

  it('a save, a move of it and a new note at its old path stay three records; an ack of the first keeps the rest shown', async () => {
    const shown = await api('/api/notes-v2/content/Acme/Vendors/list.md')
    const edited = `${shown.body.content}\nAnd the caterer.\n`
    const put = (p: string, body: unknown) => api(p, { method: 'PUT', body: JSON.stringify(body) })
    expect((await put('/api/notes-v2/content/Acme/Vendors/list.md', { content: edited, expectedHash: shown.body.contentHash })).status).toBe(200)
    expect((await post('/api/notes-v2/move', { from: 'Acme/Vendors/list.md', to: 'Acme/Vendors/all.md' })).status).toBe(200)
    // Never folded into the save before the move (it would land before the move on the Mac).
    expect((await put('/api/notes-v2/content/Acme/Vendors/list.md', { content: '# A short list\n' })).status).toBe(200)
    expect(records().map((r) => `${r.kind}:${r.path ?? `${r.from}>${r.to}`}${r.mode ? `:${r.mode}` : ''}`)).toEqual([
      'note:Acme/Vendors/list.md:put', 'note-move:Acme/Vendors/list.md>Acme/Vendors/all.md', 'note:Acme/Vendors/list.md:create',
    ])
    // The Mac takes only the save: the move and the new note still show over it.
    await postToCloudJournal('offline.drain', { home: '/x', kinds: [...APPLIED_V2_KINDS] })
    const [first, ...rest] = records().map((r) => r.seq)
    expect(await postToCloudJournal('offline.ack', { home: '/x', seqs: [first], now: Date.now() })).toMatchObject({ ok: true })
    expect((await api('/api/notes-v2/content/Acme/Vendors/all.md')).body.content).toBe(edited)
    expect((await api('/api/notes-v2/content/Acme/Vendors/list.md')).body.content).toBe('# A short list\n')
    expect(await postToCloudJournal('offline.ack', { home: '/x', seqs: rest, now: Date.now() })).toMatchObject({ ok: true })
    expect((await api('/api/notes-v2/content/Acme/Vendors/all.md')).body.content).toBe(edited)
    expect(records()).toEqual([])
  })
})

describe('tags, folders and pictures on the box', () => {
  it('a tag rename is a note save of every note that carries it, shown at once', async () => {
    const before = [await disk('Beta/vendors.md'), await disk('Beta/budget.md')]
    expect(await post('/api/notes-v2/tags/rename', { from: 'fair', to: 'expo' })).toMatchObject({ status: 200, body: { ok: true, updated: 2 } })
    expect(records().map((r) => `${r.kind}:${r.path}:${r.mode}`).sort()).toEqual(['note:Beta/budget.md:put', 'note:Beta/vendors.md:put'])
    expect((await api('/api/notes-v2/content/Beta/vendors.md')).body.content).toContain('Call the florist. #expo')
    expect((await api('/api/notes-v2/content/Beta/budget.md')).body.content).toContain('tags: [expo, money]')
    expect([await disk('Beta/vendors.md'), await disk('Beta/budget.md')]).toEqual(before)
    const tags = (await api('/api/notes-v2/tags')).body.tags as Array<{ tag: string; count: number }>
    expect(tags.find((t) => t.tag === 'expo')?.count).toBe(2)
    expect(tags.find((t) => t.tag === 'fair')).toBeUndefined()
    expect(await post('/api/v1/notes/tags/rename', { from: 'expo', to: 'expo' })).toMatchObject({ status: 200, body: { ok: true, updated: 0 } })
    expect(await post('/api/v1/notes/tags/rename', { from: 'expo' })).toMatchObject({ status: 400, body: { error: { code: 'bad_request' } } })
  })

  it('a copy that leaves a note out answers needs the Mac for a tag rename', async () => {
    await fs.writeFile(path.join(NOTES_DIR, 'Beta/huge.md'), `# Huge\n\n${'x'.repeat(1100 * 1024)}\n`)
    await round()
    const r = await post('/api/notes-v2/tags/rename', { from: 'money', to: 'cash' })
    expect(r).toMatchObject({ status: 503, body: { error: { code: 'needs_leader', why: 'tag_rename_needs_mac' } } })
    await fs.rm(path.join(NOTES_DIR, 'Beta/huge.md'))
    await round()
  })

  it('making or deleting a folder needs the Mac (web and v1); the disk is untouched', async () => {
    const answers = [
      await post('/api/notes-v2/folder', { path: 'Gamma' }),
      await api('/api/notes-v2/folder/Beta', { method: 'DELETE' }),
      await post('/api/v1/notes/folder', { path: 'Gamma' }),
      await api('/api/v1/notes/folder/Beta', { method: 'DELETE' }),
    ]
    for (const a of answers) expect(a).toMatchObject({ status: 503, body: { error: { code: 'needs_leader', why: 'folder_changes_need_mac' } } })
    await expect(fs.stat(path.join(NOTES_DIR, 'Gamma'))).rejects.toThrow()
    expect((await fs.stat(path.join(NOTES_DIR, 'Beta'))).isDirectory()).toBe(true)
  })

  it('moving or deleting a picture needs the Mac (web and v1); the file stays', async () => {
    const answers = [
      await post('/api/notes-v2/move', { from: '_attachment/logo.png', to: '_attachment/logo-2.png' }),
      await post('/api/v1/notes/move', { from: '_attachment/logo.png', to: '_attachment/logo-2.png' }),
      await api('/api/notes-v2/attachment/_attachment/logo.png', { method: 'DELETE' }),
      await api('/api/v1/notes/attachment/_attachment/logo.png', { method: 'DELETE' }),
    ]
    for (const a of answers) expect(a).toMatchObject({ status: 503, body: { error: { code: 'needs_leader', why: 'attachment_changes_need_mac' } } })
    expect((await fs.stat(path.join(NOTES_DIR, '_attachment/logo.png'))).size).toBe(7)
    expect(companionJournalRecords().filter((r) => r.kind === 'note-move')).toEqual([])
  })
})

describe('a pasted picture on the box', () => {
  const png = (n: number) => Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47]), Buffer.from(`picture ${n}`)])
  const paste = (p: string, n: number, mediaType = 'image/png') => post(p, { notePath: 'Beta/budget.md', data: png(n).toString('base64'), mediaType })
  const pictures = () => companionJournalRecords().filter((r) => r.kind === 'note-attachment')
  const onDisk = async (rel: string) => fs.readFile(path.join(NOTES_DIR, rel)).catch(() => null)

  it('before the Mac drains note-attachment, a paste needs the Mac; nothing is written', async () => {
    await postToCloudJournal('offline.drain', { home: '/x', kinds: APPLIED_V2_KINDS.filter((k) => k !== 'note-attachment') })
    const r = await paste('/api/notes-v2/attachment', 1)
    expect(r).toMatchObject({ status: 503, body: { error: { code: 'needs_leader', why: 'mac_too_old' } } })
    await expect(fs.stat(path.join(NOTES_DIR, 'Beta/_attachment'))).rejects.toThrow()
    expect(pictures()).toEqual([])
  })

  it('once it does, a paste is a record with its bytes, never written to the box\'s disk (web and v1)', async () => {
    await postToCloudJournal('offline.drain', { home: '/x', kinds: [...APPLIED_V2_KINDS] })
    const web = await paste('/api/notes-v2/attachment', 2)
    expect(web).toMatchObject({ status: 200, body: { ok: true } })
    expect(web.body.path).toMatch(/^Beta\/_attachment\/pasted-image-.*\.png$/)
    expect(await onDisk(web.body.path)).toBeNull()
    const v1 = await paste('/api/v1/notes/attachment', 3)
    expect(v1).toMatchObject({ status: 200, body: { ok: true } })
    expect(pictures().map((r) => ({ path: r.path, oursBlob: r.oursBlob, size: r.size, notePath: r.notePath }))).toEqual([
      { path: web.body.path, oursBlob: crypto.createHash('sha256').update(png(2)).digest('hex'), size: png(2).length, notePath: 'Beta/budget.md' },
      { path: v1.body.path, oursBlob: crypto.createHash('sha256').update(png(3)).digest('hex'), size: png(3).length, notePath: 'Beta/budget.md' },
    ])
    // The box shows it at once, from its record.
    const shown = await fetch(`http://127.0.0.1:${port}/api/notes-v2/attachment?path=${encodeURIComponent(web.body.path)}`, { headers: { Authorization: `Bearer ${T.phone}` } })
    expect(Buffer.from(await shown.arrayBuffer())).toEqual(png(2))
    // The route's own errors, in each route's shape.
    expect(await paste('/api/notes-v2/attachment', 4, 'image/bmp')).toMatchObject({ status: 400, body: { error: 'Unsupported media type: image/bmp' } })
    expect(await paste('/api/v1/notes/attachment', 4, 'image/bmp')).toMatchObject({ status: 400, body: { error: { code: 'bad_request' } } })
    expect(pictures()).toHaveLength(2)
  })

  it('when the journal refuses a paste, the paste fails and nothing is kept', async () => {
    const blobs = path.join(companionJournalDir(), 'blobs')
    await fs.chmod(blobs, 0o500)
    try {
      const r = await paste('/api/notes-v2/attachment', 5)
      expect(r).toMatchObject({ status: 503, body: { error: { code: 'journal_unwritable' } } })
    } finally {
      await fs.chmod(blobs, 0o700)
    }
    await expect(fs.stat(path.join(NOTES_DIR, 'Beta/_attachment'))).rejects.toThrow()
    expect(pictures()).toHaveLength(2)
  })
})
