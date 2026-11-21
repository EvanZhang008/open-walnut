/**
 * /api/v1/focus-spaces: saved spaces, entering and leaving a focus, the quiet hold it sets,
 * the experiment switch, and a test run kept in its own copy (an automated browser must never
 * hold the user's notifications for real).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'node:fs/promises'
import path from 'node:path'
import { createMockConstants } from '../../helpers/mock-constants.js'

vi.mock('../../../src/constants.js', () => createMockConstants('focus-spaces-route-test'))

const flags = { focus_workspace: true }
vi.mock('../../../src/core/config-manager.js', () => ({ getConfig: async () => ({ experimental: { ...flags } }) }))

import express from 'express'
import request from 'supertest'
import { WALNUT_HOME } from '../../../src/constants.js'
import { focusSpacesV1Router } from '../../../src/web/routes/focus-spaces-v1.js'
import { getQuiet, stopQuiet } from '../../../src/core/quiet/quiet-state.js'
import { resetActiveFocus } from '../../../src/core/focus-spaces/active.js'
import { withTestRun } from '../../../src/core/test-run.js'
import { _resetTestRunPrefsForTest } from '../../../src/core/test-run-prefs.js'
import { errorHandler } from '../../../src/web/middleware/error-handler.js'

function createApp(run?: string) {
  const app = express()
  app.use(express.json())
  if (run) app.use((_req, _res, next) => withTestRun(run, () => next()))
  app.use('/api/v1', focusSpacesV1Router)
  app.use(errorHandler)
  return app
}

beforeEach(async () => {
  flags.focus_workspace = true
  stopQuiet()
  resetActiveFocus()
  _resetTestRunPrefsForTest()
  await fs.rm(WALNUT_HOME, { recursive: true, force: true })
  await fs.mkdir(WALNUT_HOME, { recursive: true })
})

afterEach(async () => {
  stopQuiet()
  await fs.rm(WALNUT_HOME, { recursive: true, force: true })
})

describe('/api/v1/focus-spaces', () => {
  it('creates, renames and deletes a space; the file keeps it', async () => {
    const app = createApp()
    expect((await request(app).get('/api/v1/focus-spaces')).body).toEqual({ spaces: [], active: null, apps: [] })
    const made = await request(app).post('/api/v1/focus-spaces').send({ name: '  Interview  prep ', projects: ['Walnut', 'Walnut'], tasks: ['t1'] })
    expect(made.status).toBe(201)
    expect(made.body.space).toMatchObject({ name: 'Interview prep', projects: ['Walnut'], tasks: ['t1'], apps: {} })
    expect(made.body.space.id).toMatch(/^fs-[0-9a-f]{8}$/)
    const id = made.body.space.id
    const renamed = await request(app).patch(`/api/v1/focus-spaces/${id}`).send({ name: 'Prep', apps: { 'walnut-mail': 'inherit', bad: 'nope' } })
    expect(renamed.body.space).toMatchObject({ name: 'Prep', projects: ['Walnut'], apps: { 'walnut-mail': 'inherit' } })
    const file = JSON.parse(await fs.readFile(path.join(WALNUT_HOME, 'focus-spaces.json'), 'utf8'))
    expect(file.spaces[0].name).toBe('Prep')
    expect((await request(app).delete(`/api/v1/focus-spaces/${id}`)).body).toEqual({ removed: true })
    expect((await request(app).get('/api/v1/focus-spaces')).body.spaces).toEqual([])
  })

  it('refuses an empty space and an unknown one', async () => {
    const app = createApp()
    const empty = await request(app).post('/api/v1/focus-spaces').send({ name: 'Nothing' })
    expect(empty.status).toBe(400)
    expect(empty.body.error.code).toBe('bad_request')
    expect((await request(app).patch('/api/v1/focus-spaces/fs-00000000').send({ name: 'x' })).status).toBe(404)
    expect((await request(app).put('/api/v1/focus-spaces/active').send({ spaceId: 'fs-00000000' })).status).toBe(404)
  })

  it('entering holds quiet with the scope; leaving lets it go', async () => {
    const app = createApp()
    const { body: { space } } = await request(app).post('/api/v1/focus-spaces').send({ name: 'Walnut work', projects: ['Walnut'] })
    const until = Date.now() + 30 * 60_000
    const on = await request(app).put('/api/v1/focus-spaces/active').send({ spaceId: space.id, until })
    expect(on.body.active).toMatchObject({ spaceId: space.id, name: 'Walnut work', scope: { projects: ['Walnut'] }, until, by: 'person' })
    const quiet = await getQuiet()
    expect(quiet.holds).toEqual([expect.objectContaining({ source: 'focus-space', reason: 'Focus: Walnut work', scope: { projects: ['Walnut'] }, until })])

    // Editing the space the person is in moves the focus with it.
    await request(app).patch(`/api/v1/focus-spaces/${space.id}`).send({ projects: ['Walnut', 'Inbox'] })
    expect((await getQuiet()).holds[0].scope).toEqual({ projects: ['Walnut', 'Inbox'] })
    expect((await request(app).get('/api/v1/focus-spaces')).body.active.since).toBe(on.body.active.since)

    const off = await request(app).delete('/api/v1/focus-spaces/active')
    expect(off.body.ended).toMatchObject({ spaceId: space.id })
    expect((await getQuiet()).holds).toEqual([])
  })

  it('a focus block leaves only the focus it entered', async () => {
    const app = createApp()
    await request(app).put('/api/v1/focus-spaces/active').send({ scope: { tasks: ['task-a'] }, name: 'Task A', by: 'block' })
    // The person chose a space since: the block's end must not take it away.
    await request(app).put('/api/v1/focus-spaces/active').send({ scope: { projects: ['Walnut'] }, name: 'Walnut' })
    expect((await request(app).delete('/api/v1/focus-spaces/active?only_by=block')).body.ended).toBeNull()
    expect((await request(app).get('/api/v1/focus-spaces')).body.active).toMatchObject({ name: 'Walnut', by: 'person' })
  })

  it('refuses an `until` past 24 hours or in the past', async () => {
    const app = createApp()
    for (const until of [Date.now() - 1000, Date.now() + 25 * 3600_000, 'soon']) {
      const res = await request(app).put('/api/v1/focus-spaces/active').send({ scope: { tasks: ['t'] }, until })
      expect(res.status).toBe(400)
    }
  })

  it('deleting the space the person is in ends the focus', async () => {
    const app = createApp()
    const { body: { space } } = await request(app).post('/api/v1/focus-spaces').send({ name: 'A', tasks: ['t1'] })
    await request(app).put('/api/v1/focus-spaces/active').send({ spaceId: space.id })
    await request(app).delete(`/api/v1/focus-spaces/${space.id}`)
    expect((await request(app).get('/api/v1/focus-spaces')).body.active).toBeNull()
    expect((await getQuiet()).holds).toEqual([])
  })

  it('answers 404 while the experiment is off, and a focus left on ends', async () => {
    const app = createApp()
    await request(app).put('/api/v1/focus-spaces/active').send({ scope: { tasks: ['t1'] } })
    expect((await getQuiet()).holds).toHaveLength(1)
    flags.focus_workspace = false
    const res = await request(app).get('/api/v1/focus-spaces')
    expect(res.status).toBe(404)
    expect(res.body.error.code).toBe('experiment_off')
    expect((await getQuiet()).holds).toEqual([])
  })

  it('a test run keeps its spaces and focus in its own copy', async () => {
    const run = createApp('webdriver-spec')
    const user = createApp()
    const { body: { space } } = await request(run).post('/api/v1/focus-spaces').send({ name: 'Spec', tasks: ['t1'] })
    const on = await request(run).put('/api/v1/focus-spaces/active').send({ spaceId: space.id })
    expect(on.body.active).toMatchObject({ spaceId: space.id })
    expect((await request(run).get('/api/v1/focus-spaces')).body).toMatchObject({ spaces: [{ id: space.id }], active: { spaceId: space.id } })
    // Nothing reached the user: no file, no space, no hold.
    expect((await request(user).get('/api/v1/focus-spaces')).body).toEqual({ spaces: [], active: null, apps: [] })
    expect((await getQuiet()).holds).toEqual([])
    await expect(fs.stat(path.join(WALNUT_HOME, 'focus-spaces.json'))).rejects.toThrow()
    expect((await request(run).delete('/api/v1/focus-spaces/active')).body.ended).toMatchObject({ spaceId: space.id })
  })
})
