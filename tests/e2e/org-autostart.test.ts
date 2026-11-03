/**
 * Main and every VP start their own session in the background, and one switch turns the whole
 * org off (src/core/org/org-autostart.ts, src/core/org/org-enabled.ts), on a real server with a
 * mock daemon and the mock CLI:
 *   - a VP made on the Org page starts with no click, with Walnut's note asking for its Brief;
 *   - Main, made, starts when the Org page shows it (making it starts nothing: its maker's message does);
 *   - a test window's start starts nothing;
 *   - a start that fails says why on the task, and Retry starts it;
 *   - with the org off: a new VP starts nothing, the start route, an agent's org_send, task_send
 *     and task_start to a VP answer 409 org_off, a Brief refresh and the team note are skipped,
 *     and nothing reaches a VP from a worker's status change;
 *   - turning it on starts the VP made while it was off;
 *   - an install that never set the switch reads it as on, and only off is written.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import type { Server as HttpServer } from 'node:http'
import { createMockConstants } from '../helpers/mock-constants.js'

vi.mock('../../src/constants.js', () => createMockConstants('walnut-org-autostart-e2e'))

import { CONFIG_FILE, WALNUT_HOME } from '../../src/constants.js'
import { sessionRunner } from '../../src/providers/claude-code-session.js'
import { startServer, stopServer } from '../../src/web/server.js'
import { createMockDaemon, type MockDaemon } from '../helpers/mock-daemon.js'
import { addTask, getTask, setProjectMetadata } from '../../src/core/task-manager.js'
import { getSessionsForTask } from '../../src/core/session-tracker.js'
import { pendingOrgDigest } from '../../src/core/org/org-store.js'
import { _orgStartsSettled, orgStartMessage } from '../../src/core/org/org-autostart.js'
import { orgEnabledOf } from '../../src/core/org/org-enabled.js'
import { sendMessageToSession } from '../../src/core/session-message-queue.js'

const CAPTURE_CLI = path.resolve(import.meta.dirname, 'fixtures/mock-claude-argv-capture.mjs')
const ARGV_DIR = path.join(os.tmpdir(), `walnut-org-autostart-argv-${process.pid}`)

let server: HttpServer
let port: number
let daemon: MockDaemon

const url = (p: string) => `http://localhost:${port}${p}`

async function req(method: string, p: string, body?: unknown, headers: Record<string, string> = {}) {
  const res = await fetch(url(p), {
    method,
    headers: { 'content-type': 'application/json', ...headers },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
  return { status: res.status, json: await res.json().catch(() => null) as any }
}

async function until<T>(what: string, probe: () => Promise<T>, ok: (v: T) => boolean, timeoutMs = 30_000): Promise<T> {
  const deadline = Date.now() + timeoutMs
  let v = await probe()
  while (!ok(v) && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 150))
    v = await probe()
  }
  if (!ok(v)) throw new Error(`timed out waiting for ${what}: ${JSON.stringify(v)?.slice(0, 400)}`)
  return v
}

const sessionsOf = async (taskId: string) => (await getSessionsForTask(taskId)).filter((s) => !s.archived)
const hasSession = async (taskId: string) => (await sessionsOf(taskId)).length > 0

/** The first messages the runner was handed, by task (the mock CLI keeps no transcript). */
const firstMessages = new Map<string, string>()

beforeAll(async () => {
  await fs.rm(WALNUT_HOME, { recursive: true, force: true })
  await fs.rm(ARGV_DIR, { recursive: true, force: true })
  process.env.MOCK_CLAUDE_ARGV_DIR = ARGV_DIR
  process.env.WALNUT_ORG_AUTOSTART = '1'
  // The test-run header counts here as on the real Walnut (src/core/test-run.ts).
  process.env.WALNUT_TEST_RUN_MARK = '1'
  daemon = await createMockDaemon()
  daemon.setCliCommand(CAPTURE_CLI)
  sessionRunner.setCliCommand(CAPTURE_CLI)
  sessionRunner.setTestDaemonUrl(`ws://127.0.0.1:${daemon.port}`)
  const startSession = sessionRunner.startSession.bind(sessionRunner)
  vi.spyOn(sessionRunner, 'startSession').mockImplementation((params) => {
    if (params.taskId && params.message) firstMessages.set(params.taskId, params.message)
    return startSession(params)
  })
  server = await startServer({ port: 0, dev: true })
  const addr = server.address()
  port = typeof addr === 'object' && addr ? addr.port : 0
}, 120_000)

afterAll(async () => {
  process.env.WALNUT_ORG_AUTOSTART = '0'
  delete process.env.WALNUT_TEST_RUN_MARK
  sessionRunner.setTestDaemonUrl(undefined)
  delete process.env.MOCK_CLAUDE_ARGV_DIR
  await stopServer()
  await daemon.stop()
  await fs.rm(WALNUT_HOME, { recursive: true, force: true }).catch(() => {})
  await fs.rm(ARGV_DIR, { recursive: true, force: true }).catch(() => {})
})

describe('the org switch reads', () => {
  it('on when never set, off only when set to false', async () => {
    expect(orgEnabledOf({})).toBe(true)
    expect(orgEnabledOf({ org: { name: 'Acme' } })).toBe(true)
    expect(orgEnabledOf({ org: { enabled: false } })).toBe(false)
    const r = await req('GET', '/api/v1/org/settings')
    expect(r.status).toBe(200)
    expect(r.json.enabled).toBe(true)
  })
})

describe('a VP starts by itself', () => {
  it('a new VP gets its session with no click, told to read its teams and write its Brief', async () => {
    const made = await req('POST', '/api/v1/org/vps', { name: 'Orchard' })
    expect(made.status, JSON.stringify(made.json)).toBe(201)
    const id = made.json.task.id as string
    await until('the VP has a session', () => hasSession(id), Boolean)
    await _orgStartsSettled()
    const vp = await getTask(id)
    expect(vp.org_start).toBeUndefined()
    const lines = firstMessages.get(id) ?? ''
    expect(lines).toContain('Walnut started your session')
    // Framed as Walnut's own note: the transcript never reads it as the user's words.
    expect(lines).toContain('<walnut-message')
    expect(lines).toContain('org_get')
    expect(lines).toContain('brief_write')
    // Walnut's own note, never the user's words.
    expect(orgStartMessage(vp, 'Orchard VP')).toContain('you are the Orchard VP in the org')
  }, 60_000)

  it('Main, once made, starts when the Org page asks', async () => {
    const r = await req('POST', '/api/v1/org/main')
    expect(r.status).toBe(200)
    const mainId = r.json.task.id as string
    // Making it starts nothing: whoever made it sends its first message next.
    await new Promise((res) => setTimeout(res, 1000))
    await _orgStartsSettled()
    expect(await hasSession(mainId)).toBe(false)
    // A test window on the real Walnut starts no CLI for it.
    const probe = await req('POST', `/api/v1/org/nodes/${mainId}/start`, { auto: true }, { 'x-walnut-test-run': 'org-autostart-e2e' })
    expect(probe.json).toEqual({ queued: false, skipped: 'test_run' })
    expect(await hasSession(mainId)).toBe(false)
    // The Org page showing it does.
    const shown = await req('POST', `/api/v1/org/nodes/${mainId}/start`, { auto: true })
    expect(shown.status).toBe(202)
    await until('Main has a session', () => hasSession(mainId), Boolean)
    expect(orgStartMessage(await getTask(mainId), 'CEO')).toContain('the CEO of the org (Main)')
    await _orgStartsSettled()
    expect((await getTask(mainId)).org_start).toBeUndefined()
  }, 60_000)

  it('a start that fails says why, and Retry starts it', async () => {
    await setProjectMetadata('Broken Fields', { default_host: 'no-such-host-xyz' })
    const made = await req('POST', '/api/v1/org/projects', { name: 'Broken Fields' })
    expect(made.status, JSON.stringify(made.json)).toBe(201)
    const id = made.json.task.id as string
    const failed = await until('the start failed', () => getTask(id), (t) => t.org_start?.state === 'failed')
    expect(failed.org_start?.error).toBeTruthy()
    expect(await hasSession(id)).toBe(false)
    // Shown again, it is not retried by itself...
    const auto = await req('POST', `/api/v1/org/nodes/${id}/start`, { auto: true })
    expect(auto.json).toEqual({ queued: false, skipped: 'failed_before' })
    // ...the user's Retry is, once the cause is fixed.
    await setProjectMetadata('Broken Fields', { default_host: '' })
    const retry = await req('POST', `/api/v1/org/nodes/${id}/start`, {})
    expect(retry.status).toBe(202)
    await until('the VP has a session', () => hasSession(id), Boolean)
    await _orgStartsSettled()
    expect((await getTask(id)).org_start).toBeUndefined()
  }, 60_000)

  it('a VP that already has a session is not started again', async () => {
    const vp = (await req('GET', '/api/v1/org')).json
    const orchard = (await getSessionsForTask((vp.tree.projects as any[]).find((p) => p.project === 'Orchard').lead.id))
    const r = await req('POST', `/api/v1/org/nodes/${orchard[0]!.taskId}/start`, { auto: true })
    expect(r.json).toEqual({ queued: false, skipped: 'has_session' })
  })
})

describe('the org turned off', () => {
  let offVp = ''
  let workerSid = ''
  let workerTaskId = ''

  it('is written as off and read back off', async () => {
    const r = await req('PUT', '/api/v1/org/settings', { enabled: false })
    expect(r.status).toBe(200)
    expect(r.json.enabled).toBe(false)
    expect(await fs.readFile(CONFIG_FILE, 'utf8')).toMatch(/enabled: false/)
    expect((await req('PUT', '/api/v1/org/settings', { enabled: 'no' })).status).toBe(400)
    // A test window never moves the user's switch.
    const t = await req('PUT', '/api/v1/org/settings', { enabled: true }, { 'x-walnut-test-run': 'org-autostart-e2e' })
    expect(t.status).toBe(409)
    expect((await req('GET', '/api/v1/org/settings')).json.enabled).toBe(false)
  })

  it('a new VP starts nothing, and the start route says the org is off', async () => {
    const made = await req('POST', '/api/v1/org/vps', { name: 'Meadow' })
    expect(made.status).toBe(201)
    offVp = made.json.task.id
    await new Promise((r) => setTimeout(r, 2000))
    await _orgStartsSettled()
    expect(await hasSession(offVp)).toBe(false)
    const start = await req('POST', `/api/v1/org/nodes/${offVp}/start`, {})
    expect(start.status).toBe(409)
    expect(start.json.code).toBe('org_off')
  })

  it('an agent cannot reach a VP: org_send, task_send and task_start answer org_off', async () => {
    // A worker with a session, as an agent caller.
    const worker = (await addTask({ title: 'Prune the rows', project: 'Orchard', source: 'local' })).task
    const started = await req('POST', '/api/sessions/quick-start', { cwd: '/tmp', taskId: worker.id, message: 'go' })
    expect(started.status, JSON.stringify(started.json)).toBe(200)
    workerSid = started.json.sessionId
    workerTaskId = worker.id
    const as = { 'x-walnut-caller-sid': workerSid }
    const contact = await req('POST', '/api/v1/org/contact', { to: 'Orchard' }, as)
    expect(contact.status).toBe(409)
    expect(contact.json.code).toBe('org_off')
    const orchardLead = (await req('GET', '/api/v1/org')).json.tree.projects.find((p: any) => p.project === 'Orchard').lead.id
    const sent = await req('POST', '/api/v1/messages', { to: orchardLead, text: 'status?', expect_reply: false }, as)
    expect(sent.status).toBe(409)
    expect(JSON.stringify(sent.json)).toContain('org_off')
    const start = await req('POST', `/api/v1/tasks/${offVp}/start`, { message: 'hello' }, as)
    expect(start.status).toBe(409)
    expect(start.json.error.code).toBe('org_off')
    expect(await hasSession(offVp)).toBe(false)
  }, 60_000)

  it('a person still reaches a VP: a message goes in, and a start of their own runs', async () => {
    const orchardLead = (await req('GET', '/api/v1/org')).json.tree.projects.find((p: any) => p.project === 'Orchard').lead.id
    const sent = await req('POST', '/api/v1/messages', { to: orchardLead, text: 'how is it going?', expect_reply: false })
    expect(sent.status, JSON.stringify(sent.json)).toBeLessThan(300)
    const made = await req('POST', '/api/v1/org/vps', { name: 'Prairie' })
    const prairie = made.json.task.id as string
    const start = await req('POST', `/api/v1/tasks/${prairie}/start`, { message: 'hello, what do you lead?' })
    expect(start.status, JSON.stringify(start.json)).toBe(202)
    await until('the VP the person started has a session', () => hasSession(prairie), Boolean)
  }, 60_000)

  it('a background turn of Walnut never reaches a VP, whatever path sends it', async () => {
    const orchardLead = (await req('GET', '/api/v1/org')).json.tree.projects.find((p: any) => p.project === 'Orchard').lead.id
    const [s] = await sessionsOf(orchardLead)
    await expect(sendMessageToSession(s!.claudeSessionId, 'Re-check your ask.', { source: 'needs-recheck', taskId: orchardLead }))
      .rejects.toMatchObject({ code: 'org_off' })
    // A worker's own background turn is not the org's.
    const [w] = await sessionsOf(workerTaskId)
    await expect(sendMessageToSession(w!.claudeSessionId, 'Re-check your ask.', { source: 'needs-recheck', taskId: workerTaskId }))
      .resolves.toBeTruthy()
  })

  it('no Brief refresh, no team note', async () => {
    const orchardLead = (await req('GET', '/api/v1/org')).json.tree.projects.find((p: any) => p.project === 'Orchard').lead.id
    const r = await req('POST', `/api/v1/org/nodes/${orchardLead}/brief-refresh`, { by: 'web' })
    expect(r.json).toMatchObject({ sent: false, why: 'org_off' })
    const [s] = await sessionsOf(orchardLead)
    expect(await pendingOrgDigest(s!.claudeSessionId)).toBeNull()
    // A report sent or scheduled is the org's own letter; a preview still reads.
    expect((await req('POST', '/api/v1/org/report', { of: orchardLead, send: true })).status).toBe(409)
    expect((await req('POST', '/api/v1/org/report', { of: orchardLead })).status).toBe(200)
  })

  it('turning it on starts the VP made while it was off', async () => {
    const r = await req('PUT', '/api/v1/org/settings', { enabled: true })
    expect(r.json.enabled).toBe(true)
    // Only off is written: on is the default.
    expect(await fs.readFile(CONFIG_FILE, 'utf8')).not.toMatch(/enabled: false/)
    await until('the VP made while off has a session', () => hasSession(offVp), Boolean)
    // An agent reaches the org again.
    const contact = await req('POST', '/api/v1/org/contact', { to: 'Orchard' }, { 'x-walnut-caller-sid': workerSid })
    expect(contact.status).toBe(200)
  }, 60_000)
})
