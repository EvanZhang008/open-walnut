/**
 * task_start_check (POST /api/v1/tasks/start-check): may this caller start a task in a mode now,
 * under the one start-mode ceiling (core/sessions/delegated-mode.ts), read through the same chain as
 * task_start's (the relay's held job token for a vouched job, core/plugin-jobs/job-caller.ts START_OPS;
 * the start route's own caller reader, core/sessions/start-request-caller.ts).
 *
 * Why: a ticket worker's plugin job looked healthy for 30 hours while its starts were capped at
 * default and bypass refused. The job now asks this check and alarms when it cannot start.
 *
 * - the person (no caller) may start in bypass; a default session asking bypass hears the
 *   ceiling's own refusal, as a 200 with allowed:false; an unproven caller hears it with
 *   UNPROVEN_NOTE, even naming a bypass session's sid;
 * - a plugin job its host's daemon vouched for, relayed as a start is, may start in bypass; the job
 *   named but not vouched for, the held token on a session's sid, or from another host, may not;
 * - a malformed mode is the only 400;
 * - it creates no task, starts no session and writes no task or session.
 *
 * Real: the server, the relay, the op executor, the route, the ceiling. Mocked: constants.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import fs from 'node:fs/promises'
import type { Server as HttpServer } from 'node:http'
import { createMockConstants } from '../helpers/mock-constants.js'

vi.mock('../../src/constants.js', () => createMockConstants('walnut-task-start-check'))

import { WALNUT_HOME } from '../../src/constants.js'
import { startServer, stopServer } from '../../src/web/server.js'
import { createSessionRecord, listSessions } from '../../src/core/session-tracker.js'
import { listTasks } from '../../src/core/task-manager.js'
import { handleGatewayCapability } from '../../src/core/peers/capability-router.js'
import { executeOp } from '../../src/ops/index.js'
import { holdRelayJob } from '../../src/core/plugin-jobs/job-caller.js'
import { UNPROVEN_NOTE } from '../../src/core/sessions/delegated-mode.js'

const REFUSAL = 'A default session cannot start a task in bypass mode. Change the caller\'s mode first.'
const JOB = { plugin: 'ticket-investigator', job: 'poll' }
const VOUCHED = { ...JOB, vouched: true as const }
const HOST = 'devbox'
const DEFAULT_SID = '3b0c6e1a-2d4f-4a8b-9c7e-5f1a2b3c4d5e'
const BYPASS_SID = '8e2d4c6a-1b3f-4d5e-8a9b-0c1d2e3f4a5b'
let server: HttpServer
let port: number

function relay(args: Record<string, unknown>, pluginJob?: { plugin: string; job: string; vouched?: true }) {
  return handleGatewayCapability('tools.call', 'external', { name: 'task_start_check', args }, HOST, undefined, pluginJob ? { pluginJob } : {})
}

async function check(body: unknown, headers: Record<string, string> = {}) {
  const res = await fetch(`http://127.0.0.1:${port}/api/v1/tasks/start-check`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body),
  })
  return { status: res.status, json: await res.json().catch(() => null) as any }
}

async function newTask(title: string): Promise<string> {
  const res = await fetch(`http://127.0.0.1:${port}/api/tasks`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ title, priority: 'none', project: 'Marina' }),
  })
  return ((await res.json()) as any).task.id as string
}

beforeAll(async () => {
  await fs.rm(WALNUT_HOME, { recursive: true, force: true })
  await fs.mkdir(WALNUT_HOME, { recursive: true })
  server = await startServer({ port: 0, dev: true })
  port = (server.address() as { port: number }).port
  await createSessionRecord(DEFAULT_SID, await newTask('A default-mode worker'), 'Marina', WALNUT_HOME, { mode: 'default', initialProcessStatus: 'stopped' })
  await createSessionRecord(BYPASS_SID, await newTask('A bypass-mode worker'), 'Marina', WALNUT_HOME, { mode: 'bypass', initialProcessStatus: 'stopped' })
}, 120_000)

afterAll(async () => {
  await stopServer()
  await fs.rm(WALNUT_HOME, { recursive: true, force: true }).catch(() => {})
}, 60_000)

describe('the start check answers what the start ceiling decides, as a 200 either way', () => {
  it('the person (no caller) may start in bypass', async () => {
    const r = await check({ mode: 'bypass' })
    expect(r.status).toBe(200)
    expect(r.json).toEqual({ allowed: true, mode: 'bypass', caller: 'person' })
  })

  it('a default session asking bypass: allowed false with the ceiling\'s own words; default is allowed', async () => {
    const refused = await check({ mode: 'bypass' }, { 'x-walnut-caller-sid': DEFAULT_SID })
    expect(refused.status).toBe(200)
    expect(refused.json).toEqual({ allowed: false, mode: 'bypass', caller: 'session', reason: REFUSAL })
    const allowed = await check({ mode: 'default' }, { 'x-walnut-caller-sid': DEFAULT_SID })
    expect(allowed.json).toEqual({ allowed: true, mode: 'default', caller: 'session' })
  })

  it('an unproven caller is an outside caller, even naming a bypass session, and hears UNPROVEN_NOTE', async () => {
    const proven = await check({ mode: 'bypass' }, { 'x-walnut-caller-sid': BYPASS_SID })
    expect(proven.json).toEqual({ allowed: true, mode: 'bypass', caller: 'session' })
    const unproven = await check({ mode: 'bypass' }, { 'x-walnut-caller-sid': BYPASS_SID, 'x-walnut-caller-unproven': '1' })
    expect(unproven.status).toBe(200)
    expect(unproven.json).toEqual({ allowed: false, mode: 'bypass', caller: 'external', reason: `${REFUSAL} ${UNPROVEN_NOTE}` })
  })

  it('a plugin job its host vouched for, relayed as a start is, may start in bypass', async () => {
    const r = await relay({ mode: 'bypass' }, VOUCHED)
    expect(r.ok, JSON.stringify(r)).toBe(true)
    const result = (r as { result: Record<string, unknown> }).result
    expect(result).toMatchObject({ allowed: true, mode: 'bypass', caller: 'plugin-job' })
    expect(result.outcome).toBe('Starting a task in bypass is allowed for this caller now.')
  })

  it('the job named but not vouched for, or the anonymous caller, is refused as a success, never an error', async () => {
    for (const job of [JOB, undefined]) {
      const r = await relay({ mode: 'bypass' }, job)
      expect(r.ok, JSON.stringify(r)).toBe(true)
      const result = (r as { result: Record<string, unknown> }).result
      expect(result).toMatchObject({ allowed: false, mode: 'bypass', caller: 'external', reason: REFUSAL })
      expect(result.outcome).toBe(REFUSAL)
    }
  })

  it('the job\'s held token vouches only on the anonymous caller\'s self-call from its own host', async () => {
    const labels = { 'x-walnut-origin': `host:${HOST}`, 'x-walnut-plugin-id': JOB.plugin, 'x-walnut-plugin-job': JOB.job }
    const token = holdRelayJob(JOB, HOST)!
    const own = await check({ mode: 'bypass' }, { ...labels, 'x-walnut-caller-sid': 'external', 'x-walnut-caller-job': token })
    expect(own.json).toMatchObject({ allowed: true, caller: 'plugin-job' })
    // On a session's sid: that session's own ceiling, not the job's.
    const onSession = await check({ mode: 'bypass' }, { ...labels, 'x-walnut-caller-sid': DEFAULT_SID, 'x-walnut-caller-job': token })
    expect(onSession.json).toEqual({ allowed: false, mode: 'bypass', caller: 'session', reason: REFUSAL })
    // From another host's origin: an outside caller.
    const otherHost = await check({ mode: 'bypass' }, { ...labels, 'x-walnut-origin': 'host:otherbox', 'x-walnut-caller-sid': 'external', 'x-walnut-caller-job': token })
    expect(otherHost.json).toEqual({ allowed: false, mode: 'bypass', caller: 'external', reason: REFUSAL })
  })

  it('a malformed mode is a 400, the only failure; the op refuses it before any call', async () => {
    for (const body of [{}, { mode: 'yolo' }, { mode: 3 }]) {
      const r = await check(body)
      expect(r.status, JSON.stringify(body)).toBe(400)
      expect(r.json.error.code).toBe('bad_request')
    }
    const op = await executeOp('task_start_check', { mode: 'yolo' })
    expect(op.ok).toBe(false)
  })

  it('the op in process for the person: allowed, with its outcome and next', async () => {
    const r = await executeOp('task_start_check', { mode: 'bypass' })
    expect(r.ok).toBe(true)
    expect((r as { result: unknown }).result).toMatchObject({
      allowed: true, mode: 'bypass', caller: 'person', outcome: 'Starting a task in bypass is allowed for this caller now.',
    })
  })
})

describe('the start check has no side effect', () => {
  it('creates no task, starts no session and changes no task or session', async () => {
    // What a start or a write would change. A task's derived user_status is left out: the server's own
    // background pass stores it for the sessions made in beforeAll, whenever it runs.
    const tasksNow = async () => JSON.stringify((await listTasks()).map((t) => ({
      id: t.id, phase: t.phase, status: t.status, session_ids: t.session_ids, session_id: (t as { session_id?: unknown }).session_id, updated_at: t.updated_at,
    })))
    const sessionsNow = async () => JSON.stringify((await listSessions()).map((s) => ({
      sid: s.claudeSessionId, taskId: s.taskId, mode: s.mode, process_status: s.process_status, archived: s.archived,
    })))
    const before = { tasks: await tasksNow(), sessions: await sessionsNow() }
    await check({ mode: 'bypass' })
    await check({ mode: 'bypass' }, { 'x-walnut-caller-sid': DEFAULT_SID })
    await check({ mode: 'plan' }, { 'x-walnut-caller-sid': BYPASS_SID })
    expect((await relay({ mode: 'bypass' }, VOUCHED)).ok).toBe(true)
    expect((await relay({ mode: 'bypass' })).ok).toBe(true)
    expect(await tasksNow()).toBe(before.tasks)
    expect(await sessionsNow()).toBe(before.sessions)
    expect((await listSessions()).map((s) => s.claudeSessionId).sort()).toEqual([DEFAULT_SID, BYPASS_SID].sort())
  })
})
