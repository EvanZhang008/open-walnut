/**
 * PUT /api/ordering/separators — the store behind the tier divider lines.
 *
 * Bare express + supertest against the real config-manager on an isolated temp
 * home. What matters here is that a malformed entry is REJECTED rather than
 * half-stored: the renderer places a line from these fields, and a row missing
 * its tier or mode would either vanish or land in the wrong list, which reads to
 * the user as "Walnut lost my separator".
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'node:fs/promises'
import { createMockConstants } from '../../helpers/mock-constants.js'

vi.mock('../../../src/constants.js', () => createMockConstants('walnut-ordering-separators'))

import express from 'express'
import request from 'supertest'
import { orderingRouter } from '../../../src/web/routes/ordering.js'
import { errorHandler } from '../../../src/web/middleware/error-handler.js'
import { WALNUT_HOME } from '../../../src/constants.js'

function createApp() {
  const app = express()
  app.use(express.json())
  app.use('/api/ordering', orderingRouter)
  app.use(errorHandler)
  return app
}

beforeEach(async () => {
  await fs.rm(WALNUT_HOME, { recursive: true, force: true })
  await fs.mkdir(WALNUT_HOME, { recursive: true })
})

afterEach(async () => {
  await fs.rm(WALNUT_HOME, { recursive: true, force: true }).catch(() => {})
})

const sep = (over: Record<string, unknown> = {}) => ({
  id: 'sep_a1',
  tier: 'focus',
  mode: 'project',
  project: 'marina',
  after: 't1',
  before: 't2',
  ...over,
})

describe('GET /api/ordering', () => {
  it('starts with no separators', async () => {
    const res = await request(createApp()).get('/api/ordering')
    expect(res.status).toBe(200)
    expect(res.body.separators).toEqual([])
  })
})

describe('PUT /api/ordering/separators', () => {
  it('round-trips a placed line', async () => {
    const app = createApp()
    const put = await request(app).put('/api/ordering/separators').send({ separators: [sep()] })
    expect(put.status).toBe(200)
    expect(put.body.separators).toHaveLength(1)

    const get = await request(app).get('/api/ordering')
    expect(get.body.separators[0]).toMatchObject({ id: 'sep_a1', tier: 'focus', mode: 'project', project: 'marina', after: 't1', before: 't2' })
  })

  it('normalizes missing anchors to "" and drops project in custom mode', async () => {
    const app = createApp()
    await request(app).put('/api/ordering/separators')
      .send({ separators: [{ id: 'sep_b', tier: 'wait', mode: 'custom', project: 'ignored' }] })
      .expect(200)
    const get = await request(app).get('/api/ordering')
    expect(get.body.separators[0]).toEqual({ id: 'sep_b', tier: 'wait', mode: 'custom', after: '', before: '' })
  })

  it('keeps the project order untouched', async () => {
    const app = createApp()
    await request(app).put('/api/ordering/projects').send({ order: ['marina', 'acme'] }).expect(200)
    await request(app).put('/api/ordering/separators').send({ separators: [sep()] }).expect(200)
    const get = await request(app).get('/api/ordering')
    expect(get.body.projects).toEqual(['marina', 'acme'])
    expect(get.body.separators).toHaveLength(1)
  })

  it('replaces the whole list (a drag is an update, not an append)', async () => {
    const app = createApp()
    await request(app).put('/api/ordering/separators').send({ separators: [sep()] }).expect(200)
    await request(app).put('/api/ordering/separators')
      .send({ separators: [sep({ after: 't5', before: 't6' })] })
      .expect(200)
    const get = await request(app).get('/api/ordering')
    expect(get.body.separators).toHaveLength(1)
    expect(get.body.separators[0]).toMatchObject({ after: 't5', before: 't6' })
  })

  it('collapses a duplicated id — last write wins', async () => {
    const app = createApp()
    const res = await request(app).put('/api/ordering/separators')
      .send({ separators: [sep({ before: 'old' }), sep({ before: 'new' })] })
    expect(res.status).toBe(200)
    expect(res.body.separators).toHaveLength(1)
    expect(res.body.separators[0].before).toBe('new')
  })

  it('rejects a malformed entry instead of storing part of it', async () => {
    const app = createApp()
    const bad: unknown[] = [
      { tier: 'focus', mode: 'project' },                 // no id
      { id: 'x', mode: 'project' },                       // no tier
      { id: 'x', tier: 'focus' },                         // no mode
      { id: 'x', tier: 'focus', mode: 'sideways' },       // unknown mode
      { id: 'x', tier: 'focus', mode: 'project', before: 7 }, // non-string anchor
      'not an object',
    ]
    for (const entry of bad) {
      const res = await request(app).put('/api/ordering/separators').send({ separators: [entry] })
      expect(res.status).toBe(400)
    }
    const get = await request(app).get('/api/ordering')
    expect(get.body.separators).toEqual([])
  })

  it('rejects a non-array body and an oversized list', async () => {
    const app = createApp()
    await request(app).put('/api/ordering/separators').send({ separators: 'nope' }).expect(400)
    const many = Array.from({ length: 501 }, (_, i) => sep({ id: `sep_${i}` }))
    await request(app).put('/api/ordering/separators').send({ separators: many }).expect(400)
  })
})
