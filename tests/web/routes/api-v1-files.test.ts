/**
 * /api/v1 file browsing (Wave 2) — files-v1.ts. Local behavior plus the
 * SANDBOX GUARDS the endpoints inherit from the shared core (files.ts /
 * file-content.ts): directory-traversal rejection, absolute-path requirement,
 * shell-metacharacter rejection, and length caps. These guards are the whole
 * point of exposing file reads over the frozen contract — pin them.
 * Cloud behavior (relay + the file-content 501) lives in
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
  base = await fs.mkdtemp(path.join(os.tmpdir(), 'walnut-files-v1-'))
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
