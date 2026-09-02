/**
 * Conditional GET on GET /api/file-content for a REMOTE host — the case the
 * whole feature exists for: re-opening an unchanged file must not move a single
 * byte over the tunnel.
 *
 * The daemon reader is faked so the RPCs can be counted: a 304 is allowed to
 * cost ONE fs.stat and must cost ZERO fs.read. A daemon that can't stat degrades
 * to a normal full read instead of guessing.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest'
import express from 'express'
import request from 'supertest'

/** Fake remote filesystem — content plus the mtime the daemon would report. */
const remoteFiles = new Map<string, { content: string; mtimeMs: number }>()
const calls = { stat: 0, readFile: 0 }
let statThrows = false

vi.mock('../../../src/core/session-file-reader.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/core/session-file-reader.js')>()
  return {
    ...actual,
    createFileReader: vi.fn(async () => ({
      async stat(p: string) {
        calls.stat++
        if (statThrows) throw new Error('unknown command: fs.stat')
        const f = remoteFiles.get(p)
        return f ? { mtimeMs: f.mtimeMs, size: Buffer.byteLength(f.content, 'utf-8') } : null
      },
      async readFile(p: string) {
        calls.readFile++
        return remoteFiles.get(p)?.content ?? null
      },
    })),
  }
})

const { fileContentRouter } = await import('../../../src/web/routes/file-content.js')
const { clearFileValidatorCache } = await import('../../../src/web/routes/file-content-validator.js')
const { errorHandler } = await import('../../../src/web/middleware/error-handler.js')

const HOST = 'marina' // neutral fixture host
const FILE = '/home/dev/project/main.ts'

function createApp() {
  const app = express()
  app.set('etag', false) // mirror server.ts
  app.use(express.json())
  app.use('/api/file-content', fileContentRouter)
  app.use(errorHandler)
  return app
}

let app: express.Express

const read = (extra: Record<string, string> = {}) =>
  request(app).get('/api/file-content').query({ path: FILE, host: HOST, ...extra })

const revalidate = (inm: string) =>
  request(app).get('/api/file-content').query({ path: FILE, host: HOST }).set('If-None-Match', inm)

beforeEach(() => {
  remoteFiles.clear()
  remoteFiles.set(FILE, { content: 'export const remote = 1\n', mtimeMs: 1767225600000 })
  calls.stat = 0
  calls.readFile = 0
  statThrows = false
  clearFileValidatorCache()
  app = createApp()
})

describe('GET /api/file-content?host= — conditional GET over the tunnel', () => {
  it('a remote 200 stats once, reads once, and hands out an ETag', async () => {
    const res = await read()
    expect(res.status).toBe(200)
    expect(res.body.content).toBe('export const remote = 1\n')
    expect(res.headers.etag).toBe(`"${res.body.contentHash}"`)
    expect(res.headers['cache-control']).toBe('no-cache')
    expect(calls.stat).toBe(1) // the validator stat, taken BEFORE the read
    expect(calls.readFile).toBe(1)
  })

  it('re-opening an unchanged remote file ships ZERO bytes (one stat, no read)', async () => {
    const first = await read()
    const tag = first.headers.etag as string
    calls.stat = 0
    calls.readFile = 0

    const res = await revalidate(tag)
    expect(res.status).toBe(304)
    expect(res.headers.etag).toBe(tag)
    expect(res.headers['cache-control']).toBe('no-cache')
    expect(res.text ?? '').toBe('')
    expect(calls.stat).toBe(1)
    expect(calls.readFile).toBe(0) // the whole point: nothing crossed the tunnel
  })

  it('a changed remote file answers 200 with the new ETag', async () => {
    const first = await read()
    const oldTag = first.headers.etag as string
    remoteFiles.set(FILE, { content: 'export const remote = 2\n', mtimeMs: 1767225660000 })
    calls.readFile = 0

    const res = await revalidate(oldTag)
    expect(res.status).toBe(200)
    expect(res.body.content).toBe('export const remote = 2\n')
    expect(res.headers.etag).not.toBe(oldTag)
    expect(calls.readFile).toBe(1)
  })

  it('a vanished remote file answers the error payload, never a 304', async () => {
    const first = await read()
    const tag = first.headers.etag as string
    remoteFiles.delete(FILE)

    const res = await revalidate(tag)
    expect(res.status).toBe(200)
    expect(res.body.error).toBe('File not found')
    expect(res.headers.etag).toBeUndefined()
  })

  it('a daemon that cannot fs.stat degrades to a full read instead of guessing', async () => {
    statThrows = true
    const first = await read()
    expect(first.status).toBe(200)
    expect(first.headers.etag).toBe(`"${first.body.contentHash}"`) // ETag still offered
    const tag = first.headers.etag as string

    calls.readFile = 0
    const res = await revalidate(tag)
    expect(res.status).toBe(200) // no validator was remembered — read it properly
    expect(res.body.content).toBe('export const remote = 1\n')
    expect(calls.readFile).toBe(1)
  })

  it('an unreachable host on a conditional request still answers the read path', async () => {
    const first = await read()
    const tag = first.headers.etag as string
    statThrows = true // tunnel died between the two opens

    const res = await revalidate(tag)
    expect(res.status).toBe(200)
    expect(res.body.content).toBe('export const remote = 1\n')
  })
})
