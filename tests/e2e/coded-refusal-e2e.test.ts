/**
 * A sync plugin's content rule refusing a task's text is answered `content_rule` on every door, on
 * a real server: the v1 route, the route outside v1, a create, a note write, and the ops an agent
 * calls (src/lib/coded-refusal.ts).
 *
 * 2026-11-26: a session's task_update put text the task's sync plugin refuses into a
 * description. The task manager threw its typed error, no route named it, and the session read
 * `internal`: a server fault in real use's count, with nothing saying the text was the problem.
 * The same refusal by merge_into (one more field in the call) answers one code from the op's own
 * check and from the route's.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import type { AddressInfo } from 'node:net'
import { createMockConstants } from '../helpers/mock-constants.js'
import { mockLocalDaemonReader } from '../helpers/mock-local-daemon-reader.js'

vi.mock('../../src/constants.js', () => createMockConstants('walnut-coded-refusal-e2e'))
vi.mock('../../src/core/daemon-file-reader.js', () => mockLocalDaemonReader())

import { startServer, stopServer } from '../../src/web/server.js'
import { addTask, ensureProject, getTask } from '../../src/core/task-manager.js'
import { registry } from '../../src/core/integration-registry.js'
import { ensureProjectLead } from '../../src/core/org/org-store.js'
import { executeOp } from '../../src/ops/index.js'
import { failureClass } from '../../src/core/usage-watch/normalize.js'
import { opFailureCode } from '../../src/providers/tool-call-output.js'
import { createMockPlugin, createNoopSync } from '../core/plugin-test-utils.js'

const RULE = 'Text for this tracker holds no semicolons'
let base = ''
let taskId = ''
let leadId = ''

const json = (method: string, path: string, body: unknown) => fetch(`${base}${path}`, { method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })

beforeAll(async () => {
  const sync = createNoopSync()
  sync.validateContent = (_task, _field, value) => (value.includes(';') ? RULE : null)
  if (!registry.has('fake-tracker')) registry.register('fake-tracker', createMockPlugin({ id: 'fake-tracker', sync, claim: { fn: (() => false) as never, priority: 10 } }))
  const server = await startServer({ port: 0, dev: true })
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  await ensureProject('Tracked', 'fake-tracker')
  taskId = (await addTask({ title: 'Plain title', project: 'Tracked' })).task.id
  leadId = (await ensureProjectLead('Garden')).id
}, 40_000)

afterAll(async () => { await stopServer() })

describe('a plugin\'s content rule is a refusal with its code on every door', () => {
  it('the v1 update: 422 content_rule in the frozen shape, and nothing is written', async () => {
    const res = await json('PATCH', `/api/v1/tasks/${taskId}`, { description: 'first; second' })
    expect(res.status).toBe(422)
    expect(await res.json()).toEqual({ error: { code: 'content_rule', message: RULE } })
    expect((await getTask(taskId))?.description ?? '').not.toContain(';')
  })

  it('the update outside v1: the message with its code', async () => {
    const res = await json('PATCH', `/api/tasks/${taskId}`, { title: 'one; two' })
    expect(res.status).toBe(422)
    expect(await res.json()).toMatchObject({ error: RULE, code: 'content_rule' })
  })

  it('a create in the plugin\'s project', async () => {
    const res = await json('POST', '/api/v1/tasks', { title: 'new; task', project: 'Tracked' })
    expect(res.status).toBe(422)
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe('content_rule')
  })

  it.each([
    ['task_update', () => ({ id: taskId, description: 'first; second' })],
    ['task_note_write', () => ({ id: taskId, content: 'a note; with one' })],
  ])('the op %s: the session reads content_rule, counted as its argument, never a thrown error', async (op, args) => {
    const r = await executeOp(op, args(), { apiBase: base })
    expect(r).toMatchObject({ ok: false, status: 422, code: 'content_rule' })
    if (r.ok) return
    expect(r.message).toContain(RULE)
    expect(opFailureCode(r.message)).toBe('content_rule')
    expect(failureClass(r as never)).toEqual({ cls: 'bad_args', code: 'content_rule' })
  })

  it('text the rule allows still goes through', async () => {
    const res = await json('PATCH', `/api/v1/tasks/${taskId}`, { description: 'first, then second' })
    expect(res.status).toBe(200)
    expect((await getTask(taskId))?.description).toBe('first, then second')
  })
})

describe('merge_into with another field is one refusal under one code', () => {
  it('the route and the op\'s own check both answer bad_input', async () => {
    const route = await json('PATCH', `/api/v1/tasks/${leadId}/threads/th-0123456789ab`, { merge_into: 'th-ba9876543210', reply: 'kept here' })
    expect(route.status).toBe(400)
    const body = (await route.json()) as { error: { code: string; message: string } }
    expect(body.error.code).toBe('bad_input')
    expect(body.error.message).toContain('merge_into goes alone')
    const op = await executeOp('thread_update', { task: leadId, id: 'th-0123456789ab', merge_into: 'th-ba9876543210', reply: 'kept here' }, { apiBase: base })
    expect(op).toMatchObject({ ok: false, code: 'bad_input' })
  })
})
