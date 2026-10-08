/**
 * GET /api/v1/search?tasks=1&semanticWaitMs= — the phone's extras
 * (src/core/search-hit-tasks.ts), and the `server.search` relay that answers the
 * same call for the cloud companion.
 *
 * The phone's task list holds open tasks plus 14 days of completed ones, so a hit
 * on an older completed task needs its row from the search response to be drawn
 * as a task and opened. search() is mocked: the rows are the input under test,
 * and the lexical test server has no session index.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'node:fs/promises'
import { createMockConstants } from '../../helpers/mock-constants.js'

const { searchMock } = vi.hoisted(() => ({ searchMock: vi.fn() }))

vi.mock('../../../src/constants.js', () => createMockConstants('walnut-apiv1-search-hit-tasks'))
vi.mock('../../../src/core/search.js', () => ({ search: searchMock }))

import express from 'express'
import request from 'supertest'
import { searchMemoryV1Router } from '../../../src/web/routes/search-memory-v1.js'
import { errorHandler } from '../../../src/web/middleware/error-handler.js'
import { handleSessionControlRelay } from '../../../src/core/sessions/session-controls.js'
import { clampSemanticWaitMs, wantsHitTasks } from '../../../src/core/search-hit-tasks.js'
import { addTask, completeTask, updateTaskRaw, _resetForTesting } from '../../../src/core/task-manager.js'
import { WALNUT_HOME } from '../../../src/constants.js'

function createApp() {
  const app = express()
  app.use(express.json())
  app.use('/api/v1', searchMemoryV1Router)
  app.use(errorHandler)
  return app
}

beforeEach(async () => {
  searchMock.mockReset()
  _resetForTesting()
  await fs.rm(WALNUT_HOME, { recursive: true, force: true })
})

afterEach(async () => {
  _resetForTesting()
  await fs.rm(WALNUT_HOME, { recursive: true, force: true })
})

async function seed() {
  const { task: open } = await addTask({ title: 'Plan the marina picnic', project: 'Life' })
  const { task: old } = await addTask({ title: 'Book the picnic tables', project: 'Life' })
  await completeTask(old.id)
  // Completed 60 days ago: outside the phone's 14-day window.
  const longAgo = new Date(Date.now() - 60 * 86_400_000).toISOString()
  await updateTaskRaw(old.id, { completed_at: longAgo, updated_at: longAgo })
  const rows = [
    { type: 'session', title: 'picnic transcript', snippet: 'the picnic', sessionId: 'sid-1', taskId: old.id, score: 0.9, matchField: 'description' },
    { type: 'task', title: old.title, snippet: old.title, taskId: old.id, score: 0.8, matchField: 'title' },
    { type: 'memory', title: 'a memory', snippet: 'picnic', path: '/x/memory.md', score: 0.7, matchField: 'memory' },
    { type: 'session', title: 'orphan', snippet: 'picnic', sessionId: 'sid-2', score: 0.6, matchField: 'description' },
    { type: 'task', title: 'deleted meanwhile', snippet: 'picnic', taskId: 'gone-0000', score: 0.5, matchField: 'title' },
    { type: 'task', title: open.title, snippet: open.title, taskId: open.id, score: 0.4, matchField: 'title' },
  ]
  searchMock.mockResolvedValue(rows)
  return { open, old, longAgo, rows }
}

describe('GET /api/v1/search?tasks=1', () => {
  it('carries each named task once, in row order, completed ones included', async () => {
    const { open, old, longAgo, rows } = await seed()
    const res = await request(createApp()).get('/api/v1/search?q=picnic&types=task,session&limit=80&tasks=1')

    expect(res.status).toBe(200)
    expect(res.body.results).toEqual(rows)
    // The session row's owner comes first (its row ranked first); memory rows,
    // owner-less sessions and deleted tasks name nothing.
    expect(res.body.tasks.map((t: { id: string }) => t.id)).toEqual([old.id, open.id])
    expect(res.body.tasks[0]).toMatchObject({
      id: old.id, title: 'Book the picnic tables', status: 'done', phase: 'COMPLETE', project: 'Life', completed_at: longAgo,
    })
    expect(res.body.tasks[1]).toMatchObject({ id: open.id, status: 'todo', phase: 'TODO', project: 'Life' })
  })

  it('leaves the response as it was without tasks=1 (agents and the CLI read it)', async () => {
    await seed()
    const res = await request(createApp()).get('/api/v1/search?q=picnic')
    expect(res.status).toBe(200)
    expect(res.body).not.toHaveProperty('tasks')
    expect(searchMock).toHaveBeenCalledWith('picnic', { types: undefined, limit: undefined, semanticDeadlineMs: undefined })
  })

  it('answers an empty tasks list when no row names a task', async () => {
    searchMock.mockResolvedValue([{ type: 'memory', title: 'm', snippet: 's', path: '/m.md', score: 1, matchField: 'memory' }])
    const res = await request(createApp()).get('/api/v1/search?q=m&tasks=1')
    expect(res.body.tasks).toEqual([])
  })

  it('passes the semantic wait through, clamped to 0..5000', async () => {
    searchMock.mockResolvedValue([])
    const app = createApp()
    await request(app).get('/api/v1/search?q=a&semanticWaitMs=1500')
    await request(app).get('/api/v1/search?q=a&semanticWaitMs=999999')
    await request(app).get('/api/v1/search?q=a&semanticWaitMs=-4')
    await request(app).get('/api/v1/search?q=a&semanticWaitMs=soon')
    expect(searchMock.mock.calls.map((c) => c[1].semanticDeadlineMs)).toEqual([1500, 5000, 0, undefined])
  })
})

describe('server.search relay (the companion asking the Mac)', () => {
  it('answers what the route answers for the same tasks=1 call', async () => {
    const { open, old } = await seed()
    const relayed = await handleSessionControlRelay('server.search', '__server__', {
      q: 'picnic', types: ['task', 'session'], limit: 80, tasks: true, semanticWaitMs: 1500,
    })
    expect(relayed.ok).toBe(true)
    if (!relayed.ok) return
    const direct = await request(createApp()).get('/api/v1/search?q=picnic&types=task,session&limit=80&tasks=1&semanticWaitMs=1500')
    expect(relayed.result).toEqual(direct.body)
    expect((relayed.result.tasks as Array<{ id: string }>).map((t) => t.id)).toEqual([old.id, open.id])
    expect(searchMock).toHaveBeenLastCalledWith('picnic', { types: ['task', 'session'], limit: 80, semanticDeadlineMs: 1500 })
  })

  it('leaves the relay answer as it was without tasks', async () => {
    await seed()
    const relayed = await handleSessionControlRelay('server.search', '__server__', { q: 'picnic' })
    expect(relayed.ok && relayed.result).not.toHaveProperty('tasks')
  })
})

describe('parameter parsing', () => {
  it('clampSemanticWaitMs takes numbers and numeric strings only', () => {
    expect(clampSemanticWaitMs(undefined)).toBeUndefined()
    expect(clampSemanticWaitMs('')).toBeUndefined()
    expect(clampSemanticWaitMs(['1500'])).toBeUndefined()
    expect(clampSemanticWaitMs(1499.6)).toBe(1500)
    expect(clampSemanticWaitMs(Infinity)).toBeUndefined()
  })

  it('wantsHitTasks takes 1, true and the JSON true only', () => {
    expect([true, '1', 'true'].every(wantsHitTasks)).toBe(true)
    expect([false, '0', 'yes', 1, undefined].some(wantsHitTasks)).toBe(false)
  })
})
