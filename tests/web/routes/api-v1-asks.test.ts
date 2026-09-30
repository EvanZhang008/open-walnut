/**
 * GET /api/v1/asks on the PRIMARY: the real task store on an isolated home, the
 * session store mocked at its module seam (running / idle states), supertest
 * against the real router. What it pins:
 *   - the list is the web drawer's list: the same rules module run over the same
 *     minimal task rows, so `asks` equals `selectAgentTasks` + `askTitle` from the
 *     web model byte for byte;
 *   - activity is what a SENT message stamps (linkSession / touchLastSessionUpdate),
 *     never an edit (a rename bumps updated_at and moves nothing);
 *   - per-agent lists, search, limit + total, 404 / 400 in the frozen shape;
 *   - the `server.asks` relay handler answers exactly what the route answers
 *     (the replica serves the phone through it).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'node:fs/promises'
import { createMockConstants } from '../../helpers/mock-constants.js'

vi.mock('../../../src/constants.js', () => createMockConstants('walnut-apiv1-asks'))

const sessionsMock = vi.fn()
vi.mock('../../../src/core/session-tracker.js', async (orig) => ({
  ...(await orig<typeof import('../../../src/core/session-tracker.js')>()),
  listSessions: () => sessionsMock(),
  listSessionsForTasks: () => sessionsMock(),
}))

import express from 'express'
import request from 'supertest'
import { asksV1Router } from '../../../src/web/routes/asks-v1.js'
import { errorHandler } from '../../../src/web/middleware/error-handler.js'
import { WALNUT_HOME } from '../../../src/constants.js'
import {
  addTask, linkSession, touchLastSessionUpdate, updateTask, completeTask, queryTasksSlimPage, _resetForTesting,
} from '../../../src/core/task-manager.js'
import { handleSessionControlRelay } from '../../../src/core/sessions/session-controls.js'
import { closeDb as closeTaskDb } from '../../../src/core/task-db.js'
import { GENERAL_ASK_AGENT, selectAgentTasks, toAskAgent } from '../../../web/src/components/chat/ask-walnut-slot-model.js'
import { askTitle } from '../../../src/core/sessions/ask-list.js'
import type { Task } from '../../../src/core/types.js'

function createApp() {
  const app = express()
  app.use(express.json())
  app.use('/api/v1', asksV1Router)
  app.use(errorHandler)
  return app
}

let clock = Date.UTC(2026, 8, 1, 9, 0, 0)
/** Every write reads `new Date()`: step a fake clock so stamps are distinct and known. */
function at(iso: string): void {
  clock = Date.parse(iso)
  vi.setSystemTime(clock)
}

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ['Date'] })
  // A fresh store per test: the SQLite connection outlives the directory unless closed.
  closeTaskDb()
  await fs.rm(WALNUT_HOME, { recursive: true, force: true })
  await fs.mkdir(WALNUT_HOME, { recursive: true })
  _resetForTesting()
  sessionsMock.mockReset()
  sessionsMock.mockResolvedValue([])
})

afterEach(async () => {
  vi.useRealTimers()
  closeTaskDb()
  await fs.rm(WALNUT_HOME, { recursive: true, force: true }).catch(() => {})
})

/** The board as the user would build it: asks born on different days, some
 *  continued later, one done, one never started, one renamed, a Mentor ask,
 *  a todo filed under Ask Walnut by hand and an unrelated task. */
async function seedBoard(): Promise<Record<string, string>> {
  const id: Record<string, string> = {}
  at('2026-09-01T09:00:00.000Z')
  id.oldContinued = (await addTask({ title: 'Garden plan', project: 'Ask Walnut', walnut_agent: true })).task.id
  await linkSession(id.oldContinued, 'sess-garden')
  at('2026-09-05T09:00:00.000Z')
  id.done = (await addTask({ title: 'Reading list', project: 'Ask Walnut', walnut_agent: true })).task.id
  await linkSession(id.done, 'sess-reading')
  await completeTask(id.done)
  at('2026-09-10T09:00:00.000Z')
  id.running = (await addTask({ title: 'Release checklist', project: 'Ask Walnut', walnut_agent: true })).task.id
  await linkSession(id.running, 'sess-release')
  at('2026-09-12T09:00:00.000Z')
  id.mentor = (await addTask({ title: 'Weekly reflection', project: 'Ask Mentor', walnut_agent: true, agent_id: 'mentor' })).task.id
  await linkSession(id.mentor, 'sess-mentor')
  at('2026-09-14T09:00:00.000Z')
  id.renamed = (await addTask({ title: 'Ask Walnut', project: 'Ask Walnut', walnut_agent: true })).task.id
  await linkSession(id.renamed, 'sess-trip')
  at('2026-09-16T09:00:00.000Z')
  id.noSession = (await addTask({ title: 'Filed by hand', project: 'Ask Walnut' })).task.id
  id.unrelated = (await addTask({ title: 'Unrelated chore', project: 'Home' })).task.id
  // Later: the old ask gets a message (activity), the placeholder gets its
  // drifted title (an edit, not activity), a bulk edit touches the done one.
  at('2026-09-20T09:00:00.000Z')
  await touchLastSessionUpdate(id.oldContinued)
  at('2026-09-21T09:00:00.000Z')
  await updateTask(id.renamed, { title: 'Trip plan: hotel shortlist' })
  await updateTask(id.done, { priority: 'high' })
  sessionsMock.mockResolvedValue([
    { claudeSessionId: 'sess-release', taskId: id.running, process_status: 'running', mode: 'default', startedAt: '', lastActiveAt: '', messageCount: 1 },
    { claudeSessionId: 'sess-garden', taskId: id.oldContinued, process_status: 'idle', mode: 'default', startedAt: '', lastActiveAt: '', messageCount: 1 },
  ])
  return id
}

describe('GET /api/v1/asks (primary)', () => {
  it("lists Walnut's asks in activity order, with the printed stamp, title and state", async () => {
    const id = await seedBoard()
    const res = await request(createApp()).get('/api/v1/asks')
    expect(res.status).toBe(200)
    expect(res.body.agentId).toBe('general')
    expect(res.body.project).toBe('Ask Walnut')
    expect(res.body.total).toBe(5)
    const rows = res.body.asks as Array<Record<string, string>>
    expect(rows.map((r) => r.id)).toEqual([id.oldContinued, id.noSession, id.renamed, id.running, id.done])
    expect(rows.map((r) => r.activityAt)).toEqual([
      '2026-09-20T09:00:00.000Z', // continued: its message, not its birth
      '2026-09-16T09:00:00.000Z', // never started: its birth
      '2026-09-14T09:00:00.000Z', // renamed on 09-21, but a rename is not activity
      '2026-09-10T09:00:00.000Z',
      '2026-09-05T09:00:00.000Z', // edited on 09-21, still where its conversation left it
    ])
    expect(rows.map((r) => r.state)).toEqual(['idle', 'todo', 'idle', 'running', 'done'])
    expect(rows[2].title).toBe('Trip plan: hotel shortlist')
    expect(rows[0].sessionId).toBe('sess-garden')
    expect(rows[1]).not.toHaveProperty('sessionId')
  })

  it('is exactly the web drawer list for the same rows (same module, same inputs)', async () => {
    await seedBoard()
    const res = await request(createApp()).get('/api/v1/asks')
    const page = await queryTasksSlimPage({}, { minimal: true })
    const web = selectAgentTasks(page.tasks as unknown as Task[], GENERAL_ASK_AGENT)
    expect((res.body.asks as Array<{ id: string; title: string }>).map((r) => [r.id, r.title]))
      .toEqual(web.map((t) => [t.id, askTitle(t, GENERAL_ASK_AGENT)]))
  })

  it("serves another agent's own list", async () => {
    const id = await seedBoard()
    const res = await request(createApp()).get('/api/v1/asks?agentId=mentor')
    expect(res.status).toBe(200)
    expect(res.body.project).toBe(toAskAgent({ id: 'mentor', name: 'Mentor' }).project)
    expect((res.body.asks as Array<{ id: string }>).map((r) => r.id)).toEqual([id.mentor])
  })

  it('filters by q on the shown title and caps with limit while total counts every match', async () => {
    const id = await seedBoard()
    const q = await request(createApp()).get('/api/v1/asks?q=PLAN')
    expect((q.body.asks as Array<{ id: string }>).map((r) => r.id)).toEqual([id.oldContinued, id.renamed])
    const capped = await request(createApp()).get('/api/v1/asks?limit=2')
    expect(capped.body.total).toBe(5)
    expect(capped.body.asks).toHaveLength(2)
  })

  it('404 for an agent the drawer does not offer, 400 for a malformed id, both frozen-shape', async () => {
    const missing = await request(createApp()).get('/api/v1/asks?agentId=nobody-here')
    expect(missing.status).toBe(404)
    expect(missing.body.error.code).toBe('not_found')
    const bad = await request(createApp()).get('/api/v1/asks?agentId=Bad%20Id')
    expect(bad.status).toBe(400)
    expect(bad.body.error.code).toBe('bad_request')
  })

  it('an empty board is an empty list, not an error', async () => {
    const res = await request(createApp()).get('/api/v1/asks')
    expect(res.status).toBe(200)
    expect(res.body).toEqual({ agentId: 'general', project: 'Ask Walnut', total: 0, launch: true, asks: [] })
  })

  it('says it launches asks (launch: true), computed here so a replica carries the Mac\'s own answer', async () => {
    await seedBoard()
    const res = await request(createApp()).get('/api/v1/asks?agentId=mentor')
    expect(res.status).toBe(200)
    expect(res.body.launch).toBe(true)
    const relayed = await handleSessionControlRelay('server.asks', '__server__', { agentId: 'mentor' })
    expect(relayed.ok && relayed.result.launch).toBe(true)
  })

  it('refuses a limit that is not a whole number from 1 (it used to become 200 silently)', async () => {
    await seedBoard()
    for (const raw of ['0', 'abc', '-1', '2.5', '', '1e2', ' 5']) {
      const res = await request(createApp()).get(`/api/v1/asks?limit=${encodeURIComponent(raw)}`)
      expect(res.status, `limit=${JSON.stringify(raw)}`).toBe(400)
      expect(res.body.error.code).toBe('bad_request')
      expect(res.body.error.message).toMatch(/limit/i)
    }
    const repeated = await request(createApp()).get('/api/v1/asks?limit=1&limit=2')
    expect(repeated.status).toBe(400)
    // The relay takes the same rule: the phone cannot reach through the replica
    // with a limit the Mac's route refuses.
    const relayed = await handleSessionControlRelay('server.asks', '__server__', { agentId: 'general', limit: 0 })
    expect(relayed).toMatchObject({ ok: false, errorKind: 'bad_request' })
    // Above the max is capped (documented), and total still counts every match.
    const big = await request(createApp()).get('/api/v1/asks?limit=5000')
    expect(big.status).toBe(200)
    expect(big.body.total).toBe(5)
  })

  it('caps a limit of any length at 1000, as documented (a 20-digit one used to be a 400)', async () => {
    await seedBoard()
    for (const raw of ['1001', '99999999999999999999', '9'.repeat(400), '0001000', '00005']) {
      const res = await request(createApp()).get(`/api/v1/asks?limit=${raw}`)
      expect(res.status, `limit=${raw.slice(0, 24)}`).toBe(200)
      expect(res.body.total).toBe(5)
      expect(res.body.asks).toHaveLength(5)
    }
    const two = await request(createApp()).get('/api/v1/asks?limit=002')
    expect(two.body.asks).toHaveLength(2)
    for (const raw of ['000', '00']) {
      const res = await request(createApp()).get(`/api/v1/asks?limit=${raw}`)
      expect(res.status, `limit=${raw}`).toBe(400)
    }
    // The relay takes numbers: a huge one is capped, a non-finite one refused.
    const relayedBig = await handleSessionControlRelay('server.asks', '__server__', { agentId: 'general', limit: 1e21 })
    expect(relayedBig.ok && relayedBig.result.total).toBe(5)
    const relayedInf = await handleSessionControlRelay('server.asks', '__server__', { agentId: 'general', limit: Infinity })
    expect(relayedInf).toMatchObject({ ok: false, errorKind: 'bad_request' })
  })

  it('refuses an agentId or q that is not one string (a repeat used to fall back silently)', async () => {
    const id = await seedBoard()
    // A repeated agentId used to list WALNUT's asks; a repeated q listed everything.
    for (const qs of ['agentId=mentor&agentId=mentor', 'agentId=mentor&agentId=general', 'q=plan&q=plan']) {
      const res = await request(createApp()).get(`/api/v1/asks?${qs}`)
      expect(res.status, qs).toBe(400)
      expect(res.body.error.code).toBe('bad_request')
      expect(res.body.error.message, qs).toMatch(/agentId|\bq\b/)
    }
    // Once, as text, both still work; empty is the default.
    const once = await request(createApp()).get('/api/v1/asks?agentId=mentor&q=')
    expect(once.status).toBe(200)
    expect((once.body.asks as Array<{ id: string }>).map((r) => r.id)).toEqual([id.mentor])
    expect((await request(createApp()).get('/api/v1/asks?agentId=')).body.agentId).toBe('general')
    // The relay takes the same rule.
    for (const params of [{ agentId: ['mentor', 'general'] }, { q: ['a', 'b'] }, { agentId: 7 }]) {
      const relayed = await handleSessionControlRelay('server.asks', '__server__', params as Record<string, unknown>)
      expect(relayed, JSON.stringify(params)).toMatchObject({ ok: false, errorKind: 'bad_request' })
    }
  })

  it('the server.asks relay handler answers exactly what the route answers', async () => {
    await seedBoard()
    const direct = await request(createApp()).get('/api/v1/asks?agentId=general&q=plan&limit=5')
    const relayed = await handleSessionControlRelay('server.asks', '__server__', { agentId: 'general', q: 'plan', limit: 5 })
    expect(relayed.ok).toBe(true)
    expect(relayed.ok && relayed.result).toEqual(direct.body)
    const refused = await handleSessionControlRelay('server.asks', '__server__', { agentId: 'Bad Id' })
    expect(refused).toMatchObject({ ok: false, errorKind: 'bad_request' })
    const unknown = await handleSessionControlRelay('server.asks', '__server__', { agentId: 'nobody-here' })
    expect(unknown).toMatchObject({ ok: false, errorKind: 'not_found' })
  })
})
