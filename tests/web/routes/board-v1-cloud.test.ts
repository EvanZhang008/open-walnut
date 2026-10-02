/**
 * Task Board routes on a REPLICA (CLOUD_MODE): reads serve the board that came
 * with the data sync; every write answers 501 not_supported_cloud before it
 * touches the store or the send path (the primary is the single writer).
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import fs from 'node:fs/promises'
import { createMockConstants } from '../../helpers/mock-constants.js'

vi.mock('../../../src/constants.js', () => createMockConstants('walnut-board-v1-cloud', { CLOUD_MODE: true }))

const performSessionSendMock = vi.fn()
vi.mock('../../../src/core/sessions/session-send-core.js', async (importOriginal) => {
  const orig = await importOriginal<typeof import('../../../src/core/sessions/session-send-core.js')>()
  return { ...orig, performSessionSend: (...args: unknown[]) => performSessionSendMock(...args) }
})

import express from 'express'
import request from 'supertest'
import { WALNUT_HOME } from '../../../src/constants.js'
import { boardV1Router } from '../../../src/web/routes/board-v1.js'
import { errorHandler } from '../../../src/web/middleware/error-handler.js'
import { addTask } from '../../../src/core/task-manager.js'
import { getBoard, postBoardMessage, setBoardHtml, type BoardMessage } from '../../../src/core/boards/board-store.js'

function createApp() {
  const app = express()
  app.use(express.json())
  app.use('/api/v1', boardV1Router)
  app.use(errorHandler)
  return app
}

let taskId: string
let synced: BoardMessage

beforeAll(async () => {
  await fs.rm(WALNUT_HOME, { recursive: true, force: true })
  await fs.mkdir(WALNUT_HOME, { recursive: true })
  taskId = (await addTask({ title: 'Replica board', project: 'acme' })).task.id
  await setBoardHtml(taskId, '<h1>Synced</h1>', { by: 'human' })
  synced = await postBoardMessage(taskId, 'synced', { author: 'user', text: 'Came with the sync' })
})

afterAll(async () => {
  await fs.rm(WALNUT_HOME, { recursive: true, force: true }).catch(() => {})
})

describe('board routes on a REPLICA', () => {
  it('GET reads the local board', async () => {
    const res = await request(createApp()).get(`/api/v1/tasks/${taskId}/board`)
    expect(res.status).toBe(200)
    expect(res.body.board).toMatchObject({ html: '<h1>Synced</h1>', version: 1 })
    expect(res.body).toMatchObject({ board_task_id: taskId, board_task_title: 'Replica board', projects: {}, checks: {}, reminders: {} })
    // The team owner is a read too, so it works on a replica.
    const owner = await request(createApp()).get(`/api/v1/tasks/${taskId}/board/owner`)
    expect(owner.body).toEqual({ task_id: taskId, title: 'Replica board', self: true, has_board: true })
  })

  it('every write is 501 not_supported_cloud and changes nothing', async () => {
    const app = createApp()
    const base = `/api/v1/tasks/${taskId}/board`
    const writes = [
      request(app).put(base).send({ html: '<p>x</p>' }),
      request(app).post(`${base}/edits`).send({ edits: [{ old: 'Synced', new: 'x' }] }),
      request(app).post(`${base}/threads/t1`).send({ text: 'hello' }),
      request(app).delete(`${base}/threads/synced/messages/${synced.id}`),
      request(app).put(`${base}/marks/m1`).send({ state: 'reviewed' }),
      request(app).put(`${base}/projects/p1`).send({ status: 'wip' }),
      request(app).put(`${base}/checks/c1`).send({ read: true, hash: 'abc' }),
      request(app).put(`${base}/choices/q1`).send({ option: 'a' }),
      request(app).put(`${base}/reminders/q1`).send({ at: new Date(Date.now() + 3_600_000).toISOString() }),
      request(app).put(`${base}/seen/s1`).send({ hash: 'abc' }),
      request(app).delete(base),
    ]
    for (const res of await Promise.all(writes)) {
      expect(res.status).toBe(501)
      expect(res.body.error.code).toBe('not_supported_cloud')
    }
    expect(performSessionSendMock).not.toHaveBeenCalled()
    const board = await getBoard(taskId)
    expect(board).toMatchObject({
      html: '<h1>Synced</h1>', version: 1, threads: { synced: [synced] }, marks: {},
      projects: {}, checks: {}, choices: {}, reminders: {}, section_seen: {},
    })
  })
})
