/**
 * upload.part ('upload-part-v1', transfer-core.ts uploadPart): a phone's file for
 * a session, in chunks, written ONLY as <uploads root>/<uploadId>/<name>. It is
 * bridge-reachable, so the checks on the id and the name are the security line.
 * Also pins the twin wiring (dispatch, bridge allowlist, capability, bulk lane)
 * and runs the INLINED factory text, the way the JS source twin gets it.
 *
 * MACHINE SAFETY: every file lives in one temp dir; nothing spawns.
 */
import { afterAll, describe, expect, it } from 'vitest'
import * as crypto from 'node:crypto'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { createTransferCore, type TransferCoreDeps } from '../../src/providers/transfer-core.js'
import { ADVERTISED_DAEMON_CAPABILITIES, REQUIRED_DAEMON_CAPABILITIES } from '../../src/providers/daemon-capabilities.js'
import { isUploadName, withFilePaths, withoutAttachmentHeaders, FILES_ATTACHED_LINE } from '../../src/core/sessions/session-uploads.js'
import { IMAGES_ATTACHED_LINE, withImagePaths } from '../../src/core/sessions/cloud-images.js'

const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'walnut-upload-part-')))
afterAll(() => { if (tmp.includes('walnut-upload-part-')) fs.rmSync(tmp, { recursive: true, force: true }) })
const noSpawn = (() => { throw new Error('upload.part never spawns') }) as unknown as TransferCoreDeps['spawn']
const deps = (over: Partial<TransferCoreDeps> = {}): TransferCoreDeps => ({ fs, path, crypto, spawn: noSpawn, env: {}, home: tmp, ...over })
const core = createTransferCore(deps())
const sha = (b: Buffer) => crypto.createHash('sha256').update(b).digest('hex')
const b64 = (b: Buffer) => b.toString('base64')
const ID = 'up-0f8e7a6b-1c2d-4e5f-9a8b-7c6d5e4f3a2b'

async function refusal(p: Promise<unknown>): Promise<{ code: string; data?: Record<string, unknown> }> {
  try { await p } catch (err) { return err as { code: string; data?: Record<string, unknown> } }
  throw new Error('expected a refusal')
}

describe('upload.part', () => {
  const MB = 1024 * 1024
  const body = crypto.randomBytes(2 * MB + 777)
  const parts = [body.subarray(0, MB), body.subarray(MB, 2 * MB), body.subarray(2 * MB)]

  it('lands at <root>/<id>/<name> in chunks; retries are no-ops; the last chunk names the path', async () => {
    const root = path.join(tmp, 'r1', 'uploads')
    const name = 'Clip from the phone \u4e2d\u6587.mov'
    const at = (offset: number, data: Buffer, extra: Record<string, unknown> = {}) =>
      core.uploadPart({ uploadId: ID, name, size: body.length, offset, data: b64(data), ...extra }, root)
    expect(await at(0, parts[0])).toEqual({ staged: MB })
    expect(await at(0 + MB, parts[1])).toEqual({ staged: 2 * MB })
    // A retry of a chunk already staged (its answer was lost) writes nothing.
    expect(await at(MB, parts[1])).toEqual({ staged: 2 * MB })
    const target = path.join(root, ID, name)
    expect(fs.existsSync(target)).toBe(false)
    const done = await at(2 * MB, parts[2], { sha256: sha(body) })
    expect(done).toEqual({ staged: body.length, done: true, sha256: sha(body), path: target })
    expect(fs.readFileSync(target).equals(body)).toBe(true)
    // The last chunk again after the rename: done, same path, nothing rewritten.
    expect(await at(2 * MB, parts[2], { sha256: sha(body) })).toMatchObject({ done: true, path: target })
  })

  it('a chunk past what is staged answers gap with have; offset 0 starts over', async () => {
    const root = path.join(tmp, 'r2')
    const call = (offset: number, data: Buffer) => core.uploadPart({ uploadId: ID, name: 'a.pdf', size: body.length, offset, data: b64(data) }, root)
    await call(0, parts[0])
    expect(await refusal(call(2 * MB, parts[2]))).toMatchObject({ code: 'gap', data: { have: MB } })
    expect(await call(0, parts[0])).toEqual({ staged: MB })
  })

  it('a wrong checksum leaves no file', async () => {
    const root = path.join(tmp, 'r3')
    const small = Buffer.from('%PDF-1.4 tiny')
    expect(await refusal(core.uploadPart({ uploadId: ID, name: 'b.pdf', size: small.length, offset: 0, data: b64(small), sha256: sha(Buffer.from('other')) }, root)))
      .toMatchObject({ code: 'checksum_mismatch' })
    expect(fs.existsSync(path.join(root, ID, 'b.pdf'))).toBe(false)
  })

  it('an empty file is one empty chunk', async () => {
    const root = path.join(tmp, 'r4')
    const r = await core.uploadPart({ uploadId: ID, name: 'empty.txt', size: 0, offset: 0, data: '' }, root)
    expect(r).toMatchObject({ done: true, path: path.join(root, ID, 'empty.txt') })
    expect(fs.statSync(path.join(root, ID, 'empty.txt')).size).toBe(0)
  })

  it('refuses any name or id that could leave its folder, and never writes', async () => {
    const root = path.join(tmp, 'r5')
    const one = Buffer.from('x')
    const names = ['../escape.txt', 'a/b.txt', 'a\\b.txt', '..', '.', '.hidden', ' lead.txt', 'trail.txt ', 'nul\u0000.txt', 'line\nbreak.txt',
      'x.walnut-part', '', 'a'.repeat(201)]
    for (const name of names) {
      expect(await refusal(core.uploadPart({ uploadId: ID, name, size: 1, offset: 0, data: b64(one) }, root)), JSON.stringify(name))
        .toMatchObject({ code: 'bad_request' })
    }
    for (const uploadId of ['../up-12345678', 'up-short', 'down-12345678', 'up-12345678/../x', 123]) {
      expect(await refusal(core.uploadPart({ uploadId, name: 'ok.txt', size: 1, offset: 0, data: b64(one) }, root))).toMatchObject({ code: 'bad_request' })
    }
    expect(await refusal(core.uploadPart({ uploadId: ID, name: 'ok.txt', size: 1, offset: 0, data: b64(one) }, 'relative/root'))).toMatchObject({ code: 'unavailable' })
    expect(fs.existsSync(root)).toBe(false)
    // isUploadName (the server's check before any bytes move) agrees on every case.
    for (const name of names) expect(isUploadName(name), JSON.stringify(name)).toBe(false)
    expect(isUploadName('Clip from the phone \u4e2d\u6587.mov')).toBe(true)
  })

  it('refuses a file larger than the cap and a part past the declared size', async () => {
    const root = path.join(tmp, 'r6')
    expect(await refusal(core.uploadPart({ uploadId: ID, name: 'big.bin', size: 4 * 1024 ** 3 + 1, offset: 0, data: b64(Buffer.from('x')) }, root)))
      .toMatchObject({ code: 'bad_request' })
    expect(await refusal(core.uploadPart({ uploadId: ID, name: 'over.bin', size: 2, offset: 0, data: b64(Buffer.from('xyz')) }, root)))
      .toMatchObject({ code: 'size_mismatch' })
  })

  it('the first chunk is refused when the disk cannot hold the file plus the margin', async () => {
    const tight = createTransferCore(deps({
      fs: { ...fs, promises: { ...fs.promises, statfs: async () => ({ bavail: 100, bsize: 4096 }) } } as unknown as typeof fs,
    }))
    const root = path.join(tmp, 'r7')
    expect(await refusal(tight.uploadPart({ uploadId: ID, name: 'v.mov', size: 10, offset: 0, data: b64(Buffer.from('0123456789')) }, root)))
      .toMatchObject({ code: 'no_space', data: { free: 409_600 } })
    expect(fs.existsSync(root)).toBe(false)
  })

  it('every chunk checks the room the rest of the file needs, and keeps the size its first chunk named', async () => {
    let free = 10 * 1024 ** 3
    const shrinking = createTransferCore(deps({
      fs: { ...fs, promises: { ...fs.promises, statfs: async () => ({ bavail: free / 4096, bsize: 4096 }) } } as unknown as typeof fs,
    }))
    const root = path.join(tmp, 'r9')
    const call = (offset: number, data: Buffer, size = body.length) =>
      shrinking.uploadPart({ uploadId: ID, name: 'v.mov', size, offset, data: b64(data) }, root)
    expect(await call(0, parts[0])).toEqual({ staged: MB })
    // A later chunk may not change the size the free-space check was made for.
    expect(await refusal(call(MB, parts[1], 4 * 1024 ** 3))).toMatchObject({ code: 'bad_request' })
    // Another upload took the room: the next chunk stops with no_space, not a full disk.
    free = 100 * MB
    expect(await refusal(call(MB, parts[1]))).toMatchObject({ code: 'no_space' })
    // The size record is beside the file under a dot name no upload can take.
    expect(fs.readdirSync(path.join(root, ID)).sort()).toEqual(['.upload.json', 'v.mov.walnut-part'])
  })

  it('a finished upload is never written again; only its last chunk is answered', async () => {
    const root = path.join(tmp, 'r10')
    const one = Buffer.from('first version')
    const call = (data: Buffer, sha256?: string) =>
      core.uploadPart({ uploadId: ID, name: 'n.txt', size: data.length, offset: 0, data: b64(data), ...(sha256 ? { sha256 } : {}) }, root)
    expect(await call(one, sha(one))).toMatchObject({ done: true })
    expect(fs.readdirSync(path.join(root, ID))).toEqual(['n.txt'])
    expect(await call(one, sha(one))).toMatchObject({ done: true, path: path.join(root, ID, 'n.txt') })
    // An earlier chunk of the same file (a resend after the app was ended) is told
    // the upload is whole; its empty last chunk then answers the path.
    expect(await refusal(core.uploadPart({ uploadId: ID, name: 'n.txt', size: one.length, offset: 0, data: b64(one.subarray(0, 4)) }, root)))
      .toMatchObject({ code: 'gap', data: { have: one.length } })
    expect(await core.uploadPart({ uploadId: ID, name: 'n.txt', size: one.length, offset: one.length, data: '', sha256: sha(one) }, root))
      .toMatchObject({ done: true, path: path.join(root, ID, 'n.txt') })
    const other = Buffer.from('other version')
    expect(await refusal(call(other, sha(other)))).toMatchObject({ code: 'bad_request' })
    expect(await refusal(call(other))).toMatchObject({ code: 'bad_request' })
    expect(fs.readFileSync(path.join(root, ID, 'n.txt')).equals(one)).toBe(true)
  })

  it('a repeat racing the last chunk waits for it and answers the finished file', async () => {
    const root = path.join(tmp, 'r-race', 'uploads')
    const call = (offset: number, data: Buffer, sha256?: string) =>
      core.uploadPart({ uploadId: ID, name: 'race.mov', size: body.length, offset, data: b64(data), ...(sha256 ? { sha256 } : {}) }, root)
    await call(0, parts[0])
    await call(MB, parts[1])
    // The last chunk and its repeat (a lost reply), and an earlier chunk resent,
    // all at once: each sees either the staged file or the finished one, never
    // the moment between, and the file is written once.
    const [a, b, c] = await Promise.allSettled([
      call(2 * MB, parts[2], sha(body)), call(2 * MB, parts[2], sha(body)), call(MB, parts[1]),
    ])
    const target = path.join(root, ID, 'race.mov')
    expect(a).toMatchObject({ status: 'fulfilled', value: { done: true, path: target } })
    expect(b).toMatchObject({ status: 'fulfilled', value: { done: true, path: target } })
    expect(c).toMatchObject({ status: 'rejected', reason: { code: 'gap', data: { have: body.length } } })
    expect(fs.readFileSync(target).equals(body)).toBe(true)
  })

  it('a first chunk sweeps uploads given up on a day ago, never a finished file or a live one', async () => {
    let clock = Date.now()
    const timed = createTransferCore(deps({ now: () => clock }))
    const root = path.join(tmp, 'r11')
    const stale = 'up-aaaaaaaa-0000-0000-0000-000000000001'
    const live = 'up-aaaaaaaa-0000-0000-0000-000000000002'
    const done = 'up-aaaaaaaa-0000-0000-0000-000000000003'
    const start = (uploadId: string, size = 10) => timed.uploadPart({ uploadId, name: 'f.bin', size, offset: 0, data: b64(Buffer.from('12345')) }, root)
    await start(stale)
    await timed.uploadPart({ uploadId: done, name: 'f.bin', size: 5, offset: 0, data: b64(Buffer.from('12345')) }, root)
    clock += 25 * 60 * 60 * 1000
    await start(live)
    await new Promise((r) => setTimeout(r, 200))
    expect(fs.existsSync(path.join(root, stale))).toBe(false)
    expect(fs.existsSync(path.join(root, live, 'f.bin.walnut-part'))).toBe(true)
    expect(fs.existsSync(path.join(root, done, 'f.bin'))).toBe(true)
  })

  it('the inlined factory text answers the same', async () => {
    const strict = new Function('"use strict"; return (' + String(createTransferCore) + ')')() as typeof createTransferCore
    const inlined = strict(deps())
    const root = path.join(tmp, 'r8')
    const r = await inlined.uploadPart({ uploadId: ID, name: 'same.txt', size: 5, offset: 0, data: b64(Buffer.from('hello')), sha256: sha(Buffer.from('hello')) }, root)
    expect(r).toMatchObject({ done: true, path: path.join(root, ID, 'same.txt') })
    expect(await refusal(inlined.uploadPart({ uploadId: ID, name: '../x', size: 1, offset: 0, data: 'eA==' }, root))).toMatchObject({ code: 'bad_request' })
  })
})

describe('upload.part twin wiring', () => {
  const ROOT = path.resolve(__dirname, '../..')
  const read = (rel: string) => fs.readFileSync(path.join(ROOT, rel), 'utf8')
  const setLiteral = (src: string, name: string) => {
    const start = src.indexOf(name + ' = new Set([')
    const end = src.indexOf('])', start)
    return src.slice(start, end).split('\n').map((l) => l.replace(/\/\/.*$/, '')).join('\n')
  }

  it('both twins dispatch it, allow it over the bridge, and never to a follower', () => {
    for (const rel of ['src/providers/daemon-standalone.ts', 'src/providers/daemon-source.ts']) {
      const src = read(rel)
      expect(src, rel).toContain("case 'upload.part':")
      expect(setLiteral(src, 'BRIDGE_ALLOWED_COMMANDS'), rel).toContain("'upload.part'")
      expect(setLiteral(src, 'FOLLOWER_ALLOWED_COMMANDS'), rel).not.toContain("'upload.part'")
      expect(src, rel).toContain('function uploadsRootFor(')
    }
  })

  it('is advertised, not required, and rides the bulk lane', () => {
    expect(ADVERTISED_DAEMON_CAPABILITIES).toContain('upload-part-v1')
    expect(REQUIRED_DAEMON_CAPABILITIES as readonly string[]).not.toContain('upload-part-v1')
    expect(read('src/providers/daemon-connection.ts')).toMatch(/BULK_COMMANDS = new Set\(\[[^\]]*'upload\.part'/)
  })
})

describe('the message text a file send carries', () => {
  it('names the paths under the files header, and titles read only the words', () => {
    const text = withFilePaths('what is in this clip?', ['/h/tasks/t1/uploads/up-1/clip.mov', '/h/tasks/t1/uploads/up-2/My Report.pdf'])
    expect(text).toBe(`${FILES_ATTACHED_LINE}\n- /h/tasks/t1/uploads/up-1/clip.mov\n- /h/tasks/t1/uploads/up-2/My Report.pdf\n\nwhat is in this clip?`)
    expect(withoutAttachmentHeaders(text)).toBe('what is in this clip?')
    // A photo too: the server puts its header in front of the phone's.
    const both = withImagePaths(text, ['/tmp/open-walnut/images/1-a.jpg'])
    expect(both.startsWith(IMAGES_ATTACHED_LINE)).toBe(true)
    expect(withoutAttachmentHeaders(both)).toBe('what is in this clip?')
    expect(withoutAttachmentHeaders('plain words')).toBe('plain words')
  })
})
