/**
 * A remote file still arriving at the request's stream cap (a slow link that
 * answers): the viewer's payload says so with `loading`, in the host's name,
 * and the next request joins the read that is still running instead of starting
 * over. FileContentView asks again at once on `loading` (a gate review found it
 * showed "Still loading" with nothing to retry it).
 *
 * The host's daemon is faked at the pool's readers (connected, bytes arriving,
 * answering a probe) and at the file reader (a read that takes 250ms); the
 * bounds are shortened through the module's test seam.
 */
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'
import express from 'express'
import request from 'supertest'
import { createMockConstants } from '../../helpers/mock-constants.js'

vi.mock('../../../src/constants.js', () => createMockConstants('walnut-file-content-still-loading'))

const calls = { readFile: 0 }
const CONTENT = 'export const slow = 1\n'
vi.mock('../../../src/core/session-file-reader.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/core/session-file-reader.js')>()
  return {
    ...actual,
    createFileReader: vi.fn(async () => ({
      async stat() { return { mtimeMs: 1767225600000, size: CONTENT.length } },
      async readFile() {
        calls.readFile++
        // Longer than one request's stream cap (150ms), shorter than two: the
        // retry joins with the read part-way and is answered when it is in (or,
        // on a slow runner that asks after it ended, gets the result it left).
        await new Promise((r) => setTimeout(r, 250))
        return CONTENT
      },
    })),
  }
})

/** What the pool says it heard from the host: bytes arriving, unless a test freezes it. */
const link = vi.hoisted(() => {
  let n = 0
  return { heard: (): number => (n += 10_000) }
})
vi.mock('../../../src/providers/daemon-connection.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../src/providers/daemon-connection.js')>()),
  daemonConnectWouldWait: () => 'connected',
  daemonHeardBytes: () => link.heard(),
  probeDaemonLiveness: async () => true,
  daemonLinkSilent: () => false,
}))

const { fileContentRouter } = await import('../../../src/web/routes/file-content.js')
const { clearFileValidatorCache } = await import('../../../src/web/routes/file-content-validator.js')
const { errorHandler } = await import('../../../src/web/middleware/error-handler.js')
const { resetSharedHostReadsForTest, setHostReadBoundsForTest } = await import('../../../src/core/hosts/remote-read-bound.js')

const HOST = 'marina' // neutral fixture host
const FILE = '/home/dev/project/slow.ts'

function createApp() {
  const app = express()
  app.set('etag', false)
  app.use(express.json())
  app.use('/api/file-content', fileContentRouter)
  app.use(errorHandler)
  return app
}

beforeEach(() => {
  calls.readFile = 0
  clearFileValidatorCache()
  resetSharedHostReadsForTest()
  setHostReadBoundsForTest({ quietMs: 30, streamCapMs: 150, idleMs: 5_000 })
})

afterAll(() => {
  setHostReadBoundsForTest(null)
  resetSharedHostReadsForTest()
})

describe('GET /api/file-content?host= on a slow link that answers', () => {
  it('says it is still loading, in the host\'s name; the next request joins the read and gets the file', async () => {
    const app = createApp()
    const first = await request(app).get('/api/file-content').query({ path: FILE, host: HOST })
    expect(first.status).toBe(200)
    expect(first.body.content).toBeNull()
    expect(first.body.loading).toEqual({ from: HOST })
    expect(first.body.error).toBe(`Still loading from ${HOST}. Try again in a moment.`)

    const second = await request(app).get('/api/file-content').query({ path: FILE, host: HOST })
    expect(second.status).toBe(200)
    expect(second.body.content).toBe(CONTENT)
    expect(second.body.loading).toBeUndefined()
    // One transfer: the retry joined the read the first request started.
    expect(calls.readFile).toBe(1)
  })

  it('a host that answers but sends the read nothing is not "loading": no join is offered', async () => {
    // The pool hears nothing more from now on: the read is idle, not arriving.
    const arriving = link.heard
    const frozen = arriving()
    link.heard = () => frozen
    setHostReadBoundsForTest({ quietMs: 30, streamCapMs: 5_000, idleMs: 150 })
    try {
      const res = await request(createApp()).get('/api/file-content').query({ path: `${FILE}.idle`, host: HOST })
      expect(res.status).toBe(200)
      expect(res.body.content).toBeNull()
      expect(res.body.error).toBe(`${HOST} did not answer in time`)
      expect(res.body.loading).toBeUndefined()
    } finally {
      link.heard = arriving
    }
  })
})
