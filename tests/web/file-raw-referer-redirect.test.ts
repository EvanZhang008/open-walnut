/**
 * Root-absolute references inside a previewed HTML file.
 *
 * The bug: a report previewed at `/api/file-raw/local/tmp/report/index.html`
 * linked to the video it produced as `href="/tmp/report/video.webm"`. That is a
 * filesystem path, but the browser resolved it against the site root, and the
 * click landed on Express's bare `Cannot GET /tmp/report/video.webm`. The
 * Referer names the previewed document, so a not-found request carrying a
 * file-raw referer is redirected onto that route under the same host segment.
 *
 * SAFETY: every served path here lives inside the mkdtemp dir.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import express from 'express'
import request from 'supertest'
import { fileRawRedirectTarget, fileRawRefererRedirect } from '../../src/web/file-raw-referer.js'
import { fileRawRouter } from '../../src/web/routes/file-raw.js'
import { errorHandler } from '../../src/web/middleware/error-handler.js'

const ORIGIN = 'http://localhost:3456'

function encodePath(absPath: string): string {
  return absPath.split('/').filter((s) => s.length > 0).map(encodeURIComponent).join('/')
}

describe('fileRawRedirectTarget', () => {
  const doc = `${ORIGIN}/api/file-raw/local/tmp/report/index.html?r=3`

  it('maps a root-absolute path onto the referring document’s file-raw host', () => {
    expect(fileRawRedirectTarget(doc, '/tmp/report/video.webm'))
      .toBe('/api/file-raw/local/tmp/report/video.webm')
  })

  it('keeps the request’s own encoding and query string verbatim', () => {
    expect(fileRawRedirectTarget(doc, '/tmp/odd%20name%20%231/clip.webm?t=5'))
      .toBe('/api/file-raw/local/tmp/odd%20name%20%231/clip.webm?t=5')
  })

  it('follows the referer’s host segment and route prefix (remote host, v1 twin)', () => {
    expect(fileRawRedirectTarget(`${ORIGIN}/api/file-raw/devbox/~/proj/index.html`, '/home/me/x.png'))
      .toBe('/api/file-raw/devbox/home/me/x.png')
    expect(fileRawRedirectTarget(`${ORIGIN}/api/v1/file-raw/local/tmp/a.html`, '/tmp/b.png'))
      .toBe('/api/v1/file-raw/local/tmp/b.png')
  })

  it('ignores a referer from another host, even when its path looks like a preview', () => {
    expect(fileRawRedirectTarget('https://evil.example/api/file-raw/local/x/y.html', '/Users/me/secret.txt', 'localhost:3456'))
      .toBeNull()
    expect(fileRawRedirectTarget(doc, '/tmp/report/video.webm', 'localhost:3456'))
      .toBe('/api/file-raw/local/tmp/report/video.webm')
    // Case of the host header does not matter; a proxy may normalise it.
    expect(fileRawRedirectTarget(doc, '/tmp/report/video.webm', 'LOCALHOST:3456')).not.toBeNull()
    expect(fileRawRedirectTarget(doc, '/tmp/report/video.webm', 'other.example')).toBeNull()
  })

  it('leaves requests alone when the referer is not a previewed document', () => {
    expect(fileRawRedirectTarget(undefined, '/tmp/report/video.webm')).toBeNull()
    expect(fileRawRedirectTarget(`${ORIGIN}/`, '/tmp/report/video.webm')).toBeNull()
    expect(fileRawRedirectTarget(`${ORIGIN}/sessions?id=x`, '/tmp/report/video.webm')).toBeNull()
    expect(fileRawRedirectTarget(`${ORIGIN}/api/file-raw/`, '/tmp/x')).toBeNull()
    expect(fileRawRedirectTarget('not a url', '/tmp/x')).toBeNull()
  })

  it('never touches API calls, the site root, or protocol-relative URLs', () => {
    // A relative <img src="img/a.png"> in the same document resolves to the
    // file-raw route itself and carries the same referer: it must pass through.
    expect(fileRawRedirectTarget(doc, '/api/file-raw/local/tmp/report/img/a.png')).toBeNull()
    expect(fileRawRedirectTarget(doc, '/api/config')).toBeNull()
    expect(fileRawRedirectTarget(doc, '/api')).toBeNull()
    expect(fileRawRedirectTarget(doc, '/')).toBeNull()
    expect(fileRawRedirectTarget(doc, '//evil.example/x')).toBeNull()
    expect(fileRawRedirectTarget(doc, 'tmp/x')).toBeNull()
  })

  it('on a cloud replica (query-shaped document URL) redirects onto the query-shaped route', () => {
    const cloudDoc = `${ORIGIN}/api/file-content?path=%2Ftmp%2Freport%2Findex.html&raw=1&host=devbox`
    const target = fileRawRedirectTarget(cloudDoc, '/tmp/report/clip%20one.webm')
    expect(target).not.toBeNull()
    const url = new URL(target!, ORIGIN)
    expect(url.pathname).toBe('/api/file-content')
    expect(url.searchParams.get('path')).toBe('/tmp/report/clip one.webm')
    expect(url.searchParams.get('raw')).toBe('1')
    expect(url.searchParams.get('host')).toBe('devbox')
    // A file-content referer that is NOT a raw document (a JSON read) does not count.
    expect(fileRawRedirectTarget(`${ORIGIN}/api/file-content?path=%2Ftmp%2Fa.md`, '/tmp/b.png')).toBeNull()
    // The v1 twin the mobile client uses redirects onto its own prefix.
    const v1 = fileRawRedirectTarget(`${ORIGIN}/api/v1/file-content?path=%2Ftmp%2Fa.html&raw=1`, '/tmp/b.png')
    expect(new URL(v1!, ORIGIN).pathname).toBe('/api/v1/file-content')
  })
})

describe('fileRawRefererRedirect middleware, wired with the real file-raw route', () => {
  let tmp: string
  let staticDir: string
  // supertest addresses an ephemeral 127.0.0.1 port; the browser would address
  // the same host the referer names, so say so explicitly.
  const HOST = 'localhost:3456'

  beforeEach(async () => {
    tmp = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'walnut-raw-referer-')))
    await fs.mkdir(path.join(tmp, 'report'), { recursive: true })
    await fs.writeFile(
      path.join(tmp, 'report', 'index.html'),
      `<h1>Report</h1><a href="${path.join(tmp, 'report', 'clip.webm')}">Recording</a>\n`,
    )
    await fs.writeFile(path.join(tmp, 'report', 'clip.webm'), Buffer.from([0x1a, 0x45, 0xdf, 0xa3, 1, 2, 3]))
    staticDir = path.join(tmp, 'static')
    await fs.mkdir(staticDir, { recursive: true })
    await fs.writeFile(path.join(staticDir, 'favicon.ico'), Buffer.from([0, 0, 1, 0]))
  })

  afterEach(async () => {
    await fs.rm(tmp, { recursive: true, force: true })
  })

  function createApp() {
    const app = express()
    app.use('/api/file-raw', fileRawRouter)
    // Same order as server.ts: static roots first, then the redirect, then the
    // SPA's index.html fallback.
    app.use(express.static(staticDir))
    app.use(fileRawRefererRedirect)
    app.use((req, res) => {
      if (req.method === 'GET' && !req.path.startsWith('/api/')) { res.type('html').send('<!doctype html>SPA SHELL'); return }
      res.status(404).type('text/plain').send(`Cannot GET ${req.path}`)
    })
    app.use(errorHandler)
    return app
  }

  it('a root-absolute link clicked inside the preview ends on the file, not on Cannot GET', async () => {
    const app = createApp()
    const docUrl = `/api/file-raw/local/${encodePath(path.join(tmp, 'report', 'index.html'))}`
    // The document itself serves as before.
    const doc = await request(app).get(docUrl)
    expect(doc.status).toBe(200)
    expect(doc.text).toContain('Recording')

    // What the browser requests after resolving href="/…/report/clip.webm"
    // against the site root, with the document as referer.
    const hop = await request(app)
      .get(`/${encodePath(path.join(tmp, 'report', 'clip.webm'))}`)
      .set('Host', HOST)
      .set('Referer', `${ORIGIN}${docUrl}?r=2`)
    expect(hop.status).toBe(302)
    expect(hop.headers.location).toBe(`/api/file-raw/local/${encodePath(path.join(tmp, 'report', 'clip.webm'))}`)

    const file = await request(app).get(hop.headers.location!)
    expect(file.status).toBe(200)
    expect(file.headers['content-type']).toMatch(/video\/webm/)
  })

  it('an .html target no longer loads the SPA shell inside the preview frame', async () => {
    const app = createApp()
    const docUrl = `/api/file-raw/local/${encodePath(path.join(tmp, 'report', 'index.html'))}`
    const hop = await request(app)
      .get(`/${encodePath(path.join(tmp, 'report', 'other.html'))}`)
      .set('Host', HOST)
      .set('Referer', `${ORIGIN}${docUrl}`)
    expect(hop.status).toBe(302)
    // The redirect target answers for the file (here: honestly missing), never with the shell.
    const file = await request(app).get(hop.headers.location!)
    expect(file.status).toBe(404)
    expect(file.text).not.toContain('SPA SHELL')
  })

  it('a real site asset still wins over the filesystem guess (preview opened in its own tab)', async () => {
    const app = createApp()
    const res = await request(app)
      .get('/favicon.ico')
      .set('Host', HOST)
      .set('Referer', `${ORIGIN}/api/file-raw/local/${encodePath(path.join(tmp, 'report', 'index.html'))}`)
    expect(res.status).toBe(200)
    expect(res.headers['content-type']).toMatch(/icon/)
  })

  it('a referer from another host gets no redirect', async () => {
    const app = createApp()
    const res = await request(app)
      .get(`/${encodePath(path.join(tmp, 'report', 'clip.webm'))}`)
      .set('Host', HOST)
      .set('Referer', 'https://evil.example/api/file-raw/local/tmp/x.html')
    expect(res.status).toBe(200)
    expect(res.text).toContain('SPA SHELL')
  })

  it('the same path without a preview referer behaves exactly as before', async () => {
    const app = createApp()
    const res = await request(app).get(`/${encodePath(path.join(tmp, 'report', 'clip.webm'))}`)
    expect(res.status).toBe(200)
    expect(res.text).toContain('SPA SHELL')
    const api = await request(app).post('/tmp/x').set('Referer', `${ORIGIN}/api/file-raw/local/tmp/a.html`)
    expect(api.status).toBe(404)
  })
})
