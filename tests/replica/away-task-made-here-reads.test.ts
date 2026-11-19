/**
 * Every read the decision table (tests/replica/away-task-reads-table.ts) marks `leader`, called on
 * its REAL route for a task this host's journal made while the Mac is away: the route cannot find
 * it in the copy, and the reads (src/replica/away-reads.ts) answer 503 needs_leader
 * `task_made_here_needs_mac`, never the route's "not found". The same route for a task nobody made
 * here keeps its own answer, which proves the route is really mounted (not the app's catch-all).
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { createMockConstants } from '../helpers/mock-constants.js'

vi.mock('../../src/constants.js', () => createMockConstants('walnut-away-made-here-reads'))
// The change-status experiment on: with it off, /changes/stage answers 409 disabled for every
// task before it looks one up (its own answer, the same for a task made here).
vi.mock('../../src/core/changes/watch.js', async (orig) => ({ ...(await orig<Record<string, unknown>>()), changeStatusEnabled: async () => true }))

import express from 'express'
import request from 'supertest'
import { awayReads } from '../../src/replica/away-reads.js'
import type { Overlay } from '../../src/replica/overlay.js'
import { errorHandler, notFoundHandler } from '../../src/web/middleware/error-handler.js'
import { AWAY_TASK_READS, MADE_HERE } from './away-task-reads-table.js'

const MADE = 'mwo1jjmq-0011aa22bb33cc44'
const OTHER = 'mwo1zzzz-9999aa22bb33cc44'
const madeRow = { id: MADE, title: 'Import the venue rows', phase: 'TODO', project: 'Acme', replica_sync: 'pending' }

let app: express.Express

beforeAll(async () => {
  const overlay = {
    refresh: async () => {},
    task: (id: string, row: Record<string, unknown> | null) => (id === MADE ? madeRow : row),
    taskForReaders: (id: string, row: Record<string, unknown> | null) => (id === MADE ? madeRow : row),
    createdTaskIds: () => [MADE],
    entries: () => [],
    boardRecords: () => [],
    markOf: () => null,
  } as unknown as Overlay
  app = express()
  app.use(express.json())
  app.use('/api', awayReads({ overlay, answeredAway: () => true, refreshWaitMs: 200 }))
  // The routers that serve the table's rows, mounted where server.ts mounts them.
  app.use('/api/tasks', (await import('../../src/web/routes/tasks.js')).tasksRouter)
  app.use('/api/v1', (await import('../../src/web/routes/task-v1.js')).taskV1Router)
  app.use('/api/v1', (await import('../../src/web/routes/agent-memory-v1.js')).agentMemoryV1Router)
  app.use('/api/v1', (await import('../../src/web/routes/agent-skills-v1.js')).agentSkillsV1Router)
  app.use('/api/v1', (await import('../../src/web/routes/task-watch-v1.js')).taskWatchV1Router)
  app.use('/api/v1', (await import('../../src/web/routes/brief-v1.js')).briefV1Router)
  app.use('/api/v1', (await import('../../src/web/routes/org-threads-v1.js')).orgThreadsV1Router)
  app.use('/api/v1', (await import('../../src/web/routes/transfer-v1.js')).transferV1Router)
  app.use('/api', notFoundHandler)
  app.use(errorHandler)
}, 60_000)

afterAll(async () => {
  try { (await import('../../src/core/task-db.js')).closeDb() } catch { /* never opened */ }
})

const LEADER_ROWS = Object.entries(AWAY_TASK_READS).filter(([, d]) => d.answer === 'leader' && d.why === MADE_HERE).map(([k]) => k)

/** A walked route with its params filled in. */
function urlOf(key: string, taskId: string): string {
  const p = key.replace(/^GET /, '')
  return p.replace(':id', taskId).replace(':name', 'notes.md').replace(':thread', 'th-abc123')
    + (p.endsWith('/changes/stage') ? '?url=https%3A%2F%2Fexample.com%2Fpr%2F1&stage=build' : '')
}

describe('the reads of a task made here that only the Mac\'s store answers', () => {
  it('the table names some', () => {
    expect(LEADER_ROWS.length).toBeGreaterThan(5)
  })

  it.each(LEADER_ROWS)('%s answers 503 needs_leader task_made_here_needs_mac', async (key) => {
    const r = await request(app).get(urlOf(key, MADE))
    expect(r.status, JSON.stringify(r.body)).toBe(503)
    expect(r.body.error).toMatchObject({ code: 'needs_leader', why: 'task_made_here_needs_mac' })
    expect(r.headers['retry-after']).toBe('5')
    // The route is mounted: for a task nobody made here it answers itself, never the catch-all.
    const other = await request(app).get(urlOf(key, OTHER))
    expect(other.status, JSON.stringify(other.body)).not.toBe(503)
    expect(String(other.body?.error ?? ''), key).not.toMatch(/^Not found: GET/)
  })
})
