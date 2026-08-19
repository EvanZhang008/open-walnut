/**
 * POST /api/agents/:agentId/conversations/:cid/promote-task — turn a WHOLE
 * conversation into a task.
 *
 * The contract under test (each clause is a product decision):
 *  - creates a task linked to the conversation's lane session (session_id slot
 *    + session_ids history + the record's taskId back-pointer);
 *  - the lane binding SURVIVES — the chat stays in Main Chat, the task's circle
 *    routes back to the same transcript (dual visibility is the feature);
 *  - title precedence: caller's title → conversation auto-title;
 *  - project routes ('' / omitted = Inbox);
 *  - a conversation with no lane session yet is a 409, not a task without a
 *    session (that shape would be indistinguishable from Quick Add).
 *
 * What's real: Express server, session-tracker, task-manager, conversations
 * store. What's mocked: constants.js (temp dir). The lane session record is
 * seeded directly (createSessionRecord with `lane`) — spawning a real CLI is
 * the live tier's job.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import fs from 'node:fs/promises'
import type { Server as HttpServer } from 'node:http'
import { vi } from 'vitest'
import { createMockConstants } from '../../helpers/mock-constants.js'

vi.mock('../../../src/constants.js', () => createMockConstants())

import { WALNUT_HOME } from '../../../src/constants.js'
import { startServer, stopServer } from '../../../src/web/server.js'
import { closeDb as closeTaskDb } from '../../../src/core/task-db.js'
import { closeDb as closeSessionDb } from '../../../src/core/session-db.js'
import { _resetForTesting as resetTaskManager } from '../../../src/core/task-manager.js'
import { createSessionRecord, getSessionByClaudeId } from '../../../src/core/session-tracker.js'
import { personalAiLaneKey } from '../../../src/core/sessions/personal-ai-lane.js'
import { createConversation } from '../../../src/core/conversations.js'

let server: HttpServer
let port: number

function apiUrl(p: string): string {
  return `http://localhost:${port}${p}`
}

/** Seed a conversation + its lane-bound session record, like a real chat send did. */
async function seedLaneConversation(agentId: string, sessionId: string, title?: string): Promise<string> {
  const meta = await createConversation(agentId, title)
  await createSessionRecord(sessionId, '', 'chat', process.cwd(), {
    lane: personalAiLaneKey(agentId, meta.id),
  })
  return meta.id
}

async function promote(agentId: string, cid: string, body: Record<string, unknown>): Promise<Response> {
  return fetch(apiUrl(`/api/agents/${agentId}/conversations/${cid}/promote-task`), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
}

beforeAll(async () => {
  closeTaskDb()
  closeSessionDb()
  resetTaskManager()
  await fs.rm(WALNUT_HOME, { recursive: true, force: true })
  server = await startServer({ port: 0, dev: true })
  const addr = server.address()
  port = typeof addr === 'object' && addr ? addr.port : 0
})

afterAll(async () => {
  await stopServer()
  closeTaskDb()
  closeSessionDb()
  await fs.rm(WALNUT_HOME, { recursive: true, force: true }).catch(() => {})
})

describe('POST /api/agents/:agentId/conversations/:cid/promote-task', () => {
  it('creates a task linked to the lane session, in the picked project', async () => {
    const sid = 'promote-lane-001'
    const cid = await seedLaneConversation('general', sid, 'QMD search rework')

    const res = await promote('general', cid, { title: 'Rework QMD search', project: 'Search' })
    expect(res.status).toBe(201)
    const body = (await res.json()) as { task: Record<string, any>; sessionId: string }

    expect(body.sessionId).toBe(sid)
    expect(body.task.title).toBe('Rework QMD search')
    expect(body.task.project).toBe('Search')
    // The lane session occupies the PRIMARY slot — this task's working session.
    expect(body.task.session_id).toBe(sid)
    expect(body.task.session_ids).toContain(sid)

    // Back-pointer: session → task (what handleSessionClick and the reconciler read).
    const record = await getSessionByClaudeId(sid)
    expect(record?.taskId).toBe(body.task.id)
    // THE core promise: the lane binding survives, so the conversation still
    // renders in Main Chat. Losing `lane` would silently re-home the chat.
    expect(record?.lane).toBe(personalAiLaneKey('general', cid))
  })

  it('falls back to the conversation title when no title is given, and lands in Inbox', async () => {
    const sid = 'promote-lane-002'
    const cid = await seedLaneConversation('general', sid, 'Calendar sync bug hunt')

    const res = await promote('general', cid, {})
    expect(res.status).toBe(201)
    const body = (await res.json()) as { task: Record<string, any> }
    expect(body.task.title).toBe('Calendar sync bug hunt')
    expect(body.task.project ?? '').toBe('')
  })

  it('409s a conversation that has no lane session yet', async () => {
    const meta = await createConversation('general', 'never chatted')
    const res = await promote('general', meta.id, { title: 'should not exist' })
    expect(res.status).toBe(409)
  })

  it('400s a non-string title or project', async () => {
    const sid = 'promote-lane-003'
    const cid = await seedLaneConversation('general', sid)
    expect((await promote('general', cid, { title: 42 })).status).toBe(400)
    expect((await promote('general', cid, { project: ['x'] })).status).toBe(400)
  })
})
