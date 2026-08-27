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

/** A project-mode line: anchored between two FOLDERS (a folder is one unit there). */
const sep = (over: Record<string, unknown> = {}) => ({
  id: 'sep_a1',
  tier: 'focus',
  mode: 'project',
  afterProject: 'marina',
  beforeProject: 'acme',
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
    expect(get.body.separators[0]).toEqual({ id: 'sep_a1', tier: 'focus', mode: 'project', afterProject: 'marina', beforeProject: 'acme' })
  })

  it('normalizes missing card anchors to "" and drops folder anchors in custom mode', async () => {
    const app = createApp()
    await request(app).put('/api/ordering/separators')
      .send({ separators: [{ id: 'sep_b', tier: 'wait', mode: 'custom', beforeProject: 'ignored' }] })
      .expect(200)
    const get = await request(app).get('/api/ordering')
    expect(get.body.separators[0]).toEqual({ id: 'sep_b', tier: 'wait', mode: 'custom', after: '', before: '' })
  })

  it('drops card anchors in project mode — a folder is the unit, so cards cannot position a line', async () => {
    const app = createApp()
    await request(app).put('/api/ordering/separators')
      .send({ separators: [sep({ after: 't1', before: 't2' })] })
      .expect(200)
    const get = await request(app).get('/api/ordering')
    expect(get.body.separators[0]).toEqual({ id: 'sep_a1', tier: 'focus', mode: 'project', afterProject: 'marina', beforeProject: 'acme' })
  })

  it('keeps a folder anchor that is "" — Inbox is a real folder, not "no folder"', async () => {
    const app = createApp()
    await request(app).put('/api/ordering/separators')
      .send({ separators: [{ id: 'sep_c', tier: 'focus', mode: 'project', afterProject: 'acme', beforeProject: '' }] })
      .expect(200)
    const get = await request(app).get('/api/ordering')
    expect(get.body.separators[0]).toEqual({ id: 'sep_c', tier: 'focus', mode: 'project', afterProject: 'acme', beforeProject: '' })
  })

  it('a top-of-tier line stores NO afterProject — absent is how "no folder above" is spelled', async () => {
    const app = createApp()
    await request(app).put('/api/ordering/separators')
      .send({ separators: [{ id: 'sep_d', tier: 'focus', mode: 'project', beforeProject: 'marina' }] })
      .expect(200)
    const get = await request(app).get('/api/ordering')
    expect(get.body.separators[0]).toEqual({ id: 'sep_d', tier: 'focus', mode: 'project', beforeProject: 'marina' })
    expect('afterProject' in get.body.separators[0]).toBe(false)
  })

  it('keeps a LEGACY row (line inside a run) so the renderer can still resolve it', async () => {
    const app = createApp()
    await request(app).put('/api/ordering/separators')
      .send({ separators: [{ id: 'sep_old', tier: 'focus', mode: 'project', project: 'marina', after: 't1', before: 't2' }] })
      .expect(200)
    const get = await request(app).get('/api/ordering')
    expect(get.body.separators[0]).toEqual({ id: 'sep_old', tier: 'focus', mode: 'project', project: 'marina' })
  })

  it('a folder anchor beats the legacy field once the line has been dragged', async () => {
    const app = createApp()
    await request(app).put('/api/ordering/separators')
      .send({ separators: [{ id: 'sep_old', tier: 'focus', mode: 'project', project: 'marina', beforeProject: 'acme' }] })
      .expect(200)
    const get = await request(app).get('/api/ordering')
    expect(get.body.separators[0]).toEqual({ id: 'sep_old', tier: 'focus', mode: 'project', beforeProject: 'acme' })
  })

  it('round-trips a heading label in both modes, trims an empty one, rejects a non-string', async () => {
    const app = createApp()
    await request(app).put('/api/ordering/separators')
      .send({ separators: [
        { id: 'sep_h1', tier: 'focus', mode: 'custom', after: 't1', before: 't2', label: 'Now' },
        { id: 'sep_h2', tier: 'focus', mode: 'project', beforeProject: 'marina', label: 'Next' },
        { id: 'sep_h3', tier: 'focus', mode: 'custom', after: 't2', before: '', label: '   ' },
      ] })
      .expect(200)
    const get = await request(app).get('/api/ordering')
    expect(get.body.separators[0].label).toBe('Now')
    expect(get.body.separators[1].label).toBe('Next')
    // Whitespace-only degrades to a plain line, not a heading that renders as nothing.
    expect('label' in get.body.separators[2]).toBe(false)
    await request(app).put('/api/ordering/separators')
      .send({ separators: [{ id: 'sep_h1', tier: 'focus', mode: 'custom', label: 7 }] })
      .expect(400)
  })

  it('stores the label TRIMMED — padding would render as an indented heading', async () => {
    const app = createApp()
    await request(app).put('/api/ordering/separators')
      .send({ separators: [{ id: 'sep_t', tier: 'focus', mode: 'custom', label: '  Now\n' }] })
      .expect(200)
    const get = await request(app).get('/api/ordering')
    expect(get.body.separators[0].label).toBe('Now')
  })

  it('rejects an id without the sep_ prefix — the client classifies ids by prefix', async () => {
    // A separator id colliding with a task id would duplicate that task in the
    // dnd items array and in the pin-order payload.
    await request(createApp()).put('/api/ordering/separators')
      .send({ separators: [{ id: 't123', tier: 'focus', mode: 'custom', after: 't1', before: 't2' }] })
      .expect(400)
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
      .send({ separators: [sep({ afterProject: 'acme', beforeProject: 'orbit' })] })
      .expect(200)
    const get = await request(app).get('/api/ordering')
    expect(get.body.separators).toHaveLength(1)
    expect(get.body.separators[0]).toMatchObject({ afterProject: 'acme', beforeProject: 'orbit' })
  })

  it('collapses a duplicated id — last write wins', async () => {
    const app = createApp()
    const res = await request(app).put('/api/ordering/separators')
      .send({ separators: [sep({ beforeProject: 'old' }), sep({ beforeProject: 'new' })] })
    expect(res.status).toBe(200)
    expect(res.body.separators).toHaveLength(1)
    expect(res.body.separators[0].beforeProject).toBe('new')
  })

  it('rejects a malformed entry instead of storing part of it', async () => {
    const app = createApp()
    const bad: unknown[] = [
      { tier: 'focus', mode: 'project' },                 // no id
      { id: 'x', mode: 'project' },                       // no tier
      { id: 'x', tier: 'focus' },                         // no mode
      { id: 'x', tier: 'focus', mode: 'sideways' },       // unknown mode
      { id: 'x', tier: 'focus', mode: 'custom', before: 7 },  // non-string card anchor
      { id: 'x', tier: 'focus', mode: 'project', beforeProject: 7 }, // non-string folder anchor
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
