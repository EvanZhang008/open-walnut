/**
 * A plugin's job starts its tasks in the mode it asks for once its host's daemon vouches for it
 * (core/plugin-jobs/job-caller.ts, core/peers/capability-router.ts, ops/executor.ts,
 * routes/task-v1.ts, core/sessions/delegated-mode.ts capStartMode).
 *
 * The bug: a ticket investigator's job runs on a host's daemon and calls task_create with mode
 * `bypass` (the user decided its sessions run so). The daemon relayed the call to the leader as
 * the anonymous caller `external`, which the start-mode ceiling caps at `default`, so the task was
 * made and its start answered 403 "A default session cannot start a task in bypass mode".
 *
 * Here the relay is what the leader sees once the daemon side forwards the job (`meta.pluginJob`
 * with `vouched: true`, once the daemon checked the calling process is that job's own):
 * - the job's task_create in bypass starts, and the session record's mode is bypass; its later
 *   task_start of a task that did not start, and of a stopped session, both go through;
 * - a job named but not vouched for (`vouched` absent, or anything but the literal true) stays
 *   capped, and so do the plugin headers alone with no credential;
 * - the anonymous caller asking for bypass is still refused with the same sentence; a project's
 *   default of bypass still comes down to default for it;
 * - the job's labels alone (x-walnut-plugin-id + x-walnut-plugin-job, which any local program can
 *   write) vouch for nothing, nor does a token nobody held, one copied onto another caller's call,
 *   or one sent with another host's origin;
 * - a session calling through a plugin stays capped at its own mode.
 *
 * Real: the server, the relay, the op executor, the routes, the start path. Mocked: constants, the
 * daemon (MockDaemon) and the CLI (mock-claude.mjs).
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import fs from 'node:fs/promises'
import path from 'node:path'
import type { Server as HttpServer } from 'node:http'
import { createMockConstants } from '../helpers/mock-constants.js'

vi.mock('../../src/constants.js', () => createMockConstants('walnut-plugin-job-start-mode'))

import { WALNUT_HOME } from '../../src/constants.js'
import { startServer, stopServer } from '../../src/web/server.js'
import { sessionRunner } from '../../src/providers/claude-code-session.js'
import { createMockDaemon, type MockDaemon } from '../helpers/mock-daemon.js'
import { createSessionRecord, getSessionsForTask, updateSessionRecord } from '../../src/core/session-tracker.js'
import { setProjectMetadata, updateTask } from '../../src/core/task-manager.js'
import { handleGatewayCapability } from '../../src/core/peers/capability-router.js'
import { executeOp } from '../../src/ops/index.js'
import { holdRelayJob } from '../../src/core/plugin-jobs/job-caller.js'

const MOCK_CLI = path.resolve(import.meta.dirname, '../providers/mock-claude.mjs')
const REFUSAL = 'A default session cannot start a task in bypass mode. Change the caller\'s mode first.'
const JOB = { plugin: 'ticket-investigator', job: 'poll' }
/** What the daemon sends once it checked the calling process is that job's own. */
const VOUCHED = { ...JOB, vouched: true as const }
const HOST = 'devbox'
const SESSION_SID = '7a1e4c2b-9d3f-4e8a-b6c5-2f0d1e9a8b7c'
let server: HttpServer
let port: number
let daemon: MockDaemon
let sessionTask: string

/** One `walnut tools call` as a host's daemon relays it: the anonymous caller, with the job it vouches for. */
function relay(name: string, args: Record<string, unknown>, pluginJob?: { plugin: string; job: string; vouched?: true }) {
  return handleGatewayCapability('tools.call', 'external', { name, args }, HOST, undefined, pluginJob ? { pluginJob } : {})
}

function textOf(r: Awaited<ReturnType<typeof relay>>): string {
  return r.ok ? JSON.stringify(r.result) : `${r.error.code}: ${r.error.message} ${JSON.stringify(r.error.detail ?? '')}`
}

async function http(p: string, body: unknown, headers: Record<string, string>) {
  const res = await fetch(`http://127.0.0.1:${port}${p}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body),
  })
  return { status: res.status, json: await res.json().catch(() => null) as any }
}

async function newTask(title: string, project = 'Tickets'): Promise<string> {
  const r = await http('/api/tasks', { title, priority: 'none', project }, {})
  return r.json.task.id as string
}

async function modeOf(taskId: string): Promise<string | undefined> {
  const records = await getSessionsForTask(taskId)
  return records.find((s) => !s.archived)?.mode
}

/** The task id a relayed task_create made, from its answer (a start refusal still names the task). */
function createdId(r: Awaited<ReturnType<typeof relay>>): string | undefined {
  return /"id":"([^"]+)"/.exec(textOf(r))?.[1]
}

beforeAll(async () => {
  await fs.rm(WALNUT_HOME, { recursive: true, force: true })
  await fs.mkdir(WALNUT_HOME, { recursive: true })
  daemon = await createMockDaemon()
  sessionRunner.setTestDaemonUrl(`ws://127.0.0.1:${daemon.port}`)
  daemon.setCliCommand(MOCK_CLI)
  server = await startServer({ port: 0, dev: true })
  port = (server.address() as { port: number }).port
  sessionTask = await newTask('A default-mode worker', 'Marina')
  await createSessionRecord(SESSION_SID, sessionTask, 'Marina', WALNUT_HOME, { mode: 'default', initialProcessStatus: 'stopped' })
  await updateTask(sessionTask, { session_id: SESSION_SID } as never)
}, 120_000)

afterAll(async () => {
  sessionRunner.setTestDaemonUrl(undefined)
  await stopServer()
  await daemon?.stop()
  await fs.rm(WALNUT_HOME, { recursive: true, force: true }).catch(() => {})
}, 60_000)

describe('a plugin job vouched for by its host starts its tasks in the mode it asks for', () => {
  it('task_create in bypass starts, and the session runs in bypass', async () => {
    const r = await relay('task_create', { title: 'Investigate ticket one', project: 'Tickets', mode: 'bypass', cwd: WALNUT_HOME, message: 'look into it' }, VOUCHED)
    expect(r.ok, textOf(r)).toBe(true)
    const id = createdId(r)!
    expect(id).toBeTruthy()
    expect(await modeOf(id)).toBe('bypass')
  }, 60_000)

  it('its later task_start of a task that did not start, then of its stopped session, goes through', async () => {
    const made = await relay('task_create', { title: 'Investigate ticket two', project: 'Tickets', record_only: true }, VOUCHED)
    expect(made.ok, textOf(made)).toBe(true)
    const id = createdId(made)!
    const started = await relay('task_start', { id, mode: 'bypass', cwd: WALNUT_HOME, message: 'start now' }, VOUCHED)
    expect(started.ok, textOf(started)).toBe(true)
    expect(await modeOf(id)).toBe('bypass')
    // The session stops; the job starts the task again, in bypass: its conversation continues.
    const sid = (await getSessionsForTask(id)).find((s) => !s.archived)!.claudeSessionId
    await updateSessionRecord(sid, { process_status: 'stopped' } as never)
    const again = await relay('task_start', { id, mode: 'bypass', message: 'one more look' }, VOUCHED)
    expect(again.ok, textOf(again)).toBe(true)
    // The anonymous caller asking the same is refused before anything is sent.
    await updateSessionRecord(sid, { process_status: 'stopped' } as never)
    const anon = await relay('task_start', { id, mode: 'bypass', message: 'one more look' })
    expect(anon.ok).toBe(false)
    expect(textOf(anon)).toContain(REFUSAL)
  }, 90_000)
})

describe('everyone else stays under the ceiling', () => {
  it('a job the daemon named but did not vouch for (an older daemon, a host\'s own replica) stays capped', async () => {
    const r = await relay('task_create', { title: 'Unvouched job', project: 'Tickets', mode: 'bypass', cwd: WALNUT_HOME, message: 'look' }, JOB)
    expect(r.ok).toBe(false)
    expect(textOf(r)).toContain(REFUSAL)
    // Only the literal true vouches: a string or a number from a frame is no proof.
    for (const vouched of ['true', 1, {}]) {
      const id = await newTask(`Vouched as ${JSON.stringify(vouched)}`)
      const s = await relay('task_start', { id, mode: 'bypass', cwd: WALNUT_HOME, message: 'look' }, { ...JOB, vouched } as never)
      expect(s.ok, JSON.stringify(vouched)).toBe(false)
      expect(textOf(s)).toContain(REFUSAL)
    }
  }, 60_000)

  it('the plugin id header alone, or with the job header, and no credential is capped', async () => {
    const body = { mode: 'bypass', cwd: WALNUT_HOME, message: 'look' }
    const base = { 'x-walnut-caller-sid': 'external', 'x-walnut-origin': `host:${HOST}` }
    for (const headers of [
      { ...base, 'x-walnut-plugin-id': JOB.plugin },
      { ...base, 'x-walnut-plugin-id': JOB.plugin, 'x-walnut-plugin-job': JOB.job },
      { 'x-walnut-caller-sid': 'external', 'x-walnut-plugin-id': JOB.plugin, 'x-walnut-plugin-job': JOB.job },
    ]) {
      const r = await http(`/api/v1/tasks/${await newTask('Headers only')}/start`, body, headers)
      expect(r.status, JSON.stringify(headers)).toBe(403)
      expect(JSON.stringify(r.json)).toContain(REFUSAL)
    }
  }, 60_000)

  it('the anonymous caller asking for bypass is refused with the same sentence (an older daemon)', async () => {
    const r = await relay('task_create', { title: 'Investigate ticket three', project: 'Tickets', mode: 'bypass', cwd: WALNUT_HOME, message: 'look' })
    expect(r.ok).toBe(false)
    expect(textOf(r)).toContain(REFUSAL)
    const id = createdId(r)
    if (id) expect(await modeOf(id)).toBeUndefined()
  }, 60_000)

  it('a project default of bypass comes down to default for the anonymous caller, and stays bypass for the job', async () => {
    await setProjectMetadata('BypassDefault', { default_mode: 'bypass' })
    const anon = await relay('task_create', { title: 'Default-mode project task', project: 'BypassDefault', cwd: WALNUT_HOME, message: 'look' })
    expect(anon.ok, textOf(anon)).toBe(true)
    expect(await modeOf(createdId(anon)!)).toBe('default')
    const job = await relay('task_create', { title: 'Job project task', project: 'BypassDefault', cwd: WALNUT_HOME, message: 'look' }, VOUCHED)
    expect(job.ok, textOf(job)).toBe(true)
    expect(await modeOf(createdId(job)!)).toBe('bypass')
  }, 90_000)

  it('the job\'s labels alone, a token nobody held, or a real one on another call vouch for nothing', async () => {
    const labels = { 'x-walnut-caller-sid': 'external', 'x-walnut-origin': `host:${HOST}`, 'x-walnut-plugin-id': JOB.plugin, 'x-walnut-plugin-job': JOB.job }
    const body = { mode: 'bypass', cwd: WALNUT_HOME, message: 'look' }
    const forged = await http(`/api/v1/tasks/${await newTask('Forged labels')}/start`, body, labels)
    expect(forged.status).toBe(403)
    expect(JSON.stringify(forged.json)).toContain(REFUSAL)
    const unheld = await http(`/api/v1/tasks/${await newTask('Unheld token')}/start`, body, { ...labels, 'x-walnut-caller-job': 'a'.repeat(48) })
    expect(unheld.status).toBe(403)
    // A token the relay really held, on a call from another host's origin: capped.
    const token = holdRelayJob(JOB, HOST)!
    const otherHost = await http(`/api/v1/tasks/${await newTask('Other host')}/start`, body, { ...labels, 'x-walnut-origin': 'host:otherbox', 'x-walnut-caller-job': token })
    expect(otherHost.status).toBe(403)
    // Copied onto a session's call: the session's own ceiling.
    const onSession = await http(`/api/v1/tasks/${await newTask('Session copy')}/start`, body, { ...labels, 'x-walnut-caller-sid': SESSION_SID, 'x-walnut-caller-job': token })
    expect(onSession.status).toBe(403)
    expect(JSON.stringify(onSession.json)).toContain(REFUSAL)
    // Naming another job of that plugin: capped.
    const otherJob = await http(`/api/v1/tasks/${await newTask('Other job')}/start`, body, { ...labels, 'x-walnut-plugin-job': 'other', 'x-walnut-caller-job': token })
    expect(otherJob.status).toBe(403)
    // The same token on the call it was held for is the job's (the route reads it).
    const right = await http(`/api/v1/tasks/${await newTask('Right call')}/start`, body, { ...labels, 'x-walnut-caller-job': token })
    expect(right.status, JSON.stringify(right.json)).toBe(202)
  }, 90_000)

  it('a relay that names a job for a session\'s call holds nothing: the session stays capped', async () => {
    const id = await newTask('Through a plugin from a session')
    const r = await handleGatewayCapability('tools.call', SESSION_SID, { name: 'task_start', args: { id, mode: 'bypass', cwd: WALNUT_HOME, message: 'look' } }, HOST, undefined, { pluginJob: VOUCHED })
    expect(r.ok).toBe(false)
    expect(textOf(r)).toContain(REFUSAL)
  }, 60_000)

  it('a session calling through a plugin op stays capped at its own mode', async () => {
    const id = await newTask('Plugin op from a session')
    const r = await executeOp('task_start', { id, mode: 'bypass', cwd: WALNUT_HOME, message: 'look' }, { callerSid: SESSION_SID, callerPluginId: JOB.plugin, callerPluginJob: JOB.job })
    expect(r.ok).toBe(false)
    expect(r.ok ? '' : r.message).toContain(REFUSAL)
  }, 60_000)
})
