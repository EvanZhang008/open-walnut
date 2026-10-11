/**
 * A save, and a create/rename/copy/delete, wait for their answer a bounded
 * time (gate review, 2026-10-03: Save on a link that stopped answering waited
 * 30 to 60s with no client deadline, then showed the daemon pool's error).
 *
 * The deadline must never cut a save the server is still allowed to finish:
 * its checks before the write are bounded like every read (the stream cap, then
 * at most one probe), and the write itself by the daemon's command timeout.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  FILE_OP_TIMEOUT_MS, FileOpPending, FileSaveHttpError, SAVE_TIMED_OUT_MESSAGE, SAVE_TIMEOUT_MS,
  createFolder, fetchFileContentConditional, saveFileContent,
} from '../../web/src/api/files'
import { classifyWriteFailure } from '../../web/src/hooks/useLiveEdit'
import { apiGet } from '../../web/src/api/client'
import { HOST_READ_STREAM_CAP_MS } from '../../src/core/hosts/remote-read-bound.js'

/** DaemonConnection's command timeout (a private static there), which bounds the write. */
const DAEMON_COMMAND_TIMEOUT_MS = 30_000
/** The longest liveness probe (DaemonConnection.probeDeadlineMs). */
const PROBE_CEILING_MS = 20_000
/** file-ops.ts DEFAULT_PENDING_AFTER_MS: the server answers "still working" by then. */
const SERVER_PENDING_AFTER_MS = 20_000

/**
 * WebKit's shape of a deadline (the Mac app): AbortSignal.timeout fires with a
 * TimeoutError reason, and fetch rejects with a bare AbortError, "Fetch is
 * aborted". A gate review saw exactly those words on a Save (at 120s) and a New
 * Folder (at 45s) in WebKit while Chromium showed the right sentences.
 */
function webkitDeadline(): void {
  vi.spyOn(AbortSignal, 'timeout').mockImplementation(() => {
    const deadline = new AbortController()
    deadline.abort(new DOMException('signal timed out', 'TimeoutError'))
    return deadline.signal
  })
  vi.stubGlobal('fetch', vi.fn(async (_url: string, init: RequestInit) => {
    if (!init.signal?.aborted) throw new Error('the request was given no deadline that fired')
    throw new DOMException('Fetch is aborted', 'AbortError')
  }))
}

describe('the save deadline', () => {
  afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks() })

  it('outlasts the longest answer the server may still give', () => {
    expect(SAVE_TIMEOUT_MS).toBeGreaterThan(HOST_READ_STREAM_CAP_MS + PROBE_CEILING_MS + DAEMON_COMMAND_TIMEOUT_MS)
    expect(FILE_OP_TIMEOUT_MS).toBeGreaterThan(SERVER_PENDING_AFTER_MS + 5_000)
  })

  it('a save carries a deadline, and one that runs out says so as a 504 (Live Edit retries it)', async () => {
    let signal: AbortSignal | undefined
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init: RequestInit) => {
      signal = init.signal ?? undefined
      throw new DOMException('The operation timed out.', 'TimeoutError')
    }))
    const err = await saveFileContent('/w/doc.md', 'text', { host: 'devbox' }).catch((e: unknown) => e)
    expect(signal).toBeInstanceOf(AbortSignal)
    expect(err).toBeInstanceOf(FileSaveHttpError)
    expect((err as FileSaveHttpError).status).toBe(504)
    expect((err as Error).message).toBe(SAVE_TIMED_OUT_MESSAGE)
    expect(classifyWriteFailure(err)).toBe('unreachable')
  })

  it('a file operation that runs out reads as still working, not as a failure', async () => {
    let signal: AbortSignal | undefined
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init: RequestInit) => {
      signal = init.signal ?? undefined
      throw new DOMException('The operation timed out.', 'TimeoutError')
    }))
    const err = await createFolder('/w/new-folder', 'devbox').catch((e: unknown) => e)
    expect(signal).toBeInstanceOf(AbortSignal)
    expect(err).toBeInstanceOf(FileOpPending)
  })

  it('in WebKit, a save that runs out says the same sentence, never "Fetch is aborted"', async () => {
    webkitDeadline()
    const err = await saveFileContent('/w/doc.md', 'text', { host: 'devbox' }).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(FileSaveHttpError)
    expect((err as FileSaveHttpError).status).toBe(504)
    expect((err as Error).message).toBe(SAVE_TIMED_OUT_MESSAGE)
    expect(classifyWriteFailure(err)).toBe('unreachable')
  })

  it('in WebKit, a file operation that runs out still reads as still working', async () => {
    webkitDeadline()
    const err = await createFolder('/w/new-folder', 'devbox').catch((e: unknown) => e)
    expect(err).toBeInstanceOf(FileOpPending)
  })

  it('in WebKit, an api request that runs out is a TimeoutError for every caller, and a cancel stays a cancel', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined)
    webkitDeadline()
    const timedOut = await apiGet('/api/tasks').catch((e: unknown) => e)
    expect((timedOut as Error).name).toBe('TimeoutError')
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
    // The caller's own cancel, with the deadline still far off: an AbortError, as before.
    vi.stubGlobal('fetch', vi.fn(async () => { throw new DOMException('Fetch is aborted', 'AbortError') }))
    const cancel = new AbortController()
    cancel.abort()
    const cancelled = await apiGet('/api/tasks', undefined, { signal: cancel.signal }).catch((e: unknown) => e)
    expect((cancelled as Error).name).toBe('AbortError')
  })

  it('in WebKit, opening a file whose deadline ran out is a TimeoutError (the viewer says the deadline), and a cancel stays a cancel', async () => {
    // The editor's read hands its own deadline in; WebKit rejects the fetch with
    // a bare AbortError either way, so only the signal tells the two apart.
    vi.stubGlobal('fetch', vi.fn(async () => { throw new DOMException('Fetch is aborted', 'AbortError') }))
    const deadline = new AbortController()
    deadline.abort(new DOMException('signal timed out', 'TimeoutError'))
    const timedOut = await fetchFileContentConditional('/w/a.ts', 'devbox', { signal: deadline.signal }).catch((e: unknown) => e)
    expect((timedOut as Error).name).toBe('TimeoutError')
    const cancel = new AbortController()
    cancel.abort()
    const cancelled = await fetchFileContentConditional('/w/a.ts', 'devbox', { signal: cancel.signal }).catch((e: unknown) => e)
    expect((cancelled as Error).name).toBe('AbortError')
  })
})
