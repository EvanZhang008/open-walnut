/**
 * /api/v1 file browsing (Wave 2) — files-v1.ts. Local behavior plus the
 * SANDBOX GUARDS the endpoints inherit from the shared core (files.ts /
 * file-content.ts): directory-traversal rejection, absolute-path requirement,
 * shell-metacharacter rejection, and length caps. These guards are the whole
 * point of exposing file reads over the frozen contract — pin them.
 * Cloud behavior (relay + the file-content bounded bridge read) lives in
 * api-v1-files-cloud.test.ts.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { createMockConstants } from '../../helpers/mock-constants.js'

vi.mock('../../../src/constants.js', () => createMockConstants('walnut-apiv1-files'))

import express from 'express'
import request from 'supertest'
import { filesV1Router } from '../../../src/web/routes/files-v1.js'
import { errorHandler } from '../../../src/web/middleware/error-handler.js'
import { WALNUT_HOME } from '../../../src/constants.js'

function createApp() {
  const app = express()
  app.use(express.json())
  app.use('/api/v1', filesV1Router)
  app.use(errorHandler)
  return app
}

let base = ''

beforeEach(async () => {
  await fs.rm(WALNUT_HOME, { recursive: true, force: true })
  await fs.mkdir(WALNUT_HOME, { recursive: true })
  // realpath: on macOS os.tmpdir() is a symlink (/var → /private/var), and the
  // resolver deliberately returns REAL paths so one file can't end up with two
  // different "absolute" paths depending on how the session was started.
  base = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'walnut-files-v1-')))
  await fs.mkdir(path.join(base, 'sub'))
  await fs.writeFile(path.join(base, 'readme.md'), '# hello from wave 2\n')
  await fs.writeFile(path.join(base, 'sub', 'nested.txt'), 'nested content\n')
})

afterEach(async () => {
  await fs.rm(base, { recursive: true, force: true }).catch(() => {})
  await fs.rm(WALNUT_HOME, { recursive: true, force: true }).catch(() => {})
})

describe('GET /api/v1/files/list', () => {
  it('lists one directory level, dirs before files', async () => {
    const res = await request(createApp()).get(`/api/v1/files/list?path=${encodeURIComponent(base)}`)
    expect(res.status).toBe(200)
    const names = res.body.entries.map((e: { name: string }) => e.name)
    expect(names).toEqual(['sub', 'readme.md'])
    expect(res.body.entries[0].type).toBe('dir')
  })

  it('400 when path is missing or relative', async () => {
    const app = createApp()
    expect((await request(app).get('/api/v1/files/list')).status).toBe(400)
    const rel = await request(app).get('/api/v1/files/list?path=relative/dir')
    expect(rel.status).toBe(400)
    expect(rel.body.error.code).toBe('bad_request')
  })

  it('SANDBOX: rejects directory traversal', async () => {
    const res = await request(createApp())
      .get(`/api/v1/files/list?path=${encodeURIComponent(base + '/sub/../../..')}`)
    expect(res.status).toBe(400)
    expect(res.body.error.code).toBe('bad_request')
  })

  it('SANDBOX: rejects shell metacharacters in the path', async () => {
    const res = await request(createApp())
      .get(`/api/v1/files/list?path=${encodeURIComponent('/tmp/$(rm -rf x)')}`)
    expect(res.status).toBe(400)
  })

  it('SANDBOX: rejects an oversized path', async () => {
    const res = await request(createApp())
      .get(`/api/v1/files/list?path=${encodeURIComponent('/' + 'a'.repeat(5000))}`)
    expect(res.status).toBe(400)
  })
})

describe('GET /api/v1/files/resolve-path', () => {
  it('resolves a cwd-relative path that exists', async () => {
    const res = await request(createApp())
      .get(`/api/v1/files/resolve-path?rel=readme.md&cwd=${encodeURIComponent(base)}`)
    expect(res.status).toBe(200)
    expect(res.body.resolved).toBe(true)
    expect(res.body.path).toBe(path.join(base, 'readme.md'))
  })

  it('unresolvable → { resolved: false } with the cwd-joined fallback', async () => {
    const res = await request(createApp())
      .get(`/api/v1/files/resolve-path?rel=ghost.md&cwd=${encodeURIComponent(base)}`)
    expect(res.status).toBe(200)
    expect(res.body.resolved).toBe(false)
  })

  it('SANDBOX: rejects traversal in rel', async () => {
    const res = await request(createApp())
      .get(`/api/v1/files/resolve-path?rel=${encodeURIComponent('../../etc/passwd')}&cwd=${encodeURIComponent(base)}`)
    expect(res.status).toBe(400)
  })
})

describe('GET /api/v1/file-content', () => {
  it('returns the FileViewer payload for a text file', async () => {
    const res = await request(createApp())
      .get(`/api/v1/file-content?path=${encodeURIComponent(path.join(base, 'readme.md'))}`)
    expect(res.status).toBe(200)
    expect(res.body.content).toContain('hello from wave 2')
    expect(res.body.binary).toBe(false)
    expect(res.body.truncated).toBe(false)
    expect(res.body.extension).toBe('md')
  })

  it('missing file → 200 with error set (the viewer contract, not 404)', async () => {
    const res = await request(createApp())
      .get(`/api/v1/file-content?path=${encodeURIComponent(path.join(base, 'ghost.md'))}`)
    expect(res.status).toBe(200)
    expect(res.body.error).toBeDefined()
  })

  it('SANDBOX: rejects traversal and relative paths', async () => {
    const app = createApp()
    const traversal = await request(app)
      .get(`/api/v1/file-content?path=${encodeURIComponent(base + '/../../../etc/passwd')}`)
    expect(traversal.status).toBe(400)
    const rel = await request(app).get('/api/v1/file-content?path=relative.md')
    expect(rel.status).toBe(400)
  })
})

// raw=1 (additive 2026-08): byte serving with a real Content-Type — the iOS
// WKWebView HTML preview points here. Shares the internal route's raw
// implementation AND its sandbox, so pin both behaviors on this edge too.
describe('GET /api/v1/file-content?raw=1', () => {
  it('serves .html raw with text/html (WKWebView preview path)', async () => {
    const html = '<!doctype html><h1 id="t">HTML preview</h1><script>document.getElementById("t").textContent += " + JS"</script>'
    await fs.writeFile(path.join(base, 'page.html'), html)
    const res = await request(createApp())
      .get(`/api/v1/file-content?path=${encodeURIComponent(path.join(base, 'page.html'))}&raw=1`)
    expect(res.status).toBe(200)
    expect(res.headers['content-type']).toContain('text/html')
    expect(res.text).toBe(html)
  })

  it('serves non-HTML text as text/plain (no sniffing surprises)', async () => {
    const res = await request(createApp())
      .get(`/api/v1/file-content?path=${encodeURIComponent(path.join(base, 'readme.md'))}&raw=1`)
    expect(res.status).toBe(200)
    expect(res.headers['content-type']).toContain('text/plain')
    expect(res.text).toContain('hello from wave 2')
  })

  it('missing file → 404 plain text (raw mode has no JSON viewer contract)', async () => {
    const res = await request(createApp())
      .get(`/api/v1/file-content?path=${encodeURIComponent(path.join(base, 'ghost.html'))}&raw=1`)
    expect(res.status).toBe(404)
    expect(res.headers['content-type']).toContain('text/plain')
  })

  it('SANDBOX: raw mode rejects traversal and relative paths identically', async () => {
    const app = createApp()
    const traversal = await request(app)
      .get(`/api/v1/file-content?path=${encodeURIComponent(base + '/../../../etc/passwd')}&raw=1`)
    expect(traversal.status).toBe(400)
    const rel = await request(app).get('/api/v1/file-content?path=relative.html&raw=1')
    expect(rel.status).toBe(400)
  })

  it('download=1 forces Content-Disposition attachment', async () => {
    await fs.writeFile(path.join(base, 'notes.txt'), 'plain text\n')
    const res = await request(createApp())
      .get(`/api/v1/file-content?path=${encodeURIComponent(path.join(base, 'notes.txt'))}&raw=1&download=1`)
    expect(res.status).toBe(200)
    expect(res.headers['content-disposition']).toContain('attachment')
  })

  it('an EMPTY file on the raw path answers 200/0 bytes instead of erroring', async () => {
    // Routing office types onto the byte lane made a latent hole reachable:
    // for size 0 the range math yields end = -1, and createReadStream({end:-1})
    // throws ERR_OUT_OF_RANGE *after* the 200 headers are staged, so the client
    // got the generic error handler instead of an empty document.
    await fs.writeFile(path.join(base, 'blank.docx'), '')
    const res = await request(createApp())
      .get(`/api/v1/file-content?path=${encodeURIComponent(path.join(base, 'blank.docx'))}&raw=1`)
    expect(res.status).toBe(200)
    expect(res.headers['content-length']).toBe('0')
  })

  it('serves office documents as raw BYTES with their real OOXML type (docx/xlsx/pptx)', async () => {
    // The web console's OfficePreview fetches these bytes and renders them
    // client-side (docx-preview / SheetJS / pptx-preview). A text-decoded read
    // would corrupt the zip container — the old "Binary file, cannot display".
    // Deliberately NOT valid UTF-8 (0xff 0xfe 0x80): the earlier fixture was
    // pure ASCII, which survives a `readFile(…,'utf-8') → send(string)` path
    // byte for byte, so the byte assertion below passed even when the file was
    // being text-decoded. These bytes fail that path loudly.
    const zipMagic = Buffer.from([0x50, 0x4b, 0x03, 0x04, 0xff, 0xfe, 0x80, 0x00])
    const cases: Array<[string, string]> = [
      ['letter.docx', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'],
      ['budget.xlsx', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'],
      ['deck.pptx', 'application/vnd.openxmlformats-officedocument.presentationml.presentation'],
    ]
    const app = createApp()
    for (const [name, mime] of cases) {
      await fs.writeFile(path.join(base, name), zipMagic)
      const res = await request(app)
        .get(`/api/v1/file-content?path=${encodeURIComponent(path.join(base, name))}&raw=1`)
        // superagent has no parser for OOXML types — buffer the bytes ourselves,
        // else res.body is {} and the byte assertion below is meaningless.
        .buffer(true)
        .parse((r, cb) => {
          const chunks: Buffer[] = []
          r.on('data', (c: Buffer) => chunks.push(c))
          r.on('end', () => cb(null, Buffer.concat(chunks)))
        })
      expect(res.status).toBe(200)
      expect(res.headers['content-type']).toBe(mime)
      // Byte-exact, whole file — a text-decode path mangles the 0xff/0x80.
      expect(res.body as Buffer).toEqual(zipMagic)
    }
  })
})
