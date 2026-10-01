/**
 * A session's task title is a few words (POST + PATCH /api/v1/tasks with the
 * x-walnut-caller-sid header; src/core/sessions/task-title-brake.ts).
 *
 * Real startServer({ port: 0, dev: true }) with an isolated home; the callers are
 * real session records. The only fake is Walnut's fast model
 * (session-title-backend.js), so the background refine is judged on the stored
 * row and on the bus, not on a mocked write.
 *
 * The contract pinned here:
 *   - no caller header (the phone, the web UI): a long title is stored as typed;
 *   - a worker, an ask and an untracked session: a title over 60 characters is
 *     cut to its head at once, the long form becomes the description when the
 *     create had none, the response names the cut, and TASK_CREATED already
 *     carries the cut (the board never sees the long form);
 *   - the fast model then renames the task, with a TASK_UPDATED for the board;
 *   - a short title from a session is stored as sent, with no cut field;
 *   - PATCH from a session meets the same brake; PATCH without a caller does not.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest'
import fs from 'node:fs/promises'
import type { Server as HttpServer } from 'node:http'
import { createMockConstants } from '../../helpers/mock-constants.js'

vi.mock('../../../src/constants.js', () => createMockConstants('walnut-apiv1-title-brake'))
vi.mock('../../../src/core/fork-title.js', async (orig) => ({
  ...(await orig<typeof import('../../../src/core/fork-title.js')>()),
  summarizeGroupLabel: vi.fn(async () => 'Refined Folder'),
}))
const backend = { available: true, answer: null as string | null, calls: 0 }
vi.mock('../../../src/core/session-title-backend.js', () => ({
  backendTitleAvailable: () => backend.available,
  titleViaBackendModel: vi.fn(async () => { backend.calls += 1; return backend.answer }),
}))

import { WALNUT_HOME } from '../../../src/constants.js'
import { startServer, stopServer } from '../../../src/web/server.js'
import { addTask, getTask } from '../../../src/core/task-manager.js'
import { createSessionRecord } from '../../../src/core/session-tracker.js'
import { bus, EventNames } from '../../../src/core/event-bus.js'

let server: HttpServer
let port: number
const api = (p: string): string => `http://localhost:${port}${p}`

async function post(body: unknown, sid?: string): Promise<{ status: number; json: Record<string, any> }> {
  const res = await fetch(api('/api/v1/tasks'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(sid ? { 'x-walnut-caller-sid': sid } : {}) },
    body: JSON.stringify(body),
  })
  return { status: res.status, json: await res.json() as Record<string, any> }
}

async function patch(id: string, body: unknown, sid?: string): Promise<{ status: number; json: Record<string, any> }> {
  const res = await fetch(api(`/api/v1/tasks/${id}`), {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json', ...(sid ? { 'x-walnut-caller-sid': sid } : {}) },
    body: JSON.stringify(body),
  })
  return { status: res.status, json: await res.json() as Record<string, any> }
}

let seq = 0
async function seedCaller(project: string, opts: { walnutAgent?: boolean; noTask?: boolean } = {}): Promise<string> {
  seq += 1
  const sid = `11111111-2222-3333-4444-${String(seq).padStart(12, '0')}`
  if (opts.noTask) {
    await createSessionRecord(sid, '', project, `/repo/${project}`, { title: 'loose' })
    return sid
  }
  const { task } = await addTask({ title: `Caller ${seq}`, project, pinned: true, ...(opts.walnutAgent ? { walnut_agent: true } : {}) })
  await createSessionRecord(sid, task.id, project, `/repo/${project}`, { title: task.title })
  return sid
}

function waitFor(cond: () => Promise<boolean>, ms = 5000): Promise<void> {
  const start = Date.now()
  return new Promise((resolve, reject) => {
    const tick = async () => {
      if (await cond()) return resolve()
      if (Date.now() - start > ms) return reject(new Error('timed out'))
      setTimeout(() => { void tick() }, 25)
    }
    void tick()
  })
}

const LONG = 'Bakery website launch: build the home page and the menu page, wire the order form to the bakery mailbox, and add the opening hours'
const CUT = 'Bakery website launch'

beforeAll(async () => {
  await fs.rm(WALNUT_HOME, { recursive: true, force: true })
  await fs.mkdir(WALNUT_HOME, { recursive: true })
  server = await startServer({ port: 0, dev: true })
  const addr = server.address()
  if (!addr || typeof addr === 'string') throw new Error('no port')
  port = addr.port
}, 30_000)

afterAll(async () => {
  await stopServer()
  await fs.rm(WALNUT_HOME, { recursive: true, force: true }).catch(() => {})
})

beforeEach(() => { backend.available = true; backend.answer = null; backend.calls = 0 })

describe('POST /api/v1/tasks', () => {
  it('no caller header: a long title is stored as typed (the phone, the web UI)', async () => {
    const { status, json } = await post({ title: LONG })
    expect(status).toBe(201)
    expect(json.task.title).toBe(LONG)
    expect(json.placement.title_shortened_from).toBeUndefined()
    expect((await getTask(json.task.id)).description ?? '').toBe('')
    expect(backend.calls).toBe(0)
  })

  it('a worker: the title is cut at once, the long form is the description, the board never sees the long form', async () => {
    const sid = await seedCaller('marina')
    const created: string[] = []
    bus.subscribe('brake-created', (e) => {
      if (e.name === EventNames.TASK_CREATED) created.push((e.data as { task: { title: string } }).task.title)
    }, { global: true })
    const off = () => bus.unsubscribe('brake-created')
    try {
      const { status, json } = await post({ title: LONG }, sid)
      expect(status).toBe(201)
      expect(json.task.title).toBe(CUT)
      expect(json.placement.title_shortened_from).toBe(LONG)
      const stored = await getTask(json.task.id)
      expect(stored.title).toBe(CUT)
      expect(stored.description).toBe(LONG)
      expect(created).toContain(CUT)
      expect(created).not.toContain(LONG)
    } finally {
      off()
    }
  })

  it('a description the session sent is kept; the long title then lives in the response only', async () => {
    const sid = await seedCaller('marina')
    const { json } = await post({ title: LONG, description: 'Ship before the weekend market.' }, sid)
    expect(json.task.title).toBe(CUT)
    expect((await getTask(json.task.id)).description).toBe('Ship before the weekend market.')
    expect(json.placement.title_shortened_from).toBe(LONG)
    // A blank description is none: the long form is still kept.
    const blank = await post({ title: LONG, description: '  ' }, sid)
    expect((await getTask(blank.json.task.id)).description).toBe(LONG)
  })

  it('the fast model then renames the task, announced on the bus, once', async () => {
    const sid = await seedCaller('marina')
    backend.answer = 'Bakery site launch'
    const renamed: string[] = []
    bus.subscribe('brake-renamed', (e) => {
      if (e.name === EventNames.TASK_UPDATED) renamed.push((e.data as { task: { title: string } }).task.title)
    }, { global: true })
    const off = () => bus.unsubscribe('brake-renamed')
    try {
      const { json } = await post({ title: LONG }, sid)
      expect(json.task.title).toBe(CUT)
      await waitFor(async () => (await getTask(json.task.id)).title === 'Bakery site launch')
      expect(renamed).toContain('Bakery site launch')
      expect(backend.calls).toBe(1)
    } finally {
      off()
    }
  })

  it('with the model gate closed, the cut head stays and nothing is asked', async () => {
    const sid = await seedCaller('marina')
    backend.available = false
    const { json } = await post({ title: LONG }, sid)
    await new Promise((r) => setTimeout(r, 50))
    expect((await getTask(json.task.id)).title).toBe(CUT)
    expect(backend.calls).toBe(0)
  })

  it('a short title from a session is stored as sent, with no cut field', async () => {
    const sid = await seedCaller('marina')
    const { json } = await post({ title: 'Fix the flaky auth test' }, sid)
    expect(json.task.title).toBe('Fix the flaky auth test')
    expect(json.placement.title_shortened_from).toBeUndefined()
    expect((await getTask(json.task.id)).description ?? '').toBe('')
    expect(backend.calls).toBe(0)
  })

  it('exactly 60 characters passes; 61 is cut', async () => {
    const sid = await seedCaller('marina')
    const sixty = 'Reindex the bakery orders table and rebuild the hours view'
    expect(sixty.length).toBe(58)
    const pass = await post({ title: `${sixty}!!` }, sid)
    expect(pass.json.task.title).toBe(`${sixty}!!`)
    const cut = await post({ title: `${sixty} now` }, sid)
    expect(cut.json.task.title.length).toBeLessThanOrEqual(60)
    expect(cut.json.placement.title_shortened_from).toBe(`${sixty} now`)
  })

  it('a Personal AI ask and an untracked session meet the same brake', async () => {
    const ask = await seedCaller('Ask Walnut', { walnutAgent: true })
    const viaAsk = await post({ title: LONG }, ask)
    expect(viaAsk.json.task.title).toBe(CUT)
    expect(viaAsk.json.placement.title_shortened_from).toBe(LONG)
    const loose = await seedCaller('marina', { noTask: true })
    const viaLoose = await post({ title: LONG }, loose)
    expect(viaLoose.json.task.title).toBe(CUT)
  })

  it('an unknown session id is an external caller: stored as typed', async () => {
    const { json } = await post({ title: LONG }, '99999999-0000-0000-0000-000000000000')
    expect(json.task.title).toBe(LONG)
    expect(json.placement.title_shortened_from).toBeUndefined()
  })

  it('a CJK title over the limit is cut at its own punctuation', async () => {
    const sid = await seedCaller('marina')
    const cjk = '订单表单接入邮箱：把面包店首页的订单表单接到邮箱，并且加上营业时间和地图，顺便修一下移动端的排版问题和图片加载慢的问题，最后把菜单页的价格改成新的'
    const { json } = await post({ title: cjk }, sid)
    expect(json.task.title).toBe('订单表单接入邮箱')
    expect((await getTask(json.task.id)).description).toBe(cjk)
  })
})

describe('PATCH /api/v1/tasks/:id', () => {
  it('a session renaming to a long title is cut, told so, and refined', async () => {
    const sid = await seedCaller('marina')
    const { task } = await addTask({ title: 'Placeholder', project: 'marina' })
    backend.answer = 'Bakery site launch'
    const { status, json } = await patch(task.id, { title: LONG }, sid)
    expect(status).toBe(200)
    expect(json.task.title).toBe(CUT)
    expect(json.title_shortened_from).toBe(LONG)
    // A rename never touches the description.
    expect((await getTask(task.id)).description ?? '').toBe('')
    await waitFor(async () => (await getTask(task.id)).title === 'Bakery site launch')
  })

  it('without a caller, a long title is stored as typed; a short title from a session carries no cut field', async () => {
    const { task } = await addTask({ title: 'Placeholder', project: 'marina' })
    const human = await patch(task.id, { title: LONG })
    expect(human.json.task.title).toBe(LONG)
    expect(human.json.title_shortened_from).toBeUndefined()
    const sid = await seedCaller('marina')
    const short = await patch(task.id, { title: 'Bakery launch' }, sid)
    expect(short.json.task.title).toBe('Bakery launch')
    expect(short.json.title_shortened_from).toBeUndefined()
    expect(backend.calls).toBe(0)
  })

  it('a patch without a title never looks the caller up', async () => {
    const { task } = await addTask({ title: 'Placeholder', project: 'marina' })
    const sid = await seedCaller('marina')
    const { status, json } = await patch(task.id, { priority: 'important' }, sid)
    expect(status).toBe(200)
    expect(json.task.title).toBe('Placeholder')
    expect(json.title_shortened_from).toBeUndefined()
  })
})
