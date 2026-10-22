/**
 * A replica's copy of the notes' pictures and files (attachment-copy-core.ts), the ONE
 * implementation a host daemon (both twins) and the cloud companion keep it with:
 * manifest diff, chunks checked against the manifest's sha256, resume, one blob per
 * hash, the half rule, a home's copy apart from another's, and the reads a host
 * replica's follower makes (paged list, one slice at a time). Real fs in a temp dir,
 * real sha256: the deps the twins pass.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import { createAttachmentCopy } from '../../src/providers/attachment-copy-core.js'

const HOME = '/fixture/walnut-home'
const OTHER = '/fixture/other-walnut'
const sha = (b: Buffer) => crypto.createHash('sha256').update(b).digest('hex')
const png = (label: string) => Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47]), Buffer.from(label)])

let dir = ''
let clock = 1_000_000
const dirOf = (home: string) => path.join(dir, crypto.createHash('sha1').update(home).digest('hex').slice(0, 16), 'attachments')
const make = () => createAttachmentCopy({ fs, path, crypto, dirOf, now: () => clock, log: () => {} })
let copy = make()

const entry = (k: string, b: Buffer) => ({ k, h: sha(b), n: b.length })
async function fill(home: string, files: Record<string, Buffer>): Promise<Record<string, unknown>> {
  const r = await copy.command(home, 'attachments.sync', { entries: Object.entries(files).map(([k, b]) => entry(k, b)), asOf: clock })
  expect(r.ok).toBe(true)
  for (const k of r.need as string[]) {
    const b = files[k]!
    for (let off = 0; off < b.length || off === 0; off += 2 * 1024 * 1024) {
      const p = await copy.command(home, 'attachments.put', { k, h: sha(b), offset: off, data: b.subarray(off, off + 2 * 1024 * 1024).toString('base64') })
      expect(p.ok).toBe(true)
      if (p.stored === true) break
    }
  }
  return r
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wac-'))
  clock = 1_000_000
  copy = make()
})
afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }) })

describe('a round', () => {
  it('a manifest asks for what it lacks; finished files are kept once per hash; the copy is held', async () => {
    const files = {
      'Acme/_attachment/logo.png': png('logo'),
      'Acme/brief.pdf': Buffer.from('%PDF-1.4 brief'),
      // Unicode path (escapes keep the source ASCII), and the same bytes at a second path.
      'journal/\u65e5\u8bb0/scan.png': png('scan'),
      'Gamma/logo-copy.png': png('logo'),
    }
    expect(copy.held(HOME)).toBe(false)
    const r = await fill(HOME, files)
    expect([...(r.need as string[])].sort()).toEqual(Object.keys(files).sort())
    expect(copy.held(HOME)).toBe(true)
    expect(await copy.command(HOME, 'attachments.status', {})).toMatchObject({ ok: true, entries: 4, pending: 0 })
    expect(copy.keys(HOME)).toEqual(Object.keys(files).sort())
    expect(await copy.readFile(HOME, 'journal/\u65e5\u8bb0/scan.png')).toEqual(png('scan'))
    // One blob per hash: the logo's bytes are on disk once.
    expect(fs.readdirSync(path.join(dirOf(HOME), 'b')).length).toBe(3)
    // An unchanged manifest needs nothing; the same bytes moved need nothing either.
    const again = await copy.command(HOME, 'attachments.sync', { entries: [entry('Acme/_attachment/logo.png', png('logo')), entry('Moved/logo.png', png('logo'))], asOf: clock })
    expect(again).toMatchObject({ ok: true, need: [], removed: 3 })
    expect(await copy.readFile(HOME, 'Moved/logo.png')).toEqual(png('logo'))
    // The removed files' bytes went (no row names them).
    expect(fs.readdirSync(path.join(dirOf(HOME), 'b'))).toEqual([sha(png('logo'))])
  })

  it('a changed file keeps its old bytes until the new ones arrive', async () => {
    await fill(HOME, { 'a/pic.png': png('one') })
    const r = await copy.command(HOME, 'attachments.sync', { entries: [entry('a/pic.png', png('two'))], asOf: clock + 1 })
    expect(r).toMatchObject({ ok: true, need: ['a/pic.png'] })
    expect(await copy.readFile(HOME, 'a/pic.png')).toEqual(png('one'))
    await copy.command(HOME, 'attachments.put', { k: 'a/pic.png', h: sha(png('two')), offset: 0, data: png('two').toString('base64') })
    expect(await copy.readFile(HOME, 'a/pic.png')).toEqual(png('two'))
  })

  it('a large file goes in 2 MB chunks and a broken upload resumes where the copy says it stopped', async () => {
    const big = crypto.randomBytes(5 * 1024 * 1024 + 7)
    const r1 = await copy.command(HOME, 'attachments.sync', { entries: [entry('scan.pdf', big)], asOf: clock })
    expect(r1).toMatchObject({ need: ['scan.pdf'], have: {} })
    const chunk = (off: number) => big.subarray(off, off + 2 * 1024 * 1024).toString('base64')
    expect(await copy.command(HOME, 'attachments.put', { k: 'scan.pdf', h: sha(big), offset: 0, data: chunk(0) })).toMatchObject({ ok: true, stored: false, have: 2 * 1024 * 1024 })
    // The connection broke; the next round's manifest says how much arrived.
    const r2 = await copy.command(HOME, 'attachments.sync', { entries: [entry('scan.pdf', big)], asOf: clock })
    expect(r2).toMatchObject({ need: ['scan.pdf'], have: { 'scan.pdf': 2 * 1024 * 1024 } })
    // A chunk past what arrived answers where to go on.
    expect(await copy.command(HOME, 'attachments.put', { k: 'scan.pdf', h: sha(big), offset: 4 * 1024 * 1024, data: chunk(4 * 1024 * 1024) }))
      .toMatchObject({ ok: false, errorKind: 'offset', have: 2 * 1024 * 1024 })
    // A chunk over 2 MB is refused.
    expect(await copy.command(HOME, 'attachments.put', { k: 'scan.pdf', h: sha(big), offset: 0, data: big.subarray(0, 2 * 1024 * 1024 + 1).toString('base64') }))
      .toMatchObject({ ok: false, errorKind: 'bad_request' })
    await copy.command(HOME, 'attachments.put', { k: 'scan.pdf', h: sha(big), offset: 2 * 1024 * 1024, data: chunk(2 * 1024 * 1024) })
    expect(await copy.command(HOME, 'attachments.put', { k: 'scan.pdf', h: sha(big), offset: 4 * 1024 * 1024, data: chunk(4 * 1024 * 1024) }))
      .toMatchObject({ ok: true, stored: true, remaining: 0 })
    expect(sha((await copy.readFile(HOME, 'scan.pdf'))!)).toBe(sha(big))
  })

  it('bytes that are not the manifest\'s, a file no manifest names, and a path that climbs out are refused', async () => {
    const real = png('real')
    await copy.command(HOME, 'attachments.sync', { entries: [entry('a/real.png', real), entry('../escape.png', real), entry('a/note.md', real), entry('.hidden/x.png', real)], asOf: clock })
    expect(copy.keyOf('../escape.png')).toBeNull()
    expect(copy.keyOf('a/note.md')).toBeNull()
    expect(copy.keyOf('.hidden/x.png')).toBeNull()
    expect(await copy.command(HOME, 'attachments.status', {})).toMatchObject({ entries: 1, pending: 1 })
    const forged = Buffer.alloc(real.length, 7)
    expect(await copy.command(HOME, 'attachments.put', { k: 'a/real.png', h: sha(real), offset: 0, data: forged.toString('base64') })).toMatchObject({ ok: false, errorKind: 'hash_mismatch' })
    expect(await copy.command(HOME, 'attachments.put', { k: 'a/other.png', h: sha(real), offset: 0, data: real.toString('base64') })).toMatchObject({ ok: false, errorKind: 'not_wanted' })
    expect(await copy.readFile(HOME, 'a/real.png')).toBeNull()
    expect(copy.held(HOME)).toBe(false)
    expect(await copy.command('', 'attachments.status', {})).toMatchObject({ ok: false, errorKind: 'bad_request' })
    expect(await copy.command(HOME, 'attachments.nope', {})).toMatchObject({ ok: false, errorKind: 'bad_request' })
  })

  it('a manifest that removes most of a copy of 200 files is refused; a smaller copy takes any', async () => {
    const many: Record<string, Buffer> = {}
    for (let i = 0; i < 220; i++) many[`Bulk/f${i}.png`] = png(`f${i}`)
    await fill(HOME, many)
    const keep10 = Object.entries(many).slice(0, 10).map(([k, b]) => entry(k, b))
    expect(await copy.command(HOME, 'attachments.sync', { entries: keep10, asOf: clock })).toMatchObject({ ok: false, errorKind: 'manifest_removes_most_rows', detail: { local: 220, removing: 210 } })
    expect(copy.keys(HOME).length).toBe(220)
    // Half or fewer go: taken.
    const keep110 = Object.entries(many).slice(0, 110).map(([k, b]) => entry(k, b))
    expect(await copy.command(HOME, 'attachments.sync', { entries: keep110, asOf: clock })).toMatchObject({ ok: true, removed: 110 })
  })

  it('a drop removes the copy; the next manifest fills it again', async () => {
    await fill(HOME, { 'a/pic.png': png('one') })
    expect(await copy.command(HOME, 'attachments.drop', {})).toMatchObject({ ok: true, dropped: true })
    expect(fs.existsSync(dirOf(HOME))).toBe(false)
    expect(copy.held(HOME)).toBe(false)
    expect(await copy.command(HOME, 'attachments.drop', {})).toMatchObject({ ok: true, dropped: false })
    await fill(HOME, { 'a/pic.png': png('one') })
    expect(await copy.readFile(HOME, 'a/pic.png')).toEqual(png('one'))
  })

  it('a home\'s copy is its own, and a restarted daemon reads the copy from disk', async () => {
    await fill(HOME, { 'a/pic.png': png('mine') })
    expect(copy.held(OTHER)).toBe(false)
    expect(await copy.readFile(OTHER, 'a/pic.png')).toBeNull()
    expect(await copy.command(OTHER, 'attachments.drop', {})).toMatchObject({ dropped: false })
    copy = make()
    expect(copy.held(HOME)).toBe(true)
    expect(await copy.readFile(HOME, 'a/pic.png')).toEqual(png('mine'))
    expect(fs.statSync(path.join(dirOf(HOME), 'index.json')).mode & 0o777).toBe(0o600)
  })
})

describe('a host replica\'s reads (the follower link)', () => {
  it('lists the paths a page at a time, and reads a file slice by slice', async () => {
    const big = crypto.randomBytes(3 * 1024 * 1024 + 11)
    const files: Record<string, Buffer> = { 'b/big.pdf': big }
    for (let i = 0; i < 30; i++) files[`a/pic-${String(i).padStart(2, '0')}.png`] = png(`p${i}`)
    await fill(HOME, files)
    const pages: string[][] = []
    let after: string | null = null
    for (;;) {
      const p = copy.list(HOME, after, 200)
      pages.push(p.keys)
      expect(p.asOf).not.toBeNull()
      if (!p.next) break
      after = p.next
    }
    expect(pages.length).toBeGreaterThan(1)
    expect(pages.flat()).toEqual(Object.keys(files).sort())
    const first = copy.readChunk(HOME, 'b/big.pdf', 0, 2 * 1024 * 1024)!
    expect(first).toMatchObject({ k: 'b/big.pdf', h: sha(big), n: big.length, offset: 0 })
    const second = copy.readChunk(HOME, 'b/big.pdf', 2 * 1024 * 1024, 4 * 1024 * 1024)!
    // Never more than one 2 MB slice, whatever the reader asks for.
    expect(Buffer.from(first.data, 'base64').length).toBe(2 * 1024 * 1024)
    expect(Buffer.concat([Buffer.from(first.data, 'base64'), Buffer.from(second.data, 'base64')])).toEqual(big)
    expect(copy.readChunk(HOME, 'b/missing.pdf', 0, 1024)).toBeNull()
    expect(copy.readChunk(HOME, '../b/big.pdf', 0, 1024)).toBeNull()
    expect(copy.readChunk(OTHER, 'b/big.pdf', 0, 1024)).toBeNull()
  })
})

describe('files this replica wrote that the leader took (the companion\'s pastes)', () => {
  it('are kept as its own until a manifest from after the ack names them, or 10 minutes', async () => {
    await fill(HOME, { 'a/old.png': png('old') })
    const ackAt = clock
    expect(await copy.keepOwn(HOME, [{ k: 'a/pasted.png', bytes: png('pasted') }, { k: '../bad.png', bytes: png('x') }], ackAt)).toBe(1)
    expect(copy.row(HOME, 'a/pasted.png')).toMatchObject({ own: true })
    // A manifest from before the ack lacks the path: the paste stays.
    expect(await copy.command(HOME, 'attachments.sync', { entries: [entry('a/old.png', png('old'))], asOf: ackAt - 1 })).toMatchObject({ ok: true, removed: 0 })
    expect(await copy.readFile(HOME, 'a/pasted.png')).toEqual(png('pasted'))
    // One from after it names the path with the leader's bytes: those win, and need nothing (same bytes).
    expect(await copy.command(HOME, 'attachments.sync', { entries: [entry('a/old.png', png('old')), entry('a/pasted.png', png('pasted'))], asOf: ackAt + 1 })).toMatchObject({ ok: true, need: [] })
    expect(copy.row(HOME, 'a/pasted.png')).toMatchObject({ own: false })
    // Another paste, never named: 10 minutes later a manifest removes it.
    await copy.keepOwn(HOME, [{ k: 'a/second.png', bytes: png('second') }], clock)
    clock += 11 * 60_000
    expect(await copy.command(HOME, 'attachments.sync', { entries: [entry('a/old.png', png('old')), entry('a/pasted.png', png('pasted'))], asOf: clock - 30 * 60_000 })).toMatchObject({ ok: true, removed: 1 })
    expect(copy.row(HOME, 'a/second.png')).toBeNull()
  })
})
