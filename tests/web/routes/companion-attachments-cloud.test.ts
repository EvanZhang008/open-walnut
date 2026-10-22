/**
 * Stage 4d of docs/plan/walnut-companion-unified-replica.md on a real CLOUD_MODE server:
 * the pictures and files of the notes come from the box's own copy of the Mac's
 * (core/companion-attachment-copy.ts), which the Mac keeps over the notes copy's door
 * (core/attachment-replica.ts, `attachments.*` on POST /bridge/host-replica), never from
 * the box's git-written disk once that copy is held.
 *
 * Pinned:
 *   - before the first whole manifest the box's disk answers (the transition);
 *   - a round brings every file the attachment route serves (by extension, at most 50 MB),
 *     and the reads (web and v1) take the copy: a file changed or gone on the box's disk
 *     still shows the Mac's bytes; an embed resolves as on the disk (exact, legacy root,
 *     longest suffix, nearest the note); an unknown file is a 404;
 *   - an unchanged round sends nothing; a changed file goes alone; a second copy of the
 *     same bytes is never sent; a file gone on the Mac leaves the copy;
 *   - a large file goes in 2 MB chunks, and an upload that broke resumes where the box
 *     says it stopped; bytes that are not the manifest's are refused;
 *   - a picture pasted on the box is never written to its disk: it shows at once from
 *     its journal record, still shows after the Mac took it (its journal bytes freed),
 *     and the copy holds the Mac's file after a round;
 *   - a manifest that removes most of a large copy is refused; a dropped copy is gone.
 *
 * Both sides share one data dir: the "Mac's" files are the ones under NOTES_DIR.
 */
import crypto from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import type { Server as HttpServer } from 'node:http'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { createMockConstants } from '../../helpers/mock-constants.js'

vi.mock('../../../src/constants.js', () => createMockConstants('walnut-companion-attachments-cloud', { CLOUD_MODE: true }))

let bridgeCfg: { enabled: boolean; url?: string; token?: string } = { enabled: false }
vi.mock('../../../src/integrations/cloud-bridge-config.js', async (orig) => ({
  ...(await orig<typeof import('../../../src/integrations/cloud-bridge-config.js')>()),
  getBridgeConfigForHost: async () => bridgeCfg,
}))

import { NOTES_DIR, WALNUT_HOME } from '../../../src/constants.js'
import { startServer, stopServer } from '../../../src/web/server.js'
import { _resetDeviceAuthForTesting } from '../../../src/core/device-auth.js'
import { _resetCloudIngestForTesting, postToCloudHostReplica, postToCloudJournal } from '../../../src/core/cloud-ingest.js'
import { _resetHostReplicaForTesting, syncCompanionHostReplica } from '../../../src/core/host-replica.js'
import { _resetAttachmentReplicaForTesting, syncAttachments } from '../../../src/core/attachment-replica.js'
import { companionAttachmentsHeld, companionAttachmentCopyDir } from '../../../src/core/companion-attachment-copy.js'
import { companionJournalRecords } from '../../../src/core/companion-journal.js'
import { APPLIED_V2_KINDS } from '../../../src/core/offline-merge/apply-v2.js'

let server: HttpServer
let port = 0
const sha = (t: string) => crypto.createHash('sha256').update(t, 'utf-8').digest('hex')
const sha256 = (b: Buffer) => crypto.createHash('sha256').update(b).digest('hex')
const tok = () => crypto.randomBytes(16).toString('hex')
const T = { local: tok(), phone: tok() }
const png = (label: string) => Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47]), Buffer.from(label)])
const withId = (rel: string, text: string): string => `---\nid: n_${crypto.createHash('sha1').update(rel).digest('hex').slice(0, 11)}\n---\n${text}`

async function put(rel: string, bytes: Buffer | string): Promise<void> {
  const file = path.join(NOTES_DIR, rel)
  await fs.mkdir(path.dirname(file), { recursive: true })
  await fs.writeFile(file, bytes)
}
/** GET one attachment through the web (`web`) or v1 route, as the editor's embed asks for it. */
async function get(raw: string, flavor: 'web' | 'v1' = 'web', note?: string): Promise<{ status: number; bytes: Buffer; type: string | null }> {
  const base = flavor === 'web' ? '/api/notes-v2/attachment' : '/api/v1/notes/attachment'
  const q = `path=${encodeURIComponent(raw)}${note ? `&note=${encodeURIComponent(note)}` : ''}`
  const r = await fetch(`http://127.0.0.1:${port}${base}?${q}`, { headers: { Authorization: `Bearer ${T.phone}` } })
  return { status: r.status, bytes: Buffer.from(await r.arrayBuffer()), type: r.headers.get('content-type') }
}
async function api(p: string, init: RequestInit = {}): Promise<{ status: number; body: Record<string, any> }> {
  const r = await fetch(`http://127.0.0.1:${port}${p}`, {
    ...init,
    headers: { Authorization: `Bearer ${T.phone}`, ...(init.body ? { 'Content-Type': 'application/json' } : {}) },
  })
  return { status: r.status, body: await r.json().catch(() => ({})) as Record<string, any> }
}
/** The Mac's attachments round with the real client, every command recorded. */
const sent: Array<{ cmd: string; k?: string; offset?: number; bytes?: number }> = []
let failPutAfter = Infinity
const send = async (cmd: string, params: Record<string, unknown>, timeoutMs?: number): Promise<Record<string, unknown>> => {
  if (cmd === 'attachments.put') {
    const bytes = Buffer.from(String(params.data), 'base64').length
    sent.push({ cmd, k: String(params.k), offset: Number(params.offset), bytes })
    if (sent.filter((s) => s.cmd === 'attachments.put').length > failPutAfter) return { ok: false, error: 'the connection broke' }
  } else sent.push({ cmd })
  return postToCloudHostReplica(cmd, params, timeoutMs ? { timeoutMs } : {})
}
/** The companion is one target of the round every replica gets (core/attachment-replica.ts). */
const companion = { hostKey: 'companion', send }
const round = async () => { sent.length = 0; return syncAttachments(companion, { on: true, exclude: [] }) }
const puts = () => sent.filter((s) => s.cmd === 'attachments.put')

beforeAll(async () => {
  await fs.mkdir(WALNUT_HOME, { recursive: true })
  const now = new Date().toISOString()
  await fs.writeFile(path.join(WALNUT_HOME, 'auth.json'), JSON.stringify({ devices: [
    { name: 'my-phone', id: 'd00000000000000c3', tokenHash: sha(T.phone), createdAt: now },
    { name: 'bridge-local', id: 'd00000000000000d4', tokenHash: sha(T.local), createdAt: now, kind: 'machine' },
  ] }), { mode: 0o600 })
  await put('Acme/plan.md', withId('Acme/plan.md', '# Plan\n\n![[logo.png]]\n'))
  await put('Beta/notes.md', withId('Beta/notes.md', '# Beta\n\n![[Untitled.png]]\n'))
  await put('Acme/_attachment/logo.png', png('acme logo'))
  await put('Acme/_attachment/Untitled.png', png('acme untitled'))
  await put('Beta/_attachment/Untitled.png', png('beta untitled'))
  await put('Acme/brief.pdf', Buffer.from('%PDF-1.4 acme brief'))
  // Not served by the route (by extension), so never copied.
  await put('Acme/_attachment/raw.bin', Buffer.from('binary'))
  // Over the route's 50 MB cap (a sparse file): never copied either.
  await fs.writeFile(path.join(NOTES_DIR, 'Acme/huge.pdf'), '')
  await fs.truncate(path.join(NOTES_DIR, 'Acme/huge.pdf'), 51 * 1024 * 1024)
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

describe('the pictures and files of the notes on the box', () => {
  it('before the first whole manifest, the box\'s disk answers', async () => {
    expect(companionAttachmentsHeld()).toBe(false)
    const r = await get('Acme/_attachment/logo.png')
    expect(r).toMatchObject({ status: 200, type: 'image/png' })
    expect(r.bytes).toEqual(png('acme logo'))
  })

  it('a round brings every served file, and the reads take the copy, not the disk', async () => {
    // The companion round runs the attachments round after the notes, memory and skills.
    await syncCompanionHostReplica()
    expect(companionAttachmentsHeld()).toBe(true)
    const status = await postToCloudHostReplica('attachments.status', {})
    expect(status).toMatchObject({ ok: true, entries: 4, pending: 0 })
    // The box's disk moves on (git sync, or nothing at all): the copy answers.
    await put('Acme/_attachment/logo.png', png('changed on the box'))
    await fs.rm(path.join(NOTES_DIR, 'Beta/_attachment/Untitled.png'))
    expect((await get('Acme/_attachment/logo.png')).bytes).toEqual(png('acme logo'))
    expect((await get('Acme/_attachment/logo.png', 'v1')).bytes).toEqual(png('acme logo'))
    // Resolution as on the disk: legacy root, longest suffix, nearest the note.
    expect((await get('Notion/Acme/_attachment/logo.png')).bytes).toEqual(png('acme logo'))
    expect((await get('logo.png|300', 'web', 'Acme/plan.md')).bytes).toEqual(png('acme logo'))
    expect((await get('Untitled.png', 'web', 'Beta/notes.md')).bytes).toEqual(png('beta untitled'))
    expect((await get('Untitled.png', 'v1', 'Acme/plan.md')).bytes).toEqual(png('acme untitled'))
    const pdf = await get('Acme/brief.pdf')
    expect(pdf).toMatchObject({ status: 200, type: 'application/pdf' })
    // Files the route does not serve, too large ones, and unknown ones.
    expect((await get('Acme/huge.pdf')).status).toBe(404)
    expect((await get('Acme/_attachment/nothing.png')).status).toBe(404)
    expect((await get('Acme/_attachment/raw.bin')).status).toBe(400)
    // Put the box's disk back as the Mac's (both sides share it here).
    await put('Acme/_attachment/logo.png', png('acme logo'))
    await put('Beta/_attachment/Untitled.png', png('beta untitled'))
  })

  it('an unchanged round sends nothing; a changed file goes alone; the same bytes twice go once; a removed file leaves the copy', async () => {
    expect(await round()).toMatchObject({ action: 'unchanged' })
    await new Promise((r) => setTimeout(r, 5))
    await put('Acme/_attachment/logo.png', png('acme logo, second edition'))
    await put('Gamma/_attachment/logo-copy.png', png('beta untitled'))
    await fs.rm(path.join(NOTES_DIR, 'Acme/brief.pdf'))
    const r = await round()
    expect(r).toMatchObject({ action: 'synced', entries: 4, sent: 1 })
    expect(puts().map((p) => p.k)).toEqual(['Acme/_attachment/logo.png'])
    expect((await get('Acme/_attachment/logo.png')).bytes).toEqual(png('acme logo, second edition'))
    expect((await get('Gamma/_attachment/logo-copy.png')).bytes).toEqual(png('beta untitled'))
    expect((await get('Acme/brief.pdf')).status).toBe(404)
  })

  it('a large file goes in chunks, and a broken upload resumes where the box says it stopped', async () => {
    const big = crypto.randomBytes(5 * 1024 * 1024 + 123)
    await put('Acme/scan.pdf', big)
    failPutAfter = 1
    try {
      const broken = await round()
      expect(broken).toMatchObject({ action: 'synced', sent: 0, more: true })
    } finally {
      failPutAfter = Infinity
      _resetAttachmentReplicaForTesting()
    }
    expect((await get('Acme/scan.pdf')).status).toBe(404)
    const resumed = await round()
    expect(resumed).toMatchObject({ action: 'synced', sent: 1 })
    // The first 2 MB arrived before the break: the round went on from there.
    expect(puts().map((p) => p.offset)).toEqual([2 * 1024 * 1024, 4 * 1024 * 1024])
    const r = await get('Acme/scan.pdf')
    expect(r.status).toBe(200)
    expect(sha256(r.bytes)).toBe(sha256(big))
  })

  it('bytes that are not the ones the manifest named are refused', async () => {
    const real = png('a real picture')
    const listed = await postToCloudHostReplica('attachments.sync', { entries: [
      ...(await import('../../../src/core/attachment-replica.js').then((m) => m.attachmentEntries([]))).map(({ k, h, n }) => ({ k, h, n })),
      { k: 'Acme/_attachment/forged.png', h: sha256(real), n: real.length },
    ], asOf: Date.now() })
    expect(listed).toMatchObject({ ok: true, need: ['Acme/_attachment/forged.png'] })
    const forged = Buffer.alloc(real.length, 7)
    expect(await postToCloudHostReplica('attachments.put', { k: 'Acme/_attachment/forged.png', h: sha256(real), offset: 0, data: forged.toString('base64') }))
      .toMatchObject({ ok: false, errorKind: 'hash_mismatch' })
    expect(await postToCloudHostReplica('attachments.put', { k: 'Acme/_attachment/other.png', h: sha256(real), offset: 0, data: real.toString('base64') }))
      .toMatchObject({ ok: false, errorKind: 'not_wanted' })
    expect((await get('Acme/_attachment/forged.png')).status).toBe(404)
    // The Mac's next round names its own files again.
    _resetAttachmentReplicaForTesting()
    expect(await round()).toMatchObject({ action: 'synced' })
    expect((await postToCloudHostReplica('attachments.status', {})).pending).toBe(0)
  })
})

describe('a picture pasted on the box', () => {
  const pasted = png('pasted on the box')
  it('is never written to the box\'s disk: it shows at once from its record', async () => {
    await postToCloudJournal('offline.drain', { home: '/x', kinds: [...APPLIED_V2_KINDS] })
    const r = await api('/api/notes-v2/attachment', { method: 'POST', body: JSON.stringify({ notePath: 'Acme/plan.md', data: pasted.toString('base64'), mediaType: 'image/png' }) })
    expect(r).toMatchObject({ status: 200, body: { ok: true } })
    const rel = r.body.path as string
    expect(rel).toMatch(/^Acme\/_attachment\/pasted-image-.*\.png$/)
    await expect(fs.stat(path.join(NOTES_DIR, rel))).rejects.toThrow()
    expect(companionJournalRecords().filter((x) => x.kind === 'note-attachment').map((x) => x.path)).toEqual([rel])
    expect((await get(rel)).bytes).toEqual(pasted)
    expect((await get(rel, 'v1')).bytes).toEqual(pasted)
    // A round meanwhile (the Mac has not taken it) changes nothing the box shows.
    _resetAttachmentReplicaForTesting()
    await round()
    expect((await get(rel)).bytes).toEqual(pasted)
  })

  it('still shows after the Mac took it, then the copy holds the Mac\'s file', async () => {
    const rel = companionJournalRecords().find((x) => x.kind === 'note-attachment')!.path as string
    const drained = await postToCloudJournal('offline.drain', { home: '/x', kinds: [...APPLIED_V2_KINDS] })
    const seqs = (drained.records as Array<{ seq: number; kind: string }>).filter((x) => x.kind === 'note-attachment').map((x) => x.seq)
    const macNow = Date.now()
    expect(await postToCloudJournal('offline.ack', { home: '/x', seqs, now: macNow })).toMatchObject({ ok: true })
    expect(companionJournalRecords().filter((x) => x.kind === 'note-attachment')).toEqual([])
    expect((await get(rel)).bytes).toEqual(pasted)
    // A round from before the Mac wrote it (its manifest lacks the path) keeps it.
    _resetAttachmentReplicaForTesting()
    const early = await postToCloudHostReplica('attachments.sync', {
      entries: (await import('../../../src/core/attachment-replica.js').then((m) => m.attachmentEntries([]))).map(({ k, h, n }) => ({ k, h, n })), asOf: macNow - 1_000,
    })
    expect(early).toMatchObject({ ok: true })
    expect((await get(rel)).bytes).toEqual(pasted)
    // The Mac wrote it at the path (offline-merge/apply-note-attachment.ts); its next round names it.
    await new Promise((r) => setTimeout(r, 5))
    await put(rel, pasted)
    _resetAttachmentReplicaForTesting()
    expect(await round()).toMatchObject({ action: 'synced', sent: 0 })
    expect((await get(rel)).bytes).toEqual(pasted)
    // Gone on the Mac: gone from the box too (the box's own hold ended with that round).
    await fs.rm(path.join(NOTES_DIR, rel))
    await round()
    expect((await get(rel)).status).toBe(404)
  })
})

describe('the copy\'s bounds', () => {
  it('a manifest that removes most of a large copy is refused; a dropped copy is gone', async () => {
    const many = Array.from({ length: 220 }, (_, i) => ({ k: `Bulk/_attachment/f${i}.png`, h: sha256(Buffer.from(`f${i}`)), n: 2 }))
    expect(await postToCloudHostReplica('attachments.sync', { entries: many, asOf: Date.now() })).toMatchObject({ ok: true })
    expect(await postToCloudHostReplica('attachments.sync', { entries: many.slice(0, 10), asOf: Date.now() }))
      .toMatchObject({ ok: false, errorKind: 'manifest_removes_most_rows' })
    expect(await syncAttachments(companion, { on: false, exclude: [] })).toMatchObject({ action: 'dropped' })
    expect(companionAttachmentsHeld()).toBe(false)
    await expect(fs.stat(companionAttachmentCopyDir())).rejects.toThrow()
    // Back on: the next round fills it again.
    _resetAttachmentReplicaForTesting()
    expect(await round()).toMatchObject({ action: 'synced' })
    expect(companionAttachmentsHeld()).toBe(true)
  })
})
