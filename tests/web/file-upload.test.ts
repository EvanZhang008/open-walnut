/**
 * The web's file attachments (web/src/api/file-upload.ts): one contract with the
 * server's chunk lane and message header (src/core/sessions/session-uploads.ts),
 * so a name the composer picks is one the host takes, the header the composer
 * writes is the one titles and history read, and the upload resumes the way the
 * host answers.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import {
  FILES_ATTACHED_LINE as WEB_LINE, MAX_FILE_BYTES, UPLOAD_CHUNK_BYTES as WEB_CHUNK, safeUploadName,
  splitAttachmentHeaders, uploadFile, withFilePaths as webWithFilePaths, FileUploadError, formatBytes,
} from '../../web/src/api/file-upload.js'
import {
  FILES_ATTACHED_LINE, MAX_UPLOAD_BYTES, UPLOAD_CHUNK_BYTES, isUploadName, withFilePaths, withoutAttachmentHeaders,
} from '../../src/core/sessions/session-uploads.js'
import { IMAGES_ATTACHED_LINE } from '../../src/core/sessions/cloud-images.js'

describe('the web mirror of the upload contract', () => {
  it('has the server\'s header, chunk size and file cap', () => {
    expect(WEB_LINE).toBe(FILES_ATTACHED_LINE)
    expect(WEB_CHUNK).toBe(UPLOAD_CHUNK_BYTES)
    expect(MAX_FILE_BYTES).toBe(MAX_UPLOAD_BYTES)
  })

  it('writes the same message the server and the phone write', () => {
    expect(webWithFilePaths('hi', ['/a/b.pdf', '/a/c d.zip'])).toBe(withFilePaths('hi', ['/a/b.pdf', '/a/c d.zip']))
    expect(webWithFilePaths('hi', [])).toBe('hi')
  })

  it('every name it picks is one the host takes', () => {
    const names = [
      'report.pdf', '.env', '..', '  spaced  .txt', 'a/b\\c.log', 'tab\there.txt', '', 'x.walnut-part',
      `${'é'.repeat(150)}.json`, `${'a'.repeat(400)}.tar.gz`, '文件.txt', '...hidden', ' ', 'new\nline.md',
    ]
    for (const raw of names) {
      const safe = safeUploadName(raw)
      expect(isUploadName(safe), JSON.stringify({ raw, safe })).toBe(true)
    }
    expect(safeUploadName('report.pdf')).toBe('report.pdf')
    expect(safeUploadName(`${'a'.repeat(400)}.gz`).endsWith('.gz')).toBe(true)
  })
})

describe('splitAttachmentHeaders', () => {
  it('reads both headers in the order the server writes them, and keeps the words', () => {
    const sent = webWithFilePaths('why does this crash?', ['/h/uploads/up-1/crash.log', '/h/uploads/up-2/core dump.zip'])
    const stored = `${IMAGES_ATTACHED_LINE}\n- /tmp/open-walnut/images/1-abc.png\n\n${sent}`
    expect(splitAttachmentHeaders(stored)).toEqual({
      images: ['/tmp/open-walnut/images/1-abc.png'],
      files: ['/h/uploads/up-1/crash.log', '/h/uploads/up-2/core dump.zip'],
      body: 'why does this crash?',
    })
    // The same words the server's title reader keeps.
    expect(splitAttachmentHeaders(stored)!.body).toBe(withoutAttachmentHeaders(stored))
  })

  it('a message of files only has empty words', () => {
    expect(splitAttachmentHeaders(webWithFilePaths('', ['/x/a.pdf']))).toEqual({ images: [], files: ['/x/a.pdf'], body: '' })
  })

  it('an ordinary message, or a header mid-text, is left alone', () => {
    expect(splitAttachmentHeaders('hello')).toBeNull()
    expect(splitAttachmentHeaders(`see\n${FILES_ATTACHED_LINE}\n- /x/a.pdf`)).toBeNull()
    expect(splitAttachmentHeaders(`${FILES_ATTACHED_LINE}\n\nno paths`)).toBeNull()
  })
})

describe('formatBytes', () => {
  it('reads like a size', () => {
    expect(formatBytes(812)).toBe('812 B')
    expect(formatBytes(4300)).toBe('4.2 KB')
    expect(formatBytes(4 * 1024 ** 3)).toBe('4 GB')
    expect(formatBytes(3 * 1024 * 1024 + 17)).toBe('3 MB')
  })
})

// ── uploadFile against a stand-in XMLHttpRequest ──

interface Sent { method: string; url: string; body: Blob; headers: Record<string, string> }
type Answer = { status: number; body?: unknown } | 'network-error'

let sent: Sent[] = []
let answer: (req: Sent, index: number) => Answer

class FakeXhr {
  method = ''
  url = ''
  headers: Record<string, string> = {}
  status = 0
  responseText = ''
  upload: { onprogress: ((e: { lengthComputable: boolean; loaded: number }) => void) | null } = { onprogress: null }
  onload: (() => void) | null = null
  onerror: (() => void) | null = null
  onabort: (() => void) | null = null
  ontimeout: (() => void) | null = null
  open(method: string, url: string) { this.method = method; this.url = url }
  setRequestHeader(k: string, v: string) { this.headers[k] = v }
  abort() { this.onabort?.() }
  send(body: Blob) {
    const req: Sent = { method: this.method, url: this.url, body, headers: this.headers }
    const index = sent.push(req) - 1
    queueMicrotask(() => {
      this.upload.onprogress?.({ lengthComputable: true, loaded: body.size })
      const a = answer(req, index)
      if (a === 'network-error') { this.onerror?.(); return }
      this.status = a.status
      this.responseText = a.body === undefined ? '' : JSON.stringify(a.body)
      this.onload?.()
    })
  }
}

function query(url: string): URLSearchParams {
  return new URLSearchParams(url.split('?')[1])
}

beforeEach(() => {
  sent = []
  vi.stubGlobal('XMLHttpRequest', FakeXhr)
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
})
afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

const bytes = (n: number) => new Blob([new Uint8Array(n).fill(9)])

/** Move the fake clock until `p` settles (its checksum and reads take real time between the waits). */
async function settled<T>(p: Promise<T>): Promise<void> {
  let done = false
  p.then(() => { done = true }, () => { done = true })
  for (let i = 0; i < 200 && !done; i++) await vi.advanceTimersByTimeAsync(500)
}

describe('uploadFile', () => {
  it('sends chunks to the session route and answers the host path; progress only grows', async () => {
    const file = bytes(UPLOAD_CHUNK_BYTES + 100)
    answer = (req) => {
      const q = query(req.url)
      const end = Number(q.get('offset')) + req.body.size
      return end === file.size
        ? { status: 200, body: { received: end, size: file.size, done: true, path: '/h/tasks/t/uploads/up-a/big.bin' } }
        : { status: 200, body: { received: end, size: file.size, done: false } }
    }
    const progress: number[] = []
    const path = await uploadFile(file, { sessionId: 'sess-1' }, { uploadId: 'up-aaaaaaaa', name: 'big.bin', signal: new AbortController().signal, onProgress: (n) => progress.push(n) })
    expect(path).toBe('/h/tasks/t/uploads/up-a/big.bin')
    expect(sent.map((s) => s.url.split('?')[0])).toEqual(['/api/v1/sessions/sess-1/uploads/up-aaaaaaaa', '/api/v1/sessions/sess-1/uploads/up-aaaaaaaa'])
    expect(sent.map((s) => query(s.url).get('offset'))).toEqual(['0', String(UPLOAD_CHUNK_BYTES)])
    expect(query(sent[1].url).get('sha256')).toMatch(/^[0-9a-f]{64}$/)
    expect(query(sent[0].url).get('sha256')).toBeNull()
    expect(sent.every((s) => s.method === 'PUT' && s.headers['Content-Type'] === 'application/octet-stream')).toBe(true)
    expect(progress.every((n, i) => i === 0 || n >= progress[i - 1])).toBe(true)
    expect(progress.at(-1)).toBe(file.size)
  })

  it('with no session the bytes go to this machine', async () => {
    answer = () => ({ status: 200, body: { received: 3, size: 3, done: true, path: '/h/uploads/up-b/a.txt' } })
    await uploadFile(bytes(3), {}, { uploadId: 'up-bbbbbbbb', name: 'a.txt', signal: new AbortController().signal, onProgress: () => {} })
    expect(sent[0].url.split('?')[0]).toBe('/api/v1/uploads/up-bbbbbbbb')
  })

  it('resumes where the host says, and sends a dropped chunk again', async () => {
    vi.useRealTimers()
    const file = bytes(UPLOAD_CHUNK_BYTES * 2)
    answer = (req, i) => {
      if (i === 0) return { status: 409, body: { error: { code: 'upload_offset_mismatch', message: 'has more', received: UPLOAD_CHUNK_BYTES } } }
      if (i === 1) return 'network-error'
      return { status: 200, body: { received: file.size, size: file.size, done: true, path: '/p' } }
    }
    // Real time: one 600 ms pause before the dropped chunk goes again.
    const done = uploadFile(file, { sessionId: 's' }, { uploadId: 'up-cccccccc', name: 'x', signal: new AbortController().signal, onProgress: () => {} })
    expect(await done).toBe('/p')
    expect(sent.map((s) => query(s.url).get('offset'))).toEqual(['0', String(UPLOAD_CHUNK_BYTES), String(UPLOAD_CHUNK_BYTES)])
  })

  it('a refusal fails with the host\'s words; a link that stays down fails after a few tries', async () => {
    answer = () => ({ status: 507, body: { error: { code: 'host_disk_full', message: "The session's host does not have room for this file." } } })
    await expect(uploadFile(bytes(5), { sessionId: 's' }, { uploadId: 'up-dddddddd', name: 'x', signal: new AbortController().signal, onProgress: () => {} }))
      .rejects.toMatchObject({ message: "The session's host does not have room for this file.", code: 'host_disk_full' })

    sent = []
    answer = () => ({ status: 503, body: { error: { code: 'bridge_offline', message: 'no link' } } })
    const failing = uploadFile(bytes(5), { sessionId: 's' }, { uploadId: 'up-eeeeeeee', name: 'x', signal: new AbortController().signal, onProgress: () => {} })
    const caught = failing.catch((e: unknown) => e)
    await settled(failing)
    const err = await caught
    expect(err).toBeInstanceOf(FileUploadError)
    expect(sent.length).toBe(4)
  })

  it('an older server without the route says Walnut needs an update', async () => {
    answer = () => ({ status: 404 })
    await expect(uploadFile(bytes(5), {}, { uploadId: 'up-ffffffff', name: 'x', signal: new AbortController().signal, onProgress: () => {} }))
      .rejects.toMatchObject({ code: 'not_supported' })
  })

  it('removing it stops the upload', async () => {
    const ctrl = new AbortController()
    answer = () => { ctrl.abort(); return { status: 200, body: { received: 0, size: 5, done: false } } }
    await expect(uploadFile(bytes(5), {}, { uploadId: 'up-gggggggg', name: 'x', signal: ctrl.signal, onProgress: () => {} }))
      .rejects.toMatchObject({ name: 'AbortError' })
  })
})
