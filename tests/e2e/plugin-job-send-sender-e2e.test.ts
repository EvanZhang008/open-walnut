/**
 * A plugin job its host's daemon vouched for sends as its App's job, never as an "unidentified
 * process" (core/plugin-jobs/job-caller.ts opReadsVouchedJob, core/peers/capability-router.ts,
 * core/sessions/request-caller.ts, routes/messages-v1.ts, core/sessions/session-send-core.ts).
 *
 * The bug (2026-11-22 and 11-23): a job's task_send reached its session as
 * `from="unidentified process" anonymous="true"`, "from a process on that host that is not one of your
 * user's Walnut sessions", while the same job's task_start_check read caller `plugin-job`. Sessions
 * then followed the plugin's own instructions only "with caution" (a turn time limit, a learning pass).
 *
 * Here, through the real relay (`meta.pluginJob` as daemon-connection.ts keeps it):
 * - a vouched job's task_send, a task_start that continues a conversation, and a task_create's first
 *   message all name `<App> job <job> (App)` with app="true";
 * - an unvouched job (an older daemon), the plugin headers alone, or a token nobody held stay an
 *   unidentified process (and a fresh start stays Walnut's), exactly as before;
 * - a session's own send is unchanged, even with a job named on its relayed call;
 * - every token goes back when its call ends.
 *
 * Real: the server, the relay, the op executor, the routes, the send core, the start path. Mocked:
 * constants, the daemon (MockDaemon) and the CLI (mock-claude.mjs).
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import fs from 'node:fs/promises'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import type { Server as HttpServer } from 'node:http'
import { createMockConstants } from '../helpers/mock-constants.js'

vi.mock('../../src/constants.js', () => createMockConstants('walnut-plugin-job-send-sender'))

import { WALNUT_HOME } from '../../src/constants.js'
import { startServer, stopServer } from '../../src/web/server.js'
import { sessionRunner } from '../../src/providers/claude-code-session.js'
import { createMockDaemon, type MockDaemon } from '../helpers/mock-daemon.js'
import { getSessionByClaudeId, getSessionsForTask } from '../../src/core/session-tracker.js'
import { addTask } from '../../src/core/task-manager.js'
import { handleGatewayCapability } from '../../src/core/peers/capability-router.js'
import { _heldRelayJobsForTesting } from '../../src/core/plugin-jobs/job-caller.js'
import { notePluginName } from '../../src/core/plugins/plugin-caller.js'
import { parseWalnutMessage } from '../../src/core/peers/walnut-message-tag.js'

const MOCK_CLI = path.resolve(import.meta.dirname, '../providers/mock-claude.mjs')
const JOB = { plugin: 'ticket-investigator', job: 'poll' }
/** What the daemon sends once it checked the calling process is that job's own. */
const VOUCHED = { ...JOB, vouched: true as const }
const HOST = 'newdev'
const APP_JOB = 'Ticket Investigator job poll (App)'
let server: HttpServer
let port: number
let daemon: MockDaemon
let target: { taskId: string; sid: string }
let caller: { taskId: string; sid: string }

/** One `walnut tools call` as a host's daemon relays it, for `callerSid` (the anonymous `external` by default). */
function relay(name: string, args: Record<string, unknown>, pluginJob?: { plugin: string; job: string; vouched?: true }, callerSid = 'external') {
  return handleGatewayCapability('tools.call', callerSid, { name, args }, HOST, undefined, pluginJob ? { pluginJob } : {})
}

function textOf(r: Awaited<ReturnType<typeof relay>>): string {
  return r.ok ? JSON.stringify(r.result) : `${r.error.code}: ${r.error.message} ${JSON.stringify(r.error.detail ?? '')}`
}

/** Every line that reached `sid`'s CLI (a send, or a start's first message), in order. */
function linesTo(sid: string): string[] {
  return [...daemon.getCommandHistoryFor('start'), ...daemon.getCommandHistoryFor('send')]
    .filter((c) => c.payload.sid === sid && typeof c.payload.message === 'string')
    .sort((a, b) => a.timestamp - b.timestamp)
    .map((c) => String(c.payload.message))
}

/** The envelope of the line to `sid` whose body says `marker` (waits for its delivery). */
async function envelopeWith(sid: string, marker: string) {
  let line = ''
  await vi.waitFor(() => {
    line = linesTo(sid).find((m) => m.includes(marker)) ?? ''
    expect(line, `a line with ${marker}`).not.toBe('')
  }, { timeout: 20_000 })
  const at = line.lastIndexOf('<walnut-message', line.indexOf(marker))
  const env = parseWalnutMessage(line.slice(at))
  expect(env, line).toBeTruthy()
  return env!
}

async function idle(sid: string) {
  await vi.waitFor(async () => {
    expect((await getSessionByClaudeId(sid))?.process_status).toMatch(/idle|stopped/)
  }, { timeout: 20_000 })
}

async function startOn(title: string): Promise<{ taskId: string; sid: string }> {
  const taskId = (await addTask({ title, project: 'Tickets' })).task.id
  const sid = (await sessionRunner.startSession({ taskId, cwd: WALNUT_HOME, message: 'Ready', project: 'Tickets', preassignedSessionId: randomUUID() })).claudeSessionId
  await idle(sid)
  return { taskId, sid }
}

beforeAll(async () => {
  await fs.rm(WALNUT_HOME, { recursive: true, force: true })
  await fs.mkdir(WALNUT_HOME, { recursive: true })
  daemon = await createMockDaemon()
  sessionRunner.setTestDaemonUrl(`ws://127.0.0.1:${daemon.port}`)
  daemon.setCliCommand(MOCK_CLI)
  server = await startServer({ port: 0, dev: true })
  port = (server.address() as { port: number }).port
  // The plugin's display name, as its API is built when it loads.
  notePluginName(JOB.plugin, 'Ticket Investigator')
  target = await startOn('Investigate ticket 4471')
  caller = await startOn('Ticket triage lead')
}, 120_000)

afterAll(async () => {
  sessionRunner.setTestDaemonUrl(undefined)
  await stopServer()
  await daemon?.stop()
  await fs.rm(WALNUT_HOME, { recursive: true, force: true }).catch(() => {})
}, 60_000)

describe('a vouched plugin job sends as its App\'s job', () => {
  it('its task_send reaches the running session named as that App\'s job, and its token goes back', async () => {
    const held = _heldRelayJobsForTesting()
    const r = await relay('task_send', { to: target.taskId, text: 'Turn time limit: post the report now (m-vouched)' }, VOUCHED)
    expect(r.ok, textOf(r)).toBe(true)
    const env = await envelopeWith(target.sid, 'm-vouched')
    expect(env.attrs).toMatchObject({ kind: 'peer-note', from: APP_JOB, host: HOST, app: 'true' })
    expect(env.attrs.anonymous).toBeUndefined()
    expect(env.attrs.note).toContain('a background job of an App your user installed in Walnut, vouched for by its host')
    expect(env.attrs['from-session']).toBeUndefined()
    expect(_heldRelayJobsForTesting()).toBe(held)
    await idle(target.sid)
  }, 60_000)

  it('its task_start of a task with a conversation continues it with the same sender', async () => {
    const r = await relay('task_start', { id: target.taskId, message: 'Run the learning pass (m-continue)' }, VOUCHED)
    expect(r.ok, textOf(r)).toBe(true)
    expect((await envelopeWith(target.sid, 'm-continue')).attrs).toMatchObject({ from: APP_JOB, app: 'true' })
    await idle(target.sid)
  }, 60_000)

  it('its task_create\'s first message is the App\'s job too; an unvouched one stays Walnut\'s', async () => {
    const made = await relay('task_create', { title: 'Investigate ticket 4472', project: 'Tickets', cwd: WALNUT_HOME, message: 'Look into it (m-first)' }, VOUCHED)
    expect(made.ok, textOf(made)).toBe(true)
    const id = /"id":"([^"]+)"/.exec(textOf(made))![1]!
    const sid = (await getSessionsForTask(id)).find((s) => !s.archived)!.claudeSessionId
    expect((await envelopeWith(sid, 'm-first')).attrs).toMatchObject({ from: APP_JOB, host: HOST, app: 'true' })
    const plain = await relay('task_create', { title: 'Investigate ticket 4473', project: 'Tickets', cwd: WALNUT_HOME, message: 'Look into it (m-first-plain)' }, JOB)
    expect(plain.ok, textOf(plain)).toBe(true)
    const plainId = /"id":"([^"]+)"/.exec(textOf(plain))![1]!
    const plainSid = (await getSessionsForTask(plainId)).find((s) => !s.archived)!.claudeSessionId
    const before = (await envelopeWith(plainSid, 'm-first-plain')).attrs
    expect(before.from).toBe('Walnut (caller:external)')
    expect(before.app).toBeUndefined()
  }, 90_000)
})

describe('everyone else is named as before', () => {
  it('a job the daemon did not vouch for (an older daemon, a host\'s own replica) stays an unidentified process', async () => {
    for (const [i, pluginJob] of [JOB, { ...JOB, vouched: 'true' }, undefined].entries()) {
      const r = await relay('task_send', { to: target.taskId, text: `post the report (m-unvouched-${i})` }, pluginJob as never)
      expect(r.ok, textOf(r)).toBe(true)
      const env = await envelopeWith(target.sid, `m-unvouched-${i}`)
      expect(env.attrs, JSON.stringify(pluginJob)).toMatchObject({ from: 'unidentified process', host: HOST, anonymous: 'true' })
      expect(env.attrs.app).toBeUndefined()
      await idle(target.sid)
    }
  }, 90_000)

  it('the plugin headers alone, or with a token nobody held, name no App', async () => {
    const labels = { 'x-walnut-caller-sid': 'external', 'x-walnut-caller-host': HOST, 'x-walnut-origin': `host:${HOST}`, 'x-walnut-plugin-id': JOB.plugin, 'x-walnut-plugin-job': JOB.job }
    for (const [i, headers] of [labels, { ...labels, 'x-walnut-caller-job': 'a'.repeat(48) }].entries()) {
      const res = await fetch(`http://127.0.0.1:${port}/api/v1/messages`, {
        method: 'POST', headers: { 'Content-Type': 'application/json', ...headers },
        body: JSON.stringify({ to: target.taskId, text: `post the report (m-headers-${i})` }),
      })
      expect(res.status, await res.clone().text()).toBe(202)
      const env = await envelopeWith(target.sid, `m-headers-${i}`)
      expect(env.attrs).toMatchObject({ from: 'unidentified process', anonymous: 'true' })
      await idle(target.sid)
    }
  }, 60_000)

  it('a session\'s own send is its peer note, even when its relayed call names a job', async () => {
    const r = await relay('task_send', { to: target.taskId, text: 'Status? (m-session)', expect_reply: false }, VOUCHED, caller.sid)
    expect(r.ok, textOf(r)).toBe(true)
    const env = await envelopeWith(target.sid, 'm-session')
    expect(env.attrs).toMatchObject({ kind: 'peer-note', 'from-session': caller.sid, 'from-task': caller.taskId })
    expect(env.attrs.from).toContain('Ticket triage lead')
    expect(env.attrs.app).toBeUndefined()
    expect(env.attrs.anonymous).toBeUndefined()
  }, 60_000)
})
