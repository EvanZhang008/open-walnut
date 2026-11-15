/**
 * The shared upload retry (web/src/api/upload-retry.ts): an attachment whose
 * upload hit a dropped connection or a restarting server (2026-11-15: a paste
 * during a production restart showed "1 upload failed ... The connection to
 * Walnut dropped", and a manual Retry worked) waits and goes again by itself;
 * a real refusal fails at once with words that say what to do.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import {
  UploadAttemptError, isTransientUploadError, transientStatus, uploadRetryDelay, withUploadRetry,
} from '../../web/src/api/upload-retry.js'
import { ApiError } from '../../web/src/api/client.js'
import { uploadImageWithProgress } from '../../web/src/api/image-upload.js'
import { uploadFile } from '../../web/src/api/file-upload.js'

describe('which failures clear on their own', () => {
  it('a dropped link, a timeout and a restarting server do; a refusal does not', () => {
    for (const s of [0, 408, 429, 502, 503, 504]) expect(transientStatus(s), String(s)).toBe(true)
    for (const s of [400, 401, 403, 404, 413, 415, 422, 500, 507]) expect(transientStatus(s), String(s)).toBe(false)
    expect(isTransientUploadError(new TypeError('Failed to fetch'))).toBe(true)
    expect(isTransientUploadError(new DOMException('deadline', 'TimeoutError'))).toBe(true)
    expect(isTransientUploadError(new ApiError(503, 'restarting'))).toBe(true)
    expect(isTransientUploadError(new ApiError(413, 'too big'))).toBe(false)
    expect(isTransientUploadError(new UploadAttemptError('x', true))).toBe(true)
    expect(isTransientUploadError(new UploadAttemptError('x', false))).toBe(false)
    expect(isTransientUploadError(new Error('bug'))).toBe(false)
    // fetch's own network failure in each engine; any other TypeError is a bug.
    for (const m of ['Failed to fetch', 'Load failed', 'NetworkError when attempting to fetch resource.']) expect(isTransientUploadError(new TypeError(m)), m).toBe(true)
    expect(isTransientUploadError(new TypeError("Cannot read properties of undefined (reading 'url')"))).toBe(false)
  })

  it('the pause grows and stays short enough to feel alive', () => {
    expect([0, 1, 2, 3, 4, 10].map(uploadRetryDelay)).toEqual([1000, 2000, 4000, 8000, 8000, 8000])
  })
})

describe('withUploadRetry', () => {
  it('rides out any number of transient failures, saying why while it waits', async () => {
    let n = 0
    const waits: Array<string | null> = []
    const out = await withUploadRetry(async () => {
      if (++n < 12) throw new UploadAttemptError('The connection to Walnut dropped', true)
      return 'ok'
    }, { delay: () => 0, onWaiting: (r) => waits.push(r) })
    expect(out).toBe('ok')
    expect(n).toBe(12)
    expect(waits.filter((w) => w !== null)).toHaveLength(11)
    expect(waits[0]).toBe('The connection to Walnut dropped')
    expect(waits.at(-1)).toBeNull()
  })

  it('a real failure is thrown at once, untried again', async () => {
    let n = 0
    await expect(withUploadRetry(async () => { n++; throw new UploadAttemptError('too large', false) }, { delay: () => 0 }))
      .rejects.toThrow('too large')
    expect(n).toBe(1)
  })

  it('a failure that may clear is tried only its few times', async () => {
    let n = 0
    await expect(withUploadRetry(async () => { n++; throw new UploadAttemptError('host write error', true, 'upload_failed', 4) }, { delay: () => 0 }))
      .rejects.toThrow('host write error')
    expect(n).toBe(4)
  })

  it('a budget ends the waiting with the last failure', async () => {
    let n = 0
    await expect(withUploadRetry(async () => { n++; throw new ApiError(502, 'bad gateway') }, { delay: () => 30, budgetMs: 100 }))
      .rejects.toThrow('bad gateway')
    expect(n).toBeGreaterThan(1)
    expect(n).toBeLessThan(6)
  })

  it('an abort while waiting stops it', async () => {
    const ctrl = new AbortController()
    const p = withUploadRetry(async () => { throw new TypeError('Failed to fetch') }, { signal: ctrl.signal, delay: () => 60_000 })
    setTimeout(() => ctrl.abort(), 20)
    await expect(p).rejects.toMatchObject({ name: 'AbortError' })
  })

  it('the browser coming back online tries again at once', async () => {
    const win = new EventTarget()
    vi.stubGlobal('window', win)
    let n = 0
    const t0 = Date.now()
    const p = withUploadRetry(async () => {
      if (++n === 1) throw new TypeError('Failed to fetch')
      return 'back'
    }, { delay: () => 60_000 })
    setTimeout(() => win.dispatchEvent(new Event('online')), 20)
    expect(await p).toBe('back')
    expect(Date.now() - t0).toBeLessThan(5_000)
  })
})

// ── The upload paths through a fake XHR whose server goes down, then comes back ──

type Answer = { status: number; body?: unknown } | 'network-error'
let answers: Answer[] = []
let sent = 0
class FakeXhr {
  status = 0
  responseText = ''
  upload: { onprogress?: (e: { lengthComputable: boolean; loaded: number }) => void } = {}
  onload?: () => void
  onerror?: () => void
  onabort?: () => void
  ontimeout?: () => void
  private url = ''
  open(_m: string, url: string) { this.url = url }
  setRequestHeader() {}
  abort() { this.onabort?.() }
  send() {
    sent++
    const a = answers.shift() ?? { status: 200, body: this.url.includes('/uploads/') ? { received: 3, size: 3, done: true, path: '/h/up/a.txt' } : { filename: '1-abc.png' } }
    queueMicrotask(() => {
      if (a === 'network-error') { this.onerror?.(); return }
      this.status = a.status
      this.responseText = a.body === undefined ? '' : JSON.stringify(a.body)
      this.onload?.()
    })
  }
}

beforeEach(() => {
  answers = []
  sent = 0
  vi.stubGlobal('XMLHttpRequest', FakeXhr)
})
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals() })

/** Move a fake clock until `p` settles. */
async function settle<T>(p: Promise<T>): Promise<T> {
  let done = false
  p.then(() => { done = true }, () => { done = true })
  for (let i = 0; i < 400 && !done; i++) await vi.advanceTimersByTimeAsync(1_000)
  return p
}

const picture = { data: 'aGVsbG8=', mediaType: 'image/png', name: 'image.png' } as never

describe('a picture pasted while Walnut restarts', () => {
  it('waits through the restart (refused, then 502s) and uploads by itself', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    // Twenty tries down: well past the old three-and-fail.
    answers = [...Array(10).fill('network-error'), ...Array(10).fill({ status: 502 })]
    const waits: Array<string | null> = []
    const url = await settle(uploadImageWithProgress(picture, { signal: new AbortController().signal, onProgress: () => {}, onWaiting: (r) => waits.push(r) }))
    expect(url).toBe('/api/images/1-abc.png')
    expect(sent).toBe(21)
    expect(waits).toContain('The connection to Walnut dropped')
    expect(waits).toContain('Walnut is not reachable right now')
  })

  it('a picture the server refuses fails at once and says what to do', async () => {
    answers = [{ status: 413 }]
    await expect(uploadImageWithProgress(picture, { signal: new AbortController().signal, onProgress: () => {} }))
      .rejects.toThrow('This picture is too large to send: attach a smaller one')
    expect(sent).toBe(1)
  })
})

describe('a file attached while the session host is away', () => {
  it('waits for it (503s) and finishes by itself, resuming at the same offset', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    answers = [...Array(8).fill({ status: 503, body: { error: { code: 'bridge_offline', message: 'no link' } } }), 'network-error']
    const path = await settle(uploadFile(new Blob([new Uint8Array(3)]), { sessionId: 's' }, { uploadId: 'up-retry1', name: 'a.txt', signal: new AbortController().signal, onProgress: () => {} }))
    expect(path).toBe('/h/up/a.txt')
    expect(sent).toBe(10)
  })
})
