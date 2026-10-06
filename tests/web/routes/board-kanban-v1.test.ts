/**
 * The kanban routes (src/web/routes/board-kanban-v1.ts) and the kanban part of
 * GET /tasks/:id/board through a real server (startServer port 0, isolated
 * home). Callers are real session records on real tasks: the leader, a worker,
 * an outsider. The send core is the only fake. A getter on CLOUD_MODE lets the
 * last block act as a replica (every write 501) after the server booted.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest'
import fs from 'node:fs/promises'
import type { Server as HttpServer } from 'node:http'
import { createMockConstants } from '../../helpers/mock-constants.js'

const cloud = vi.hoisted(() => ({ on: false }))
vi.mock('../../../src/constants.js', () => {
  const c = createMockConstants('walnut-board-kanban-v1')
  return { ...c, get CLOUD_MODE() { return cloud.on } }
})
vi.mock('../../../src/core/sessions/session-send-core.js', async (importOriginal) => {
  const orig = await importOriginal<typeof import('../../../src/core/sessions/session-send-core.js')>()
  return { ...orig, performSessionSend: vi.fn(async () => ({ delivery: 'queued', targetSessionId: 'x', target: { handle: 'x', sessionId: 'x' } })) }
})

import { WALNUT_HOME } from '../../../src/constants.js'
import { startServer, stopServer } from '../../../src/web/server.js'
import { addTask, getTask, updateTask, updateTaskRaw } from '../../../src/core/task-manager.js'
import { createSessionRecord } from '../../../src/core/session-tracker.js'
import { bus, EventNames, type BusEvent } from '../../../src/core/event-bus.js'
import { getBoard } from '../../../src/core/boards/board-store.js'
import { readableAt } from '../../../src/core/boards/board-kanban.js'
import express from 'express'
import { boardKanbanV1Router } from '../../../src/web/routes/board-kanban-v1.js'
import { executeOp } from '../../../src/ops/executor.js'
import { LOCAL_ORIGIN } from '../../../src/lib/caller-origin.js'
import '../../../src/ops/index.js'

type Json = Record<string, any>
let server: HttpServer
let port: number
let events: Array<Record<string, unknown>> = []

async function call(method: string, path: string, opts: { body?: unknown; sid?: string } = {}): Promise<{ status: number; json: Json }> {
  const res = await fetch(`http://localhost:${port}/api/v1${path}`, {
    method,
    headers: {
      ...(opts.body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      ...(opts.sid ? { 'x-walnut-caller-sid': opts.sid } : {}),
    },
    ...(opts.body !== undefined ? { body: JSON.stringify(opts.body) } : {}),
  })
  const text = await res.text()
  return { status: res.status, json: text ? JSON.parse(text) as Json : {} }
}

let seq = 0
async function task(title: string, parent?: string, tags?: string[]): Promise<string> {
  const { task: t } = await addTask({ title, project: 'acme', ...(parent ? { parent_task_id: parent } : {}), ...(tags ? { tags } : {}) })
  return t.id
}
async function sessionFor(taskId: string, title: string): Promise<string> {
  seq += 1
  const sid = `bbbbbbbb-cccc-dddd-eeee-${String(seq).padStart(12, '0')}`
  await createSessionRecord(sid, taskId, 'acme', '/repo/acme', { title })
  return sid
}
const b = (id: string, tail = '') => `/tasks/${id}/board${tail}`

beforeAll(async () => {
  await fs.rm(WALNUT_HOME, { recursive: true, force: true })
  await fs.mkdir(WALNUT_HOME, { recursive: true })
  server = await startServer({ port: 0, dev: true })
  const addr = server.address()
  if (!addr || typeof addr === 'string') throw new Error('no port')
  port = addr.port
  bus.subscribe('test-kanban-route-spy', (e: BusEvent) => { events.push(e.data as Record<string, unknown>) },
    { global: true, interest: [EventNames.BOARD_CHANGED] })
}, 60_000)

afterAll(async () => {
  bus.unsubscribe('test-kanban-route-spy')
  await stopServer()
  await fs.rm(WALNUT_HOME, { recursive: true, force: true }).catch(() => {})
})

beforeEach(() => { events = []; cloud.on = false })

/** A leader with a ticket team: two open workers, one done eight days ago, its session, a worker session, an outsider's. */
async function makeTeam(name: string) {
  const leader = await task(`${name} resolver group`)
  const a = await task('V1000000401 refund stuck', leader, ['ticket:V1000000401', 'sev:2'])
  const c = await task('V1000000402 ledger drift', leader, ['ticket:V1000000402'])
  const old = await task('V1000000403 old incident', leader, ['ticket:V1000000403'])
  await updateTask(old, { phase: 'COMPLETE' })
  await updateTaskRaw(old, { completed_at: new Date(Date.now() - 8 * 86_400_000).toISOString() })
  const outsider = await task(`${name} unrelated work`)
  return {
    leader, a, c, old, outsider,
    sid: {
      leader: await sessionFor(leader, `${name} resolver group`),
      worker: await sessionFor(a, 'V1000000401 refund stuck'),
      outsider: await sessionFor(outsider, 'Unrelated'),
    },
  }
}

describe('GET kanban fields', () => {
  it('a team with no board file: template lanes, empty cards, the team with old completions, null baseline', async () => {
    const t = await makeTeam('Payments')
    const res = await call('GET', b(t.leader))
    expect(res.status).toBe(200)
    expect(res.json.board).toBeNull()
    expect(res.json).toMatchObject({ lanes: null, lanes_template: 'triage', cards: {}, kanban_seen: null, board_version: 0 })
    expect(res.json.lanes_effective.map((l: Json) => l.name))
      .toEqual(['New', 'Investigating', 'Mitigating', 'Waiting on others', 'Waiting on CR', 'Resolved'])
    expect(res.json.team.map((e: Json) => e.id)).toEqual([t.a, t.c, t.old])
    expect(res.json.team[2]).toMatchObject({ id: t.old, phase: 'COMPLETE', completed_at: expect.any(String) })
    expect(Date.now() - Date.parse(res.json.team[2].completed_at)).toBeGreaterThan(7 * 86_400_000)
  })

  it('fields=kanban answers only the kanban keys (no html), with ?team=1 from a worker', async () => {
    const t = await makeTeam('Shape')
    await call('PUT', b(t.leader), { body: { html: '<h1>Page</h1>' } })
    const res = await call('GET', `${b(t.a)}?team=1&fields=kanban`)
    expect(res.status).toBe(200)
    expect(Object.keys(res.json).sort()).toEqual(['board_task_id', 'board_task_title', 'board_version', 'cards',
      'kanban_seen', 'lanes', 'lanes_effective', 'lanes_template', 'team'].sort())
    expect(res.json).toMatchObject({ board_task_id: t.leader, board_task_title: 'Shape resolver group', board_version: 1 })
  })

  it('a general team (no ticket tags) gets the general template', async () => {
    const leader = await task('Docs refresh lead')
    await task('Rewrite the guide', leader)
    const res = await call('GET', b(leader))
    expect(res.json.lanes_effective.map((l: Json) => l.name)).toEqual(['To do', 'In progress', 'Waiting', 'Review', 'Done'])
  })
})

describe('PUT /tasks/:id/board/lanes', () => {
  it('replaces the table, creates the file (C27), and refuses a session over the user\'s lanes unless override_user', async () => {
    const t = await makeTeam('Lanes')
    const base = (await call('GET', b(t.leader))).json.lanes_effective as Json[]
    const lanes = [...base.slice(0, 5), { name: 'Blocked on vendor', kind: 'wait' }, base[5]]
    const ok = await call('PUT', b(t.leader, '/lanes'), { body: { lanes } })
    expect(ok.status).toBe(200)
    expect(ok.json.lanes).toHaveLength(7)
    expect(ok.json.lanes[5].id).toMatch(/^ln-[0-9a-f]{8}$/)
    expect(ok.json.cards_unplaced).toEqual([])
    expect(await getBoard(t.leader)).toMatchObject({ html: '', version: 0, lanes_by: 'human' })
    expect((await call('GET', b(t.a, '/owner'))).json).toMatchObject({ task_id: t.leader, has_board: true })
    expect(events).toContainEqual({ taskId: t.leader, kind: 'lanes', version: 0 })
    const refused = await call('PUT', b(t.leader, '/lanes'), { body: { lanes: ok.json.lanes.slice(1) }, sid: t.sid.leader })
    expect(refused.status).toBe(409)
    expect(refused.json.error.code).toBe('status_set_by_user')
    const over = await call('PUT', b(t.leader, '/lanes'), { body: { lanes: ok.json.lanes.slice(1), override_user: true }, sid: t.sid.leader })
    expect(over.status).toBe(200)
    expect(over.json.lanes).toHaveLength(6)
  })

  it('error bodies: no done lane 400 needs_done_lane, not an array 400, an outsider 403, stale editor 409 changed_since', async () => {
    const t = await makeTeam('Lane errors')
    const noDone = await call('PUT', b(t.leader, '/lanes'), { body: { lanes: [{ name: 'Open', kind: 'todo' }] } })
    expect([noDone.status, noDone.json.error.code]).toEqual([400, 'needs_done_lane'])
    expect(noDone.json.error.message).toBe('A board keeps one Done lane')
    const notArray = await call('PUT', b(t.leader, '/lanes'), { body: { lanes: 'x' } })
    expect([notArray.status, notArray.json.error.code]).toEqual([400, 'bad_request'])
    const tooMany = await call('PUT', b(t.leader, '/lanes'), { body: { lanes: Array.from({ length: 13 }, (_, i) => ({ name: `L${i}`, kind: 'done' })) } })
    expect([tooMany.status, tooMany.json.error.code, tooMany.json.max]).toEqual([400, 'bad_request', 12])
    const outsider = await call('PUT', b(t.leader, '/lanes'), { body: { lanes: [{ name: 'Done', kind: 'done' }] }, sid: t.sid.outsider })
    expect([outsider.status, outsider.json.error.code]).toEqual([403, 'not_in_team'])
    await call('PUT', b(t.leader, '/lanes'), { body: { lanes: [{ name: 'Open', kind: 'todo' }, { name: 'Done', kind: 'done' }] } })
    const stale = await call('PUT', b(t.leader, '/lanes'), { body: { lanes: [{ name: 'Done', kind: 'done' }], if_unchanged_since: '' } })
    expect([stale.status, stale.json.error.code]).toEqual([409, 'changed_since'])
    expect(stale.json).toMatchObject({ by: 'human', at: expect.any(String) })
    expect(stale.json.current.map((l: Json) => l.name)).toEqual(['Open', 'Done'])
  })
})

describe('PUT /tasks/:id/board/cards/:task', () => {
  it('the user vs the leader session (C11, C69 server half): 409 with the exact message, the suggestion on the card, override moves it', async () => {
    const t = await makeTeam('Cards')
    const placed = await call('POST', b(t.leader, `/cards/${t.a}/move`), { body: { lane: 'waiting-cr', order: [t.a] } })
    expect(placed.status).toBe(200)
    const refused = await call('PUT', b(t.leader, `/cards/${t.a}`), { body: { lane: 'mitigating', summary: 'x' }, sid: t.sid.leader })
    expect(refused.status).toBe(409)
    expect(refused.json.error.code).toBe('status_set_by_user')
    expect(refused.json).toMatchObject({ task: t.a, lane: 'waiting-cr', lane_at: expect.any(String) })
    // N16: a readable local time, never the raw ISO stamp (that stays in `lane_at`).
    expect(refused.json.error.message).not.toContain(refused.json.lane_at)
    expect(refused.json.error.message).toBe(`The user placed this card in "Waiting on CR" ${readableAt(refused.json.lane_at)}. `
      + 'Leave lane out to keep their pick, or pass override_user: true to replace it. '
      + 'Your suggestion to move it to "Mitigating" was recorded on the card; the user can accept it.')
    const after = (await call('GET', `${b(t.leader)}?fields=kanban`)).json.cards[t.a]
    expect(after).toMatchObject({ lane: 'waiting-cr', lane_by: 'human', lane_suggested: { lane: 'mitigating', by: t.leader } })
    expect(after.summary).toBeUndefined()
    const sessionAnswer = await call('POST', b(t.leader, `/cards/${t.a}/suggestion`), { body: { action: 'accept' }, sid: t.sid.leader })
    expect([sessionAnswer.status, sessionAnswer.json.error.code]).toEqual([403, 'human_only'])
    const accepted = await call('POST', b(t.leader, `/cards/${t.a}/suggestion`), { body: { action: 'accept' } })
    expect(accepted.status).toBe(200)
    expect(accepted.json).toMatchObject({ card: { lane: 'mitigating', lane_by: 'human' }, lane_effective: 'mitigating' })
    expect(accepted.json.card.lane_suggested).toBeUndefined()
    const badAction = await call('POST', b(t.leader, `/cards/${t.a}/suggestion`), { body: { action: 'maybe' } })
    expect(badAction.status).toBe(400)
    const none = await call('POST', b(t.leader, `/cards/${t.a}/suggestion`), { body: { action: 'dismiss' } })
    expect([none.status, none.json.error.code]).toEqual([404, 'no_suggestion'])
    const over = await call('PUT', b(t.leader, `/cards/${t.a}`), { body: { lane: 'investigating', override_user: true }, sid: t.sid.leader })
    expect(over.status).toBe(200)
    expect(over.json).toMatchObject({ card: { lane: 'investigating', lane_by: `task:${t.leader}` }, lane_effective: 'investigating' })
  })

  it('the leader writes lane and summary (C10 server half): lane_by is its task, the open pane hears board:changed kind card', async () => {
    const t = await makeTeam('Leader write')
    events = []
    const res = await call('PUT', b(t.leader, `/cards/${t.c}`), { body: { lane: 'mitigating', summary: 'Drift came from a retried batch.' }, sid: t.sid.leader })
    expect(res.status).toBe(200)
    expect(res.json.card).toMatchObject({ lane: 'mitigating', lane_by: `task:${t.leader}`, summary_by: `task:${t.leader}` })
    expect(events).toContainEqual({ taskId: t.leader, kind: 'card', task: t.c, version: 0 })
    // A worker may write its leader's board too (it is on the team).
    const worker = await call('PUT', b(t.leader, `/cards/${t.a}`), { body: { waiting_on: 'Partner team' }, sid: t.sid.worker })
    expect(worker.json.card).toMatchObject({ waiting_on: 'Partner team', waiting_on_by: `task:${t.a}` })
  })

  it('error bodies: lane_not_found with the lanes, not_in_team 404, owner_is_not_a_card 400, limits with max, wrong types', async () => {
    const t = await makeTeam('Card errors')
    const lane = await call('PUT', b(t.leader, `/cards/${t.a}`), { body: { lane: 'ln-0badbeef' } })
    expect([lane.status, lane.json.error.code, lane.json.lane]).toEqual([409, 'lane_not_found', 'ln-0badbeef'])
    expect(lane.json.lanes.map((l: Json) => l.id)).toContain('investigating')
    const outside = await call('PUT', b(t.leader, `/cards/${t.outsider}`), { body: { summary: 'x' } })
    expect([outside.status, outside.json.error.code]).toEqual([404, 'not_in_team'])
    const self = await call('PUT', b(t.leader, `/cards/${t.leader}`), { body: { summary: 'x' } })
    expect([self.status, self.json.error.code]).toEqual([400, 'owner_is_not_a_card'])
    const long = await call('PUT', b(t.leader, `/cards/${t.a}`), { body: { summary: 's'.repeat(301) } })
    expect([long.status, long.json.error.code, long.json.max]).toEqual([400, 'bad_request', 300])
    const waiting = await call('PUT', b(t.leader, `/cards/${t.a}`), { body: { waiting_on: 'w'.repeat(81) } })
    expect([waiting.status, waiting.json.max]).toEqual([400, 80])
    const type = await call('PUT', b(t.leader, `/cards/${t.a}`), { body: { summary: 5 } })
    expect([type.status, type.json.error.code]).toEqual([400, 'bad_request'])
    const empty = await call('PUT', b(t.leader, `/cards/${t.a}`), { body: {} })
    expect(empty.status).toBe(400)
    const flag = await call('PUT', b(t.leader, `/cards/${t.a}`), { body: { summary: 'x', override_user: 'yes' } })
    expect(flag.status).toBe(400)
    const unknownTask = await call('PUT', b('zzzz-no-such-task', `/cards/${t.a}`), { body: { summary: 'x' } })
    expect(unknownTask.status).toBe(404)
  })

  it('if_unchanged_since: a later write by someone else is 409 changed_since { current, at, by }; clearing works', async () => {
    const t = await makeTeam('Stale card')
    await call('PUT', b(t.leader, `/cards/${t.a}`), { body: { summary: 'Leader view' }, sid: t.sid.leader })
    const stale = await call('PUT', b(t.leader, `/cards/${t.a}`), { body: { summary: 'Mine', if_unchanged_since: '' } })
    expect(stale.status).toBe(409)
    expect(stale.json).toMatchObject({ error: { code: 'changed_since' }, current: 'Leader view', by: `task:${t.leader}`, at: expect.any(String) })
    const keep = await call('PUT', b(t.leader, `/cards/${t.a}`), { body: { summary: 'Mine' } })
    expect(keep.json.card.summary).toBe('Mine')
    const cleared = await call('PUT', b(t.leader, `/cards/${t.a}`), { body: { summary: '', lane: '' } })
    expect(cleared.status).toBe(200)
    expect(cleared.json.card.summary).toBeUndefined()
    expect(cleared.json.lane_effective).toBe('new')
  })
})

describe('POST /tasks/:id/board/cards/:task/move', () => {
  it('drops a card second in Waiting on CR (C4 server half), ranks only the cards shown there, rank_only keeps lanes (C68)', async () => {
    const t = await makeTeam('Move')
    const first = await call('POST', b(t.leader, `/cards/${t.c}/move`), { body: { lane: 'waiting-cr', order: [t.c] } })
    expect(first.json).toMatchObject({ card: { lane: 'waiting-cr', lane_by: 'human', rank: 0 }, order: [t.c] })
    const second = await call('POST', b(t.leader, `/cards/${t.a}/move`), { body: { lane: 'waiting-cr', order: [t.c, t.a, t.old, t.outsider] } })
    expect(second.status).toBe(200)
    expect(second.json.order).toEqual([t.c, t.a])
    const cards = (await call('GET', `${b(t.leader)}?fields=kanban`)).json.cards
    expect(cards[t.a]).toMatchObject({ lane: 'waiting-cr', lane_by: 'human', rank: 1, rank_lane: 'waiting-cr' })
    expect(cards[t.old]).toBeUndefined()
    const lead = await task('Reorder lead')
    const x = await task('Auto one', lead)
    const y = await task('Auto two', lead)
    const reorder = await call('POST', b(lead, `/cards/${y}/move`), { body: { lane: 'todo', order: [y, x], rank_only: true } })
    expect(reorder.json.order).toEqual([y, x])
    const k = (await call('GET', `${b(lead)}?fields=kanban`)).json.cards
    expect(k[x]).toEqual({ rank: 1, rank_lane: 'todo' })
    expect(k[y]).toEqual({ rank: 0, rank_lane: 'todo' })
    const sid = await sessionFor(lead, 'Reorder lead')
    const moved = await call('PUT', b(lead, `/cards/${x}`), { body: { lane: 'review' }, sid })
    expect(moved.status).toBe(200)
  })

  it('error bodies: no lane 400, order not an array 400, an unknown lane 409, a session over the user 409 with the suggestion', async () => {
    const t = await makeTeam('Move errors')
    expect((await call('POST', b(t.leader, `/cards/${t.a}/move`), { body: { order: [] } })).status).toBe(400)
    expect((await call('POST', b(t.leader, `/cards/${t.a}/move`), { body: { lane: 'new', order: 'x' } })).status).toBe(400)
    const lane = await call('POST', b(t.leader, `/cards/${t.a}/move`), { body: { lane: 'gone-lane', order: [] } })
    expect([lane.status, lane.json.error.code]).toEqual([409, 'lane_not_found'])
    await call('POST', b(t.leader, `/cards/${t.a}/move`), { body: { lane: 'mitigating', order: [] } })
    const refused = await call('POST', b(t.leader, `/cards/${t.a}/move`), { body: { lane: 'new', order: [] }, sid: t.sid.leader })
    expect([refused.status, refused.json.error.code]).toEqual([409, 'status_set_by_user'])
    expect((await getBoard(t.leader))!.cards[t.a]).toMatchObject({ lane: 'mitigating', lane_suggested: { lane: 'new' } })
  })
})

describe('POST /tasks/:id/board/cards', () => {
  it('201 with a subtask of the owner in its project, tagged, no session, placed in the lane (C17 server half)', async () => {
    const t = await makeTeam('Add task')
    const res = await call('POST', b(t.leader, '/cards'), {
      body: { title: 'V1000000140 checkout latency', lane: 'investigating', tags: ['ticket:V1000000140', 'sev:2'] },
    })
    expect(res.status).toBe(201)
    expect(res.json.card).toMatchObject({ lane: 'investigating', lane_by: 'human' })
    const made = await getTask(res.json.task.id)
    expect(made).toMatchObject({ title: 'V1000000140 checkout latency', parent_task_id: t.leader, project: 'acme' })
    expect(made.tags).toEqual(expect.arrayContaining(['ticket:V1000000140', 'sev:2']))
    expect(made.session_ids).toEqual([])
    const k = (await call('GET', `${b(t.leader)}?fields=kanban`)).json
    expect(k.team.map((e: Json) => e.id)).toContain(made.id)
    expect(k.cards[made.id]).toMatchObject({ lane: 'investigating' })
    expect((await call('POST', b(t.leader, '/cards'), { body: { title: 5 } })).status).toBe(400)
    expect((await call('POST', b(t.leader, '/cards'), { body: { title: 'x', tags: 'sev:2' } })).status).toBe(400)
    // A session files work with task_create (placement, depth and title brakes); this route is the user's Add task.
    for (const sid of [t.sid.leader, t.sid.outsider]) {
      const refused = await call('POST', b(t.leader, '/cards'), { body: { title: 'x' }, sid })
      expect([refused.status, refused.json.error.code]).toEqual([403, 'human_only'])
    }
  })
})

describe('PUT /tasks/:id/board/kanban-seen', () => {
  it('humans only; the baseline answers and reaches every pane as kind seen with kanban true (C62 server half)', async () => {
    const t = await makeTeam('Seen')
    const refused = await call('PUT', b(t.leader, '/kanban-seen'), { body: { cards: 'all' }, sid: t.sid.leader })
    expect([refused.status, refused.json.error.code]).toEqual([403, 'human_only'])
    events = []
    const ok = await call('PUT', b(t.leader, '/kanban-seen'), { body: { cards: 'all' } })
    expect(ok.status).toBe(200)
    expect(Object.keys(ok.json.kanban_seen.cards).sort()).toEqual([t.a, t.c, t.old].sort())
    expect(ok.json.kanban_seen.cards[t.old].lane).toBe('resolved')
    expect(events).toContainEqual({ taskId: t.leader, kind: 'seen', kanban: true, version: 0 })
    const got = (await call('GET', `${b(t.leader)}?fields=kanban`)).json.kanban_seen
    expect(got).toEqual(ok.json.kanban_seen)
    const bad = await call('PUT', b(t.leader, '/kanban-seen'), { body: { cards: 7 } })
    expect(bad.status).toBe(400)
  })
})

describe('on a replica', () => {
  it('every kanban write is 501 not_supported_cloud (the router on a bare app: a replica server also asks for auth)', async () => {
    const t = await makeTeam('Replica')
    const app = express()
    app.use(express.json())
    app.use('/api/v1', boardKanbanV1Router)
    const bare = await new Promise<HttpServer>((resolve) => { const s = app.listen(0, () => resolve(s)) })
    const barePort = (bare.address() as { port: number }).port
    const call = async (method: string, path: string, opts: { body?: unknown }) => {
      const res = await fetch(`http://localhost:${barePort}/api/v1${path}`, {
        method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(opts.body),
      })
      return { status: res.status, json: await res.json() as Json }
    }
    cloud.on = true
    const writes: Array<[string, string, unknown]> = [
      ['PUT', b(t.leader, '/lanes'), { lanes: [{ name: 'Done', kind: 'done' }] }],
      ['PUT', b(t.leader, `/cards/${t.a}`), { summary: 'x' }],
      ['POST', b(t.leader, `/cards/${t.a}/move`), { lane: 'new', order: [] }],
      ['POST', b(t.leader, '/cards'), { title: 'x' }],
      ['POST', b(t.leader, `/cards/${t.a}/suggestion`), { action: 'dismiss' }],
      ['PUT', b(t.leader, '/kanban-seen'), { cards: 'all' }],
    ]
    for (const [method, path, body] of writes) {
      const res = await call(method, path, { body })
      expect([path, res.status, res.json.error?.code]).toEqual([path, 501, 'not_supported_cloud'])
    }
    cloud.on = false
    await new Promise((r) => bare.close(r))
    expect(await getBoard(t.leader)).toBeNull()
  })
})

describe('the leader ops through the real server (C11 op half, C41)', () => {
  it('board_card_set as the leader: the user\'s lane is refused with the message, override moves it, outcome names the lane', async () => {
    const t = await makeTeam('Ops')
    const op = (name: string, args: Record<string, unknown>) =>
      executeOp(name, args, { apiBase: `http://localhost:${port}`, callerSid: t.sid.leader, origin: LOCAL_ORIGIN })
    await call('POST', b(t.leader, `/cards/${t.a}/move`), { body: { lane: 'waiting-cr', order: [t.a] } })
    const refused = await op('board_card_set', { card: t.a, lane: 'mitigating' })
    expect(refused.ok).toBe(false)
    expect((refused as { message: string }).message).toContain('was recorded on the card; the user can accept it.')
    const ok = await op('board_card_set', { card: t.a, lane: 'mitigating', summary: 'Stuck shard found', override_user: true })
    expect(ok.ok, JSON.stringify(ok)).toBe(true)
    expect((ok as { result: { outcome: string } }).result.outcome).toContain('is in "Mitigating"')
    const lanes = await op('board_lanes_set', { lanes: [{ name: 'Open', kind: 'todo' }, { name: 'Done', kind: 'done' }] })
    expect(lanes.ok, JSON.stringify(lanes)).toBe(true)
    const got = await op('board_get', {})
    expect((got as { result: { outcome: string } }).result.outcome).toMatch(/cards: 2 open, 1 with no summary from you, 0 suggestions/)
  })
})

describe('placement facts the panes rely on (C66, C92 server halves)', () => {
  it('a card done eight days ago that the user then put in Mitigating stays there (placement later than completion)', async () => {
    const t = await makeTeam('Late placement')
    const res = await call('POST', b(t.leader, `/cards/${t.old}/move`), { body: { lane: 'mitigating', order: [t.old] } })
    expect(res.json.order).toEqual([t.old])
    const put = await call('PUT', b(t.leader, `/cards/${t.old}`), { body: { summary: 'Reopened in review' } })
    expect(put.json.lane_effective).toBe('mitigating')
  })

  it('two pages writing the same card back to back: the next read shows the later write, each write announced', async () => {
    const t = await makeTeam('Two pages')
    events = []
    await call('POST', b(t.leader, `/cards/${t.a}/move`), { body: { lane: 'mitigating', order: [t.a] } })
    await call('POST', b(t.leader, `/cards/${t.a}/move`), { body: { lane: 'waiting-others', order: [t.a] } })
    const k = (await call('GET', `${b(t.leader)}?fields=kanban`)).json
    expect(k.cards[t.a]).toMatchObject({ lane: 'waiting-others', lane_by: 'human', rank_lane: 'waiting-others' })
    expect(events.filter((e) => e.kind === 'card' && e.task === t.a && e.taskId === t.leader).length).toBeGreaterThanOrEqual(2)
  })
})
