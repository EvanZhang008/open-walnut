/**
 * GET /api/file-raw/<host>/<path...> — the PATH-shaped raw-bytes route.
 *
 * The bug it exists for: an HTML preview loaded from the query-shaped URL
 * (`/api/file-content?path=…&raw=1`) resolves `<img src="diagram.png">` to
 * `/api/diagram.png`, because relative URLs resolve against the document URL's
 * PATH and the query is discarded. These tests pin the two halves of the fix:
 * the document is served at a path-shaped URL, and the sibling that URL implies
 * is served by the same route with the right Content-Type.
 *
 * SAFETY: every path here lives inside the mkdtemp dir; the denied cases name
 * paths that do not exist.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import express from 'express'
import request from 'supertest'
import { fileRawRouter, hostFromSegment, pathFromRemainder } from '../../../src/web/routes/file-raw.js'
import { errorHandler } from '../../../src/web/middleware/error-handler.js'

function createApp() {
  const app = express()
  app.use('/api/file-raw', fileRawRouter)
  app.use(errorHandler)
  return app
}

/** The URL the web client builds: one encoded segment per path component. */
function rawUrl(absPath: string, host = 'local'): string {
  const encoded = absPath.split('/').filter((s) => s.length > 0).map(encodeURIComponent).join('/')
  return `/api/file-raw/${host}/${encoded}`
}

let tmp: string

beforeEach(async () => {
  tmp = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'walnut-file-raw-')))
  await fs.mkdir(path.join(tmp, 'proj', 'img'), { recursive: true })
  await fs.writeFile(
    path.join(tmp, 'proj', 'index.html'),
    '<h1>Design</h1><img src="img/diagram.png"><img src="../shared.png">\n',
  )
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3])
  await fs.writeFile(path.join(tmp, 'proj', 'img', 'diagram.png'), png)
  await fs.writeFile(path.join(tmp, 'shared.png'), png)
  await fs.writeFile(path.join(tmp, 'proj', 'odd name #1.txt'), 'odd\n')
})

afterEach(async () => {
  await fs.rm(tmp, { recursive: true, force: true })
})

describe('path helpers', () => {
  it('maps the host segment: local → none, anything else → alias', () => {
    expect(hostFromSegment('local')).toBeUndefined()
    expect(hostFromSegment('')).toBeUndefined()
    expect(hostFromSegment('devbox')).toBe('devbox')
  })
  it('rebuilds an absolute path and keeps a ~-relative one', () => {
    expect(pathFromRemainder('Users/me/a.txt')).toBe('/Users/me/a.txt')
    expect(pathFromRemainder('/Users/me/a.txt')).toBe('/Users/me/a.txt')
    expect(pathFromRemainder('~/proj/a.txt')).toBe('~/proj/a.txt')
  })
})

describe('GET /api/file-raw', () => {
  it('serves the HTML document at a path-shaped URL with text/html', async () => {
    const res = await request(createApp()).get(rawUrl(path.join(tmp, 'proj', 'index.html')))
    expect(res.status).toBe(200)
    expect(res.headers['content-type']).toMatch(/text\/html/)
    expect(res.text).toContain('<h1>Design</h1>')
  })

  it('serves the sibling a relative <img src> resolves to, as an image', async () => {
    // This is what the browser requests after resolving "img/diagram.png"
    // against the document URL above.
    const res = await request(createApp())
      .get(rawUrl(path.join(tmp, 'proj', 'img', 'diagram.png')))
      .buffer(true)
      .parse((r, cb) => { const chunks: Buffer[] = []; r.on('data', (c) => chunks.push(c)); r.on('end', () => cb(null, Buffer.concat(chunks))) })
    expect(res.status).toBe(200)
    expect(res.headers['content-type']).toMatch(/image\/png/)
    expect((res.body as Buffer).subarray(0, 4)).toEqual(Buffer.from([0x89, 0x50, 0x4e, 0x47]))
  })

  it('serves a parent-relative reference too (the browser normalises ../ first)', async () => {
    const res = await request(createApp()).get(rawUrl(path.join(tmp, 'shared.png')))
    expect(res.status).toBe(200)
    expect(res.headers['content-type']).toMatch(/image\/png/)
  })

  it('survives a filename with # and spaces when segments are encoded', async () => {
    const res = await request(createApp()).get(rawUrl(path.join(tmp, 'proj', 'odd name #1.txt')))
    expect(res.status).toBe(200)
    expect(res.text).toBe('odd\n')
  })

  it('answers 404 as plain text for a missing sibling (a broken <img>, not a crash)', async () => {
    const res = await request(createApp()).get(rawUrl(path.join(tmp, 'proj', 'img', 'nope.png')))
    expect(res.status).toBe(404)
  })

  it('keeps the shared sandbox: a ".." rebuilt into the path is refused before any read', async () => {
    // Over HTTP a dotted segment never reaches the handler — the URL layer
    // collapses `%2E%2E` before routing, which is exactly the browser behaviour
    // relative `../x.png` relies on. So the sandbox has to be pinned at the
    // helper: whatever the remainder says, `assertPathAllowed` sees it as a path
    // and its `..` rule refuses it. (Reaching for a real host alias here would
    // spawn a connection attempt and hang the next test's socket.)
    const { assertPathAllowed } = await import('../../../src/web/routes/file-content.js')
    expect(() => assertPathAllowed(pathFromRemainder('../etc/passwd'), undefined, 'read')).toThrow()
    expect(() => assertPathAllowed(pathFromRemainder('Users/../etc/passwd'), undefined, 'read')).toThrow()
  })

  it('download=1 forces an attachment', async () => {
    const res = await request(createApp()).get(rawUrl(path.join(tmp, 'proj', 'index.html')) + '?download=1')
    expect(res.status).toBe(200)
    expect(res.headers['content-disposition']).toMatch(/attachment/)
  })
})
