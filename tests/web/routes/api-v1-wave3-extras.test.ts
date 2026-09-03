/**
 * /api/v1 Wave 3 additions folded into the existing domain routers:
 * - task-extras-v1: GET /tasks/enriched, GET /tasks/meta/sprints
 * - session-extras-v1: GET /sessions/recent, GET /sessions/summaries
 * - notes-extras-v1: GET /notes/list, POST /notes/tags/rename
 * - stt-v1: GET/POST /stt/vocab
 * - search-memory-v1: GET /memory/telemetry, POST /memory/daily-log/compact
 * - files-v1: POST /files/record-dir, GET /files/recent-dirs
 *
 * Also pins the route-shadowing fixes: the mount order here mirrors
 * server.ts (task-v1 / session-lifecycle BEFORE the extras routers), so
 * /tasks/enriched and /sessions/recent would 404 as bogus ids without the
 * RESERVED_*_SUBPATHS forwards.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'node:fs/promises'
import path from 'node:path'
import { createMockConstants } from '../../helpers/mock-constants.js'

vi.mock('../../../src/constants.js', () => createMockConstants('walnut-apiv1-wave3-extras'))

import express from 'express'
import request from 'supertest'
import { taskV1Router } from '../../../src/web/routes/task-v1.js'
import { taskExtrasV1Router } from '../../../src/web/routes/task-extras-v1.js'
import { sessionLifecycleV1Router } from '../../../src/web/routes/session-lifecycle-v1.js'
import { sessionExtrasV1Router } from '../../../src/web/routes/session-extras-v1.js'
import { notesExtrasV1Router } from '../../../src/web/routes/notes-extras-v1.js'
import { sttV1Router } from '../../../src/web/routes/stt-v1.js'
import { searchMemoryV1Router } from '../../../src/web/routes/search-memory-v1.js'
import { filesV1Router } from '../../../src/web/routes/files-v1.js'
import { errorHandler } from '../../../src/web/middleware/error-handler.js'
import { WALNUT_HOME, NOTES_DIR, DAILY_DIR, SESSIONS_DIR } from '../../../src/constants.js'

function createApp() {
  const app = express()
  app.use(express.json())
  // Same relative order as server.ts — pins the shadowing fixes.
  app.use('/api/v1', sessionLifecycleV1Router)
  app.use('/api/v1', taskV1Router)
  app.use('/api/v1', searchMemoryV1Router)
  app.use('/api/v1', sttV1Router)
  app.use('/api/v1', taskExtrasV1Router)
  app.use('/api/v1', sessionExtrasV1Router)
  app.use('/api/v1', filesV1Router)
  app.use('/api/v1', notesExtrasV1Router)
  app.use(errorHandler)
  return app
}

beforeEach(async () => {
  await fs.rm(WALNUT_HOME, { recursive: true, force: true })
  await fs.mkdir(WALNUT_HOME, { recursive: true })
  const { resetIndexBootstrap } = await import('../../../src/web/routes/notes-v2.js')
  resetIndexBootstrap()
})

afterEach(async () => {
  // Linux can still be flushing a file the last request wrote when this runs, and its
  // rmdir then fails with ENOTEMPTY where macOS just succeeds; retry a few times.
  await fs.rm(WALNUT_HOME, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }).catch(() => {})
})

// ── Tasks ────────────────────────────────────────────────────────────────────

describe('tasks enriched + sprints (through the REAL mount order)', () => {
  it('GET /tasks/enriched is not swallowed by /tasks/:id and computes overdue', async () => {
    const { addTask } = await import('../../../src/core/task-manager.js')
    await addTask({ title: 'overdue one', due_date: '2020-01-01' })
    await addTask({ title: 'future one', due_date: '2099-01-01' })

    const res = await request(createApp()).get('/api/v1/tasks/enriched')
    expect(res.status).toBe(200)
    const byTitle = Object.fromEntries(res.body.tasks.map((t: { title: string; overdue: boolean }) => [t.title, t.overdue]))
    expect(byTitle['overdue one']).toBe(true)
    expect(byTitle['future one']).toBe(false)
  })

  it('GET /tasks/groups is not swallowed either (Wave-2 shadowing regression)', async () => {
    const res = await request(createApp()).get('/api/v1/tasks/groups')
    expect(res.status).toBe(200)
    expect(res.body).toHaveProperty('groups')
  })

  it('GET /tasks/meta/sprints counts sprint members', async () => {
    const { addTask } = await import('../../../src/core/task-manager.js')
    await addTask({ title: 's1 task', sprint: 'sprint-a' })
    const res = await request(createApp()).get('/api/v1/tasks/meta/sprints')
    expect(res.status).toBe(200)
    expect(res.body.sprints).toEqual([{ name: 'sprint-a', count: 1 }])
  })
})

// ── Sessions ─────────────────────────────────────────────────────────────────

describe('sessions recent + summaries', () => {
  it('GET /sessions/recent serves the projection shape, newest first', async () => {
    // Real session records — the primary path re-exports the projection
    // inline, so seeding the file directly would just get overwritten.
    const { createSessionRecord, updateSessionRecord } = await import('../../../src/core/session-tracker.js')
    await createSessionRecord('11111111-1111-4111-8111-111111111111', '', '', '/tmp')
    await createSessionRecord('22222222-2222-4222-8222-222222222222', '', '', '/tmp')
    // Make the second one clearly the most recent.
    await updateSessionRecord('22222222-2222-4222-8222-222222222222', { lastActiveAt: new Date(Date.now() + 60_000).toISOString() })

    const res = await request(createApp()).get('/api/v1/sessions/recent?limit=1')
    expect(res.status).toBe(200)
    expect(res.body.sessions).toHaveLength(1)
    expect(res.body.sessions[0].id).toBe('22222222-2222-4222-8222-222222222222')
    // The projection shape (snake_case fields), not the raw record shape.
    expect(res.body.sessions[0]).toHaveProperty('process_status')
    expect(res.body.sessions[0]).toHaveProperty('last_active_at')
    expect(res.body.syncedAt).toBeTruthy()
  })

  it('GET /sessions/summaries parses summary markdown files', async () => {
    await fs.mkdir(SESSIONS_DIR, { recursive: true })
    await fs.writeFile(path.join(SESSIONS_DIR, '2026-08-08-demo.md'), [
      '# Session: Demo work',
      'Date: 2026-08-08',
      'Project: marina',
      'Status: completed',
      '',
      '## Summary',
      'Did the demo thing.',
    ].join('\n'))

    const res = await request(createApp()).get('/api/v1/sessions/summaries')
    expect(res.status).toBe(200)
    expect(res.body.summaries).toHaveLength(1)
    expect(res.body.summaries[0]).toMatchObject({ project: 'marina', summary: 'Did the demo thing.' })
  })
})

// ── Notes ────────────────────────────────────────────────────────────────────

describe('notes list + tag rename', () => {
  it('GET /notes/list returns the flat list; POST /notes/tags/rename rewrites carriers', async () => {
    await fs.mkdir(NOTES_DIR, { recursive: true })
    await fs.writeFile(path.join(NOTES_DIR, 'alpha.md'), 'Alpha body #work today\n')

    const app = createApp()
    const list = await request(app).get('/api/v1/notes/list')
    expect(list.status).toBe(200)
    expect(list.body.notes.map((n: { name: string }) => n.name)).toContain('alpha')

    const renamed = await request(app).post('/api/v1/notes/tags/rename').send({ from: 'work', to: 'job' })
    expect(renamed.status).toBe(200)
    expect(renamed.body.ok).toBe(true)

    const bad = await request(app).post('/api/v1/notes/tags/rename').send({ from: '', to: 'x' })
    expect(bad.status).toBe(400)
    expect(bad.body.error.code).toBe('bad_request')
  })
})

// ── STT vocab ────────────────────────────────────────────────────────────────

describe('stt vocab', () => {
  it('add → read round trip; dedup; no filesystem path in the v1 response', async () => {
    const app = createApp()
    const added = await request(app).post('/api/v1/stt/vocab').send({ word: 'Walnut' })
    expect(added.status).toBe(200)
    expect(added.body).toEqual({ added: true, word: 'Walnut' })

    const dup = await request(app).post('/api/v1/stt/vocab').send({ word: 'walnut' })
    expect(dup.body.added).toBe(false)

    const read = await request(app).get('/api/v1/stt/vocab')
    expect(read.status).toBe(200)
    expect(read.body.words).toContain('Walnut')
    // The internal route exposes the absolute path; v1 must not.
    expect(read.body.path).toBeUndefined()

    const bad = await request(app).post('/api/v1/stt/vocab').send({ word: '   ' })
    expect(bad.status).toBe(400)
  })
})

// ── Memory telemetry + daily-log compact ─────────────────────────────────────

describe('memory telemetry + daily-log compact', () => {
  it('GET /memory/telemetry answers both stores', async () => {
    const res = await request(createApp()).get('/api/v1/memory/telemetry')
    expect(res.status).toBe(200)
    expect(res.body.stores).toHaveProperty('memory')
    expect(res.body.stores).toHaveProperty('user')
  })

  it('POST /memory/daily-log/compact: 404 no log; below-threshold no-op; missing summarizer 400', async () => {
    const app = createApp()
    const missing = await request(app).post('/api/v1/memory/daily-log/compact').send({ date: '2026-01-01' })
    expect(missing.status).toBe(404)
    expect(missing.body.error.code).toBe('not_found')

    await fs.mkdir(DAILY_DIR, { recursive: true })
    await fs.writeFile(path.join(DAILY_DIR, '2026-08-08.md'), '# Day\nshort entry\n')
    const small = await request(app).post('/api/v1/memory/daily-log/compact').send({ date: '2026-08-08' })
    expect(small.status).toBe(200)
    expect(small.body.compacted).toBe(false)

    // Force over-threshold with a tiny threshold, but omit the summarizer.
    const noSummarizer = await request(app).post('/api/v1/memory/daily-log/compact')
      .send({ date: '2026-08-08', threshold: 1 })
    expect(noSummarizer.status).toBe(400)
  })
})

// ── Files record-dir / recent-dirs ───────────────────────────────────────────

describe('files record-dir + recent-dirs', () => {
  it('record → recents round trip; traversal rejected', async () => {
    const app = createApp()
    const rec = await request(app).post('/api/v1/files/record-dir').send({ path: '/tmp/wave3-demo' })
    expect(rec.status).toBe(200)

    const bad = await request(app).post('/api/v1/files/record-dir').send({ path: '/tmp/../etc' })
    expect(bad.status).toBe(400)
    const rel = await request(app).post('/api/v1/files/record-dir').send({ path: 'relative/dir' })
    expect(rel.status).toBe(400)

    const recents = await request(app).get('/api/v1/files/recent-dirs')
    expect(recents.status).toBe(200)
    // Union of mention-dirs + frequent-dirs (session cwds recorded by other
    // tests in this file may also appear) — assert containment, not equality.
    expect(recents.body.dirs).toContainEqual({ cwd: '/tmp/wave3-demo', host: null })
  })
})
