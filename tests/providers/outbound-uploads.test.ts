/**
 * Walnut's own files a message names (an attachment uploaded before its session
 * existed, a spilled paste) reach a session on another host: found by their
 * `- <path>` line in a header block at the top of the message, read only from
 * Walnut's own upload folders, sent in chunks over `upload.part`, and the line
 * rewritten to the host's copy (or kept with a note when it could not be sent).
 * Any other path is never read or sent.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createHash } from 'node:crypto'
import {
  attachmentBlocks, findShippableFiles, rewriteShipped, shipFile, SHIP_FAILED_NOTE, type DaemonSend, type ShipRoots,
} from '../../src/providers/outbound-uploads.js'
import { FILES_ATTACHED_LINE, UPLOAD_CHUNK_BYTES, withFilePaths } from '../../src/core/sessions/session-uploads.js'

const IMAGES_LINE = '[Images attached — use the Read tool to view them]'
const PASTE_LINE = '[Large text attached — 300,000 chars, spilled to a file. Use the Read tool to view it]'

let root: string
let roots: ShipRoots

beforeEach(() => {
  // Resolved: the folders are compared after symlinks are followed (macOS /var, /home here).
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'outbound-uploads-')))
  roots = { uploads: [path.join(root, 'state', 'uploads')], tasks: [path.join(root, 'state', 'tasks')], pastes: [path.join(root, 'pastes')] }
  fs.mkdirSync(roots.pastes[0], { recursive: true })
})
afterEach(() => fs.rmSync(root, { recursive: true, force: true }))

function upload(id: string, name: string, data: string | Buffer, dir = path.join(root, 'state', 'uploads')): string {
  fs.mkdirSync(path.join(dir, id), { recursive: true })
  const p = path.join(dir, id, name)
  fs.writeFileSync(p, data)
  return p
}

const file = (p: string, uploadId: string, name: string) => ({ localPath: p, readPath: p, uploadId, name })

describe('findShippableFiles', () => {
  it('finds an uploaded attachment under the header, a name with spaces whole', () => {
    const p = upload('up-11111111-aaaa', 'build log (1).txt', 'x')
    const text = withFilePaths('what failed?', [p])
    expect(text.startsWith(FILES_ATTACHED_LINE)).toBe(true)
    expect(findShippableFiles(text, roots)).toEqual([file(p, 'up-11111111-aaaa', 'build log (1).txt')])
  })

  it("finds a task's upload and a files block after the pictures' block", () => {
    const p = upload('up-12121212-abab', 'trace.zip', 'z', path.join(root, 'state', 'tasks', 'task-1', 'uploads'))
    const text = `${IMAGES_LINE}\n- /x/images/a.png\n\n${FILES_ATTACHED_LINE}\n- ${p}\n\nlook`
    expect(findShippableFiles(text, roots)).toEqual([file(p, 'up-12121212-abab', 'trace.zip')])
  })

  it('finds a spilled paste and gives it a stable upload id', () => {
    const p = path.join(roots.pastes[0], '1730000000000-abcdef123456.txt')
    fs.writeFileSync(p, 'big paste')
    const text = `${PASTE_LINE}\n- ${p}`
    const [a] = findShippableFiles(text, roots)
    const [b] = findShippableFiles(text, roots)
    expect(a.localPath).toBe(p)
    expect(a.uploadId).toMatch(/^up-paste-[0-9a-f]{24}$/)
    expect(b.uploadId).toBe(a.uploadId)
  })

  it('reads a path only inside the upload folders, even one shaped like an upload', () => {
    // `/uploads/up-…/<name>` under some other folder: the shape alone used to be enough.
    const lookalike = upload('up-99999999-zzzz', 'id_rsa', 'secret', path.join(root, 'home', 'project', 'uploads'))
    // A symlink inside the uploads folder to a file outside it.
    const outside = path.join(root, 'secrets.txt')
    fs.writeFileSync(outside, 's')
    fs.mkdirSync(path.join(roots.uploads[0], 'up-88888888-yyyy'), { recursive: true })
    const link = path.join(roots.uploads[0], 'up-88888888-yyyy', 'notes.txt')
    fs.symlinkSync(outside, link)
    // One folder too deep, and a task file that is not under the task's uploads.
    const deep = upload('up-77777777-xxxx', 'a.txt', 'x', path.join(roots.uploads[0], 'up-66666666-wwww'))
    const taskFile = path.join(root, 'state', 'tasks', 'task-1', 'notes', 'up-55555555-vvvv', 'n.txt')
    fs.mkdirSync(path.dirname(taskFile), { recursive: true })
    fs.writeFileSync(taskFile, 'n')
    const text = `${FILES_ATTACHED_LINE}\n- ${lookalike}\n- ${link}\n- ${deep}\n- ${taskFile}\n- ${outside}\n\nhi`
    expect(findShippableFiles(text, roots)).toEqual([])
  })

  it('reads only `- ` lines of a header block at the top, never the pictures block or the body', () => {
    const owned = upload('up-22222222-bbbb', 'a.log', 'x')
    const missing = path.join(roots.uploads[0], 'up-33333333-cccc', 'gone.zip')
    const cases = [
      // No header: a bullet anywhere in the text.
      `- ${owned}`,
      // A header further down the message, not at the top.
      `look at this\n${FILES_ATTACHED_LINE}\n- ${owned}`,
      // The body after a header block.
      `${FILES_ATTACHED_LINE}\n- ${missing}\n\nalso\n- ${owned}`,
      // Under the pictures header: the picture lane takes it.
      `${IMAGES_LINE}\n- ${owned}\n\nhi`,
      // Written out by hand: path.join would fold the `..` away.
      `${FILES_ATTACHED_LINE}\n- ${root}/state/uploads/up-22222222-bbbb/../up-22222222-bbbb/a.log`,
      `${FILES_ATTACHED_LINE}\nsee ${owned}`,
    ]
    for (const text of cases) expect(findShippableFiles(text, roots), text).toEqual([])
  })

  it('reads CRLF lines', () => {
    const p = upload('up-44444444-dddd', 'win.txt', 'x')
    expect(findShippableFiles(`${FILES_ATTACHED_LINE}\r\n- ${p}\r\n\r\nhi`, roots)).toEqual([file(p, 'up-44444444-dddd', 'win.txt')])
  })

  it('lists the blocks in order with their kinds', () => {
    const text = `${IMAGES_LINE}\n- /i/a.png\n\n${FILES_ATTACHED_LINE}\n- /f/b.pdf\n- /f/c d.txt\n\n${PASTE_LINE}\n- /p/x.txt\n\nwords\n- /not/listed`
    expect(attachmentBlocks(text)).toEqual([
      { kind: 'images', paths: ['/i/a.png'] },
      { kind: 'files', paths: ['/f/b.pdf', '/f/c d.txt'] },
      { kind: 'paste', paths: ['/p/x.txt'] },
    ])
  })
})

describe('shipFile', () => {
  it('sends the file in chunks, the checksum on the last, the owner on each, and answers the host path', async () => {
    const bytes = Buffer.alloc(UPLOAD_CHUNK_BYTES * 2 + 10, 7)
    const p = upload('up-44444444-dddd', 'dump.bin', bytes)
    const calls: Array<Record<string, unknown>> = []
    let held = 0
    const send: DaemonSend = vi.fn(async (_cmd, params) => {
      calls.push(params)
      held += Buffer.from(String(params.data), 'base64').length
      return held === bytes.length
        ? { ok: true, staged: held, done: true, path: '/remote/uploads/up-44444444-dddd/dump.bin' }
        : { ok: true, staged: held }
    })
    const out = await shipFile(file(p, 'up-44444444-dddd', 'dump.bin'), send, { sessionId: 'sid-1', taskId: 'task-1', home: '/h/.open-walnut' })
    expect(out).toEqual({ ok: true, path: '/remote/uploads/up-44444444-dddd/dump.bin' })
    expect(calls.map((c) => c.offset)).toEqual([0, UPLOAD_CHUNK_BYTES, UPLOAD_CHUNK_BYTES * 2])
    expect(calls.every((c) => c.size === bytes.length && c.uploadId === 'up-44444444-dddd')).toBe(true)
    expect(calls.every((c) => c.sessionId === 'sid-1' && c.taskId === 'task-1' && c.home === '/h/.open-walnut')).toBe(true)
    expect(calls[2].sha256).toBe(createHash('sha256').update(bytes).digest('hex'))
    expect(calls[0].sha256).toBeUndefined()
    expect((send as ReturnType<typeof vi.fn>).mock.calls.every((c) => c[0] === 'upload.part')).toBe(true)
  })

  it('an empty file is one empty chunk', async () => {
    const p = upload('up-55555555-eeee', 'empty.txt', '')
    const send: DaemonSend = vi.fn(async () => ({ ok: true, staged: 0, done: true, path: '/r/empty.txt' }))
    expect(await shipFile(file(p, 'up-55555555-eeee', 'empty.txt'), send)).toEqual({ ok: true, path: '/r/empty.txt' })
    expect((send as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(1)
  })

  it('a file the host already finished (shipped before) answers its path from the last chunk', async () => {
    const bytes = Buffer.alloc(UPLOAD_CHUNK_BYTES + 5, 1)
    const p = upload('up-66666666-ffff', 'again.bin', bytes)
    const send: DaemonSend = vi.fn(async (_cmd, params) => (params.offset === 0
      ? { ok: false, error: 'upload.part failed: this upload is finished; send its last chunk', code: 'gap', have: bytes.length }
      : { ok: true, staged: bytes.length, done: true, path: '/r/again.bin' }))
    expect(await shipFile(file(p, 'up-66666666-ffff', 'again.bin'), send)).toEqual({ ok: true, path: '/r/again.bin' })
    const offsets = (send as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[1].offset)
    expect(offsets).toEqual([0, bytes.length])
  })

  it('a gap part way through resumes from what the host holds', async () => {
    const bytes = Buffer.alloc(UPLOAD_CHUNK_BYTES * 3, 3)
    const p = upload('up-67676767-abcd', 'part.bin', bytes)
    // The host holds one chunk of an earlier ship that was cut off; this ship's
    // second chunk lands, then the host loses the staged tail and holds one chunk again.
    let held = UPLOAD_CHUNK_BYTES
    let lostOnce = false
    const send: DaemonSend = vi.fn(async (_cmd, params) => {
      const offset = Number(params.offset)
      const length = Buffer.from(String(params.data), 'base64').length
      if (offset === UPLOAD_CHUNK_BYTES * 2 && !lostOnce) { lostOnce = true; held = UPLOAD_CHUNK_BYTES }
      if (offset > held) return { ok: false, error: `upload.part failed: staged ${held} bytes`, code: 'gap', have: held }
      held = Math.max(held, offset + length)
      return held === bytes.length ? { ok: true, staged: held, done: true, path: '/r/part.bin' } : { ok: true, staged: held }
    })
    expect(await shipFile(file(p, 'up-67676767-abcd', 'part.bin'), send)).toEqual({ ok: true, path: '/r/part.bin' })
    const offsets = (send as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[1].offset)
    expect(offsets).toEqual([0, UPLOAD_CHUNK_BYTES, UPLOAD_CHUNK_BYTES * 2, UPLOAD_CHUNK_BYTES, UPLOAD_CHUNK_BYTES * 2])
  })

  it('a host that keeps answering gap is given up on, not looped on', async () => {
    const bytes = Buffer.alloc(UPLOAD_CHUNK_BYTES * 2, 4)
    const p = upload('up-68686868-abcd', 'loop.bin', bytes)
    const send: DaemonSend = vi.fn(async (_cmd, params) => (params.offset === 0
      ? { ok: true, staged: UPLOAD_CHUNK_BYTES }
      : { ok: false, error: 'upload.part failed: staged 0 bytes', code: 'gap', have: 0 }))
    const out = await shipFile(file(p, 'up-68686868-abcd', 'loop.bin'), send)
    expect(out.ok).toBe(false)
    expect((send as ReturnType<typeof vi.fn>).mock.calls.length).toBeLessThan(30)
  })

  it('a refusal answers why (the caller keeps the local path with a note)', async () => {
    const p = upload('up-77777777-0000', 'x.zip', 'zip')
    const send: DaemonSend = vi.fn(async () => ({ ok: false, error: 'upload.part failed: no room', code: 'no_space' }))
    expect(await shipFile(file(p, 'up-77777777-0000', 'x.zip'), send)).toEqual({ ok: false, reason: 'no room' })
  })
})

describe('rewriteShipped', () => {
  it('swaps only whole `- <path>` lines of the header blocks', () => {
    const text = `${FILES_ATTACHED_LINE}\n- /l/a.txt\n- /l/b.txt\n\nmention /l/a.txt inline\n- /l/a.txt`
    const out = rewriteShipped(text, new Map([['/l/a.txt', '/r/a.txt']]))
    expect(out).toBe(`${FILES_ATTACHED_LINE}\n- /r/a.txt\n- /l/b.txt\n\nmention /l/a.txt inline\n- /l/a.txt`)
  })

  it('swaps CRLF lines and keeps their CR', () => {
    const text = `${FILES_ATTACHED_LINE}\r\n- /l/a.txt\r\n\r\nhi`
    expect(rewriteShipped(text, new Map([['/l/a.txt', '/r/a.txt']]))).toBe(`${FILES_ATTACHED_LINE}\r\n- /r/a.txt\r\n\r\nhi`)
  })

  it('keeps a path that failed, with a one-line note the agent can read', () => {
    const text = `${FILES_ATTACHED_LINE}\n- /mac/u/x.log\n- /mac/u/y.log\n\nwhat broke?`
    const out = rewriteShipped(text, new Map([['/mac/u/y.log', '/r/y.log']]), new Map([['/mac/u/x.log', 'host has 10 bytes free (needs 20)\nmore']]))
    expect(out).toBe(`${FILES_ATTACHED_LINE}\n- /mac/u/x.log (could not be copied to this host: host has 10 bytes free needs 20 more)\n- /r/y.log\n\nwhat broke?`)
    expect(out.split('\n')[1].startsWith(`- /mac/u/x.log${SHIP_FAILED_NOTE}`)).toBe(true)
  })
})
