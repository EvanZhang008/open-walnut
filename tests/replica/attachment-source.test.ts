/**
 * A host replica's picture reads (replica/attachment-source.ts): while the Mac is away the
 * notes' pictures and files come from the copy the host daemon keeps, through the follower
 * link (`attachments.list`, `attachments.read`), never from a second vault on the host.
 * The follower link is the REAL daemon core (attachment-copy-core.ts) behind the follower
 * gate (follower-reads-core.ts), in-process; the read is the route's own function
 * (web/routes/notes-v2.ts readNoteAttachment), so the embed resolution is the disk's.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import { createMockConstants } from '../helpers/mock-constants.js'

vi.mock('../../src/constants.js', () => createMockConstants('walnut-replica-attachment-source'))

import { NOTES_DIR } from '../../src/constants.js'
import { createAttachmentCopy } from '../../src/providers/attachment-copy-core.js'
import { createFollowerReads } from '../../src/providers/follower-reads-core.js'
import { installReplicaAttachments, replicaAttachmentRead } from '../../src/replica/attachment-source.js'
import { readNoteAttachment } from '../../src/web/routes/notes-v2.js'

const HOME = '/fixture/marina-home'
const sha = (b: Buffer) => crypto.createHash('sha256').update(b).digest('hex')
const png = (label: string) => Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47]), Buffer.from(label)])

let dir = ''
let copy = createAttachmentCopy({ fs, path, crypto, dirOf: () => '', log: () => {} })
let asked: string[] = []
let failList = false

/** The follower link: the daemon's gate over the real copy, answered as the daemon answers a follower. */
function link() {
  const reads = createFollowerReads({
    path, homeDir: dir, realpath: () => null, sliceOwner: () => undefined, journalOwner: () => undefined,
    liveSessions: () => [], journalSize: () => -1, readJournal: () => '',
    replica: { list: () => null, read: () => null, readMany: () => null },
    attachments: copy, log: () => {},
  })
  return async (cmd: string, params: Record<string, unknown>): Promise<Record<string, unknown>> => {
    asked.push(cmd)
    if (failList && cmd === 'attachments.list') throw new Error('daemon_needs_upgrade: this host\'s daemon has no attachment-copy-v1')
    const d = reads.gate(HOME, { cmd, ...params })
    if ('answer' in d) return { ok: true, ...d.answer }
    if ('refuse' in d) return { ok: false, errorKind: 'not_found', error: d.refuse }
    return { ok: false, error: 'error' in d ? d.error : 'passed' }
  }
}

async function fill(files: Record<string, Buffer>): Promise<void> {
  const r = await copy.command(HOME, 'attachments.sync', { entries: Object.entries(files).map(([k, b]) => ({ k, h: sha(b), n: b.length })), asOf: Date.now() })
  for (const k of r.need as string[]) {
    const b = files[k]!
    for (let off = 0; ; off += 2 * 1024 * 1024) {
      const p = await copy.command(HOME, 'attachments.put', { k, h: sha(b), offset: off, data: b.subarray(off, off + 2 * 1024 * 1024).toString('base64') })
      if (p.stored === true) break
    }
  }
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wras-'))
  copy = createAttachmentCopy({ fs, path, crypto, dirOf: () => path.join(dir, 'attachments'), log: () => {} })
  asked = []
  failList = false
  installReplicaAttachments(link())
  // The replica's own disk vault: never read once the copy is held.
  fs.rmSync(NOTES_DIR, { recursive: true, force: true })
  fs.mkdirSync(path.join(NOTES_DIR, 'Acme', '_attachment'), { recursive: true })
  fs.writeFileSync(path.join(NOTES_DIR, 'Acme', '_attachment', 'logo.png'), png('the replica disk'))
})
afterEach(() => {
  installReplicaAttachments(null)
  fs.rmSync(dir, { recursive: true, force: true })
})

describe('a host replica\'s pictures while the Mac is away', () => {
  it('come from the daemon\'s copy, resolved as on the disk, a large file slice by slice', async () => {
    const big = crypto.randomBytes(4 * 1024 * 1024 + 17)
    await fill({
      'Acme/_attachment/logo.png': png('acme logo'),
      'Acme/_attachment/Untitled.png': png('acme untitled'),
      'Beta/_attachment/Untitled.png': png('beta untitled'),
      'Acme/scan.pdf': big,
    })
    const r = await readNoteAttachment('Acme/_attachment/logo.png')
    expect(r).toMatchObject({ mime: 'image/png', contentDisposition: 'inline' })
    expect(r.buffer).toEqual(png('acme logo'))
    // The embed rules of the disk: a size suffix, the longest suffix, the copy nearest the note.
    expect((await readNoteAttachment('logo.png|300', 'Acme/plan.md')).buffer).toEqual(png('acme logo'))
    expect((await readNoteAttachment('Untitled.png', 'Beta/notes.md')).buffer).toEqual(png('beta untitled'))
    expect((await readNoteAttachment('Untitled.png', 'Acme/plan.md')).buffer).toEqual(png('acme untitled'))
    asked = []
    const pdf = await readNoteAttachment('Acme/scan.pdf')
    expect(sha(pdf.buffer)).toBe(sha(big))
    expect(pdf.mime).toBe('application/pdf')
    // Three 2 MB slices; the listing was still fresh.
    expect(asked).toEqual(['attachments.read', 'attachments.read', 'attachments.read'])
    // A file the copy lacks is a 404, whatever the replica's disk holds.
    await expect(readNoteAttachment('Acme/_attachment/nothing.png')).rejects.toMatchObject({ statusCode: 404 })
  })

  it('before the copy is held, or with a daemon without it, the replica\'s own disk answers as before', async () => {
    expect(await replicaAttachmentRead('Acme/_attachment/logo.png')).toBeUndefined()
    expect((await readNoteAttachment('Acme/_attachment/logo.png')).buffer).toEqual(png('the replica disk'))
    // Held now, but this daemon cannot be asked (no attachment-copy-v1): the disk again.
    await fill({ 'Acme/_attachment/logo.png': png('acme logo') })
    installReplicaAttachments(link())
    failList = true
    expect(await replicaAttachmentRead('Acme/_attachment/logo.png')).toBeUndefined()
    expect((await readNoteAttachment('Acme/_attachment/logo.png')).buffer).toEqual(png('the replica disk'))
    failList = false
    installReplicaAttachments(link())
    expect((await readNoteAttachment('Acme/_attachment/logo.png')).buffer).toEqual(png('acme logo'))
    // The leader and the companion install none.
    installReplicaAttachments(null)
    expect(await replicaAttachmentRead('Acme/_attachment/logo.png')).toBeUndefined()
  })

  it('a listing is shared by a burst of reads, and taken again a few seconds later', async () => {
    await fill({ 'Acme/_attachment/a.png': png('a'), 'Acme/_attachment/b.png': png('b') })
    vi.useFakeTimers({ toFake: ['Date'] })
    try {
      await Promise.all([replicaAttachmentRead('a.png'), replicaAttachmentRead('b.png'), replicaAttachmentRead('a.png')])
      expect(asked.filter((c) => c === 'attachments.list')).toEqual(['attachments.list'])
      vi.setSystemTime(Date.now() + 5_000)
      await replicaAttachmentRead('a.png')
      expect(asked.filter((c) => c === 'attachments.list').length).toBe(2)
    } finally {
      vi.useRealTimers()
    }
  })
})
