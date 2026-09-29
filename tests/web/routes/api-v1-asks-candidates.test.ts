/**
 * GET /api/v1/asks reads only the rows that could be an ask (SQL), and answers
 * exactly what the full-table read did.
 *
 * The old path read the whole task table (about 6.5k rows on a real board) and
 * filtered in JS on every call, which held the event loop 110-390ms. The new path
 * narrows in SQL (`listTasksSlim({ askCandidates })`) and keeps the JS rule
 * (`isAskOf`) as the judge. That is only safe while the SQL is a SUPERSET of the
 * rule, so this suite:
 *   - builds a board that stresses every way the two could disagree (project case,
 *     Unicode whitespace JS trims and SQLite does not, a KELVIN SIGN that lowers to
 *     'k' in JS only, the stamp in another project, the ".metadata" sentinel,
 *     look-alike projects), written straight to the table so no write path
 *     normalises the text first;
 *   - checks the SQL candidates hold every member of every agent's list and
 *     leave the plain rows out;
 *   - checks the route's answer equals the old full-read answer for each agent.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'node:fs/promises'
import { createMockConstants } from '../../helpers/mock-constants.js'

vi.mock('../../../src/constants.js', () => createMockConstants('walnut-apiv1-asks-candidates'))

vi.mock('../../../src/core/session-tracker.js', async (orig) => ({
  ...(await orig<typeof import('../../../src/core/session-tracker.js')>()),
  listSessions: async () => [],
}))

import express from 'express'
import request from 'supertest'
import { asksV1Router } from '../../../src/web/routes/asks-v1.js'
import { errorHandler } from '../../../src/web/middleware/error-handler.js'
import { WALNUT_HOME } from '../../../src/constants.js'
import { listTasksSlim, queryTasksSlimPage, _resetForTesting } from '../../../src/core/task-manager.js'
import { closeDb, getDb, taskToRow } from '../../../src/core/task-db.js'
import { enrichTasksWithSessionStatus } from '../../../src/web/routes/tasks.js'
import { buildAskList, isAskOf, type AskListAgent } from '../../../src/core/sessions/ask-list.js'
import type { Task } from '../../../src/core/types.js'

function createApp() {
  const app = express()
  app.use(express.json())
  app.use('/api/v1', asksV1Router)
  app.use(errorHandler)
  return app
}

const WALNUT: AskListAgent = { id: 'general', project: 'Ask Walnut' }
const MENTOR: AskListAgent = { id: 'mentor', project: 'Ask Mentor' }

/** Write tasks straight to the table: no write path may tidy the project text first. */
function insertRaw(tasks: Array<Partial<Task>>): void {
  const db = getDb()!
  for (const t of tasks) {
    const row = taskToRow(t)
    const cols = Object.keys(row)
    db.prepare(`INSERT INTO tasks (${cols.join(', ')}) VALUES (${cols.map((c) => `@${c}`).join(', ')})`).run(row)
  }
}

let seq = 0
function task(over: Partial<Task>): Partial<Task> {
  seq++
  const born = new Date(Date.UTC(2026, 7, 1) + seq * 3_600_000).toISOString()
  return {
    id: `t-${String(seq).padStart(4, '0')}`,
    title: `Task ${seq}`,
    project: 'Home',
    status: 'todo',
    phase: 'TODO',
    priority: 'none',
    source: 'local',
    created_at: born,
    updated_at: born,
    session_ids: [],
    ...over,
  }
}

/** Every shape where SQL and JS could part ways, plus density. */
function edgeBoard(): Array<Partial<Task>> {
  seq = 0
  const out: Array<Partial<Task>> = [
    task({ title: 'Plain ask', project: 'Ask Walnut', walnut_agent: true }),
    task({ title: 'Upper case project', project: 'ASK WALNUT' }),
    task({ title: 'Mixed case project', project: 'ask walnut' }),
    task({ title: 'Padded project', project: '  Ask Walnut  ' }),
    // JS trim() strips these; SQLite's trim() would not, so the SQL is unanchored.
    task({ title: 'Ideographic space', project: '\u3000Ask Walnut' }),
    task({ title: 'No-break space', project: '\u00a0Ask Walnut\u00a0' }),
    task({ title: 'Tab and newline', project: '\tAsk Walnut\n' }),
    // U+212A KELVIN SIGN lowers to 'k' in JS only.
    task({ title: 'Kelvin sign', project: 'As\u212A Walnut' }),
    // Born an ask, since moved: the stamp keeps it on the list.
    task({ title: 'Moved to Home', project: 'Home', walnut_agent: true }),
    task({ title: 'Moved, no project', project: '', walnut_agent: true }),
    task({ title: 'Mentor ask', project: 'Ask Mentor', walnut_agent: true, agent_id: 'mentor' }),
    task({ title: 'Mentor ask moved', project: 'Weekly', walnut_agent: true, agent_id: 'mentor' }),
    task({ title: 'Mentor by hand', project: 'ASK MENTOR' }),
    // Look-alikes that are not asks.
    task({ title: 'Near miss', project: 'Ask Walnuts' }),
    task({ title: 'Near miss 2', project: 'Asking Walnut' }),
    task({ title: 'Near miss 3', project: 'Task board' }),
    task({ title: 'Inner space', project: 'Ask\u00a0Walnut' }),
    // The retired sentinel namespace never lists, whatever its project.
    task({ title: '.metadata sentinel', project: 'Ask Walnut', walnut_agent: true }),
    task({ title: '  .metadata padded', project: 'Ask Walnut' }),
    // A stamp that is not `true` is not an ask.
    task({ title: 'Stamp false', project: 'Home', walnut_agent: false }),
    // Done, and with a session.
    task({ title: 'Done ask', project: 'Ask Walnut', walnut_agent: true, status: 'done', phase: 'COMPLETE' }),
    task({
      title: 'Talked to', project: 'Ask Walnut', walnut_agent: true,
      session_id: 'sess-a', session_ids: ['sess-a'], last_session_update: '2026-09-20T09:00:00.000Z',
    }),
  ]
  // Density: the rest of a real board is ordinary tasks in ordinary projects.
  const projects = ['Home', 'Work', 'Garden', 'Reading', 'Travel', 'Health', 'Finance', '']
  for (let i = 0; i < 600; i++) out.push(task({ title: `Chore ${i}`, project: projects[i % projects.length] }))
  // And a few dozen asks spread among them.
  for (let i = 0; i < 40; i++) out.push(task({ title: `Ask ${i}`, project: 'Ask Walnut', walnut_agent: true }))
  return out
}

/** The old path: the whole table, then the JS rule. */
async function fullReadAnswer(agent: AskListAgent) {
  const page = await queryTasksSlimPage({}, { minimal: true })
  const members = (page.tasks as unknown as Task[]).filter((t) => isAskOf(t, agent))
  const enriched = await enrichTasksWithSessionStatus(members)
  return buildAskList(enriched, agent, { limit: 1000 })
}

beforeEach(async () => {
  closeDb()
  await fs.rm(WALNUT_HOME, { recursive: true, force: true })
  await fs.mkdir(WALNUT_HOME, { recursive: true })
  _resetForTesting()
  // Open the store (schema + init) before writing to its table directly.
  await listTasksSlim({ minimal: true })
  insertRaw(edgeBoard())
  _resetForTesting()
})

afterEach(async () => {
  closeDb()
  await fs.rm(WALNUT_HOME, { recursive: true, force: true }).catch(() => {})
})

describe('the ask candidates filter (SQL) is a superset of the rule (JS)', () => {
  it('holds every member of every agent list and leaves the plain rows out', async () => {
    const all = await listTasksSlim({ minimal: true }) as unknown as Task[]
    const candidates = await listTasksSlim({ minimal: true, askCandidates: true }) as unknown as Task[]
    const candidateIds = new Set(candidates.map((t) => t.id))
    for (const agent of [WALNUT, MENTOR]) {
      const members = all.filter((t) => isAskOf(t, agent))
      expect(members.length, agent.id).toBeGreaterThan(0)
      for (const m of members) expect(candidateIds.has(m.id), `${agent.id}: ${m.title} (${JSON.stringify(m.project)})`).toBe(true)
    }
    // The point of the filter: a few dozen rows, not the table.
    expect(all.length).toBeGreaterThan(600)
    expect(candidates.length).toBeLessThan(90)
    expect(candidates.some((t) => t.title.startsWith('Chore'))).toBe(false)
  })

  it('the edge rows land where the JS rule puts them', async () => {
    const candidates = await listTasksSlim({ minimal: true, askCandidates: true }) as unknown as Task[]
    const walnut = new Set(candidates.filter((t) => isAskOf(t, WALNUT)).map((t) => t.title))
    for (const member of ['Upper case project', 'Mixed case project', 'Padded project', 'Ideographic space',
      'No-break space', 'Tab and newline', 'Kelvin sign', 'Moved to Home', 'Moved, no project']) {
      expect(walnut.has(member), member).toBe(true)
    }
    for (const outsider of ['Near miss', 'Near miss 2', 'Near miss 3', 'Inner space', 'Stamp false', 'Mentor ask']) {
      expect(walnut.has(outsider), outsider).toBe(false)
    }
  })
})

/** A row taskToRow cannot write: its columns, then a payload and project set by hand. */
function insertForeign(over: Partial<Task>, raw: { payload: string | null; project?: null }): void {
  const row = { ...taskToRow(task(over)), ...raw }
  const cols = Object.keys(row)
  getDb()!.prepare(`INSERT INTO tasks (${cols.join(', ')}) VALUES (${cols.map((c) => `@${c}`).join(', ')})`).run(row)
}

describe('foreign rows rowToTask still reads (no write path makes them)', () => {
  it('a NULL project column with a payload project key, and a payload deeper than SQLite reads', async () => {
    let deep = '0'
    for (let i = 0; i < 1100; i++) deep = `[${deep}]`
    // rowToTask takes the payload's project when the column is NULL.
    insertForeign({ title: 'Leftover project key' }, { project: null, payload: '{"project":"Ask Walnut"}' })
    insertForeign({ title: 'Leftover mentor key' }, { project: null, payload: '{"project":"  ask mentor "}' })
    insertForeign({ title: 'Leftover other key' }, { project: null, payload: '{"project":"Home"}' })
    // json_valid says no (SQLite's JSON depth limit); JSON.parse reads the stamp.
    insertForeign({ title: 'Deep stamped', project: 'Home' }, { payload: `{"walnut_agent":true,"x":${deep}}` })
    insertForeign({ title: 'Deep stamped mentor', project: 'Home' },
      { payload: `{"walnut_agent":true,"agent_id":"mentor","x":${deep}}` })
    // Unreadable for both: a candidate, and the JS rule leaves it out.
    insertForeign({ title: 'Broken payload', project: 'Home' }, { payload: '{"walnut_agent":tru' })
    // Empty payload: rowToTask skips it, so it is not a candidate either.
    insertForeign({ title: 'Empty payload', project: 'Home' }, { payload: '' })
    _resetForTesting()

    const all = await listTasksSlim({ minimal: true }) as unknown as Task[]
    const candidates = await listTasksSlim({ minimal: true, askCandidates: true }) as unknown as Task[]
    const titles = new Set(candidates.map((t) => t.title))
    for (const [agent, want] of [[WALNUT, ['Leftover project key', 'Deep stamped']], [MENTOR, ['Leftover mentor key', 'Deep stamped mentor']]] as const) {
      const members = all.filter((t) => isAskOf(t, agent)).map((t) => t.title)
      for (const w of want) expect(members, `${agent.id} rule`).toContain(w)
      for (const m of members) expect(titles.has(m), `${agent.id}: ${m}`).toBe(true)
      const res = await request(createApp()).get(`/api/v1/asks?agentId=${agent.id}&limit=1000`)
      expect(res.status).toBe(200)
      expect(res.body.asks, agent.id).toEqual((await fullReadAnswer(agent)).asks)
    }
    expect(titles.has('Leftover other key')).toBe(false)
    expect(titles.has('Empty payload')).toBe(false)
    expect(titles.has('Broken payload')).toBe(true)
    expect(all.filter((t) => isAskOf(t, WALNUT) || isAskOf(t, MENTOR)).map((t) => t.title)).not.toContain('Broken payload')
  })
})

describe('GET /api/v1/asks answers exactly what the full read did', () => {
  it('for every agent, every row, every field', async () => {
    for (const agent of [WALNUT, MENTOR]) {
      const res = await request(createApp()).get(`/api/v1/asks?agentId=${agent.id}&limit=1000`)
      expect(res.status).toBe(200)
      const old = await fullReadAnswer(agent)
      expect(res.body.total, agent.id).toBe(old.total)
      expect(res.body.asks, agent.id).toEqual(old.asks)
    }
  })

  it('never lists the .metadata sentinel namespace', async () => {
    const res = await request(createApp()).get('/api/v1/asks?limit=1000')
    const titles = (res.body.asks as Array<{ title: string }>).map((r) => r.title)
    expect(titles.some((t) => t.trim().startsWith('.metadata'))).toBe(false)
  })
})
